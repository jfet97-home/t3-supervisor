import { Cause, Context, Effect, Layer, RcMap, Result, Scope, Semaphore } from "effect";
import { isMap, isSeq, parseDocument, stringify } from "yaml";
import { posix } from "node:path";
import {decodeDefinitionSource, definitionsCanceled, definitionsOperation, definitionsSignal, DefinitionSourceFailure, DefinitionSourceInvalid,
  parseProjectConfiguration, ProjectConfigurationSource, ProjectDefinitions, withOperationCancel} from "./project-definitions.js";
import { ProjectFileError, type ProjectWriter } from "./project-files.js";
import { type DefinitionCatalogEntry, type ProjectConfigSave, type ProjectConfigSaveOutcome, type ProjectConfigurationInfo, type ProjectDefinitionSnapshot } from "./project-definitions-contract.js";

const projectConfigPath = ".t3-supervisor/project.yaml";

// the saved index is compact: a required entry says required: true and every other entry omits the flag
const entryDocument = (entry: DefinitionCatalogEntry) => ({path: entry.path, summary: entry.summary, ...(entry.required ? {required: true} : {})});
const configDocument = (config: ProjectConfigurationInfo) => ({
  workflows: config.workflows.map(entryDocument),
  steps: config.steps.map(entryDocument),
  ...(config.default_workflow ? {default_workflow: config.default_workflow} : {}),
});

// retained index rows keep their YAML node, and so their comments; changed fields are rewritten in place
const serializeConfig = (config: ProjectConfigurationInfo, previous?: string): string => {
  const intended = stringify(configDocument(config), {lineWidth: 0});
  if (!previous) return intended;
  try {
    parseProjectConfiguration(previous);
    const document = parseDocument(previous, {schema: "core", uniqueKeys: true});
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return intended;
    for (const kind of ["workflows", "steps"] as const) {
      const list = document.get(kind, true);
      if (!isSeq(list)) return intended;
      const prior = [...list.items];
      list.items = config[kind].map(entry => {
        const matching = prior.find(node => isMap(node) && node.get("path") === entry.path);
        if (!matching) return document.createNode(entryDocument(entry));
        const node = (matching as {clone: () => unknown}).clone() as ReturnType<typeof document.createNode> & {get(key: string): unknown; set(key: string, value: unknown): void;
          delete(key: string): boolean};
        if (node.get("summary") !== entry.summary) node.set("summary", entry.summary);
        if (entry.required) {if (node.get("required") !== true) node.set("required", true);}
        else node.delete("required");
        return node;
      });
    }
    if (config.default_workflow === undefined) document.delete("default_workflow");
    else document.set("default_workflow", config.default_workflow);
    const contents = document.toString({lineWidth: 0});
    return JSON.stringify(parseProjectConfiguration(contents)) === JSON.stringify(config) ? contents : intended;
  } catch {return intended;}
};

// what saving needs from the definitions: fresh snapshots, the operative checkout and the native readback of project.yaml
export type ProjectConfigDefinitions = Pick<ProjectDefinitions["Service"], "load" | "currentWorkspace" | "readProjectConfig">;
// retains the user authorization of a verified save; a throw makes the save uncertain
// records an explicit user save in the supervision store; a failure leaves the save uncertain
export type DefinitionSaveRecorder = (definitions: ProjectDefinitionSnapshot, expectedRevision: string) => Effect.Effect<void, unknown>;
// what saving needs from the native writer: the target check and the fixed project.yaml write
export type ProjectConfigWriter = Pick<ProjectWriter["Service"], "checkProjectConfigFile" | "writeProjectConfig">;
type EditorOptions = {readonly definitions: ProjectConfigDefinitions; readonly writer: ProjectConfigWriter; readonly onSaved?: DefinitionSaveRecorder | undefined};

const makeProjectConfigEditor = Effect.fnUntraced(function* ({definitions, writer, onSaved}: EditorOptions) {
  // saves of one checkout run one after another; each save leases its root's lock and releases it when it ends
  const saveLocks = yield* RcMap.make({lookup: (_root: string) => Semaphore.make(1)});

  const save = (input: ProjectConfigSave): Effect.Effect<ProjectConfigSaveOutcome, DefinitionSourceFailure> => Effect.gen(function* () {
    // the save's own signal (its caller's cancel signal narrowed by its deadline) goes to every definitions call, as the baseline passed its signal
    const operation = yield* definitionsSignal;
    const outcome = (status: ProjectConfigSaveOutcome["status"], message: string, snapshot: ProjectDefinitionSnapshot | null = null): ProjectConfigSaveOutcome =>
      ({status, message, definitions: snapshot ? {...snapshot, editingAvailable: true} : null});
    // the writer's methods are read for every save, as the baseline read them
    const checkProjectConfigFile = writer.checkProjectConfigFile;
    const writeProjectConfig = writer.writeProjectConfig;
    if (!checkProjectConfigFile || !writeProjectConfig) return outcome("permission_required", "Project configuration editing needs the trusted native filesystem writer.");
    // the submitted object is decoded as written, so a legacy or unknown field is rejected rather than dropped
    const submitted = yield* Effect.result(Effect.try({try: () => stringify(input.config, {lineWidth: 0}),
      catch: error => new DefinitionSourceInvalid({problem: error instanceof Error ? error.message : undefined})}).pipe(
      Effect.flatMap(text => decodeDefinitionSource(ProjectConfigurationSource, text))));
    if (Result.isFailure(submitted)) return outcome("invalid", submitted.failure.problem ?? "Check the project.yaml index entries.");
    const intended = submitted.success;
    if (Buffer.byteLength(stringify(configDocument(intended), {lineWidth: 0}), "utf8") > 64 * 1024 || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
      return outcome("invalid", "Check the 64 KiB project.yaml limit and refresh the definitions.");

    const initial = yield* definitions.load(input.projectId, input.threadId, operation);
    if (initial.globalOnly) return outcome("unavailable", "Shared global configuration is read-only in project settings.", initial);
    if (!initial.complete || !initial.revision) return outcome(initial.status === "permission_required" ? "permission_required" : "unavailable",
      "Project configuration cannot be edited until the selected definition collection is fully readable.", initial);
    const root = initial.workspaceRoot;
    if (!posix.isAbsolute(root)) return outcome("unavailable", "The selected project checkout has no safe native write root.", initial);
    return yield* Effect.scoped(Effect.flatMap(RcMap.get(saveLocks, root), lock => lock.withPermit(Effect.gen(function* () {
      if (yield* definitionsCanceled) return outcome("unavailable", "The save expired before writing. Refresh the project configuration.");
      const fresh = yield* definitions.load(input.projectId, input.threadId, operation);
      if (!fresh.complete || !fresh.revision || fresh.workspaceRoot !== root || fresh.revision !== input.expectedRevision)
        return outcome("conflict", "The checkout or definition sources changed. Your draft was kept; refresh before saving again.", fresh);
      if (fresh.globalOnly) return outcome("conflict", "The selected definition scope changed. Refresh before saving.", fresh);
      // every row names an existing definition file of this checkout; the editor never creates, renames or removes files
      const files = new Set(fresh.definitionFiles.filter(file => file.origin === "project").map(file => `${file.kind}:${file.path}`));
      for (const kind of ["workflows", "steps"] as const) {
        const missing = intended[kind].find(entry => !files.has(`${kind}:${entry.path}`));
        if (missing) return outcome("invalid", `Indexed ${missing.path} needs an existing .t3-supervisor/${missing.path}; add the file to the repository or remove the row.`, fresh);
      }
      const previousContents = fresh.sources.find(source => source.origin === "project" && source.path === projectConfigPath)?.content;
      const contents = serializeConfig(intended, previousContents);
      if (Buffer.byteLength(contents, "utf8") > 64 * 1024)
        return outcome("invalid", "The serialized project.yaml exceeds the 64 KiB source limit.", fresh);
      const checkTarget = withOperationCancel(cancel => checkProjectConfigFile(root, cancel));
      const target = yield* Effect.result(checkTarget);
      if (Result.isFailure(target)) return outcome(target.failure.error instanceof ProjectFileError && target.failure.error.code === "permission_required" ? "permission_required" : "unavailable",
        "Could not verify the project.yaml write target with the native filesystem:read permission.", fresh);
      if (!target.success) return outcome("unavailable", "Editing requires an existing .t3-supervisor directory and a regular project.yaml file.", fresh);
      if ((yield* definitions.currentWorkspace(input.projectId, input.threadId, operation)) !== root)
        return outcome("conflict", "The selected checkout changed before writing. Refresh before saving again.");
      if (yield* definitionsCanceled) return outcome("unavailable", "The save expired before writing. Refresh the project configuration.");
      // a write failure other than a definite permission refusal is uncertain and never retried
      const wrote = yield* Effect.result(withOperationCancel(cancel => writeProjectConfig(root, contents, cancel)));
      if (Result.isFailure(wrote)) {
        const error = wrote.failure.error;
        if (error instanceof ProjectFileError && error.code === "permission_required") return outcome("permission_required", error.message, fresh);
        return outcome("uncertain", "The write outcome could not be confirmed. Your draft was kept. Refresh and inspect project.yaml before retrying.");
      }
      const verified = yield* definitions.load(input.projectId, input.threadId, operation);
      const readback = yield* Effect.result(Effect.gen(function* () {
        const bytes = yield* definitions.readProjectConfig(root, operation);
        const regular = yield* checkTarget;
        return yield* Effect.try({try: () => regular && !bytes.truncated && bytes.contents === contents && bytes.byteLength === Buffer.byteLength(contents, "utf8"),
          catch: error => new DefinitionSourceFailure({error})});
      }));
      if (Result.isFailure(readback)) return outcome("uncertain", "The write was accepted, but native readback could not confirm project.yaml. Refresh before retrying.", verified);
      if (!readback.success) return outcome("uncertain", "The project.yaml write could not be confirmed exactly. Refresh and inspect the file before retrying.", verified);
      if (!verified.complete || verified.workspaceRoot !== root || !verified.revision || !verified.projectConfig ||
        JSON.stringify(verified.projectConfig) !== JSON.stringify(intended))
        return outcome("uncertain", "T3 accepted the write, but the refreshed project configuration could not confirm it. Refresh and inspect project.yaml before retrying.", verified);
      const recorded = yield* Effect.result(onSaved ? Effect.catchCause(Effect.suspend(() => onSaved(verified, input.expectedRevision)), (cause) => Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>) : Effect.fail(new DefinitionSourceFailure({error: Cause.squash(cause)}))) : Effect.void);
      if (Result.isFailure(recorded)) return outcome("uncertain", "The file was saved, but its user-authorization record could not be retained. Refresh before retrying.", verified);
      return outcome("saved", "Saved .t3-supervisor/project.yaml. Required flags remain visible to the Supervisor for semantic review.", verified);
    }))));
  });

  return {save: (input: ProjectConfigSave, cancel?: AbortSignal) => save(input).pipe(definitionsOperation(cancel, "30 seconds"))};
});

/** Saves only the checkout-local project.yaml through the trusted native writer. */
export class ProjectConfigEditorService extends Context.Service<ProjectConfigEditorService, {
  // saves of one checkout are serialized; a stale revision, a missing file or an unconfirmed write is never reported saved (30 s deadline)
  // a save cancelled or past its deadline before writing reports the expired save once its turn comes
  readonly save: (input: ProjectConfigSave, cancel?: AbortSignal) => Effect.Effect<ProjectConfigSaveOutcome, DefinitionSourceFailure>;
}>()("t3-supervisor/ProjectConfigEditor") {
  static readonly make: (options: EditorOptions) => Effect.Effect<ProjectConfigEditorService["Service"], never, Scope.Scope> = makeProjectConfigEditor;
  static readonly layer = (writer: ProjectConfigWriter, onSaved?: DefinitionSaveRecorder): Layer.Layer<ProjectConfigEditorService, never, ProjectDefinitions> =>
    Layer.effect(ProjectConfigEditorService, Effect.gen(function* () {
      return yield* makeProjectConfigEditor({definitions: yield* ProjectDefinitions, writer, onSaved});
    }));
}

