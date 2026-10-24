import { Cause, Context, Data, Deferred, Duration, Effect, Exit, Layer, RcMap, Result, Schema, SchemaIssue, SchemaParser, SchemaTransformation, Scope, Semaphore } from "effect";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {SupportingReferences, SupportingSkills, type DefinitionGuidance, definitionGuidanceFields, definitionGuidanceProblem, describeDefinitionReferenceProblem } from "./definition-references.js";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import type { FreshGitProbe } from "./git-probe.js";
import { ProjectFileError, type FileFailure, type ProjectCommitter, type ProjectFiles, type ProjectWriter, type ReadFileResult } from "./project-files.js";
import {catalogEntryId, DefinitionNode, definitionIdPattern, normalizeProjectConfiguration, projectConfigurationError, ProjectConfigurationInfo, workflowDefinitionExpansionLimits,
  type DefinitionCatalogEntry, type DefinitionFileInfo, type DefinitionStepInfo, type DefinitionWorkflowInfo, type EffectiveConfigurationInfo,
  type ProjectDefinitionSnapshot} from "./project-definitions-contract.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const projectConfigPath = ".t3-supervisor/project.yaml";
type MutableSnapshot = {-readonly [K in keyof ProjectDefinitionSnapshot]: ProjectDefinitionSnapshot[K] extends ReadonlyArray<infer V> ? V[] : ProjectDefinitionSnapshot[K]};
type MutableScopeSnapshot = {steps: DefinitionStepInfo[]; workflows: DefinitionWorkflowInfo[]; config: EffectiveConfigurationInfo; projectConfig: ProjectConfigurationInfo | null;
  definitionFiles: DefinitionFileInfo[]; sources: ProjectDefinitionSnapshot["sources"][number][]; issues: ProjectDefinitionSnapshot["issues"][number][]};
type DefinitionOrigin = "global" | "project";
type DefinitionScopeStatus = "ready" | "missing" | "invalid" | "permission_required" | "unavailable";
export type DefinitionPresence = {status: "present" | "missing" | "unavailable"; message?: string};
export type GlobalDefinitionPresence = DefinitionPresence & {path: string};
export type DefinitionCheckoutTarget = {origin: "project"; threadId: string | null; workspaceRoot: string; branch: string | null; isGitRepository: boolean; members: Array<{threadId: string; title: string}>};
export type ProjectDefinitionSetupInput = {origin: "project"; action: "create" | "create_and_commit"; expectedWorkspaceRoot: string; expectedBranch: string | null};
export type ProjectDefinitionSetupOutcome = {status: "created" | "committed" | "unchanged" | "conflict" | "stale" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string | null; branch: string | null; path: string; message: string};
export type ProjectDefinitionGlobalSetupOutcome = {status: "created" | "unchanged" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string; branch: null; path: string; message: string};
export type DefinitionFileRead = ReadFileResult;
type CommitSafetyCheck = {status: "safe"; branch: string | null} | {status: "stale" | "conflict" | "unavailable"; branch: string | null; message: string};
export interface ProjectDefinitionSetupWriter {
  readonly writeFile: ProjectWriter["Service"]["writeFile"];
  readonly commitFiles?: ProjectCommitter["Service"]["commitFiles"] | undefined;
}
export interface ProjectDefinitionLoaderOptions {
  globalRoot?: string | null;
  // reads of the supervision stores; a failure is a definition source failure
  useGlobalDefinitions?: (projectId: string) => Effect.Effect<boolean, unknown>;
  isScratchProject?: (projectId: string, registeredWorkspaceRoot: string) => Effect.Effect<boolean, unknown>;
  managedScratchRoot?: string;
  setupWriter?: ProjectDefinitionSetupWriter;
  gitProbe?: FreshGitProbe;
}
// what the loader reads: the catalog, the native projection and the native file client, with the scope and setup options
export interface ProjectDefinitionSources {
  readonly source: Pick<StoreShape, "catalog">;
  readonly t3: Pick<T3ClientShape, "projection">;
  readonly files: ProjectFiles["Service"];
  readonly options?: ProjectDefinitionLoaderOptions;
}
interface DefinitionScopeRead extends MutableScopeSnapshot {
  status: DefinitionScopeStatus;
  complete: boolean;
  inputs: unknown[];
}

// a native, catalog or projection call failed; the original value serves only the baseline classification, never a log
export class DefinitionSourceFailure extends Data.TaggedError("DefinitionSourceFailure")<{readonly error: unknown}> {}
// a source exceeded the read bounds; its fixed message becomes the source diagnostic
export class DefinitionReadLimit extends Schema.TaggedError<DefinitionReadLimit>()("DefinitionReadLimit", {message: Schema.String}) {}
// checkout choices refuse the project with a fixed reason
export class DefinitionCheckoutUnavailable extends Schema.TaggedError<DefinitionCheckoutUnavailable>()("DefinitionCheckoutUnavailable", {
  reason: Schema.Literals(["project_unavailable", "workspace_invalid", "checkout_target_limit", "workspace_binding_unavailable"]),
}) {}
// an authored source broke one of its fixed rules; problem is the exact diagnostic, absent only when a non-Error was thrown
export class DefinitionSourceInvalid extends Data.TaggedError("DefinitionSourceInvalid")<{readonly problem: string | undefined}> {}

const fileFailure = (failure: DefinitionSourceFailure | DefinitionReadLimit): FileFailure | null =>
  failure._tag === "DefinitionSourceFailure" && failure.error instanceof ProjectFileError ? failure.error.code : null;
const failureMessage = (failure: DefinitionSourceFailure | DefinitionReadLimit, fallback: string): string =>
  failure._tag === "DefinitionReadLimit" ? failure.message : failure.error instanceof Error ? failure.error.message : fallback;

// the running operation's cancel trigger: completed when its caller cancels or its deadline passes; set only by definitionsOperation
const OperationCancel = Context.Reference<Deferred.Deferred<void> | undefined>("t3-supervisor/DefinitionsOperationCancel", {defaultValue: () => undefined});
// soft cancellation is part of the service contract: a cancelled call settles with its baseline outcome (an unavailable snapshot, a
// stale setup, an expired save: ct-pd-02, ct-pd-04, ct-editor-02), which an interruption would discard. The caller's cancel trigger
// is the native clients' own (native-envelope.ts); with a deadline on the effect clock, the operation gets its own trigger that
// completes at the deadline or when the caller's does
export const definitionsOperation = (cancel: Deferred.Deferred<void> | undefined, deadline?: Duration.Input) => <A, E>(self: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  deadline === undefined ? Effect.provideService(self, OperationCancel, cancel) : Effect.scoped(Effect.gen(function* () {
    const operation = yield* Deferred.make<void>();
    // started at once, so a caller's trigger that already completed has completed the operation's before it runs
    if (cancel !== undefined) yield* Effect.forkScoped(Effect.andThen(Deferred.await(cancel), Deferred.succeed(operation, undefined)), {startImmediately: true});
    yield* Effect.forkScoped(Effect.andThen(Effect.sleep(deadline), Deferred.succeed(operation, undefined)));
    return yield* Effect.provideService(self, OperationCancel, operation);
  }));
// the running operation's cancel trigger, handed explicitly to a nested definitions call
export const definitionsCancel: Effect.Effect<Deferred.Deferred<void> | undefined> = OperationCancel;
// whether the running operation was cancelled or ran past its deadline
export const definitionsCanceled: Effect.Effect<boolean> = Effect.flatMap(OperationCancel, cancel => cancel === undefined ? Effect.succeed(false) : Deferred.isDone(cancel));
// a native client call under the running operation: the operation's trigger is the call's cancel trigger, so a completed trigger ends
// the call with the client's own outcome (unavailable, or an uncertain commit) and an already completed one never connects;
// interruption ends it too
export const withOperationCancel = <A, E>(call: (cancel: Deferred.Deferred<void> | undefined) => Effect.Effect<A, E>): Effect.Effect<A, DefinitionSourceFailure> =>
  Effect.flatMap(OperationCancel, call).pipe(Effect.mapError(error => new DefinitionSourceFailure({error})));
// the operation's trigger completed while a catalog or projection read was pending
class DefinitionsOperationEnded extends Data.TaggedError("DefinitionsOperationEnded") {
  override get message() {return "The definitions read was canceled or ran past its deadline.";}
}
// a catalog or projection read ends when the operation's trigger completes
const boundedRead = <A, E>(read: () => Effect.Effect<A, E>): Effect.Effect<A, DefinitionSourceFailure> => Effect.flatMap(OperationCancel, cancel => {
  const effect = Effect.suspend(read).pipe(Effect.mapError(error => new DefinitionSourceFailure({error})),
    Effect.catchDefect(error => Effect.fail(new DefinitionSourceFailure({error}))));
  return cancel ? Effect.raceFirst(effect, Effect.andThen(Deferred.await(cancel), Effect.fail(new DefinitionSourceFailure({error: new DefinitionsOperationEnded()})))) : effect;
});
// configured predicates are synchronous reads that may throw; a throw fails the operation as the baseline's rejection did
const attempt = <A>(evaluate: () => A) => Effect.try({try: evaluate, catch: error => new DefinitionSourceFailure({error})});

const definitionId = definitionIdPattern;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 8000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(f => Object.hasOwn(v, f));
const withOptionalGuidance = (value: Record<string, unknown>, fields: string[]) =>
  exact(value, [...fields, ...["references", "skills"].filter(field => Object.hasOwn(value, field))]);
// rejected reference lists report a fixed reason and position without repeating the path
const checkGuidance = (value: Record<string, unknown>, owner: string): void => {
  const problem = definitionGuidanceProblem(value);
  if (problem) throw new Error(`${owner} ${describeDefinitionReferenceProblem(problem)}`);
};

// runs a baseline validator as a Schema transformation: its thrown message becomes the issue message unchanged, so every diagnostic keeps its text and order
const validated = <T, E>(validate: (input: E) => T) => SchemaTransformation.transformEffect<T, E>({
  decode: input => {
    try {return Effect.succeed(validate(input));}
    catch (error) {return Effect.fail(new SchemaIssue.InvalidValue(error instanceof Error ? {message: error.message} : undefined));}
  },
  encode: () => Effect.fail(new SchemaIssue.Forbidden({message: "Definition sources are decoded, never encoded."})),
});
// the yaml adapter: text to an unknown value; syntax errors, duplicate keys, custom tags and aliases are rejected with fixed messages
const parseYaml = (contents: string): unknown => {
  const doc = parseDocument(contents, {schema: "core", uniqueKeys: true});
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML; check syntax, duplicate keys and tags.");
  try {return doc.toJS({maxAliasCount: 0});}
  catch {throw new Error("YAML aliases are not supported in project definitions.");}
};
const yaml = validated<unknown, string>(parseYaml);
const DefinitionYaml = Schema.String.pipe(Schema.decodeTo(Schema.Unknown, yaml));

const definitionName = (value: unknown): value is string => text(value, 160);

const projectConfigurationFromYaml = (config: unknown): ProjectConfigurationInfo => {
  if (record(config) && Object.hasOwn(config, "required"))
    throw new Error("project.yaml indexes every reusable definition: list workflows and steps entries with path, summary and optional required: true. The top-level required list was replaced by each entry's required flag (false when omitted).");
  if (!record(config) || !(exact(config, ["workflows", "steps"]) || exact(config, ["workflows", "steps", "default_workflow"])) ||
    !Array.isArray(config.workflows) || !Array.isArray(config.steps) || config.default_workflow !== undefined && typeof config.default_workflow !== "string")
    throw new Error("project.yaml needs workflows and steps lists (use [] for none) and an optional default_workflow identifier.");
  const rows = (kind: "workflows" | "steps", values: unknown[]): DefinitionCatalogEntry[] => values.map(value => {
    // the path names the file and so the ID; an omitted required flag means false, a present one must be true or false
    if (!record(value) || !(exact(value, ["path", "summary"]) || exact(value, ["path", "summary", "required"])) ||
      typeof value.path !== "string" || typeof value.summary !== "string" || Object.hasOwn(value, "required") && typeof value.required !== "boolean")
      throw new Error(`Each ${kind} entry needs exactly path, summary and optional required (true or false).`);
    return {path: value.path, summary: value.summary, required: value.required === true};
  });
  const parsed = normalizeProjectConfiguration({workflows: rows("workflows", config.workflows), steps: rows("steps", config.steps),
    ...(config.default_workflow === undefined ? {} : {default_workflow: config.default_workflow as string})});
  const problem = projectConfigurationError(parsed);
  if (problem) throw new Error(problem);
  return parsed;
};
// the authored project.yaml: yaml decoded to an unknown value, then to the index whose entries' required flags are the only authored requirements
export const ProjectConfigurationSource = DefinitionYaml.pipe(Schema.decodeTo(ProjectConfigurationInfo, validated<typeof ProjectConfigurationInfo.Encoded, unknown>(projectConfigurationFromYaml)));

/** A definition file's own content; the summary comes from its project.yaml entry. */
const ParsedStep = Schema.Struct({id: Schema.String, name: Schema.String, description: Schema.String, references: Schema.optionalKey(SupportingReferences), skills: Schema.optionalKey(SupportingSkills)});
const ParsedWorkflow = Schema.Struct({id: Schema.String, name: Schema.String, description: Schema.String, fixed: Schema.Boolean,
  references: Schema.optionalKey(SupportingReferences), skills: Schema.optionalKey(SupportingSkills), sequence: Schema.optionalKey(Schema.Array(DefinitionNode)), parallel: Schema.optionalKey(Schema.Array(DefinitionNode))});
type ParsedStep = typeof ParsedStep.Type;
type ParsedWorkflow = typeof ParsedWorkflow.Type;
const StepDocument = Schema.Struct({frontmatter: Schema.String, body: Schema.String});
const StepMetadata = Schema.Struct({metadata: Schema.Unknown, body: Schema.String});

// a step markdown file: the filename id is checked first, then its yaml frontmatter is decoded and validated, and the body must stay empty
export const definitionStepSource = (id: string) => Schema.String.pipe(
  Schema.decodeTo(StepDocument, validated<typeof StepDocument.Type, string>(contents => {
    contents = contents.replace(/^﻿/, "");
    if (!definitionId.test(id)) throw new Error("Invalid step filename.");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    if (!frontmatter) throw new Error("Step needs YAML frontmatter containing id, name and description.");
    return {frontmatter: frontmatter[1]!, body: contents.slice(frontmatter[0].length)};
  })),
  Schema.decodeTo(StepMetadata, validated<typeof StepMetadata.Type, typeof StepDocument.Type>(document => ({metadata: parseYaml(document.frontmatter), body: document.body}))),
  Schema.decodeTo(ParsedStep, validated<ParsedStep, typeof StepMetadata.Type>(({metadata, body}) => {
    if (!record(metadata) || !withOptionalGuidance(metadata, ["id", "name", "description"]) || metadata.id !== id || !definitionName(metadata.name) || !text(metadata.description))
      throw new Error("Step frontmatter needs a matching id, name, nonempty description and optional references and skills lists.");
    checkGuidance(metadata, "Step");
    if (body.trim() !== "") throw new Error("Step body must be empty; keep all guidance in description.");
    return {id, name: metadata.name.trim(), description: metadata.description.trim(), ...definitionGuidanceFields(metadata as DefinitionGuidance)};
  })),
);

const parseNode = (value: unknown, depth: number, budget: {count: number}): DefinitionNode => {
  if (depth > workflowDefinitionExpansionLimits.maxDepth || ++budget.count > workflowDefinitionExpansionLimits.maxNodes)
    throw new Error("Workflow structure exceeds the nesting or expanded-node limit.");
  if (!record(value) || Object.keys(value).length !== 1) throw new Error("Each workflow node must contain exactly one step, workflow, sequence or parallel key.");
  if (Object.hasOwn(value, "step")) {
    if (typeof value.step === "string" && definitionId.test(value.step)) return {step: value.step};
    if (record(value.step) && withOptionalGuidance(value.step, ["id", "name", "description"]) && typeof value.step.id === "string" &&
      definitionId.test(value.step.id) && definitionName(value.step.name) && text(value.step.description)) {
      checkGuidance(value.step, `Local step ${value.step.id}`);
      return {step: {id: value.step.id, name: value.step.name.trim(), description: value.step.description.trim(), ...definitionGuidanceFields(value.step as DefinitionGuidance)}};
    }
    throw new Error("step must name a reusable step or define a local step with id, name, description and optional references and skills lists.");
  }
  if (Object.hasOwn(value, "workflow")) {
    if (typeof value.workflow === "string" && definitionId.test(value.workflow)) return {workflow: value.workflow};
    throw new Error("workflow must name a reusable workflow identifier.");
  }
  const key = Object.hasOwn(value, "sequence") ? "sequence" : "parallel";
  const children = value[key];
  if (!Array.isArray(children) || children.length === 0) throw new Error(`${key} must contain at least one workflow node.`);
  return key === "sequence"
    ? {sequence: children.map(child => parseNode(child, depth + 1, budget))}
    : {parallel: children.map(child => parseNode(child, depth + 1, budget))};
};

const collectLocalStepIds = (nodes: readonly DefinitionNode[], into: string[] = []): string[] => {
  for (const node of nodes) {
    if ("step" in node && typeof node.step !== "string") into.push(node.step.id);
    else if ("sequence" in node) collectLocalStepIds(node.sequence, into);
    else if ("parallel" in node) collectLocalStepIds(node.parallel, into);
  }
  return into;
};

// a workflow yaml file: the filename id is checked first, then the yaml is decoded and its node tree validated within the expansion limits
export const definitionWorkflowSource = (id: string) => Schema.String.pipe(
  Schema.decodeTo(Schema.String, validated<string, string>(contents => {
    if (!definitionId.test(id)) throw new Error("Invalid workflow filename.");
    return contents.replace(/^﻿/, "");
  })),
  Schema.decodeTo(Schema.Unknown, yaml),
  Schema.decodeTo(ParsedWorkflow, validated<ParsedWorkflow, unknown>(metadata => {
    const hasSequence = record(metadata) && Object.hasOwn(metadata, "sequence");
    const hasParallel = record(metadata) && Object.hasOwn(metadata, "parallel");
    const fields = ["name", "description", ...(record(metadata) && Object.hasOwn(metadata, "fixed") ? ["fixed"] : []), ...(hasSequence ? ["sequence"] : []), ...(hasParallel ? ["parallel"] : [])];
    if (!record(metadata) || !withOptionalGuidance(metadata, fields) || hasSequence === hasParallel || !definitionName(metadata.name) || !text(metadata.description) ||
      metadata.fixed !== undefined && typeof metadata.fixed !== "boolean")
      throw new Error("A workflow needs name, description, optional fixed, references and skills lists, and exactly one root sequence or parallel group.");
    checkGuidance(metadata, "Workflow");
    const root = hasSequence ? parseNode({sequence: metadata.sequence}, 0, {count: 0}) : parseNode({parallel: metadata.parallel}, 0, {count: 0});
    const nodes = hasSequence ? (root as {sequence: readonly DefinitionNode[]}).sequence : (root as {parallel: readonly DefinitionNode[]}).parallel;
    const localIds = collectLocalStepIds(nodes);
    if (new Set(localIds).size !== localIds.length) throw new Error("Local step identifiers must be unique within a workflow.");
    return {id, name: metadata.name.trim(), description: metadata.description.trim(), fixed: metadata.fixed === true,
      ...definitionGuidanceFields(metadata as DefinitionGuidance),
      ...(hasSequence ? {sequence: (root as {sequence: readonly DefinitionNode[]}).sequence} : {parallel: (root as {parallel: readonly DefinitionNode[]}).parallel})};
  })),
);

// the first fixed message along the issue chain; transformation issues sit below the encoding nodes of each decode stage
const sourceProblem = (issue: SchemaIssue.Issue): string | undefined => {
  switch (issue._tag) {
    case "Encoding": case "Pointer": case "Filter": return sourceProblem(issue.issue);
    case "Composite": case "AnyOf": return issue.issues[0] ? sourceProblem(issue.issues[0]) : undefined;
    case "InvalidValue": case "Forbidden": return typeof issue.annotations?.message === "string" ? issue.annotations.message : undefined;
    default: return undefined;
  }
};
type SourceSchema<A> = Schema.Codec<A, string>;
// decodes an authored source; the failure carries the validator's exact message
export const decodeDefinitionSource = <A>(schema: SourceSchema<A>, contents: string): Effect.Effect<A, DefinitionSourceInvalid> =>
  SchemaParser.decodeUnknownEffect(schema)(contents).pipe(Effect.mapError(issue => new DefinitionSourceInvalid({problem: sourceProblem(issue)})));
const decodeSourceSync = <A>(schema: SourceSchema<A>, contents: string, fallback: string): A => {
  const exit = SchemaParser.decodeUnknownExit(schema)(contents);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = exit.cause.reasons.find(reason => reason._tag === "Fail");
  throw new Error((failure && SchemaIssue.isIssue(failure.error) ? sourceProblem(failure.error) : undefined) ?? fallback);
};

/** Parses the index of reusable definitions; its entries' required flags are the only authored requirements. */
export const parseProjectConfiguration = (contents: string): ProjectConfigurationInfo =>
  decodeSourceSync(ProjectConfigurationSource, contents, "project.yaml is invalid.");
export const parseDefinitionStep = (id: string, contents: string): ParsedStep => decodeSourceSync(definitionStepSource(id), contents, "The steps definition is invalid.");
export const parseDefinitionWorkflow = (id: string, contents: string): ParsedWorkflow =>
  decodeSourceSync(definitionWorkflowSource(id), contents, "The workflows definition is invalid.");

const namespaceGlobal = (global: DefinitionScopeRead, project: DefinitionScopeRead, globalDefinitionsPath: string): DefinitionScopeRead => {
  const usedSteps = new Set(project.steps.map(step => step.id));
  const usedWorkflows = new Set(project.workflows.map(workflow => workflow.id));
  const knownSteps = new Set(global.steps.map(step => step.sourceId ?? step.id));
  const knownWorkflows = new Set(global.workflows.map(workflow => workflow.sourceId ?? workflow.id));
  const report = (path: string, code: string, message: string) => global.issues.push({path, code, message});
  const stepRefs = new Set<string>(global.steps.map(step => step.sourceId ?? step.id));
  const workflowRefs = new Set<string>(global.workflows.map(workflow => workflow.sourceId ?? workflow.id));
  // every indexed row is namespaced, so a missing or invalid one keeps its row and required flag
  for (const entry of global.config.steps) {
    stepRefs.add(entry.sourceId);
    if (entry.required && !knownSteps.has(entry.sourceId)) report(`${globalDefinitionsPath}/project.yaml`, "required_step_missing", `Required global step ${entry.sourceId} is missing or invalid.`);
  }
  for (const entry of global.config.workflows) {
    workflowRefs.add(entry.sourceId);
    if (entry.required && !knownWorkflows.has(entry.sourceId)) report(`${globalDefinitionsPath}/project.yaml`, "required_workflow_missing", `Required global workflow ${entry.sourceId} is missing or invalid.`);
  }
  if (global.config.default_workflow) workflowRefs.add(global.config.default_workflow);
  if (global.config.default_workflow && !knownWorkflows.has(global.config.default_workflow))
    report(`${globalDefinitionsPath}/project.yaml`, "default_workflow_missing", `Default global workflow ${global.config.default_workflow} is missing or invalid.`);
  const collectReferences = (nodes: readonly DefinitionNode[]) => {
    for (const node of nodes) {
      if ("step" in node && typeof node.step === "string") {
        stepRefs.add(node.step);
        if (!knownSteps.has(node.step)) report("", "workflow_step_missing", `A global workflow references missing or invalid step ${node.step}.`);
      } else if ("workflow" in node) {
        workflowRefs.add(node.workflow);
        if (!knownWorkflows.has(node.workflow)) report("", "workflow_reference_missing", `A global workflow references missing or invalid workflow ${node.workflow}.`);
      }
      else if ("sequence" in node) collectReferences(node.sequence);
      else if ("parallel" in node) collectReferences(node.parallel);
    }
  };
  for (const workflow of global.workflows) {
    const before = global.issues.length;
    collectReferences(workflow.sequence ?? workflow.parallel ?? []);
    for (let index = before; index < global.issues.length; index++) if (!global.issues[index]!.path) global.issues[index] = {...global.issues[index]!, path: workflow.path ?? globalDefinitionsPath};
  }
  const makeMap = (ids: Set<string>, used: Set<string>, namespace: string) => {
    const map = new Map<string, string>();
    for (const sourceId of [...ids].sort()) {
      let counter = 0;
      let id: string;
      do {id = `g${createHash("sha256").update(`${namespace}\0${sourceId}\0${counter++}`).digest("hex").slice(0, 63)}`;}
      while (used.has(id));
      used.add(id);
      map.set(sourceId, id);
    }
    return map;
  };
  const stepMap = makeMap(stepRefs, usedSteps, "global-step");
  const workflowMap = makeMap(workflowRefs, usedWorkflows, "global-workflow");
  const rewriteNode = (node: DefinitionNode): DefinitionNode => {
    if ("step" in node) return typeof node.step === "string" ? {step: stepMap.get(node.step)!} : node;
    if ("workflow" in node) return {workflow: workflowMap.get(node.workflow)!};
    if ("sequence" in node) return {sequence: node.sequence.map(rewriteNode)};
    return {parallel: node.parallel.map(rewriteNode)};
  };
  global.steps = global.steps.map(step => ({...step, id: stepMap.get(step.sourceId ?? step.id)!}));
  global.workflows = global.workflows.map(workflow => ({
    ...workflow,
    id: workflowMap.get(workflow.sourceId ?? workflow.id)!,
    ...(workflow.sequence ? {sequence: workflow.sequence.map(rewriteNode)} : {}),
    ...(workflow.parallel ? {parallel: workflow.parallel.map(rewriteNode)} : {}),
  }));
  global.config = {
    workflows: global.config.workflows.map(entry => ({...entry, id: workflowMap.get(entry.sourceId)!})),
    steps: global.config.steps.map(entry => ({...entry, id: stepMap.get(entry.sourceId)!})),
    ...(global.config.default_workflow ? {default_workflow: workflowMap.get(global.config.default_workflow)!} : {}),
  };
  return global;
};

const fingerprintGlobalScope = (scope: DefinitionScopeRead, globalDefinitionsPath: string): string | null => {
  if (!scope.complete || scope.status === "unavailable" || scope.status === "permission_required") return null;
  return createHash("sha256").update(JSON.stringify([globalDefinitionsPath, scope.status, scope.inputs])).digest("hex");
};

// cross-file references, cycles and static expansion bounds of the merged collection
const reportWorkflowGraph = (result: MutableSnapshot, projectScope: DefinitionScopeRead, issue: (path: string, code: string, message: string) => void) => {
  const stepsById = new Map(result.steps.map(step => [step.id, step]));
  const workflowsById = new Map(result.workflows.map(workflow => [workflow.id, workflow]));
  for (const entry of projectScope.config.steps) if (entry.required && !stepsById.has(entry.id))
    issue(projectConfigPath, "required_step_missing", `Required step ${entry.id} is missing or invalid.`);
  for (const entry of projectScope.config.workflows) if (entry.required && !workflowsById.has(entry.id))
    issue(projectConfigPath, "required_workflow_missing", `Required workflow ${entry.id} is missing or invalid.`);
  if (projectScope.projectConfig?.default_workflow && !workflowsById.has(projectScope.projectConfig.default_workflow))
    issue(projectConfigPath, "default_workflow_missing", `Default workflow ${result.config.default_workflow} is missing or invalid.`);
  const nodeReferences = (nodes: readonly DefinitionNode[], workflow: DefinitionWorkflowInfo): string[] => {
    const refs: string[] = [];
    for (const node of nodes) {
      if ("step" in node && typeof node.step === "string") {
        if (workflow.origin !== "global" && !stepsById.has(node.step)) issue(workflow.path ?? ".t3-supervisor/workflows", "workflow_step_missing", `Workflow ${workflow.sourceId ?? workflow.id} references missing or invalid step ${node.step}.`);
      } else if ("workflow" in node) refs.push(node.workflow);
      else if ("sequence" in node) refs.push(...nodeReferences(node.sequence, workflow));
      else if ("parallel" in node) refs.push(...nodeReferences(node.parallel, workflow));
    }
    return refs;
  };
  const workflowEdges = new Map<string, string[]>();
  for (const workflow of result.workflows) {
    const refs = nodeReferences(workflow.sequence ?? workflow.parallel ?? [], workflow);
    for (const ref of refs) if (workflow.origin !== "global" && !workflowsById.has(ref))
      issue(workflow.path ?? ".t3-supervisor/workflows", "workflow_reference_missing", `Workflow ${workflow.sourceId ?? workflow.id} references missing or invalid workflow ${ref}.`);
    workflowEdges.set(workflow.id, refs.filter(ref => workflowsById.has(ref)));
  }
  const states = new Map<string, "visiting" | "visited">();
  const chain: string[] = [];
  const reportedCycles = new Set<string>();
  const cyclicWorkflowIds = new Set<string>();
  const visit = (id: string) => {
    const state = states.get(id);
    if (state === "visited") return;
    states.set(id, "visiting");
    chain.push(id);
    for (const next of workflowEdges.get(id) ?? []) {
      if (states.get(next) === "visiting") {
        const start = chain.indexOf(next);
        const cycleIds = [...chain.slice(start), next];
        for (const cycleId of cycleIds.slice(0, -1)) cyclicWorkflowIds.add(cycleId);
        const cycleLabels = cycleIds.slice(0, -1).map(item => workflowsById.get(item)?.sourceId ?? item);
        const cycleKey = cycleLabels.map((_item, index) => [...cycleLabels.slice(index), ...cycleLabels.slice(0, index)].join("\0")).sort()[0]!;
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          const names = cycleIds.map(item => workflowsById.get(item)?.sourceId ?? item);
          issue(workflowsById.get(id)?.path ?? ".t3-supervisor/workflows", "workflow_cycle", `Workflow reference cycle: ${names.join(" -> ")}.`);
        }
      } else visit(next);
    }
    chain.pop();
    states.set(id, "visited");
  };
  for (const workflow of result.workflows) visit(workflow.id);
  const workflowsReachingCycles = new Set(cyclicWorkflowIds);
  let reachesAnotherCycle = true;
  while (reachesAnotherCycle) {
    reachesAnotherCycle = false;
    for (const [id, targets] of workflowEdges) {
      if (!workflowsReachingCycles.has(id) && targets.some(target => workflowsReachingCycles.has(target))) {
        workflowsReachingCycles.add(id);
        reachesAnotherCycle = true;
      }
    }
  }
  type ExpansionSummary = {nodes: number; depth: number; cyclic: boolean};
  const summaries = new Map<string, ExpansionSummary>();
  const maxExpandedNodes = workflowDefinitionExpansionLimits.maxNodes;
  const maxExpansionDepth = workflowDefinitionExpansionLimits.maxDepth;
  const workflowRootMemberDepth = 3; // root reference, expanded definition group, then its first member
  const boundedAdd = (left: number, right: number) => Math.min(maxExpandedNodes + 1, left + right);
  const summarizeNodes = (nodes: readonly DefinitionNode[], depth: number, stack: ReadonlySet<string>): ExpansionSummary => {
    let count = 0;
    let deepest = 0;
    let cyclic = false;
    for (const node of nodes) {
      count = boundedAdd(count, 1);
      deepest = Math.max(deepest, depth);
      let child: ExpansionSummary | null = null;
      if ("sequence" in node) child = summarizeNodes(node.sequence, depth + 1, stack);
      else if ("parallel" in node) child = summarizeNodes(node.parallel, depth + 1, stack);
      else if ("workflow" in node) child = summarizeWorkflow(node.workflow, stack);
      if (child) {
        count = boundedAdd(count, child.nodes);
        deepest = Math.max(deepest, child.depth === 0 ? 0 : child.depth + ("workflow" in node ? depth - 1 : 0));
        cyclic ||= child.cyclic;
      }
    }
    return {nodes: count, depth: deepest, cyclic};
  };
  const summarizeWorkflow = (id: string, stack: ReadonlySet<string>): ExpansionSummary => {
    if (stack.has(id)) return {nodes: 0, depth: 0, cyclic: true};
    const cached = summaries.get(id);
    if (cached) return cached;
    const workflow = workflowsById.get(id);
    if (!workflow) return {nodes: 0, depth: 0, cyclic: false};
    const nextStack = new Set(stack);
    nextStack.add(id);
    const summary = summarizeNodes(workflow.sequence ?? workflow.parallel ?? [], workflowRootMemberDepth, nextStack);
    if (!summary.cyclic) summaries.set(id, summary);
    return summary;
  };
  for (const workflow of result.workflows) {
    if (workflowsReachingCycles.has(workflow.id)) continue;
    const summary = summarizeWorkflow(workflow.id, new Set());
    if (summary.nodes > maxExpandedNodes)
      issue(workflow.path ?? ".t3-supervisor/workflows", "workflow_expansion_limit",
        `Expanding workflow ${workflow.sourceId ?? workflow.id} exceeds the ${maxExpandedNodes}-node bound.`);
    if (summary.depth > maxExpansionDepth)
      issue(workflow.path ?? ".t3-supervisor/workflows", "workflow_expansion_depth",
        `Expanding workflow ${workflow.sourceId ?? workflow.id} exceeds the ${maxExpansionDepth}-level bound.`);
  }
};

const makeProjectDefinitions = Effect.fnUntraced(function* (sources: ProjectDefinitionSources) {
  const {source, t3, files} = sources;
  const options = sources.options ?? {};
  const globalRoot = options.globalRoot === undefined ? null : options.globalRoot;
  const globalHomePath = globalRoot ?? "~";
  const globalDefinitionsPath = posix.join(globalHomePath, ".t3-supervisor");
  // setup is serialized per root; a key is leased by each setup and released when its last holder ends
  const setupLocks = yield* RcMap.make({lookup: (_key: string) => Semaphore.make(1)});
  const serialSetup = <A, E>(key: string, work: Effect.Effect<A, E>) => Effect.scoped(Effect.flatMap(RcMap.get(setupLocks, key), lock => lock.withPermit(work)));

  // methods are read on every call, so a replaced client method takes effect as it did in the baseline
  const directoryExists = (root: string) => withOperationCancel(cancel => files.directoryExists(root, cancel));
  const list = (root: string, path: string) => withOperationCancel(cancel => files.list(root, path, cancel));
  const read = (root: string, path: string) => withOperationCancel(cancel => files.read(root, path, cancel));
  const vcsInfo = (root: string) => withOperationCancel(cancel => files.vcsInfo!(root, cancel));
  const readCatalog = boundedRead(() => source.catalog());
  const readProjection = (threadId: string) => boundedRead(() => t3.projection(threadId));

  // a store read's failure or defect is a definition source failure, as a throwing callback was
  const sourceRead = <A, E>(read: Effect.Effect<A, E>): Effect.Effect<A, DefinitionSourceFailure> => Effect.catchCause(read, (cause) => Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause as Cause.Cause<never>) : Effect.fail(new DefinitionSourceFailure({error: Cause.squash(cause)})));
  const isScratchProject = (projectId: string, registeredWorkspaceRoot: string) => {
    if (options.isScratchProject) return sourceRead(Effect.suspend(() => options.isScratchProject!(projectId, registeredWorkspaceRoot)));
    const managedRoot = options.managedScratchRoot;
    return Effect.succeed(Boolean(managedRoot && posix.isAbsolute(managedRoot) && posix.isAbsolute(registeredWorkspaceRoot) &&
      posix.normalize(managedRoot) === posix.normalize(registeredWorkspaceRoot)));
  };
  const globalEnabled = (projectId: string) => globalRoot === null || !options.useGlobalDefinitions ? Effect.succeed(false)
    : sourceRead(Effect.suspend(() => options.useGlobalDefinitions!(projectId)));

  const currentWorkspace = Effect.fnUntraced(function* (projectId: string, threadId: string | null) {
    const catalog = yield* readCatalog;
    const project = catalog.projects.find(p => p.project.id === projectId && p.available);
    if (!project) return null;
    let root = project.project.workspaceRoot;
    if (threadId !== null) {
      const thread = (yield* readProjection(threadId)).projection.thread;
      if (thread.id !== threadId || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt || thread.worktreePath === undefined) return null;
      if (thread.worktreePath !== null) {
        if (!text(thread.worktreePath, 4096)) return null;
        root = thread.worktreePath;
      }
    }
    return text(root, 4096) && posix.isAbsolute(root) && !root.includes("\0") && !root.includes("\\") ? posix.normalize(root) : null;
  });

  const scopePresence = (root: string, global: boolean): Effect.Effect<DefinitionPresence> => Effect.gen(function* (): Effect.fn.Return<DefinitionPresence, DefinitionSourceFailure> {
    if (!(yield* directoryExists(root))) return {status: "unavailable", message: "The selected T3 workspace directory is unavailable."};
    const entries = yield* list(root, ".t3-supervisor");
    if (entries.truncated) return {status: "unavailable", message: "The definition folder listing is incomplete."};
    return {status: "present"};
  }).pipe(Effect.catch(failure => Effect.succeed<DefinitionPresence>(fileFailure(failure) === "missing" ? {status: "missing"} : {status: "unavailable",
    message: fileFailure(failure) === "permission_required" ? failureMessage(failure, "")
      : `The ${global ? "T3 server-home" : "project"} definition folder could not be checked safely.`})));

  const presenceGlobal: Effect.Effect<GlobalDefinitionPresence> = globalRoot
    ? Effect.map(scopePresence(globalRoot, true), presence => ({...presence, path: globalDefinitionsPath}))
    : Effect.succeed({status: "unavailable", path: globalDefinitionsPath, message: "The T3 server-home root is not configured."});

  const presenceForCheckout = (projectId: string, threadId: string | null): Effect.Effect<DefinitionPresence> => Effect.gen(function* (): Effect.fn.Return<DefinitionPresence, DefinitionSourceFailure> {
    const catalog = yield* readCatalog;
    const project = catalog.projects.find(item => item.project.id === projectId && item.available);
    if (!project) return {status: "unavailable", message: "Select an available registered project."};
    if (yield* isScratchProject(projectId, project.project.workspaceRoot)) {
      if (!globalRoot) return {status: "unavailable", message: "The T3 server-home root is not configured."};
      return yield* scopePresence(globalRoot, true);
    }
    const root = yield* currentWorkspace(projectId, threadId);
    return root ? yield* scopePresence(root, false) : {status: "unavailable", message: "The selected conversation checkout is unavailable."};
  }).pipe(Effect.catch(() => Effect.succeed<DefinitionPresence>({status: "unavailable", message: "The selected T3 workspace could not be checked."})));

  const readScope = Effect.fnUntraced(function* (root: string, origin: DefinitionOrigin, budget: {value: number; files: number}) {
    const scope: DefinitionScopeRead = {status: "unavailable", complete: false, steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: null,
      definitionFiles: [], sources: [], issues: [], inputs: []};
    const base = origin === "global" ? globalDefinitionsPath : ".t3-supervisor";
    const showPath = (path: string) => path === "" ? base : `${base}/${path.replace(/^\.t3-supervisor\//, "")}`;
    const issue = (path: string, code: string, message: string) => scope.issues.push({path, code, message});
    const markIncomplete = () => {scope.complete = false;};
    let permissionRequired = false;
    let unavailable = false;
    const noteReadFailure = (failure: DefinitionSourceFailure | DefinitionReadLimit) => {
      const code = fileFailure(failure);
      if (code === "permission_required") permissionRequired = true;
      else if (code !== null && code !== "invalid_file" && code !== "missing") unavailable = true;
    };
    const readSource = Effect.fnUntraced(function* (path: string) {
      const safeChild = /^\.t3-supervisor\/(?:steps|workflows)\/[^/\\\0]+$/.test(path) && ![".", ".."].includes(path.slice(path.lastIndexOf("/") + 1));
      if (path !== projectConfigPath && !safeChild) return yield* new DefinitionSourceFailure({error: new Error("Definition source paths must stay within project.yaml, steps/ or workflows/.")});
      const file = yield* read(root, path);
      scope.inputs.push([path, file]);
      budget.value += file.byteLength;
      if (budget.value > MAX_TOTAL_BYTES) return yield* new DefinitionReadLimit({message: "Definition sources exceed the 512 KiB combined limit."});
      if (file.truncated || file.byteLength > MAX_FILE_BYTES || (Buffer.byteLength(file.contents, "utf8") !== file.byteLength && Buffer.byteLength(file.contents, "utf8") + 3 !== file.byteLength))
        return yield* new DefinitionReadLimit({message: "Definition sources must be complete, at most 64 KiB each and 512 KiB combined."});
      scope.sources.push({path: showPath(path), content: file.contents, origin});
      return file.contents;
    });
    const readDefinitions = Effect.fnUntraced(function* (kind: "steps" | "workflows", entries: ReadonlyArray<{path: string; kind: "file" | "directory"}>) {
      const directoryPath = `.t3-supervisor/${kind}`;
      const directory = entries.find(entry => entry.path === directoryPath);
      // the index is authoritative: an indexed entry without its file stays, with its required flag, as a diagnosed gap
      const reportMissing = (found: ReadonlySet<string>) => {
        for (const entry of scope.projectConfig?.[kind] ?? []) if (!found.has(entry.path))
          issue(showPath(`.t3-supervisor/${entry.path}`), "catalog_entry_missing", `project.yaml indexes ${entry.path}, but that file does not exist.`);
      };
      if (!directory) {
        issue(showPath(directoryPath), `${kind}_directory_missing`, `Add the ${kind}/ directory to the definition folder.`);
        reportMissing(new Set());
        return;
      }
      if (directory.kind !== "directory") {
        markIncomplete();
        issue(showPath(directoryPath), `${kind}_directory_invalid`, `${kind}/ must be a directory.`);
        return;
      }
      const listed = yield* Effect.result(list(root, directoryPath));
      if (Result.isFailure(listed)) {
        markIncomplete();
        noteReadFailure(listed.failure);
        issue(showPath(directoryPath), `${kind}_listing_unavailable`, failureMessage(listed.failure, `The ${kind}/ directory could not be listed.`));
        return;
      }
      const collection = listed.success;
      scope.inputs.push([`${kind}-listing`, {...collection, entries: [...collection.entries].sort((a, b) => a.path.localeCompare(b.path))}]);
      if (collection.truncated || new Set(collection.entries.map(entry => entry.path)).size !== collection.entries.length) {
        markIncomplete();
        issue(showPath(directoryPath), `${kind}_listing_incomplete`, `The ${kind}/ listing is truncated or contains duplicate paths.`);
      }
      const files = [...collection.entries].filter(entry => entry.kind === "file" && entry.path !== `${directoryPath}/.gitkeep` &&
        entry.path !== `${directoryPath}/.DS_Store`)
        .sort((a, b) => a.path.localeCompare(b.path));
      const directChild = (candidate: string) => {
        const prefix = `${directoryPath}/`;
        if (!candidate.startsWith(prefix)) return false;
        const name = candidate.slice(prefix.length);
        return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("\0") && name !== "." && name !== "..";
      };
      const namesByCase = new Map<string, string[]>();
      for (const entry of files) {
        const name = entry.path.slice(directoryPath.length + 1).toLowerCase();
        namesByCase.set(name, [...(namesByCase.get(name) ?? []), entry.path]);
      }
      for (const names of namesByCase.values()) if (names.length > 1)
        for (const name of names) issue(showPath(name), `${kind}_case_collision`, `${kind}/ contains filenames that differ only by letter case: ${names.join(", ")}.`);
      if (collection.entries.some(entry => entry.kind === "directory")) {
        issue(showPath(directoryPath), `${kind}_nested_directory`, `${kind}/ definitions must be direct files.`);
      }
      for (const entry of files) {
        if (!directChild(entry.path)) {
          markIncomplete();
          issue(showPath(directoryPath), `${kind}_path_invalid`, `${kind}/ listings must contain direct child paths only.`);
          continue;
        }
        const match = kind === "steps"
          ? /^\.t3-supervisor\/steps\/([a-z0-9][a-z0-9_-]{0,63})\.md$/.exec(entry.path)
          : /^\.t3-supervisor\/workflows\/([a-z0-9][a-z0-9_-]{0,63})\.yaml$/.exec(entry.path);
        if (!match) {
          issue(showPath(entry.path), `${kind}_path_invalid`, kind === "steps"
            ? "Steps must be direct lowercase Markdown files named with simple identifiers. Unsupported files are reported but not read."
            : "Workflows must be direct lowercase YAML files named with simple identifiers. Unsupported files are reported but not read.");
          continue;
        }
        const id = match[1]!;
        const relative = `${kind}/${entry.path.slice(directoryPath.length + 1)}`;
        scope.definitionFiles.push({origin, kind, id, path: relative});
        // only indexed files are reusable definitions; an unreadable index reads none, and an unlisted file is reported unread
        const indexed = scope.projectConfig?.[kind].find(row => row.path === relative);
        if (!scope.projectConfig) continue;
        if (!indexed) {
          issue(showPath(entry.path), "definition_unlisted", `${entry.path.slice(directoryPath.length + 1)} is not indexed in project.yaml, so it is not loaded. Index its path with a summary, or remove it.`);
          continue;
        }
        budget.files++;
        if (budget.files > MAX_FILES) {
          issue(showPath(entry.path), "definition_file_limit", "The active scopes exceed the 100 definition-file limit.");
          markIncomplete();
          continue;
        }
        const contents = yield* Effect.result(readSource(entry.path));
        if (Result.isFailure(contents)) {
          markIncomplete();
          noteReadFailure(contents.failure);
          issue(showPath(entry.path), "definition_source_unreadable", failureMessage(contents.failure, "The definition source could not be read."));
          continue;
        }
        if (kind === "steps") {
          const value = yield* Effect.result(decodeDefinitionSource(definitionStepSource(id), contents.success));
          if (Result.isFailure(value)) issue(showPath(entry.path), `${kind}_invalid`, value.failure.problem ?? `The ${kind} definition is invalid.`);
          else scope.steps.push({...value.success, summary: indexed.summary, origin, path: showPath(entry.path), sourceId: id});
        } else {
          const value = yield* Effect.result(decodeDefinitionSource(definitionWorkflowSource(id), contents.success));
          if (Result.isFailure(value)) issue(showPath(entry.path), `${kind}_invalid`, value.failure.problem ?? `The ${kind} definition is invalid.`);
          else scope.workflows.push({...value.success, summary: indexed.summary, origin, path: showPath(entry.path), sourceId: id});
        }
      }
      if (!collection.truncated) reportMissing(new Set(scope.definitionFiles.filter(file => file.kind === kind).map(file => file.path)));
    });
    yield* Effect.gen(function* () {
      if (!(yield* directoryExists(root))) {
        scope.inputs.push(["root", "missing"]);
        scope.status = "unavailable";
        scope.complete = false;
        issue(base, origin === "project" ? "workspace_missing" : "global_home_unavailable", origin === "project"
          ? "The selected T3 workspace directory is unavailable."
          : "The T3 server user's home directory is unavailable.");
        return;
      }
      if (origin === "project" && !(yield* directoryExists(posix.join(root, ".t3-supervisor")))) {
        scope.inputs.push(["folder", false]);
        scope.status = "missing";
        scope.complete = true;
        return;
      }
      const listing = yield* list(root, ".t3-supervisor").pipe(Effect.catchIf(failure => fileFailure(failure) === "missing", () => Effect.succeed(null)));
      if (listing === null) {
        scope.inputs.push(["folder", false]);
        scope.status = "missing";
        scope.complete = true;
        if (origin === "global") issue(base, "global_definitions_missing", "The enabled global .t3-supervisor folder is missing; shared requirements remain unknown.");
        return;
      }
      scope.inputs.push(["folder", true], ["listing", {...listing, entries: [...listing.entries].sort((a, b) => a.path.localeCompare(b.path))}]);
      scope.complete = !listing.truncated && new Set(listing.entries.map(entry => entry.path)).size === listing.entries.length;
      scope.status = "ready";
      if (listing.truncated) issue(base, "listing_truncated", "The definition folder listing is incomplete.");
      if (new Set(listing.entries.map(entry => entry.path)).size !== listing.entries.length) issue(base, "listing_duplicate", "The definition folder listing contains duplicate paths.");
      if (!scope.complete) markIncomplete();

      const entries = [...listing.entries].sort((a, b) => a.path.localeCompare(b.path));
      const configEntry = entries.find(entry => entry.path === projectConfigPath);
      for (const entry of entries) {
        if ([projectConfigPath, ".t3-supervisor/steps", ".t3-supervisor/workflows", ".t3-supervisor/.DS_Store"].includes(entry.path)) continue;
        if ([".t3-supervisor/rules.yaml", ".t3-supervisor/blocks"].includes(entry.path))
          issue(showPath(entry.path), "legacy_definition_format", "The old rules.yaml/blocks format is not loaded. Replace it with project.yaml, steps/ and workflows/; an empty index is workflows: [] and steps: [].");
        else issue(base, "unexpected_definition_entry", "Only project.yaml, steps/ and workflows/ belong in the definition folder. Unexpected entries are reported but not read.");
      }
      if (configEntry?.kind === "file") {
        budget.files++;
        if (budget.files > MAX_FILES) {
          issue(showPath(projectConfigPath), "definition_file_limit", "The active scopes exceed the 100 definition-file limit.");
          markIncomplete();
        } else {
          const contents = yield* Effect.result(readSource(projectConfigPath));
          if (Result.isFailure(contents)) {
            markIncomplete();
            noteReadFailure(contents.failure);
            issue(showPath(projectConfigPath), "definition_source_unreadable", failureMessage(contents.failure, "project.yaml could not be read."));
          } else {
            const decoded = yield* Effect.result(decodeDefinitionSource(ProjectConfigurationSource, contents.success));
            if (Result.isFailure(decoded)) issue(showPath(projectConfigPath), "project_configuration_invalid", decoded.failure.problem ?? "project.yaml is invalid.");
            else {
              const index = scope.projectConfig = decoded.success;
              const rows = (kind: "workflows" | "steps", entries: readonly DefinitionCatalogEntry[]) => entries.map(entry => {
                const id = catalogEntryId(kind, entry.path)!;
                return {id, ...entry, origin, sourceId: id};
              });
              scope.config = {workflows: rows("workflows", index.workflows), steps: rows("steps", index.steps),
                ...(index.default_workflow ? {default_workflow: index.default_workflow} : {})};
            }
          }
        }
      } else {
        if (configEntry) markIncomplete();
        issue(showPath(projectConfigPath), configEntry ? "project_configuration_invalid_path" : "configuration_missing",
          configEntry ? "project.yaml must be a regular file." : "Add project.yaml indexing the workflows and steps; an empty index is workflows: [] and steps: [].");
      }

      yield* readDefinitions("steps", entries);
      yield* readDefinitions("workflows", entries);
      scope.status = permissionRequired ? "permission_required" : unavailable ? "unavailable" : scope.issues.length ? "invalid" : "ready";
    }).pipe(Effect.catch(failure => Effect.sync(() => {
      const permission = fileFailure(failure) === "permission_required";
      scope.status = permission ? "permission_required" : "unavailable";
      markIncomplete();
      issue(base, permission ? "permission_required" : "definition_scope_unavailable",
        failureMessage(failure, "Project definitions could not be read; check the T3 connection and workspace."));
    })));
    return scope;
  });

  const globalFingerprint: Effect.Effect<string | null> = globalRoot === null ? Effect.succeed(null)
    : Effect.suspend(() => readScope(globalRoot, "global", {value: 0, files: 0})).pipe(Effect.map(scope => fingerprintGlobalScope(scope, globalDefinitionsPath)));

  const checkoutTargets = Effect.fnUntraced(function* (projectId: string) {
    const catalog = yield* readCatalog;
    const project = catalog.projects.find(item => item.project.id === projectId && item.available);
    if (!project) return yield* new DefinitionCheckoutUnavailable({reason: "project_unavailable"});
    const projectRoot = text(project.project.workspaceRoot, 4096) && posix.isAbsolute(project.project.workspaceRoot) && !project.project.workspaceRoot.includes("\0") && !project.project.workspaceRoot.includes("\\")
      ? posix.normalize(project.project.workspaceRoot) : null;
    if (!projectRoot) return yield* new DefinitionCheckoutUnavailable({reason: "workspace_invalid"});
    if (yield* isScratchProject(projectId, project.project.workspaceRoot)) return [];
    const roots = new Map<string, string | null>([[projectRoot, null]]);
    const members = new Map<string, Array<{threadId: string; title: string}>>([[projectRoot, []]]);
    const candidates = catalog.threads.filter(thread => thread.projectId === projectId && thread.lineage.parentThreadId === null && !thread.deletedAt && !thread.archivedAt);
    if (candidates.length > 200) return yield* new DefinitionCheckoutUnavailable({reason: "checkout_target_limit"});
    for (const candidate of candidates) {
      const projection = yield* readProjection(candidate.id);
      const thread = projection.projection.thread;
      if (thread.id !== candidate.id || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt) continue;
      if (thread.worktreePath === undefined) return yield* new DefinitionCheckoutUnavailable({reason: "workspace_binding_unavailable"});
      if (thread.worktreePath === null) {
        members.get(projectRoot)!.push({threadId: thread.id, title: thread.title});
        continue;
      }
      if (!text(thread.worktreePath, 4096) || !posix.isAbsolute(thread.worktreePath) || thread.worktreePath.includes("\0") || thread.worktreePath.includes("\\"))
        return yield* new DefinitionCheckoutUnavailable({reason: "workspace_invalid"});
      const root = posix.normalize(thread.worktreePath);
      if (root !== projectRoot && !roots.has(root)) roots.set(root, thread.id);
      const shared = members.get(root) ?? [];
      shared.push({threadId: thread.id, title: thread.title}); members.set(root, shared);
    }
    const targets: DefinitionCheckoutTarget[] = [];
    for (const [workspaceRoot, threadId] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
      const vcs = files.vcsInfo ? yield* vcsInfo(workspaceRoot) : {isRepo: false, branch: null};
      targets.push({origin: "project", threadId, workspaceRoot, branch: vcs.branch, isGitRepository: vcs.isRepo, members: (members.get(workspaceRoot) ?? []).sort((a, b) => a.threadId.localeCompare(b.threadId))});
    }
    return targets;
  });

  const targetWorkspace = Effect.fnUntraced(function* (projectId: string, threadId: string | null) {
    const catalog = yield* readCatalog;
    const project = catalog.projects.find(item => item.project.id === projectId && item.available);
    if (!project || (yield* isScratchProject(projectId, project.project.workspaceRoot))) return null;
    return yield* currentWorkspace(projectId, threadId);
  });

  const setupOutcome = (status: ProjectDefinitionSetupOutcome["status"], workspaceRoot: string | null, branch: string | null, message: string, path = ".t3-supervisor"): ProjectDefinitionSetupOutcome =>
    ({status, workspaceRoot, branch, path, message});
  const globalSetupOutcome = (status: ProjectDefinitionGlobalSetupOutcome["status"], message: string): ProjectDefinitionGlobalSetupOutcome =>
    ({status, workspaceRoot: globalHomePath, branch: null, path: globalDefinitionsPath, message});

  const checkCommitSafety = Effect.fnUntraced(function* (projectId: string, threadId: string | null, root: string, expectedBranch: string | null,
    expectedPaths: readonly string[]): Effect.fn.Return<CommitSafetyCheck> {
    if (!files.gitOperationState || !files.vcsInfo || !options.gitProbe) return {status: "unavailable", branch: null, message: "A fresh local Git status probe is required to commit safely."};
    const operation = yield* Effect.result(withOperationCancel(cancel => files.gitOperationState!(root, cancel)));
    if (Result.isFailure(operation)) return {status: "unavailable", branch: null, message: "T3 could not verify the checkout's Git operation state."};
    const operationState = operation.success;
    if (operationState.status === "in_progress") return {status: "conflict", branch: expectedBranch, message: `Create + commit is unavailable while Git operation ${operationState.marker} is in progress.`};
    if (operationState.status === "unavailable") return {status: "unavailable", branch: expectedBranch, message: operationState.message};
    const current = yield* Effect.result(Effect.all([targetWorkspace(projectId, threadId), vcsInfo(root)]));
    if (Result.isFailure(current)) return {status: "unavailable", branch: null, message: "T3 could not verify the selected checkout before commit."};
    const [currentRoot, currentVcs] = current.success;
    if (currentRoot !== root || currentVcs.branch !== expectedBranch) return {status: "stale", branch: currentVcs.branch, message: "The selected checkout or branch changed; reload the setup choices."};
    if (!currentVcs.isRepo) return {status: "unavailable", branch: currentVcs.branch, message: "Create + commit requires a Git repository."};
    const probed = yield* Effect.result(withOperationCancel(cancel => options.gitProbe!(root, cancel)));
    if (Result.isFailure(probed)) return {status: "unavailable", branch: currentVcs.branch, message: "T3 could not obtain a fresh local Git status; no commit was attempted."};
    const fresh = probed.success;
    if (fresh.workspaceRoot !== root) return {status: "stale", branch: fresh.branch, message: "The fresh Git probe resolved a different checkout; reload the setup choices."};
    if (fresh.branch !== expectedBranch) return {status: "stale", branch: fresh.branch, message: "The selected checkout branch changed; reload the setup choices."};
    if (!fresh.isRepo) return {status: "unavailable", branch: fresh.branch, message: "Create + commit requires a Git repository."};
    if (!Array.isArray(fresh.changedPaths) || fresh.changedPaths.some(path => typeof path !== "string" || path.length > 4096 || path.includes("\0")))
      return {status: "unavailable", branch: fresh.branch, message: "The fresh Git probe returned an invalid changed-path list."};
    if (fresh.operationState.status === "in_progress") return {status: "conflict", branch: fresh.branch, message: "Create + commit is unavailable while a Git operation is in progress."};
    if (fresh.operationState.status === "unavailable") return {status: "unavailable", branch: fresh.branch, message: fresh.operationState.message};
    if (fresh.operationState.status !== "safe") return {status: "unavailable", branch: fresh.branch, message: "The fresh Git probe returned an unknown operation state."};
    const expected = new Set(expectedPaths);
    const exactFreshPaths = fresh.changedPaths.length === expected.size && fresh.changedPaths.every(path => expected.has(path));
    if (!exactFreshPaths)
      return {status: "conflict", branch: fresh.branch, message: expectedPaths.length === 0
        ? "Create + commit requires a clean checkout with no existing tracked, staged or untracked changes."
        : "Only the three new .t3-supervisor setup files may be changed before commit."};
    const latestRoot = yield* targetWorkspace(projectId, threadId).pipe(Effect.catch(() => Effect.succeed(null)));
    if (latestRoot !== root) return {status: "stale", branch: fresh.branch, message: "The selected checkout changed during the fresh Git check; reload the setup choices."};
    return {status: "safe", branch: fresh.branch};
  });

  const createScaffold = Effect.fnUntraced(function* (root: string, origin: DefinitionOrigin, action: "create" | "create_and_commit", projectId?: string, threadId?: string | null, expectedBranch?: string | null) {
    const path = origin === "global" ? globalDefinitionsPath : ".t3-supervisor";
    const setupWriter = options.setupWriter;
    if (!setupWriter) return setupOutcome("permission_required", root, expectedBranch ?? null, "A dedicated filesystem:write credential is required to create the definition scaffold.", path);
    const initialPresence = yield* scopePresence(root, origin === "global");
    if (initialPresence.status === "present") return setupOutcome(origin === "global" ? "unchanged" : "conflict", root, expectedBranch ?? null,
      origin === "global" ? "The existing global definition folder was preserved without changes." : "The selected checkout already has a .t3-supervisor folder; no files were changed.", path);
    if (initialPresence.status === "unavailable") return setupOutcome("unavailable", root, expectedBranch ?? null, initialPresence.message ?? "The definition folder could not be checked safely.", path);
    if (origin === "project" && projectId && files.vcsInfo) {
      const currentRoot = yield* targetWorkspace(projectId, threadId ?? null);
      const currentVcs = yield* vcsInfo(root);
      if (currentRoot !== root || currentVcs.branch !== expectedBranch) return setupOutcome("stale", root, currentVcs.branch, "The selected checkout changed before setup began.", path);
    }
    const stepsMarkerPath = ".t3-supervisor/steps/.gitkeep";
    const workflowsMarkerPath = ".t3-supervisor/workflows/.gitkeep";
    const configContents = "workflows: []\nsteps: []\n";
    const filesToCreate = [projectConfigPath, stepsMarkerPath, workflowsMarkerPath] as const;
    const written = new Set<string>();
    let safetyMessage: string | null = null;
    type WriteResult = "written" | "conflict" | "stale" | "permission_required" | "unavailable" | "uncertain";
    const safeWrite = Effect.fnUntraced(function* (filePath: string, contents: string): Effect.fn.Return<WriteResult, DefinitionSourceFailure> {
      safetyMessage = null;
      // native writeFile has no create-only precondition, so the existence guard cannot eliminate external races.
      if (yield* definitionsCanceled) return "stale";
      const presence = yield* scopePresence(root, origin === "global");
      if (presence.status === "unavailable") return "uncertain";
      if (filePath === projectConfigPath && presence.status === "present") return "conflict";
      if (filePath !== projectConfigPath && presence.status !== "present") return "uncertain";
      const folderListing = presence.status === "missing"
        ? {truncated: false, entries: [] as Array<{path: string; kind: "file" | "directory"}>}
        : yield* list(root, ".t3-supervisor");
      if (folderListing.truncated) return "uncertain";
      const expectedRoot = new Map<string, "file" | "directory">();
      if (written.has(projectConfigPath)) expectedRoot.set(projectConfigPath, "file");
      if (written.has(stepsMarkerPath)) expectedRoot.set(".t3-supervisor/steps", "directory");
      if (written.has(workflowsMarkerPath)) expectedRoot.set(".t3-supervisor/workflows", "directory");
      const observedRoot = new Map(folderListing.entries.map(entry => [entry.path, entry.kind]));
      if (observedRoot.size !== folderListing.entries.length || observedRoot.size !== expectedRoot.size ||
        [...expectedRoot].some(([path, kind]) => observedRoot.get(path) !== kind)) return "conflict";
      for (const [markerPath, directoryPath] of [[stepsMarkerPath, ".t3-supervisor/steps"], [workflowsMarkerPath, ".t3-supervisor/workflows"]] as const) {
        if (!written.has(markerPath)) continue;
        const directoryListing = yield* list(root, directoryPath);
        if (directoryListing.truncated) return "uncertain";
        if (directoryListing.entries.length !== 1 || directoryListing.entries[0]?.path !== markerPath || directoryListing.entries[0]?.kind !== "file") return "conflict";
        const marker = yield* read(root, markerPath);
        if (marker.truncated || marker.contents !== "") return "conflict";
      }
      const existing = yield* read(root, filePath).pipe(Effect.as("present" as const),
        Effect.catch(failure => Effect.succeed(fileFailure(failure) === "missing" ? "missing" as const : "unknown" as const)));
      if (existing === "present") return "conflict";
      if (existing === "unknown") return "uncertain";
      if (yield* definitionsCanceled) return "stale";
      if (origin === "project" && projectId && action === "create_and_commit") {
        const expectedPaths = [...written];
        const safety = yield* checkCommitSafety(projectId, threadId ?? null, root, expectedBranch ?? null, expectedPaths);
        if (safety.status !== "safe") safetyMessage = `${safety.message} ${written.size ? "Files created so far were left uncommitted." : "No setup files were written."}`;
        if (safety.status === "stale") return "stale";
        if (safety.status === "conflict") return "conflict";
        if (safety.status === "unavailable") return "unavailable";
      } else if (origin === "project" && projectId && files.vcsInfo) {
        const currentRoot = yield* targetWorkspace(projectId, threadId ?? null);
        const currentVcs = yield* vcsInfo(root);
        if (currentRoot !== root || currentVcs.branch !== expectedBranch) return "stale";
      }
      if (yield* definitionsCanceled) return "stale";
      yield* withOperationCancel(cancel => setupWriter.writeFile(root, filePath, contents, cancel));
      const readback = yield* read(root, filePath);
      if (readback.truncated || readback.contents !== contents) return "uncertain";
      written.add(filePath);
      return "written";
    }, Effect.catch(failure => Effect.succeed<WriteResult>(fileFailure(failure) === "permission_required" ? "permission_required" : "uncertain")));
    for (const [index, filePath] of filesToCreate.entries()) {
      const contents = filePath === projectConfigPath ? configContents : "";
      const result = yield* safeWrite(filePath, contents);
      if (result !== "written") return setupOutcome(result === "permission_required" ? "permission_required" : result === "conflict" ? "conflict" : result === "stale" ? "stale" : result === "unavailable" ? "unavailable" : "uncertain", root, expectedBranch ?? null,
        result === "stale" ? (written.size ? "Setup stopped because the selected checkout changed or was canceled; files created so far were left uncommitted." : "Setup stopped because the selected checkout changed or was canceled before writing.") :
          result === "conflict" ? safetyMessage ?? `The target changed or contains other files during setup; files created so far remain uncommitted (${written.size} of 3).` :
            result === "unavailable" ? safetyMessage ?? "A fresh local Git status could not be verified; no further setup files were written." :
              `The ${filePath} write could not be confirmed; a partial scaffold may remain, left uncommitted, and setup was not enabled.`, path);
      if (index < filesToCreate.length - 1 && (yield* definitionsCanceled))
        return setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; files created so far were left uncommitted.", path);
    }
    if (action === "create") return setupOutcome("created", root, expectedBranch ?? null, "Created project.yaml, steps/.gitkeep and workflows/.gitkeep; all files are uncommitted.", path);
    if (!setupWriter.commitFiles) return setupOutcome("permission_required", root, expectedBranch ?? null, "The files were created, but a dedicated source-control write credential is required to commit them.", path);
    if (origin === "project" && projectId) {
      const config = yield* read(root, projectConfigPath);
      const stepsMarker = yield* read(root, stepsMarkerPath);
      const workflowsMarker = yield* read(root, workflowsMarkerPath);
      if (config.truncated || stepsMarker.truncated || workflowsMarker.truncated || config.contents !== configContents || stepsMarker.contents !== "" || workflowsMarker.contents !== "")
        return setupOutcome("conflict", root, expectedBranch ?? null, "The setup files changed before commit; they were left uncommitted.", path);
      const listings = yield* Effect.result(Effect.all([list(root, ".t3-supervisor"), list(root, ".t3-supervisor/steps"), list(root, ".t3-supervisor/workflows")]));
      if (Result.isFailure(listings))
        return setupOutcome("uncertain", root, expectedBranch ?? null, "T3 could not verify that the setup folder contains only the three new files; they were left uncommitted.", path);
      const [folderEntries, stepsEntries, workflowsEntries] = listings.success;
      if (folderEntries.truncated || stepsEntries.truncated || workflowsEntries.truncated)
        return setupOutcome("uncertain", root, expectedBranch ?? null, "T3 returned an incomplete setup folder listing; the files were left uncommitted.", path);
      const folderContents = folderEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      const stepsContents = stepsEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      const workflowsContents = workflowsEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      if (JSON.stringify(folderContents) !== JSON.stringify([[projectConfigPath, "file"], [".t3-supervisor/steps", "directory"], [".t3-supervisor/workflows", "directory"]]) ||
        JSON.stringify(stepsContents) !== JSON.stringify([[stepsMarkerPath, "file"]]) ||
        JSON.stringify(workflowsContents) !== JSON.stringify([[workflowsMarkerPath, "file"]]))
        return setupOutcome("conflict", root, expectedBranch ?? null, "The setup folder contains other files; the new setup files were left uncommitted.", path);
      if (yield* definitionsCanceled) return setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; the files were left uncommitted.", path);
      const safety = yield* checkCommitSafety(projectId, threadId ?? null, root, expectedBranch ?? null, filesToCreate);
      if (safety.status !== "safe") return setupOutcome(safety.status, root, safety.branch, `${safety.message} The setup files were left uncommitted.`, path);
    }
    if (yield* definitionsCanceled) return setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; the files were left uncommitted.", path);
    const actionId = `supervisor-setup-${createHash("sha256").update(JSON.stringify([origin, root, expectedBranch, configContents])).digest("hex").slice(0, 32)}`;
    // the commit result is inspected as the baseline did inside its catch, so a malformed result is uncertain rather than a failure
    return yield* withOperationCancel(cancel => setupWriter.commitFiles!(root, filesToCreate, "Initialize T3 Supervisor definitions", actionId, cancel)).pipe(
      Effect.flatMap(commit => attempt(() => {
        if (commit.status === "uncertain") return setupOutcome("uncertain", root, expectedBranch ?? null, "The commit result is uncertain. The setup paths were submitted and may remain staged; inspect the checkout and commit history before retrying.", path);
        if (!commit.commitSha) return setupOutcome("uncertain", root, expectedBranch ?? null, "The commit result could not be verified. Refresh the checkout before retrying.", path);
        return setupOutcome("committed", root, expectedBranch ?? null, "T3 completed the requested setup commit. Repository hooks and signing apply; hooks can change which files it contains.", path);
      })),
      Effect.catch(failure => Effect.succeed(fileFailure(failure) === "permission_required"
        ? setupOutcome("permission_required", root, expectedBranch ?? null, "The files were created, but native source-control write permission is unavailable.", path)
        : setupOutcome("uncertain", root, expectedBranch ?? null, "The files were created, but the native commit result is uncertain. Refresh the checkout before retrying.", path))),
    );
  });

  const initializeGlobal: Effect.Effect<ProjectDefinitionGlobalSetupOutcome, DefinitionSourceFailure> = globalRoot === null
    ? Effect.succeed(globalSetupOutcome("unavailable", "The T3 server-home root is not configured."))
    : serialSetup(`global:${globalRoot}`, Effect.gen(function* () {
      const presence = yield* scopePresence(globalRoot, true);
      if (presence.status === "present") return globalSetupOutcome("unchanged", "The existing global definition folder was preserved without changes.");
      if (presence.status === "unavailable") return globalSetupOutcome("unavailable", presence.message ?? "The global definition folder could not be checked safely.");
      if (!options.setupWriter) return globalSetupOutcome("permission_required", "A dedicated filesystem:write credential is required to create the global definition scaffold.");
      const outcome = yield* createScaffold(globalRoot, "global", "create");
      if (outcome.status === "stale") return globalSetupOutcome("unavailable", "Global setup was canceled before completion; no setting was changed.");
      if (outcome.status === "committed") return globalSetupOutcome("uncertain", "Global setup does not commit files; refresh the server-home folder before retrying.");
      return globalSetupOutcome(outcome.status, outcome.message);
    }));

  const initialize = Effect.fnUntraced(function* (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput) {
    const root = yield* targetWorkspace(projectId, threadId);
    if (!root || root !== posix.normalize(input.expectedWorkspaceRoot)) return setupOutcome("stale", root, null, "The selected checkout changed. Reload checkout choices before setup.");
    return yield* serialSetup(`project:${root}`, Effect.gen(function* () {
      const vcs = files.vcsInfo ? yield* vcsInfo(root) : null;
      if (!vcs || vcs.branch !== input.expectedBranch) return setupOutcome("stale", root, vcs?.branch ?? null, "The selected checkout branch changed. Reload checkout choices before setup.");
      if (input.action === "create_and_commit" && !vcs.isRepo) return setupOutcome("unavailable", root, vcs.branch, "Create and commit is unavailable because this checkout is not a Git repository.");
      if (!options.setupWriter) return setupOutcome("permission_required", root, vcs.branch, "A dedicated filesystem:write credential is required to create the project definition scaffold.");
      if (input.action === "create_and_commit" && !options.setupWriter.commitFiles) return setupOutcome("permission_required", root, vcs.branch, "A dedicated source-control write credential is required to commit the new project definition files.");
      return yield* createScaffold(root, "project", input.action, projectId, threadId, input.expectedBranch);
    }));
  });

  const load = (projectId: string, threadId: string | null = null): Effect.Effect<ProjectDefinitionSnapshot> => Effect.gen(function* () {
    const result: MutableSnapshot = {projectId, threadId, workspaceRoot: "", globalOnly: false, revision: null, editingAvailable: false,
      status: "unavailable", steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: null, definitionFiles: [], complete: false, sources: [], issues: []};
    const inputs: unknown[] = [];
    const issue = (path: string, code: string, message: string) => result.issues.push({path, code, message});
    yield* Effect.gen(function* () {
      const catalog = yield* readCatalog;
      const project = catalog.projects.find(item => item.project.id === projectId && item.available);
      if (!project) {issue("", "project_unavailable", "Select an available registered project.");return;}
      const registeredRoot = text(project.project.workspaceRoot, 4096) && posix.isAbsolute(project.project.workspaceRoot) && !project.project.workspaceRoot.includes("\\")
        ? posix.normalize(project.project.workspaceRoot) : null;
      if (!registeredRoot) {issue("", "workspace_invalid", "T3 must supply an absolute Mac or Linux workspace path.");return;}
      let root = registeredRoot;
      if (threadId !== null) {
        const snapshot = yield* readProjection(threadId);
        const thread = snapshot.projection.thread;
        if (thread.id !== threadId || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt) {
          issue("", "thread_unavailable", "The conversation does not belong to this available project.");return;
        }
        if (thread.worktreePath === undefined) {issue("", "workspace_invalid", "T3 did not supply the conversation's worktree binding.");return;}
        if (thread.worktreePath !== null) {
          if (!text(thread.worktreePath, 4096) || !posix.isAbsolute(thread.worktreePath) || thread.worktreePath.includes("\\")) {
            issue("", "workspace_invalid", "T3 returned an invalid worktree binding.");return;
          }
          root = posix.normalize(thread.worktreePath);
        }
      }
      result.workspaceRoot = root;
      const scratch = yield* isScratchProject(projectId, registeredRoot);
      result.globalOnly = scratch;
      const enabled = yield* globalEnabled(projectId);
      inputs.push(["globalDefinitionsEnabled", enabled]);
      const budget = {value: 0, files: 0};
      const emptyScope = (): DefinitionScopeRead => ({status: "missing", complete: true, steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: null,
        definitionFiles: [], sources: [], issues: [], inputs: []});
      const globalScope = enabled && globalRoot ? yield* readScope(globalRoot, "global", budget) : emptyScope();
      result.globalRevision = enabled ? fingerprintGlobalScope(globalScope, globalDefinitionsPath) : null;
      inputs.push(["global", enabled ? globalScope.inputs : ["disabled"]]);
      const projectScope = scratch ? emptyScope() : yield* readScope(root, "project", budget);
      inputs.push(["project", scratch ? ["global-only", root] : projectScope.inputs]);
      const namespacedGlobal = enabled ? namespaceGlobal(globalScope, projectScope, globalDefinitionsPath) : globalScope;
      result.steps = [...namespacedGlobal.steps, ...projectScope.steps];
      result.workflows = [...namespacedGlobal.workflows, ...projectScope.workflows];
      result.projectConfig = scratch ? null : projectScope.projectConfig;
      const defaultWorkflow = projectScope.config.default_workflow ?? (enabled ? namespacedGlobal.config.default_workflow : undefined);
      result.config = {
        workflows: [...(enabled ? namespacedGlobal.config.workflows : []), ...projectScope.config.workflows],
        steps: [...(enabled ? namespacedGlobal.config.steps : []), ...projectScope.config.steps],
        ...(defaultWorkflow ? {default_workflow: defaultWorkflow} : {}),
      };
      result.definitionFiles = [...(enabled ? globalScope.definitionFiles : []), ...projectScope.definitionFiles];
      result.sources = [...(enabled ? globalScope.sources : []), ...projectScope.sources];
      result.issues.push(...namespacedGlobal.issues, ...projectScope.issues);
      const activeScopes = [...(enabled ? [globalScope] : []), ...(!scratch ? [projectScope] : [])];
      result.complete = activeScopes.every(scope => scope.complete);
      reportWorkflowGraph(result, projectScope, issue);
      if (activeScopes.some(scope => scope.status === "permission_required")) result.status = "permission_required";
      else if (activeScopes.some(scope => scope.status === "unavailable")) result.status = "unavailable";
      else if (activeScopes.some(scope => scope.status === "invalid") || result.issues.some(item => item.code !== "global_definitions_missing")) result.status = "invalid";
      else if (enabled && globalScope.status === "missing") result.status = "missing";
      else if (scratch && enabled) result.status = globalScope.status;
      else if (scratch) result.status = "ready";
      else if (projectScope.status === "missing") result.status = "missing";
      else result.status = "ready";
      if (result.status === "missing" && scratch && enabled && !result.issues.length)
        issue(globalDefinitionsPath, "global_definitions_missing", "Create the global .t3-supervisor folder to make shared definitions available in Scratch.");
      if (result.complete) result.revision = createHash("sha256").update(JSON.stringify([projectId, threadId, root, scratch, inputs])).digest("hex");
      if (result.status === "permission_required" || result.status === "unavailable") {
        result.complete = false;
        result.revision = null;
        if (!result.issues.length) issue(globalDefinitionsPath, result.status, result.status === "permission_required"
          ? "The active global or project definition scope requires filesystem:read access."
          : "An active definition scope could not be read; no empty requirements were assumed.");
      }
    }).pipe(Effect.catch(failure => Effect.sync(() => {
      result.complete = false;
      result.revision = null;
      result.status = fileFailure(failure) === "permission_required" ? "permission_required" : "unavailable";
      issue(globalDefinitionsPath, result.status, failure.error instanceof ProjectFileError ? failure.error.message : "Project definitions could not be read; check the T3 connection and workspace.");
    })));
    return result as ProjectDefinitionSnapshot;
  });

  // every public operation runs under its caller's cancel signal; only load carries the 30 s deadline, as in the baseline
  return {
    globalHomePath,
    globalDefinitionsPath,
    load: (projectId: string, threadId: string | null = null, cancel?: Deferred.Deferred<void>) => load(projectId, threadId).pipe(definitionsOperation(cancel, "30 seconds")),
    presence: (projectId: string, cancel?: Deferred.Deferred<void>) => presenceForCheckout(projectId, null).pipe(definitionsOperation(cancel)),
    presenceGlobal: (cancel?: Deferred.Deferred<void>) => presenceGlobal.pipe(definitionsOperation(cancel)),
    presenceForCheckout: (projectId: string, threadId: string | null, cancel?: Deferred.Deferred<void>) => presenceForCheckout(projectId, threadId).pipe(definitionsOperation(cancel)),
    checkoutTargets: (projectId: string, cancel?: Deferred.Deferred<void>) => checkoutTargets(projectId).pipe(definitionsOperation(cancel)),
    currentWorkspace: (projectId: string, threadId: string | null, cancel?: Deferred.Deferred<void>) => currentWorkspace(projectId, threadId).pipe(definitionsOperation(cancel)),
    globalFingerprint: (cancel?: Deferred.Deferred<void>) => globalFingerprint.pipe(definitionsOperation(cancel)),
    initialize: (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput, cancel?: Deferred.Deferred<void>) =>
      initialize(projectId, threadId, input).pipe(definitionsOperation(cancel)),
    initializeGlobal: (cancel?: Deferred.Deferred<void>) => initializeGlobal.pipe(definitionsOperation(cancel)),
    readProjectConfig: (root: string, cancel?: Deferred.Deferred<void>) => read(root, projectConfigPath).pipe(definitionsOperation(cancel)),
  };
});

/** Loads validated definitions from the operative checkout and shared T3 user home. */
export class ProjectDefinitions extends Context.Service<ProjectDefinitions, {
  readonly globalHomePath: string;
  readonly globalDefinitionsPath: string;
  // never fails: an unreadable scope makes the snapshot incomplete and revision-less (30 s deadline)
  readonly load: (projectId: string, threadId?: string | null, cancel?: Deferred.Deferred<void>) => Effect.Effect<ProjectDefinitionSnapshot>;
  readonly presence: (projectId: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<DefinitionPresence>;
  readonly presenceGlobal: (cancel?: Deferred.Deferred<void>) => Effect.Effect<GlobalDefinitionPresence>;
  readonly presenceForCheckout: (projectId: string, threadId: string | null, cancel?: Deferred.Deferred<void>) => Effect.Effect<DefinitionPresence>;
  readonly checkoutTargets: (projectId: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<DefinitionCheckoutTarget[], DefinitionSourceFailure | DefinitionCheckoutUnavailable>;
  // the operative checkout comes from the native projection; caller-supplied roots are never accepted
  readonly currentWorkspace: (projectId: string, threadId: string | null, cancel?: Deferred.Deferred<void>) => Effect.Effect<string | null, DefinitionSourceFailure>;
  readonly globalFingerprint: (cancel?: Deferred.Deferred<void>) => Effect.Effect<string | null>;
  // setup is serialized per root; a cancel signal stops it at the next check, leaving files written so far uncommitted
  readonly initialize: (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<ProjectDefinitionSetupOutcome, DefinitionSourceFailure>;
  readonly initializeGlobal: (cancel?: Deferred.Deferred<void>) => Effect.Effect<ProjectDefinitionGlobalSetupOutcome, DefinitionSourceFailure>;
  // the native readback of a checkout's project.yaml
  readonly readProjectConfig: (root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<DefinitionFileRead, DefinitionSourceFailure>;
}>()("t3-supervisor/ProjectDefinitions") {
  static readonly make: (sources: ProjectDefinitionSources) => Effect.Effect<ProjectDefinitions["Service"], never, Scope.Scope> = makeProjectDefinitions;
  static readonly layer = (sources: ProjectDefinitionSources): Layer.Layer<ProjectDefinitions> => Layer.effect(ProjectDefinitions, makeProjectDefinitions(sources));
}

