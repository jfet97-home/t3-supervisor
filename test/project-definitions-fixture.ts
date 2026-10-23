import { Effect, Layer } from "effect";
import { ProjectDefinitions, type ProjectDefinitionLoaderOptions, type ProjectDefinitionSetupWriter, type ProjectDefinitionSources } from "../src/project-definitions.js";
import { ProjectConfigEditorService, type DefinitionSaveRecorder, type ProjectConfigDefinitions, type ProjectConfigWriter } from "../src/project-config-editor.js";
import { ProjectFileError, type ProjectFiles, type ProjectWriter } from "../src/project-files.js";
import { stringify } from "yaml";
import {
  definitionCatalogPath, type DefinitionCatalogKind, type DefinitionReference, type EffectiveConfigurationInfo, type ProjectConfigurationInfo,
} from "../src/project-definitions-contract.js";

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
  // the in-memory native file client: a listing or read is recorded, then answered from the trees or with its injected failure
  const projectFiles = {
    directoryExists: (path: string) => Effect.sync(() => directories.has(path)),
    list: (targetRoot: string, path: string) => Effect.gen(function* () {
      calls.push({kind: "list", root: targetRoot, path});
      const failure = failures.get(`${targetRoot}|${path}`);
      if (failure) return yield* failure;
      if (path && !directories.has(`${targetRoot}/${path}`)) return yield* new ProjectFileError("missing");
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
    }),
    read: (targetRoot: string, path: string) => Effect.gen(function* () {
      calls.push({kind: "read", root: targetRoot, path});
      const failure = failures.get(`${targetRoot}|${path}`);
      if (failure) return yield* failure;
      const contents = trees.get(targetRoot)?.get(path);
      if (contents === undefined) return yield* new ProjectFileError("missing");
      return {contents, byteLength: Buffer.byteLength(contents, "utf8"), truncated: truncatedFiles.has(`${targetRoot}|${path}`)};
    }),
    vcsInfo: (targetRoot: string) => Effect.succeed({isRepo: targetRoot !== globalRoot, branch: targetRoot === "/worktrees/feature" ? "feature" : "main", changedPaths: []}),
    gitOperationState: () => Effect.succeed({status: "safe" as const}),
  } satisfies ProjectFiles["Service"];
  const source = {catalog: () => Effect.succeed({
    projects: [{project: {id: projectId, title: "Project", workspaceRoot: root}, available: true}],
    threads: [{id: "thread", projectId, title: "Worktree", lineage: {parentThreadId: null, relationshipToParent: null}}],
  })};
  const t3 = {projection: (threadId: string) => Effect.succeed({snapshotSequence: 1, projection: {
    thread: {id: threadId, projectId, title: "Worktree", lineage: {parentThreadId: null, relationshipToParent: null}, worktreePath: threadRoot},
    runs: [], messages: [],
  }})};
  const setupWriter = {
    writeFile: (targetRoot: string, path: string, contents: string) => Effect.sync(() => {
      writes.push({root: targetRoot, path, contents});
      addFile(targetRoot, path, contents);
    }),
    commitFiles: (_targetRoot: string, paths: readonly string[]) => Effect.succeed({status: "committed" as const, commitSha: paths.join("-")}),
  } satisfies ProjectDefinitionSetupWriter;
  const definitionScopeOptions = {
    globalRoot,
    useGlobalDefinitions: () => Effect.succeed(options.globalEnabled ?? false),
    isScratchProject: (_id: string, registeredRoot: string) => Effect.succeed(options.scratch === true && registeredRoot === root),
  };
  const definitionOptions: ProjectDefinitionLoaderOptions = {...definitionScopeOptions, setupWriter};
  // the in-memory native project writer: the regular project.yaml check reads the in-memory listing
  const projectWriter = {
    checkProjectConfigFile: (targetRoot: string) => Effect.map(projectFiles.list(targetRoot, ".t3-supervisor"), folder =>
      !folder.truncated && folder.entries.some(entry => entry.path === ".t3-supervisor/project.yaml" && entry.kind === "file")),
    writeProjectConfig: (targetRoot: string, contents: string) => Effect.sync(() => {
      writes.push({root: targetRoot, path: ".t3-supervisor/project.yaml", contents});
      addFile(targetRoot, ".t3-supervisor/project.yaml", contents);
    }),
    writeFile: setupWriter.writeFile,
  } satisfies ProjectWriter["Service"];
  // the definitions service over the in-memory catalog, projection, files and options, any of them replaced, in the caller's scope
  const makeDefinitions = (replaced: {files?: ProjectFiles["Service"]; options?: ProjectDefinitionLoaderOptions; t3?: ProjectDefinitionSources["t3"]} = {}) =>
    ProjectDefinitions.make({source, t3: replaced.t3 ?? t3, files: replaced.files ?? projectFiles, options: replaced.options ?? definitionOptions});
  // the config editor over a project writer and the given definitions, in the caller's scope
  const makeConfigEditor = (definitions: ProjectConfigDefinitions, configWriter: ProjectConfigWriter = projectWriter, onSaved?: DefinitionSaveRecorder) =>
    ProjectConfigEditorService.make({definitions, writer: configWriter, onSaved});
  // the same services as layers: the definitions, and the config editor over a project writer
  const definitionsLayer = ProjectDefinitions.layer({source, t3, files: projectFiles, options: definitionOptions});
  const configEditorLayer = (configWriter: ProjectConfigWriter = projectWriter, onSaved?: DefinitionSaveRecorder) =>
    ProjectConfigEditorService.layer(configWriter, onSaved).pipe(Layer.provideMerge(definitionsLayer));
  /** Writes a project.yaml that indexes every step and workflow file present under the root. */
  const writeIndex = (targetRoot: string, options: Omit<IndexOptions, "steps" | "workflows"> & {omit?: readonly string[]} = {}) => {
    const present = (kind: DefinitionCatalogKind, extension: string) => [...(trees.get(targetRoot)?.keys() ?? [])]
      .flatMap(path => {const match = new RegExp(`^\\.t3-supervisor/${kind}/([a-z0-9][a-z0-9_-]{0,63})\\.${extension}$`).exec(path);return match ? [match[1]!] : [];})
      .filter(id => !(options.omit ?? []).includes(id)).sort();
    addFile(targetRoot, ".t3-supervisor/project.yaml", indexSource({...options, steps: present("steps", "md"), workflows: present("workflows", "yaml")}));
  };

  return {
    projectFiles, projectWriter, setupWriter, definitionOptions, makeDefinitions, makeConfigEditor, definitionsLayer, configEditorLayer,
    source, t3, trees, directories, failures, truncatedPaths, truncatedFiles, calls, writes, addFile, addDirectory, writeIndex, root, projectId, globalRoot, threadRoot,
  };
}
