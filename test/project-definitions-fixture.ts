import { Context, Effect, Layer, Scope } from "effect";
import { ProjectDefinitions, type ProjectDefinitionSources } from "../src/project-definitions.js";
import { ProjectConfigEditorService, type DefinitionSaveRecorder, type ProjectConfigDefinitions } from "../src/project-config-editor.js";
import { projectConfigEditorFacade, projectDefinitionsFacade } from "./support/root-facades.js";
import { ProjectFileError } from "../src/project-files.js";
import { asLoaderOptions, asProjectFiles, asProjectWriter, type ProjectDefinitionLoaderOptions, type ProjectFiles, type ProjectWriter } from "./support/native-files-promise.js";
import { stringify } from "yaml";
import { definitionCatalogPath, type DefinitionCatalogKind, type DefinitionReference, type EffectiveConfigurationInfo, type ProjectConfigurationInfo } from "../src/project-definitions-contract.js";

/** A navigation summary for test definitions; real summaries say what a definition is for and when it applies. */
export const testSummary = (id: string): string => `Use ${id} when the task needs it.`;
export const indexEntry = (kind: DefinitionCatalogKind, id: string, required = false, summary = testSummary(id)) =>
  ({path: definitionCatalogPath(kind, id), summary, required});
const flagged = (required: readonly DefinitionReference[], kind: DefinitionCatalogKind, id: string): boolean =>
  required.some(reference => kind === "steps" ? "step" in reference && reference.step === id : "workflow" in reference && reference.workflow === id);
type IndexOptions = {steps?: readonly string[]; workflows?: readonly string[]; required?: readonly DefinitionReference[]; default_workflow?: string};
/** An authored project.yaml index of the given definition IDs; required names the flagged ones. */
export const projectIndex = (options: IndexOptions = {}): ProjectConfigurationInfo => ({
  workflows: (options.workflows ?? []).map(id => indexEntry("workflows", id, flagged(options.required ?? [], "workflows", id))),
  steps: (options.steps ?? []).map(id => indexEntry("steps", id, flagged(options.required ?? [], "steps", id))),
  ...(options.default_workflow ? {default_workflow: options.default_workflow} : {}),
});
export const indexSource = (options: IndexOptions = {}): string => stringify(projectIndex(options), {lineWidth: 0});
type IndexedDefinition = {readonly id: string; readonly origin?: "global" | "project" | undefined; readonly sourceId?: string | undefined; readonly summary?: string | undefined};
/** The effective index a loader derives for a snapshot's definitions; a required ID without a definition keeps its row. */
export const effectiveIndex = (definitions: {readonly steps: readonly IndexedDefinition[]; readonly workflows: readonly IndexedDefinition[]},
  required: readonly DefinitionReference[] = [], default_workflow?: string): EffectiveConfigurationInfo => {
  const rows = (kind: DefinitionCatalogKind, items: readonly IndexedDefinition[]) => {
    const extra = required.flatMap(reference => kind === "steps" ? "step" in reference ? [reference.step] : [] : "workflow" in reference ? [reference.workflow] : [])
      .filter(id => !items.some(item => item.id === id)).map((id): IndexedDefinition => ({id}));
    return [...items, ...extra].map(item => ({id: item.id, ...indexEntry(kind, item.sourceId ?? item.id, flagged(required, kind, item.id), item.summary ?? testSummary(item.sourceId ?? item.id)),
      origin: item.origin ?? "project" as const, sourceId: item.sourceId ?? item.id}));
  };
  return {workflows: rows("workflows", definitions.workflows), steps: rows("steps", definitions.steps), ...(default_workflow ? {default_workflow} : {})};
};

export const stepSource = (id: string, description = "Inspect the changed behavior.") =>
  `---\nid: ${id}\nname: ${id}\ndescription: ${description}\n---\n`;

export const workflowSource = (name: string, nodes: string, options: {fixed?: boolean; group?: "sequence" | "parallel"} = {}) =>
  `name: ${name}\ndescription: ${name} workflow.\n${options.fixed ? "fixed: true\n" : ""}${options.group ?? "sequence"}:\n${nodes}`;

export function makeDefinitionFixture(options: {
  projectId?: string;
  root?: string;
  threadRoot?: string | null;
  scratch?: boolean;
  globalEnabled?: boolean;
} = {}) {
  const projectId = options.projectId ?? "project";
  const root = options.root ?? "/workspace";
  const threadRoot = options.threadRoot === undefined ? "/worktrees/feature" : options.threadRoot;
  const globalRoot = "/server-home";
  const trees = new Map<string, Map<string, string>>();
  const directories = new Set([root, globalRoot, "/worktrees/feature"]);
  const failures = new Map<string, ProjectFileError>();
  const truncatedPaths = new Set<string>();
  const truncatedFiles = new Set<string>();
  const calls: Array<{kind: "list" | "read"; root: string; path: string}> = [];
  const writes: Array<{root: string; path: string; contents: string}> = [];
  const addDirectory = (targetRoot: string, path: string) => {
    let current = targetRoot;
    for (const segment of path.split("/").filter(Boolean)) {
      current = current === "/" ? `/${segment}` : `${current}/${segment}`;
      directories.add(current);
    }
  };
  const addFile = (targetRoot: string, path: string, contents: string) => {
    let tree = trees.get(targetRoot);
    if (!tree) {tree = new Map();trees.set(targetRoot, tree);}
    tree.set(path, contents);
    directories.add(targetRoot);
    addDirectory(targetRoot, path.split("/").slice(0, -1).join("/"));
  };
  const list = async (targetRoot: string, path: string) => {
    calls.push({kind: "list", root: targetRoot, path});
    const failure = failures.get(`${targetRoot}|${path}`);
    if (failure) throw failure;
    if (path && !directories.has(`${targetRoot}/${path}`)) throw new ProjectFileError("missing");
    const tree = trees.get(targetRoot) ?? new Map<string, string>();
    const prefix = path ? `${path}/` : "";
    const entries = new Map<string, "file" | "directory">();
    const absolutePrefix = path ? `${targetRoot}/${path}/` : `${targetRoot}/`;
    for (const directory of directories) {
      if (!directory.startsWith(absolutePrefix)) continue;
      const remainder = directory.slice(absolutePrefix.length);
      if (!remainder) continue;
      const child = remainder.split("/")[0]!;
      const childPath = prefix ? `${prefix}${child}` : child;
      entries.set(childPath, "directory");
    }
    for (const filePath of tree.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (!remainder) continue;
      const child = remainder.split("/")[0]!;
      const childPath = prefix ? `${prefix}${child}` : child;
      entries.set(childPath, remainder.includes("/") ? "directory" : "file");
    }
    return {truncated: truncatedPaths.has(`${targetRoot}|${path}`), entries: [...entries].map(([entryPath, kind]) => ({path: entryPath, kind}))};
  };
  const files: ProjectFiles = {
    directoryExists: async path => directories.has(path),
    list: async (targetRoot, path) => list(targetRoot, path),
    read: async (targetRoot, path) => {
      calls.push({kind: "read", root: targetRoot, path});
      const failure = failures.get(`${targetRoot}|${path}`);
      if (failure) throw failure;
      const contents = trees.get(targetRoot)?.get(path);
      if (contents === undefined) throw new ProjectFileError("missing");
      return {contents, byteLength: Buffer.byteLength(contents, "utf8"), truncated: truncatedFiles.has(`${targetRoot}|${path}`)};
    },
    vcsInfo: async targetRoot => ({isRepo: targetRoot !== globalRoot, branch: targetRoot === "/worktrees/feature" ? "feature" : "main", changedPaths: []}),
    gitOperationState: async () => ({status: "safe"}),
  };
  const source = {catalog: () => Effect.succeed({
    projects: [{project: {id: projectId, title: "Project", workspaceRoot: root}, available: true}],
    threads: [{id: "thread", projectId, title: "Worktree", lineage: {parentThreadId: null, relationshipToParent: null}}],
  })};
  const t3 = {projection: (threadId: string) => Effect.succeed({snapshotSequence: 1, projection: {
    thread: {id: threadId, projectId, title: "Worktree", lineage: {parentThreadId: null, relationshipToParent: null}, worktreePath: threadRoot},
    runs: [], messages: [],
  }})};
  const setupWriter = {
    writeFile: async (targetRoot: string, path: string, contents: string) => {
      writes.push({root: targetRoot, path, contents});
      addFile(targetRoot, path, contents);
    },
    commitFiles: async (_targetRoot: string, paths: readonly string[]) => ({status: "committed" as const, commitSha: paths.join("-")}),
  };
  const loaderOptions: ProjectDefinitionLoaderOptions = {
    globalRoot,
    useGlobalDefinitions: () => options.globalEnabled ?? false,
    isScratchProject: (_id, registeredRoot) => options.scratch === true && registeredRoot === root,
    setupWriter,
  };
  // the definitions service and its baseline promise facade (./support/root-facades.ts), for the fixture's lifetime
  const run = Effect.runPromiseWith(Context.empty());
  const scope = Effect.runSync(Scope.make());
  const definitionsWith = (replaced: {files?: ProjectFiles; options?: ProjectDefinitionLoaderOptions; t3?: ProjectDefinitionSources["t3"]} = {}) =>
    Effect.runSync(Scope.provide(scope)(ProjectDefinitions.make({source, t3: replaced.t3 ?? t3, files: asProjectFiles(replaced.files ?? files), options: asLoaderOptions(replaced.options ?? loaderOptions)})));
  const definitions = definitionsWith();
  const loader = projectDefinitionsFacade(run, definitions);
  // the facade over definitions with replaced native files and options
  const loaderWith = (replacedFiles: ProjectFiles, replacedOptions: ProjectDefinitionLoaderOptions) =>
    projectDefinitionsFacade(run, definitionsWith({files: replacedFiles, options: replacedOptions}));
  const writer: ProjectWriter = {
    checkProjectConfigFile: async (targetRoot, signal) => {
      const folder = await files.list(targetRoot, ".t3-supervisor", signal);
      return !folder.truncated && folder.entries.some(entry => entry.path === ".t3-supervisor/project.yaml" && entry.kind === "file");
    },
    writeProjectConfig: async (targetRoot, contents, _signal) => {
      writes.push({root: targetRoot, path: ".t3-supervisor/project.yaml", contents});
      addFile(targetRoot, ".t3-supervisor/project.yaml", contents);
    },
    writeFile: setupWriter.writeFile,
  };
  /** Writes a project.yaml that indexes every step and workflow file present under the root. */
  const writeIndex = (targetRoot: string, options: Omit<IndexOptions, "steps" | "workflows"> & {omit?: readonly string[]} = {}) => {
    const present = (kind: DefinitionCatalogKind, extension: string) => [...(trees.get(targetRoot)?.keys() ?? [])]
      .flatMap(path => {const match = new RegExp(`^\\.t3-supervisor/${kind}/([a-z0-9][a-z0-9_-]{0,63})\\.${extension}$`).exec(path);return match ? [match[1]!] : [];})
      .filter(id => !(options.omit ?? []).includes(id)).sort();
    addFile(targetRoot, ".t3-supervisor/project.yaml", indexSource({...options, steps: present("steps", "md"), workflows: present("workflows", "yaml")}));
  };
  // the same in-memory files, catalog, projection and setup writer as services: the definitions, and the config editor over a project writer
  const layer = ProjectDefinitions.layer({source, t3, files: asProjectFiles(files), options: asLoaderOptions(loaderOptions)});
  const editorLayer = (configWriter: ProjectWriter = writer, onSaved?: DefinitionSaveRecorder) =>
    ProjectConfigEditorService.layer(asProjectWriter(configWriter), onSaved).pipe(Layer.provideMerge(layer));
  // the config editor's promise facade over a project writer and the fixture's (or the given) definitions service
  const editor = (configWriter: ProjectWriter = writer, over: ProjectConfigDefinitions = definitions) =>
    projectConfigEditorFacade(run, Effect.runSync(Scope.provide(scope)(ProjectConfigEditorService.make({definitions: over, writer: asProjectWriter(configWriter)}))));
  return {loader, loaderWith, definitions, definitionsWith, editor, run, source, t3, loaderOptions, layer, editorLayer, files, writer, trees, directories, failures, truncatedPaths, truncatedFiles, calls, writes, addFile, addDirectory, writeIndex, root, projectId, globalRoot, threadRoot};
}
