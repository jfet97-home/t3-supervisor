import { isMap, isSeq, parseDocument, stringify } from "yaml";
import { posix } from "node:path";
import { ProjectDefinitionLoader, parseProjectConfiguration } from "./project-definitions.js";
import { ProjectFileError, type ProjectWriter } from "./project-files.js";
import { normalizeProjectConfiguration, type ProjectConfigSave, type ProjectConfigSaveOutcome, type ProjectConfigurationInfo, type ProjectDefinitionSnapshot } from "./project-definitions-contract.js";

const configDocument = (config: ProjectConfigurationInfo) => ({
  workflows: config.workflows.map(entry => ({id: entry.id, path: entry.path, summary: entry.summary, required: entry.required})),
  steps: config.steps.map(entry => ({id: entry.id, path: entry.path, summary: entry.summary, required: entry.required})),
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
        const matching = prior.find(node => isMap(node) && node.get("id") === entry.id);
        if (!matching) return document.createNode({id: entry.id, path: entry.path, summary: entry.summary, required: entry.required});
        const node = (matching as {clone: () => unknown}).clone() as ReturnType<typeof document.createNode> & {get(key: string): unknown; set(key: string, value: unknown): void};
        for (const field of ["path", "summary", "required"] as const) if (node.get(field) !== entry[field]) node.set(field, entry[field]);
        return node;
      });
    }
    if (config.default_workflow === undefined) document.delete("default_workflow");
    else document.set("default_workflow", config.default_workflow);
    const contents = document.toString({lineWidth: 0});
    return JSON.stringify(parseProjectConfiguration(contents)) === JSON.stringify(config) ? contents : intended;
  } catch {return intended;}
};

/** Saves only the checkout-local project.yaml through the trusted native writer. */
export class ProjectConfigEditor {
  private readonly active = new Map<string, Promise<void>>();
  constructor(readonly loader: ProjectDefinitionLoader, readonly writer: ProjectWriter,
    readonly onSaved?: (definitions: ProjectDefinitionSnapshot, expectedRevision: string) => void) {}

  async save(input: ProjectConfigSave, parentSignal?: AbortSignal): Promise<ProjectConfigSaveOutcome> {
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const outcome = (status: ProjectConfigSaveOutcome["status"], message: string, definitions: ProjectDefinitionSnapshot | null = null): ProjectConfigSaveOutcome =>
      ({status, message, definitions: definitions ? {...definitions, editingAvailable: true} : null});
    const checkProjectConfigFile = this.writer.checkProjectConfigFile;
    const writeProjectConfig = this.writer.writeProjectConfig;
    if (!checkProjectConfigFile || !writeProjectConfig) return outcome("permission_required", "Project configuration editing needs the trusted native filesystem writer.");
    let intended: ReturnType<typeof parseProjectConfiguration>;
    try {
      intended = parseProjectConfiguration(stringify(configDocument(normalizeProjectConfiguration(input.config)), {lineWidth: 0}));
    } catch (error) {return outcome("invalid", error instanceof Error ? error.message : "Check the project.yaml index entries.");}
    if (Buffer.byteLength(stringify(configDocument(intended), {lineWidth: 0}), "utf8") > 64 * 1024 || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
      return outcome("invalid", "Check the 64 KiB project.yaml limit and refresh the definitions.");

    const initial = await this.loader.load(input.projectId, input.threadId, signal);
    if (initial.globalOnly) return outcome("unavailable", "Shared global configuration is read-only in project settings.", initial);
    if (!initial.complete || !initial.revision) return outcome(initial.status === "permission_required" ? "permission_required" : "unavailable",
      "Project configuration cannot be edited until the selected definition collection is fully readable.", initial);
    const root = initial.workspaceRoot;
    if (!posix.isAbsolute(root)) return outcome("unavailable", "The selected project checkout has no safe native write root.", initial);
    const previousSave = this.active.get(root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {release = resolve;});
    const queued = previousSave.then(() => current);
    this.active.set(root, queued);
    try {
      await previousSave;
      if (signal.aborted) return outcome("unavailable", "The save expired before writing. Refresh the project configuration.");
      const fresh = await this.loader.load(input.projectId, input.threadId, signal);
      if (!fresh.complete || !fresh.revision || fresh.workspaceRoot !== root || fresh.revision !== input.expectedRevision)
        return outcome("conflict", "The checkout or definition sources changed. Your draft was kept; refresh before saving again.", fresh);
      if (fresh.globalOnly) return outcome("conflict", "The selected definition scope changed. Refresh before saving.", fresh);
      // every row names an existing definition file of this checkout; the editor never creates, renames or removes files
      const files = new Set(fresh.definitionFiles.filter(file => file.origin === "project").map(file => `${file.kind}:${file.path}`));
      for (const kind of ["workflows", "steps"] as const) {
        const missing = intended[kind].find(entry => !files.has(`${kind}:${entry.path}`));
        if (missing) return outcome("invalid", `Indexed ${kind === "workflows" ? "workflow" : "step"} ${missing.id} needs an existing .t3-supervisor/${missing.path}; add the file to the repository or remove the row.`, fresh);
      }
      const target = ".t3-supervisor/project.yaml";
      const previousContents = fresh.sources.find(source => source.origin === "project" && source.path === target)?.content;
      const contents = serializeConfig(intended, previousContents);
      if (Buffer.byteLength(contents, "utf8") > 64 * 1024)
        return outcome("invalid", "The serialized project.yaml exceeds the 64 KiB source limit.", fresh);
      const checkTarget = () => checkProjectConfigFile(root, signal);
      try {
        if (!await checkTarget()) return outcome("unavailable", "Editing requires an existing .t3-supervisor directory and a regular project.yaml file.", fresh);
      } catch (error) {
        return outcome(error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable",
          "Could not verify the project.yaml write target with the native filesystem:read permission.", fresh);
      }
      if (await this.loader.currentWorkspace(input.projectId, input.threadId, signal) !== root)
        return outcome("conflict", "The selected checkout changed before writing. Refresh before saving again.");
      if (signal.aborted) return outcome("unavailable", "The save expired before writing. Refresh the project configuration.");
      try {await writeProjectConfig(root, contents, signal);}
      catch (error) {
        if (error instanceof ProjectFileError && error.code === "permission_required")
          return outcome("permission_required", error.message, fresh);
        return outcome("uncertain", "The write outcome could not be confirmed. Your draft was kept. Refresh and inspect project.yaml before retrying.");
      }
      const verified = await this.loader.load(input.projectId, input.threadId, signal);
      try {
        const bytes = await this.loader.files.read(root, target, signal);
        if (!await checkTarget() || bytes.truncated || bytes.contents !== contents || bytes.byteLength !== Buffer.byteLength(contents, "utf8"))
          return outcome("uncertain", "The project.yaml write could not be confirmed exactly. Refresh and inspect the file before retrying.", verified);
      } catch {return outcome("uncertain", "The write was accepted, but native readback could not confirm project.yaml. Refresh before retrying.", verified);}
      if (!verified.complete || verified.workspaceRoot !== root || !verified.revision || !verified.projectConfig ||
        JSON.stringify(verified.projectConfig) !== JSON.stringify(intended))
        return outcome("uncertain", "T3 accepted the write, but the refreshed project configuration could not confirm it. Refresh and inspect project.yaml before retrying.", verified);
      try {this.onSaved?.(verified, input.expectedRevision);}
      catch {return outcome("uncertain", "The file was saved, but its user-authorization record could not be retained. Refresh before retrying.", verified);}
      return outcome("saved", "Saved .t3-supervisor/project.yaml. Required flags remain visible to the Supervisor for semantic review.", verified);
    } finally {
      release();
      if (this.active.get(root) === queued) this.active.delete(root);
    }
  }
}
