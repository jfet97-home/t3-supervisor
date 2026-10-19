import { Effect } from "effect";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { definitionReferenceFields, validDefinitionReferences } from "./definition-references.js";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import { ProjectFileError, type FreshGitProbe, type ProjectCommitter, type ProjectFiles } from "./project-files.js";
import {workflowDefinitionExpansionLimits, type DefinitionNode, type DefinitionReference, type DefinitionStepInfo, type DefinitionWorkflowInfo, type ProjectConfigurationInfo, type ProjectDefinitionSnapshot} from "./project-definitions-contract.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
type MutableSnapshot = {-readonly [K in keyof ProjectDefinitionSnapshot]: ProjectDefinitionSnapshot[K] extends ReadonlyArray<infer V> ? V[] : ProjectDefinitionSnapshot[K]};
type MutableScopeSnapshot = {steps: DefinitionStepInfo[]; workflows: DefinitionWorkflowInfo[]; config: ProjectConfigurationInfo; projectConfig: ProjectConfigurationInfo | null; sources: ProjectDefinitionSnapshot["sources"][number][]; issues: ProjectDefinitionSnapshot["issues"][number][]};
type DefinitionOrigin = "global" | "project";
type DefinitionScopeStatus = "ready" | "missing" | "invalid" | "permission_required" | "unavailable";
export type DefinitionCheckoutTarget = {origin: "project"; threadId: string | null; workspaceRoot: string; branch: string | null; isGitRepository: boolean};
export type ProjectDefinitionSetupInput = {origin: "project"; action: "create" | "create_and_commit"; expectedWorkspaceRoot: string; expectedBranch: string | null};
export type ProjectDefinitionSetupOutcome = {status: "created" | "committed" | "unchanged" | "conflict" | "stale" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string | null; branch: string | null; path: string; message: string};
export type ProjectDefinitionGlobalSetupOutcome = {status: "created" | "unchanged" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string; branch: null; path: string; message: string};
type CommitSafetyCheck = {status: "safe"; branch: string | null} | {status: "stale" | "conflict" | "unavailable"; branch: string | null; message: string};
export interface ProjectDefinitionSetupWriter {
  writeFile(root: string, path: string, contents: string, signal: AbortSignal): Promise<void>;
  commitFiles?: ProjectCommitter["commitFiles"];
}
export interface ProjectDefinitionLoaderOptions {
  globalRoot?: string | null;
  useGlobalDefinitions?: (projectId: string) => boolean;
  isScratchProject?: (projectId: string, registeredWorkspaceRoot: string) => boolean;
  managedScratchRoot?: string;
  setupWriter?: ProjectDefinitionSetupWriter;
  gitProbe?: FreshGitProbe;
}
interface DefinitionScopeRead extends MutableScopeSnapshot {
  status: DefinitionScopeStatus;
  complete: boolean;
  inputs: unknown[];
}
class DefinitionReadLimit extends Error {}
const definitionId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 8000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(f => Object.hasOwn(v, f));
const withOptionalReferences = (value: Record<string, unknown>, fields: string[]) =>
  exact(value, [...fields, ...(Object.hasOwn(value, "references") ? ["references"] : [])]) &&
  (!Object.hasOwn(value, "references") || validDefinitionReferences(value.references));

const yaml = (contents: string): unknown => {
  const doc = parseDocument(contents, {schema: "core", uniqueKeys: true});
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML; check syntax, duplicate keys and tags.");
  try {return doc.toJS({maxAliasCount: 0});}
  catch {throw new Error("YAML aliases are not supported in project definitions.");}
};

const definitionName = (value: unknown): value is string => text(value, 160);

export const parseProjectConfiguration = (contents: string): ProjectConfigurationInfo => {
  const config = yaml(contents);
  if (!record(config) || !(exact(config, ["required"]) || exact(config, ["required", "default_workflow"])) ||
    !Array.isArray(config.required) || config.required.length > MAX_FILES ||
    config.default_workflow !== undefined && (typeof config.default_workflow !== "string" || !definitionId.test(config.default_workflow)))
    throw new Error("project.yaml needs required: [] and an optional default_workflow identifier.");
  const seen = new Set<string>();
  const required = config.required.map(value => {
    if (!record(value) || Object.keys(value).length !== 1 ||
      !(typeof value.step === "string" && definitionId.test(value.step) || typeof value.workflow === "string" && definitionId.test(value.workflow)))
      throw new Error("Each required item must name one reusable step or workflow.");
    const reference: DefinitionReference = typeof value.step === "string" ? {step: value.step} : {workflow: value.workflow as string};
    const key = "step" in reference ? `step:${reference.step}` : `workflow:${reference.workflow}`;
    if (seen.has(key)) throw new Error("Required definition references must be unique.");
    seen.add(key);
    return reference;
  });
  return {...(config.default_workflow === undefined ? {} : {default_workflow: config.default_workflow}), required};
};

export const parseDefinitionStep = (id: string, contents: string): DefinitionStepInfo => {
  contents = contents.replace(/^\uFEFF/, "");
  if (!definitionId.test(id)) throw new Error("Invalid step filename.");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!frontmatter) throw new Error("Step needs YAML frontmatter containing id, name and description.");
  const metadata = yaml(frontmatter[1]!);
  if (!record(metadata) || !withOptionalReferences(metadata, ["id", "name", "description"]) || metadata.id !== id || !definitionName(metadata.name) || !text(metadata.description))
    throw new Error("Step frontmatter needs a matching id, name, nonempty description and optional references: a list of relative file paths.");
  if (contents.slice(frontmatter[0].length).trim() !== "") throw new Error("Step body must be empty; keep all guidance in description.");
  return {id, name: metadata.name.trim(), description: metadata.description.trim(), ...definitionReferenceFields(metadata.references as readonly string[] | undefined)};
};

const parseNode = (value: unknown, depth: number, budget: {count: number}): DefinitionNode => {
  if (depth > workflowDefinitionExpansionLimits.maxDepth || ++budget.count > workflowDefinitionExpansionLimits.maxNodes)
    throw new Error("Workflow structure exceeds the nesting or expanded-node limit.");
  if (!record(value) || Object.keys(value).length !== 1) throw new Error("Each workflow node must contain exactly one step, workflow, sequence or parallel key.");
  if (Object.hasOwn(value, "step")) {
    if (typeof value.step === "string" && definitionId.test(value.step)) return {step: value.step};
    if (record(value.step) && withOptionalReferences(value.step, ["id", "name", "description"]) && typeof value.step.id === "string" &&
      definitionId.test(value.step.id) && definitionName(value.step.name) && text(value.step.description))
      return {step: {id: value.step.id, name: value.step.name.trim(), description: value.step.description.trim(), ...definitionReferenceFields(value.step.references as readonly string[] | undefined)}};
    throw new Error("step must name a reusable step or define a local step with id, name, description and optional references: a list of relative file paths.");
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

export const parseDefinitionWorkflow = (id: string, contents: string): DefinitionWorkflowInfo => {
  if (!definitionId.test(id)) throw new Error("Invalid workflow filename.");
  const metadata = yaml(contents.replace(/^\uFEFF/, ""));
  const hasSequence = record(metadata) && Object.hasOwn(metadata, "sequence");
  const hasParallel = record(metadata) && Object.hasOwn(metadata, "parallel");
  const fields = ["name", "description", ...(record(metadata) && Object.hasOwn(metadata, "fixed") ? ["fixed"] : []), ...(hasSequence ? ["sequence"] : []), ...(hasParallel ? ["parallel"] : [])];
  if (!record(metadata) || !withOptionalReferences(metadata, fields) || hasSequence === hasParallel || !definitionName(metadata.name) || !text(metadata.description) ||
    metadata.fixed !== undefined && typeof metadata.fixed !== "boolean")
    throw new Error("A workflow needs name, description, optional fixed and references (relative file paths), and exactly one root sequence or parallel group.");
  const root = hasSequence ? parseNode({sequence: metadata.sequence}, 0, {count: 0}) : parseNode({parallel: metadata.parallel}, 0, {count: 0});
  const nodes = hasSequence ? (root as {sequence: readonly DefinitionNode[]}).sequence : (root as {parallel: readonly DefinitionNode[]}).parallel;
  const localIds = collectLocalStepIds(nodes);
  if (new Set(localIds).size !== localIds.length) throw new Error("Local step identifiers must be unique within a workflow.");
  return {id, name: metadata.name.trim(), description: metadata.description.trim(), fixed: metadata.fixed === true,
    ...definitionReferenceFields(metadata.references as readonly string[] | undefined),
    ...(hasSequence ? {sequence: (root as {sequence: readonly DefinitionNode[]}).sequence} : {parallel: (root as {parallel: readonly DefinitionNode[]}).parallel})};
};

/** Loads validated definitions from the operative checkout and shared T3 user home. */
export class ProjectDefinitionLoader {
  private readonly setupQueues = new Map<string, Promise<void>>();
  private readonly globalRoot: string | null;

  constructor(
    readonly source: Pick<StoreShape, "catalog">,
    readonly t3: Pick<T3ClientShape, "projection">,
    readonly files: ProjectFiles,
    readonly options: ProjectDefinitionLoaderOptions = {},
  ) {
    this.globalRoot = options.globalRoot === undefined ? null : options.globalRoot;
  }

  globalHomePath(): string {return this.globalRoot ?? "~";}
  globalDefinitionsPath(): string {return posix.join(this.globalHomePath(), ".t3-supervisor");}

  private isScratchProject(projectId: string, registeredWorkspaceRoot: string): boolean {
    if (this.options.isScratchProject) return this.options.isScratchProject(projectId, registeredWorkspaceRoot);
    const managedRoot = this.options.managedScratchRoot;
    return Boolean(managedRoot && posix.isAbsolute(managedRoot) && posix.isAbsolute(registeredWorkspaceRoot) &&
      posix.normalize(managedRoot) === posix.normalize(registeredWorkspaceRoot));
  }

  private globalEnabled(projectId: string): boolean {
    return this.globalRoot !== null && (this.options.useGlobalDefinitions?.(projectId) ?? false);
  }

  async currentWorkspace(projectId: string, threadId: string | null, signal: AbortSignal): Promise<string | null> {
    const catalog = await Effect.runPromise(this.source.catalog(), {signal});
    const project = catalog.projects.find(p => p.project.id === projectId && p.available);
    if (!project) return null;
    let root = project.project.workspaceRoot;
    if (threadId !== null) {
      const thread = (await Effect.runPromise(this.t3.projection(threadId), {signal})).projection.thread;
      if (thread.id !== threadId || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt || thread.worktreePath === undefined) return null;
      if (thread.worktreePath !== null) {
        if (!text(thread.worktreePath, 4096)) return null;
        root = thread.worktreePath;
      }
    }
    return text(root, 4096) && posix.isAbsolute(root) && !root.includes("\0") && !root.includes("\\") ? posix.normalize(root) : null;
  }

  private async scopePresence(root: string, global: boolean, signal: AbortSignal): Promise<{status: "present" | "missing" | "unavailable"; message?: string}> {
    try {
      if (!await this.files.directoryExists(root, signal)) return {status: "unavailable", message: "The selected T3 workspace directory is unavailable."};
      const folderName = ".t3-supervisor";
      const entries = await this.files.list(root, folderName, signal);
      if (entries.truncated) return {status: "unavailable", message: "The definition folder listing is incomplete."};
      return {status: "present"};
    } catch (error) {
      if (error instanceof ProjectFileError && error.code === "missing") return {status: "missing"};
      return {status: "unavailable", message: error instanceof ProjectFileError && error.code === "permission_required"
        ? error.message
        : `The ${global ? "T3 server-home" : "project"} definition folder could not be checked safely.`};
    }
  }

  async presenceGlobal(signal: AbortSignal): Promise<{status: "present" | "missing" | "unavailable"; path: string; message?: string}> {
    if (!this.globalRoot) return {status: "unavailable", path: this.globalDefinitionsPath(), message: "The T3 server-home root is not configured."};
    return {...await this.scopePresence(this.globalRoot, true, signal), path: this.globalDefinitionsPath()};
  }

  async presence(projectId: string, signal: AbortSignal): Promise<{status: "present" | "missing" | "unavailable"; message?: string}> {
    return this.presenceForCheckout(projectId, null, signal);
  }

  async presenceForCheckout(projectId: string, threadId: string | null, signal: AbortSignal): Promise<{status: "present" | "missing" | "unavailable"; message?: string}> {
    try {
      const catalog = await Effect.runPromise(this.source.catalog(), {signal});
      const project = catalog.projects.find(item => item.project.id === projectId && item.available);
      if (!project) return {status: "unavailable", message: "Select an available registered project."};
      if (this.isScratchProject(projectId, project.project.workspaceRoot)) {
        if (!this.globalRoot) return {status: "unavailable", message: "The T3 server-home root is not configured."};
        return this.scopePresence(this.globalRoot, true, signal);
      }
      const root = await this.currentWorkspace(projectId, threadId, signal);
      return root ? this.scopePresence(root, false, signal) : {status: "unavailable", message: "The selected conversation checkout is unavailable."};
    } catch {
      return {status: "unavailable", message: "The selected T3 workspace could not be checked."};
    }
  }

  private async readScope(root: string, origin: DefinitionOrigin, signal: AbortSignal, budget: {value: number; files: number}): Promise<DefinitionScopeRead> {
    const scope: DefinitionScopeRead = {status: "unavailable", complete: false, steps: [], workflows: [], config: {required: []}, projectConfig: null, sources: [], issues: [], inputs: []};
    const base = origin === "global" ? this.globalDefinitionsPath() : ".t3-supervisor";
    const showPath = (path: string) => path === "" ? base : `${base}/${path.replace(/^\.t3-supervisor\//, "")}`;
    const issue = (path: string, code: string, message: string) => scope.issues.push({path, code, message});
    const markIncomplete = () => {scope.complete = false;};
    let permissionRequired = false;
    let unavailable = false;
    const noteReadFailure = (error: unknown) => {
      if (error instanceof ProjectFileError && error.code === "permission_required") permissionRequired = true;
      else if (error instanceof ProjectFileError && error.code !== "invalid_file" && error.code !== "missing") unavailable = true;
    };
    const readSource = async (path: string): Promise<string> => {
      const safeChild = /^\.t3-supervisor\/(?:steps|workflows)\/[^/\\\0]+$/.test(path) && ![".", ".."].includes(path.slice(path.lastIndexOf("/") + 1));
      if (path !== ".t3-supervisor/project.yaml" && !safeChild) throw new Error("Definition source paths must stay within project.yaml, steps/ or workflows/.");
      const file = await this.files.read(root, path, signal);
      scope.inputs.push([path, file]);
      budget.value += file.byteLength;
      if (budget.value > MAX_TOTAL_BYTES) throw new DefinitionReadLimit("Definition sources exceed the 512 KiB combined limit.");
      if (file.truncated || file.byteLength > MAX_FILE_BYTES || (Buffer.byteLength(file.contents, "utf8") !== file.byteLength && Buffer.byteLength(file.contents, "utf8") + 3 !== file.byteLength))
        throw new DefinitionReadLimit("Definition sources must be complete, at most 64 KiB each and 512 KiB combined.");
      scope.sources.push({path: showPath(path), content: file.contents, origin});
      return file.contents;
    };
    try {
      if (!await this.files.directoryExists(root, signal)) {
        scope.inputs.push(["root", "missing"]);
        scope.status = "unavailable";
        scope.complete = false;
        issue(base, origin === "project" ? "workspace_missing" : "global_home_unavailable", origin === "project"
          ? "The selected T3 workspace directory is unavailable."
          : "The T3 server user's home directory is unavailable.");
        return scope;
      }
      if (origin === "project" && !await this.files.directoryExists(posix.join(root, ".t3-supervisor"), signal)) {
        scope.inputs.push(["folder", false]);
        scope.status = "missing";
        scope.complete = true;
        return scope;
      }
      let listing: Awaited<ReturnType<ProjectFiles["list"]>>;
      try {listing = await this.files.list(root, ".t3-supervisor", signal);}
      catch (error) {
        if (error instanceof ProjectFileError && error.code === "missing") {
          scope.inputs.push(["folder", false]);
          scope.status = "missing";
          scope.complete = true;
          if (origin === "global") issue(base, "global_definitions_missing", "The enabled global .t3-supervisor folder is missing; shared requirements remain unknown.");
          return scope;
        }
        throw error;
      }
      scope.inputs.push(["folder", true], ["listing", {...listing, entries: [...listing.entries].sort((a, b) => a.path.localeCompare(b.path))}]);
      scope.complete = !listing.truncated && new Set(listing.entries.map(entry => entry.path)).size === listing.entries.length;
      scope.status = "ready";
      if (listing.truncated) issue(base, "listing_truncated", "The definition folder listing is incomplete.");
      if (new Set(listing.entries.map(entry => entry.path)).size !== listing.entries.length) issue(base, "listing_duplicate", "The definition folder listing contains duplicate paths.");
      if (!scope.complete) markIncomplete();

      const entries = [...listing.entries].sort((a, b) => a.path.localeCompare(b.path));
      const projectFile = ".t3-supervisor/project.yaml";
      const configEntry = entries.find(entry => entry.path === projectFile);
      for (const entry of entries) {
        if ([projectFile, ".t3-supervisor/steps", ".t3-supervisor/workflows", ".t3-supervisor/.DS_Store"].includes(entry.path)) continue;
        if ([".t3-supervisor/rules.yaml", ".t3-supervisor/blocks"].includes(entry.path))
          issue(showPath(entry.path), "legacy_definition_format", "The old rules.yaml/blocks format is not loaded. Replace it with project.yaml, steps/ and workflows/; use required: [] for no requirements.");
        else issue(base, "unexpected_definition_entry", "Only project.yaml, steps/ and workflows/ belong in the definition folder. Unexpected entries are reported but not read.");
      }
      if (configEntry?.kind === "file") {
        budget.files++;
        if (budget.files > MAX_FILES) {
          issue(showPath(projectFile), "definition_file_limit", "The active scopes exceed the 100 definition-file limit.");
          markIncomplete();
        } else {
          try {
            const contents = await readSource(projectFile);
            try {scope.config = scope.projectConfig = parseProjectConfiguration(contents);}
            catch (error) {issue(showPath(projectFile), "project_configuration_invalid", error instanceof Error ? error.message : "project.yaml is invalid.");}
          } catch (error) {markIncomplete();noteReadFailure(error);issue(showPath(projectFile), "definition_source_unreadable", error instanceof Error ? error.message : "project.yaml could not be read.");}
        }
      } else {
        if (configEntry) markIncomplete();
        issue(showPath(projectFile), configEntry ? "project_configuration_invalid_path" : "configuration_missing",
          configEntry ? "project.yaml must be a regular file." : "Add project.yaml with a required list; use required: [] for no requirements.");
      }

      const readDefinitions = async (kind: "steps" | "workflows") => {
        const directoryPath = `.t3-supervisor/${kind}`;
        const directory = entries.find(entry => entry.path === directoryPath);
        if (!directory) {
          issue(showPath(directoryPath), `${kind}_directory_missing`, `Add the ${kind}/ directory to the definition folder.`);
          return;
        }
        if (directory.kind !== "directory") {
          markIncomplete();
          issue(showPath(directoryPath), `${kind}_directory_invalid`, `${kind}/ must be a directory.`);
          return;
        }
        let collection: Awaited<ReturnType<ProjectFiles["list"]>>;
        try {collection = await this.files.list(root, directoryPath, signal);}
        catch (error) {
          markIncomplete();
          noteReadFailure(error);
          issue(showPath(directoryPath), `${kind}_listing_unavailable`, error instanceof Error ? error.message : `The ${kind}/ directory could not be listed.`);
          return;
        }
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
          budget.files++;
          if (budget.files > MAX_FILES) {
            issue(showPath(entry.path), "definition_file_limit", "The active scopes exceed the 100 definition-file limit.");
            markIncomplete();
            continue;
          }
          let contents: string;
          try {contents = await readSource(entry.path);}
          catch (error) {
            markIncomplete();
            noteReadFailure(error);
            issue(showPath(entry.path), "definition_source_unreadable", error instanceof Error ? error.message : "The definition source could not be read.");
            continue;
          }
          try {
            const value = kind === "steps" ? parseDefinitionStep(match[1]!, contents) : parseDefinitionWorkflow(match[1]!, contents);
            if (kind === "steps") scope.steps.push({...value as DefinitionStepInfo, origin, path: showPath(entry.path), sourceId: match[1]!});
            else scope.workflows.push({...value as DefinitionWorkflowInfo, origin, path: showPath(entry.path), sourceId: match[1]!});
          } catch (error) {
            issue(showPath(entry.path), `${kind}_invalid`, error instanceof Error ? error.message : `The ${kind} definition is invalid.`);
          }
        }
      };
      await readDefinitions("steps");
      await readDefinitions("workflows");
      scope.status = permissionRequired ? "permission_required" : unavailable ? "unavailable" : scope.issues.length ? "invalid" : "ready";
    } catch (error) {
      const permission = error instanceof ProjectFileError && error.code === "permission_required";
      scope.status = permission ? "permission_required" : error instanceof DefinitionReadLimit ? "invalid" : error instanceof ProjectFileError ? "unavailable" : "unavailable";
      markIncomplete();
      issue(base, permission ? "permission_required" : error instanceof DefinitionReadLimit ? "definition_source_limit" : "definition_scope_unavailable",
        error instanceof Error ? error.message : "Project definitions could not be read; check the T3 connection and workspace.");
    }
    return scope;
  }

  private namespaceGlobal(global: DefinitionScopeRead, project: DefinitionScopeRead): DefinitionScopeRead {
    const usedSteps = new Set(project.steps.map(step => step.id));
    const usedWorkflows = new Set(project.workflows.map(workflow => workflow.id));
    const knownSteps = new Set(global.steps.map(step => step.sourceId ?? step.id));
    const knownWorkflows = new Set(global.workflows.map(workflow => workflow.sourceId ?? workflow.id));
    const report = (path: string, code: string, message: string) => global.issues.push({path, code, message});
    const stepRefs = new Set<string>(global.steps.map(step => step.sourceId ?? step.id));
    const workflowRefs = new Set<string>(global.workflows.map(workflow => workflow.sourceId ?? workflow.id));
    for (const reference of global.config.required) {
      const id = "step" in reference ? reference.step : reference.workflow;
      ("step" in reference ? stepRefs : workflowRefs).add(id);
      if ("step" in reference && !knownSteps.has(id)) report(`${this.globalDefinitionsPath()}/project.yaml`, "required_step_missing", `Required global step ${id} is missing or invalid.`);
      if ("workflow" in reference && !knownWorkflows.has(id)) report(`${this.globalDefinitionsPath()}/project.yaml`, "required_workflow_missing", `Required global workflow ${id} is missing or invalid.`);
    }
    if (global.config.default_workflow) workflowRefs.add(global.config.default_workflow);
    if (global.config.default_workflow && !knownWorkflows.has(global.config.default_workflow))
      report(`${this.globalDefinitionsPath()}/project.yaml`, "default_workflow_missing", `Default global workflow ${global.config.default_workflow} is missing or invalid.`);
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
      for (let index = before; index < global.issues.length; index++) if (!global.issues[index]!.path) global.issues[index] = {...global.issues[index]!, path: workflow.path ?? this.globalDefinitionsPath()};
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
      required: global.config.required.map(reference => "step" in reference
        ? {step: stepMap.get(reference.step)!} : {workflow: workflowMap.get(reference.workflow)!}),
      ...(global.config.default_workflow ? {default_workflow: workflowMap.get(global.config.default_workflow)!} : {}),
    };
    return global;
  }

  private fingerprintGlobalScope(scope: DefinitionScopeRead): string | null {
    if (!scope.complete || scope.status === "unavailable" || scope.status === "permission_required") return null;
    return createHash("sha256").update(JSON.stringify([this.globalDefinitionsPath(), scope.status, scope.inputs])).digest("hex");
  }

  async globalFingerprint(signal: AbortSignal): Promise<string | null> {
    if (!this.globalRoot) return null;
    const scope = await this.readScope(this.globalRoot, "global", signal, {value: 0, files: 0});
    return this.fingerprintGlobalScope(scope);
  }

  async checkoutTargets(projectId: string, signal: AbortSignal): Promise<DefinitionCheckoutTarget[]> {
    const catalog = await Effect.runPromise(this.source.catalog(), {signal});
    const project = catalog.projects.find(item => item.project.id === projectId && item.available);
    if (!project) throw new Error("project_unavailable");
    const projectRoot = text(project.project.workspaceRoot, 4096) && posix.isAbsolute(project.project.workspaceRoot) && !project.project.workspaceRoot.includes("\0") && !project.project.workspaceRoot.includes("\\")
      ? posix.normalize(project.project.workspaceRoot) : null;
    if (!projectRoot) throw new Error("workspace_invalid");
    if (this.isScratchProject(projectId, project.project.workspaceRoot)) return [];
    const roots = new Map<string, string | null>([[projectRoot, null]]);
    const candidates = catalog.threads.filter(thread => thread.projectId === projectId && thread.lineage.parentThreadId === null && !thread.deletedAt && !thread.archivedAt);
    if (candidates.length > 200) throw new Error("checkout_target_limit");
    for (const candidate of candidates) {
      const projection = await Effect.runPromise(this.t3.projection(candidate.id), {signal});
      const thread = projection.projection.thread;
      if (thread.id !== candidate.id || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt) continue;
      if (thread.worktreePath === undefined) throw new Error("workspace_binding_unavailable");
      if (thread.worktreePath === null) continue;
      if (!text(thread.worktreePath, 4096) || !posix.isAbsolute(thread.worktreePath) || thread.worktreePath.includes("\0") || thread.worktreePath.includes("\\")) throw new Error("workspace_invalid");
      const root = posix.normalize(thread.worktreePath);
      if (root !== projectRoot && !roots.has(root)) roots.set(root, thread.id);
    }
    const targets: DefinitionCheckoutTarget[] = [];
    for (const [workspaceRoot, threadId] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
      const vcs = this.files.vcsInfo ? await this.files.vcsInfo(workspaceRoot, signal) : {isRepo: false, branch: null};
      targets.push({origin: "project", threadId, workspaceRoot, branch: vcs.branch, isGitRepository: vcs.isRepo});
    }
    return targets;
  }

  private async targetWorkspace(projectId: string, threadId: string | null, signal: AbortSignal): Promise<string | null> {
    const catalog = await Effect.runPromise(this.source.catalog(), {signal});
    const project = catalog.projects.find(item => item.project.id === projectId && item.available);
    if (!project || this.isScratchProject(projectId, project.project.workspaceRoot)) return null;
    return this.currentWorkspace(projectId, threadId, signal);
  }

  private async serialSetup<A>(key: string, work: () => Promise<A>): Promise<A> {
    const previous = this.setupQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {release = resolve;});
    this.setupQueues.set(key, current);
    await previous.catch(() => undefined);
    try {return await work();}
    finally {release();if (this.setupQueues.get(key) === current) this.setupQueues.delete(key);}
  }

  private setupOutcome(status: ProjectDefinitionSetupOutcome["status"], workspaceRoot: string | null, branch: string | null, message: string, path = ".t3-supervisor"): ProjectDefinitionSetupOutcome {
    return {status, workspaceRoot, branch, path, message};
  }

  private globalSetupOutcome(status: ProjectDefinitionGlobalSetupOutcome["status"], message: string): ProjectDefinitionGlobalSetupOutcome {
    return {status, workspaceRoot: this.globalHomePath(), branch: null, path: this.globalDefinitionsPath(), message};
  }

  private async checkCommitSafety(projectId: string, threadId: string | null, root: string, expectedBranch: string | null, expectedPaths: readonly string[], signal: AbortSignal): Promise<CommitSafetyCheck> {
    if (!this.files.gitOperationState || !this.files.vcsInfo || !this.options.gitProbe) return {status: "unavailable", branch: null, message: "A fresh local Git status probe is required to commit safely."};
    let operationState: Awaited<ReturnType<NonNullable<ProjectFiles["gitOperationState"]>>>;
    try {operationState = await this.files.gitOperationState(root, signal);}
    catch {return {status: "unavailable", branch: null, message: "T3 could not verify the checkout's Git operation state."};}
    if (operationState.status === "in_progress") return {status: "conflict", branch: expectedBranch, message: `Create + commit is unavailable while Git operation ${operationState.marker} is in progress.`};
    if (operationState.status === "unavailable") return {status: "unavailable", branch: expectedBranch, message: operationState.message};
    let currentRoot: string | null;
    let currentVcs: Awaited<ReturnType<NonNullable<ProjectFiles["vcsInfo"]>>>;
    try {
      currentRoot = await this.targetWorkspace(projectId, threadId, signal);
      currentVcs = await this.files.vcsInfo(root, signal);
    } catch {return {status: "unavailable", branch: null, message: "T3 could not verify the selected checkout before commit."};}
    if (currentRoot !== root || currentVcs.branch !== expectedBranch) return {status: "stale", branch: currentVcs.branch, message: "The selected checkout or branch changed; reload the setup choices."};
    if (!currentVcs.isRepo) return {status: "unavailable", branch: currentVcs.branch, message: "Create + commit requires a Git repository."};
    let fresh;
    try {fresh = await this.options.gitProbe(root, signal);}
    catch {return {status: "unavailable", branch: currentVcs.branch, message: "T3 could not obtain a fresh local Git status; no commit was attempted."};}
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
    const latestRoot = await this.targetWorkspace(projectId, threadId, signal).catch(() => null);
    if (latestRoot !== root) return {status: "stale", branch: fresh.branch, message: "The selected checkout changed during the fresh Git check; reload the setup choices."};
    return {status: "safe", branch: fresh.branch};
  }

  async initializeGlobal(signal: AbortSignal): Promise<ProjectDefinitionGlobalSetupOutcome> {
    const root = this.globalRoot;
    if (!root) return this.globalSetupOutcome("unavailable", "The T3 server-home root is not configured.");
    return this.serialSetup(`global:${root}`, async () => {
      const presence = await this.scopePresence(root, true, signal);
      if (presence.status === "present") return this.globalSetupOutcome("unchanged", "The existing global definition folder was preserved without changes.");
      if (presence.status === "unavailable") return this.globalSetupOutcome("unavailable", presence.message ?? "The global definition folder could not be checked safely.");
      if (!this.options.setupWriter) return this.globalSetupOutcome("permission_required", "A dedicated filesystem:write credential is required to create the global definition scaffold.");
      const outcome = await this.createScaffold(root, "global", "create", signal);
      if (outcome.status === "stale") return this.globalSetupOutcome("unavailable", "Global setup was canceled before completion; no setting was changed.");
      if (outcome.status === "committed") return this.globalSetupOutcome("uncertain", "Global setup does not commit files; refresh the server-home folder before retrying.");
      return this.globalSetupOutcome(outcome.status, outcome.message);
    });
  }

  async initialize(projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput, signal: AbortSignal): Promise<ProjectDefinitionSetupOutcome> {
    const root = await this.targetWorkspace(projectId, threadId, signal);
    if (!root || root !== posix.normalize(input.expectedWorkspaceRoot)) return this.setupOutcome("stale", root, null, "The selected checkout changed. Reload checkout choices before setup.");
    return this.serialSetup(`project:${root}`, async () => {
      const vcs = this.files.vcsInfo ? await this.files.vcsInfo(root, signal) : null;
      if (!vcs || vcs.branch !== input.expectedBranch) return this.setupOutcome("stale", root, vcs?.branch ?? null, "The selected checkout branch changed. Reload checkout choices before setup.");
      if (input.action === "create_and_commit" && !vcs.isRepo) return this.setupOutcome("unavailable", root, vcs.branch, "Create and commit is unavailable because this checkout is not a Git repository.");
      if (!this.options.setupWriter) return this.setupOutcome("permission_required", root, vcs.branch, "A dedicated filesystem:write credential is required to create the project definition scaffold.");
      if (input.action === "create_and_commit" && !this.options.setupWriter.commitFiles) return this.setupOutcome("permission_required", root, vcs.branch, "A dedicated source-control write credential is required to commit the new project definition files.");
      return this.createScaffold(root, "project", input.action, signal, projectId, threadId, input.expectedBranch);
    });
  }

  private async createScaffold(root: string, origin: DefinitionOrigin, action: "create" | "create_and_commit", signal: AbortSignal, projectId?: string, threadId?: string | null, expectedBranch?: string | null): Promise<ProjectDefinitionSetupOutcome> {
    const path = origin === "global" ? this.globalDefinitionsPath() : ".t3-supervisor";
    const setupWriter = this.options.setupWriter;
    if (!setupWriter) return this.setupOutcome("permission_required", root, expectedBranch ?? null, "A dedicated filesystem:write credential is required to create the definition scaffold.", path);
    const initialPresence = await this.scopePresence(root, origin === "global", signal);
    if (initialPresence.status === "present") return this.setupOutcome(origin === "global" ? "unchanged" : "conflict", root, expectedBranch ?? null,
      origin === "global" ? "The existing global definition folder was preserved without changes." : "The selected checkout already has a .t3-supervisor folder; no files were changed.", path);
    if (initialPresence.status === "unavailable") return this.setupOutcome("unavailable", root, expectedBranch ?? null, initialPresence.message ?? "The definition folder could not be checked safely.", path);
    if (origin === "project" && projectId && this.files.vcsInfo) {
      const currentRoot = await this.targetWorkspace(projectId, threadId ?? null, signal);
      const currentVcs = await this.files.vcsInfo(root, signal);
      if (currentRoot !== root || currentVcs.branch !== expectedBranch) return this.setupOutcome("stale", root, currentVcs.branch, "The selected checkout changed before setup began.", path);
    }
    const configPath = ".t3-supervisor/project.yaml";
    const stepsMarkerPath = ".t3-supervisor/steps/.gitkeep";
    const workflowsMarkerPath = ".t3-supervisor/workflows/.gitkeep";
    const configContents = "required: []\n";
    const filesToCreate = [configPath, stepsMarkerPath, workflowsMarkerPath] as const;
    const written = new Set<string>();
    let safetyMessage: string | null = null;
    const safeWrite = async (filePath: string, contents: string): Promise<"written" | "conflict" | "stale" | "permission_required" | "unavailable" | "uncertain"> => {
      try {
        safetyMessage = null;
        // native writeFile has no create-only precondition, so the existence guard cannot eliminate external races.
        if (signal.aborted) return "stale";
        const presence = await this.scopePresence(root, origin === "global", signal);
        if (presence.status === "unavailable") return "uncertain";
        if (filePath === configPath && presence.status === "present") return "conflict";
        if (filePath !== configPath && presence.status !== "present") return "uncertain";
        const folderListing = presence.status === "missing"
          ? {truncated: false, entries: [] as Array<{path: string; kind: "file" | "directory"}>}
          : await this.files.list(root, ".t3-supervisor", signal);
        if (folderListing.truncated) return "uncertain";
        const expectedRoot = new Map<string, "file" | "directory">();
        if (written.has(configPath)) expectedRoot.set(configPath, "file");
        if (written.has(stepsMarkerPath)) expectedRoot.set(".t3-supervisor/steps", "directory");
        if (written.has(workflowsMarkerPath)) expectedRoot.set(".t3-supervisor/workflows", "directory");
        const observedRoot = new Map(folderListing.entries.map(entry => [entry.path, entry.kind]));
        if (observedRoot.size !== folderListing.entries.length || observedRoot.size !== expectedRoot.size ||
          [...expectedRoot].some(([path, kind]) => observedRoot.get(path) !== kind)) return "conflict";
        for (const [markerPath, directoryPath] of [[stepsMarkerPath, ".t3-supervisor/steps"], [workflowsMarkerPath, ".t3-supervisor/workflows"]] as const) {
          if (!written.has(markerPath)) continue;
          const directoryListing = await this.files.list(root, directoryPath, signal);
          if (directoryListing.truncated) return "uncertain";
          if (directoryListing.entries.length !== 1 || directoryListing.entries[0]?.path !== markerPath || directoryListing.entries[0]?.kind !== "file") return "conflict";
          const marker = await this.files.read(root, markerPath, signal);
          if (marker.truncated || marker.contents !== "") return "conflict";
        }
        const existing = await this.files.read(root, filePath, signal).then(() => "present" as const).catch(error =>
          error instanceof ProjectFileError && error.code === "missing" ? "missing" as const : "unknown" as const);
        if (existing === "present") return "conflict";
        if (existing === "unknown") return "uncertain";
        if (signal.aborted) return "stale";
        if (origin === "project" && projectId && action === "create_and_commit") {
          const expectedPaths = [...written];
          const safety = await this.checkCommitSafety(projectId, threadId ?? null, root, expectedBranch ?? null, expectedPaths, signal);
          if (safety.status !== "safe") safetyMessage = `${safety.message} ${written.size ? "Files created so far were left uncommitted." : "No setup files were written."}`;
          if (safety.status === "stale") return "stale";
          if (safety.status === "conflict") return "conflict";
          if (safety.status === "unavailable") return "unavailable";
        } else if (origin === "project" && projectId && this.files.vcsInfo) {
          const currentRoot = await this.targetWorkspace(projectId, threadId ?? null, signal);
          const currentVcs = await this.files.vcsInfo(root, signal);
          if (currentRoot !== root || currentVcs.branch !== expectedBranch) return "stale";
        }
        if (signal.aborted) return "stale";
        await setupWriter.writeFile(root, filePath, contents, signal);
        const readback = await this.files.read(root, filePath, signal);
        if (readback.truncated || readback.contents !== contents) return "uncertain";
        written.add(filePath);
        return "written";
      } catch (error) {
        if (error instanceof ProjectFileError && error.code === "permission_required") return "permission_required";
        return "uncertain";
      }
    };
    for (const [index, filePath] of filesToCreate.entries()) {
      const contents = filePath === configPath ? configContents : "";
      const result = await safeWrite(filePath, contents);
      if (result !== "written") return this.setupOutcome(result === "permission_required" ? "permission_required" : result === "conflict" ? "conflict" : result === "stale" ? "stale" : result === "unavailable" ? "unavailable" : "uncertain", root, expectedBranch ?? null,
        result === "stale" ? (written.size ? "Setup stopped because the selected checkout changed or was canceled; files created so far were left uncommitted." : "Setup stopped because the selected checkout changed or was canceled before writing.") :
          result === "conflict" ? safetyMessage ?? `The target changed or contains other files during setup; files created so far remain uncommitted (${written.size} of 3).` :
            result === "unavailable" ? safetyMessage ?? "A fresh local Git status could not be verified; no further setup files were written." :
              `The ${filePath} write could not be confirmed; a partial scaffold may remain, left uncommitted, and setup was not enabled.`, path);
      if (index < filesToCreate.length - 1 && signal.aborted)
        return this.setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; files created so far were left uncommitted.", path);
    }
    if (action === "create") return this.setupOutcome("created", root, expectedBranch ?? null, "Created project.yaml, steps/.gitkeep and workflows/.gitkeep; all files are uncommitted.", path);
    if (!setupWriter.commitFiles) return this.setupOutcome("permission_required", root, expectedBranch ?? null, "The files were created, but a dedicated source-control write credential is required to commit them.", path);
    if (origin === "project" && projectId) {
      const config = await this.files.read(root, configPath, signal);
      const stepsMarker = await this.files.read(root, stepsMarkerPath, signal);
      const workflowsMarker = await this.files.read(root, workflowsMarkerPath, signal);
      if (config.truncated || stepsMarker.truncated || workflowsMarker.truncated || config.contents !== configContents || stepsMarker.contents !== "" || workflowsMarker.contents !== "")
        return this.setupOutcome("conflict", root, expectedBranch ?? null, "The setup files changed before commit; they were left uncommitted.", path);
      let folderEntries: Awaited<ReturnType<ProjectFiles["list"]>>;
      let stepsEntries: Awaited<ReturnType<ProjectFiles["list"]>>;
      let workflowsEntries: Awaited<ReturnType<ProjectFiles["list"]>>;
      try {
        folderEntries = await this.files.list(root, ".t3-supervisor", signal);
        stepsEntries = await this.files.list(root, ".t3-supervisor/steps", signal);
        workflowsEntries = await this.files.list(root, ".t3-supervisor/workflows", signal);
      } catch {
        return this.setupOutcome("uncertain", root, expectedBranch ?? null, "T3 could not verify that the setup folder contains only the three new files; they were left uncommitted.", path);
      }
      if (folderEntries.truncated || stepsEntries.truncated || workflowsEntries.truncated)
        return this.setupOutcome("uncertain", root, expectedBranch ?? null, "T3 returned an incomplete setup folder listing; the files were left uncommitted.", path);
      const folderContents = folderEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      const stepsContents = stepsEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      const workflowsContents = workflowsEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      if (JSON.stringify(folderContents) !== JSON.stringify([[configPath, "file"], [".t3-supervisor/steps", "directory"], [".t3-supervisor/workflows", "directory"]]) ||
        JSON.stringify(stepsContents) !== JSON.stringify([[stepsMarkerPath, "file"]]) ||
        JSON.stringify(workflowsContents) !== JSON.stringify([[workflowsMarkerPath, "file"]]))
        return this.setupOutcome("conflict", root, expectedBranch ?? null, "The setup folder contains other files; the new setup files were left uncommitted.", path);
      if (signal.aborted) return this.setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; the files were left uncommitted.", path);
      const safety = await this.checkCommitSafety(projectId, threadId ?? null, root, expectedBranch ?? null, filesToCreate, signal);
      if (safety.status !== "safe") return this.setupOutcome(safety.status, root, safety.branch, `${safety.message} The setup files were left uncommitted.`, path);
    }
    if (signal.aborted) return this.setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; the files were left uncommitted.", path);
    const actionId = `supervisor-setup-${createHash("sha256").update(JSON.stringify([origin, root, expectedBranch, configContents])).digest("hex").slice(0, 32)}`;
    try {
      const commit = await setupWriter.commitFiles(root, filesToCreate, "Initialize T3 Supervisor definitions", actionId, signal);
      if (commit.status === "uncertain") return this.setupOutcome("uncertain", root, expectedBranch ?? null, "The commit result is uncertain. The setup paths were submitted and may remain staged; inspect the checkout and commit history before retrying.", path);
      if (!commit.commitSha) return this.setupOutcome("uncertain", root, expectedBranch ?? null, "The commit result could not be verified. Refresh the checkout before retrying.", path);
      return this.setupOutcome("committed", root, expectedBranch ?? null, "T3 completed the requested setup commit. Repository hooks and signing apply; hooks can change which files it contains.", path);
    } catch (error) {
      if (error instanceof ProjectFileError && error.code === "permission_required") return this.setupOutcome("permission_required", root, expectedBranch ?? null, "The files were created, but native source-control write permission is unavailable.", path);
      return this.setupOutcome("uncertain", root, expectedBranch ?? null, "The files were created, but the native commit result is uncertain. Refresh the checkout before retrying.", path);
    }
  }

  async load(projectId: string, threadId: string | null = null, parentSignal?: AbortSignal): Promise<ProjectDefinitionSnapshot> {
    const result: MutableSnapshot = {projectId, threadId, workspaceRoot: "", globalOnly: false, revision: null, editingAvailable: false,
      status: "unavailable", steps: [], workflows: [], config: {required: []}, projectConfig: null, complete: false, sources: [], issues: []};
    const inputs: unknown[] = [];
    const deadline = AbortSignal.timeout(30_000);
    const signal = parentSignal ? AbortSignal.any([deadline, parentSignal]) : deadline;
    const issue = (path: string, code: string, message: string) => result.issues.push({path, code, message});
    try {
      const catalog = await Effect.runPromise(this.source.catalog(), {signal});
      const project = catalog.projects.find(item => item.project.id === projectId && item.available);
      if (!project) {issue("", "project_unavailable", "Select an available registered project.");return result;}
      const registeredRoot = text(project.project.workspaceRoot, 4096) && posix.isAbsolute(project.project.workspaceRoot) && !project.project.workspaceRoot.includes("\\")
        ? posix.normalize(project.project.workspaceRoot) : null;
      if (!registeredRoot) {issue("", "workspace_invalid", "T3 must supply an absolute Mac or Linux workspace path.");return result;}
      let root = registeredRoot;
      if (threadId !== null) {
        const snapshot = await Effect.runPromise(this.t3.projection(threadId), {signal});
        const thread = snapshot.projection.thread;
        if (thread.id !== threadId || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt) {
          issue("", "thread_unavailable", "The conversation does not belong to this available project.");return result;
        }
        if (thread.worktreePath === undefined) {issue("", "workspace_invalid", "T3 did not supply the conversation's worktree binding.");return result;}
        if (thread.worktreePath !== null) {
          if (!text(thread.worktreePath, 4096) || !posix.isAbsolute(thread.worktreePath) || thread.worktreePath.includes("\\")) {
            issue("", "workspace_invalid", "T3 returned an invalid worktree binding.");return result;
          }
          root = posix.normalize(thread.worktreePath);
        }
      }
      result.workspaceRoot = root;
      const scratch = this.isScratchProject(projectId, registeredRoot);
      result.globalOnly = scratch;
      const globalEnabled = this.globalEnabled(projectId);
      inputs.push(["globalDefinitionsEnabled", globalEnabled]);
      const budget = {value: 0, files: 0};
      const emptyScope = (): DefinitionScopeRead => ({status: "missing", complete: true, steps: [], workflows: [], config: {required: []}, projectConfig: null, sources: [], issues: [], inputs: []});
      const globalScope = globalEnabled && this.globalRoot ? await this.readScope(this.globalRoot, "global", signal, budget) : emptyScope();
      result.globalRevision = globalEnabled ? this.fingerprintGlobalScope(globalScope) : null;
      inputs.push(["global", globalEnabled ? globalScope.inputs : ["disabled"]]);
      const projectScope = scratch ? emptyScope() : await this.readScope(root, "project", signal, budget);
      inputs.push(["project", scratch ? ["global-only", root] : projectScope.inputs]);
      const namespacedGlobal = globalEnabled ? this.namespaceGlobal(globalScope, projectScope) : globalScope;
      result.steps = [...namespacedGlobal.steps, ...projectScope.steps];
      result.workflows = [...namespacedGlobal.workflows, ...projectScope.workflows];
      result.projectConfig = scratch ? null : projectScope.projectConfig;
      result.config = {
        required: [...(globalEnabled ? namespacedGlobal.config.required : []), ...projectScope.config.required],
        ...((projectScope.config.default_workflow ?? (globalEnabled ? namespacedGlobal.config.default_workflow : undefined))
          ? {default_workflow: projectScope.config.default_workflow ?? namespacedGlobal.config.default_workflow} : {}),
      };
      result.sources = [...(globalEnabled ? globalScope.sources : []), ...projectScope.sources];
      result.issues.push(...namespacedGlobal.issues, ...projectScope.issues);
      const activeScopes = [...(globalEnabled ? [globalScope] : []), ...(!scratch ? [projectScope] : [])];
      result.complete = activeScopes.every(scope => scope.complete);
      const stepsById = new Map(result.steps.map(step => [step.id, step]));
      const workflowsById = new Map(result.workflows.map(workflow => [workflow.id, workflow]));
      const globalRequiredCount = globalEnabled ? namespacedGlobal.config.required.length : 0;
      for (const [index, reference] of result.config.required.entries()) {
        if (index < globalRequiredCount) continue;
        if ("step" in reference && !stepsById.has(reference.step))
          issue(".t3-supervisor/project.yaml", "required_step_missing", `Required step ${reference.step} is missing or invalid.`);
        if ("workflow" in reference && !workflowsById.has(reference.workflow))
          issue(".t3-supervisor/project.yaml", "required_workflow_missing", `Required workflow ${reference.workflow} is missing or invalid.`);
      }
      if (projectScope.projectConfig?.default_workflow && !workflowsById.has(projectScope.projectConfig.default_workflow))
        issue(".t3-supervisor/project.yaml", "default_workflow_missing", `Default workflow ${result.config.default_workflow} is missing or invalid.`);
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
      if (activeScopes.some(scope => scope.status === "permission_required")) result.status = "permission_required";
      else if (activeScopes.some(scope => scope.status === "unavailable")) result.status = "unavailable";
      else if (activeScopes.some(scope => scope.status === "invalid") || result.issues.some(item => item.code !== "global_definitions_missing")) result.status = "invalid";
      else if (globalEnabled && globalScope.status === "missing") result.status = "missing";
      else if (scratch && globalEnabled) result.status = globalScope.status;
      else if (scratch) result.status = "ready";
      else if (projectScope.status === "missing") result.status = "missing";
      else result.status = "ready";
      if (result.status === "missing" && scratch && globalEnabled && !result.issues.length)
        issue(this.globalDefinitionsPath(), "global_definitions_missing", "Create the global .t3-supervisor folder to make shared definitions available in Scratch.");
      if (result.complete) result.revision = createHash("sha256").update(JSON.stringify([projectId, threadId, root, scratch, inputs])).digest("hex");
      if (result.status === "permission_required" || result.status === "unavailable") {
        result.complete = false;
        result.revision = null;
        if (!result.issues.length) issue(this.globalDefinitionsPath(), result.status, result.status === "permission_required"
          ? "The active global or project definition scope requires filesystem:read access."
          : "An active definition scope could not be read; no empty requirements were assumed.");
      }
    } catch (error) {
      result.complete = false;
      result.revision = null;
      result.status = error instanceof DefinitionReadLimit ? "invalid" : error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable";
      issue(this.globalDefinitionsPath(), result.status, error instanceof ProjectFileError || error instanceof DefinitionReadLimit ? error.message : "Project definitions could not be read; check the T3 connection and workspace.");
    }
    return result;
  }
}
