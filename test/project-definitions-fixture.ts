import { Effect } from "effect";
import { ProjectDefinitionLoader } from "../src/project-definitions.js";
import { ProjectFileError, type ProjectFiles, type ProjectWriter } from "../src/project-files.js";

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
  const loader = new ProjectDefinitionLoader(source, t3, files, {
    globalRoot,
    useGlobalDefinitions: () => options.globalEnabled ?? false,
    isScratchProject: (_id, registeredRoot) => options.scratch === true && registeredRoot === root,
    setupWriter,
  });
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
  return {loader, files, writer, trees, directories, failures, truncatedPaths, truncatedFiles, calls, writes, addFile, addDirectory, root, projectId, globalRoot, threadRoot};
}
