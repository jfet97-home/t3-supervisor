import { Effect } from "effect";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import { ProjectFileError, type FreshGitProbe, type ProjectCommitter, type ProjectFiles } from "./project-files.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
type MutableSnapshot = {-readonly [K in keyof ProjectDefinitionSnapshot]: ProjectDefinitionSnapshot[K] extends ReadonlyArray<infer V> ? V[] : ProjectDefinitionSnapshot[K]};
type MutableScopeSnapshot = {rules: ProjectDefinitionSnapshot["rules"][number][]; blocks: ProjectDefinitionSnapshot["blocks"][number][]; issues: ProjectDefinitionSnapshot["issues"][number][]};
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
  inputs: unknown[];
}
class DefinitionReadLimit extends Error {}
const blockId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 8000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(f => Object.hasOwn(v, f));

const yaml = (contents: string): unknown => {
  const doc = parseDocument(contents, {schema: "core", uniqueKeys: true});
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML; check syntax, duplicate keys and tags.");
  try {return doc.toJS({maxAliasCount: 0});}
  catch {throw new Error("YAML aliases are not supported in project definitions.");}
};

export const parseDefinitionRules = (contents: string): ProjectDefinitionSnapshot["rules"] => {
  const manifest = yaml(contents);
  if (!record(manifest) || !exact(manifest, ["rules"]) || !Array.isArray(manifest.rules) || manifest.rules.length > MAX_FILES)
    throw new Error("Expected a rules mapping containing at most 100 rules.");
  const names = new Set<string>();
  return manifest.rules.map(rule => {
    if (!record(rule) || !exact(rule, ["name", "description", "required_blocks"]) || !text(rule.name, 160) || !text(rule.description) ||
      !Array.isArray(rule.required_blocks) || rule.required_blocks.length === 0 || rule.required_blocks.length > MAX_FILES ||
      !rule.required_blocks.every(id => typeof id === "string" && blockId.test(id)) || new Set(rule.required_blocks).size !== rule.required_blocks.length)
      throw new Error("Each rule needs name, description and a nonempty list of unique block identifiers.");
    const name = rule.name.trim();
    if (names.has(name)) throw new Error("Rule names must be unique.");
    names.add(name);
    return {name, description: rule.description.trim(), required_blocks: rule.required_blocks as string[]};
  });
};

export const parseDefinitionBlock = (id: string, contents: string): ProjectDefinitionSnapshot["blocks"][number] => {
  contents = contents.replace(/^\uFEFF/, "");
  if (!blockId.test(id)) throw new Error("Invalid block filename.");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!frontmatter) throw new Error("Block needs YAML frontmatter with name and description.");
  const metadata = yaml(frontmatter[1]!);
  if (!record(metadata) || !exact(metadata, ["name", "description"]) || !text(metadata.name, 160) || !text(metadata.description))
    throw new Error("Block frontmatter needs only a nonempty name and description.");
  const body = contents.slice(frontmatter[0].length);
  const sections = new Map<string, string[]>();
  let section: string | null = null;
  let fence: {marker: string; length: number} | null = null;
  for (const line of body.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const insideFence = fence !== null;
    if (delimiter) {
      if (!fence) fence = {marker: delimiter[1]![0]!, length: delimiter[1]!.length};
      else if (delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && delimiter[2]!.trim() === "") fence = null;
    }
    const heading = !insideFence && !delimiter ? /^ {0,3}##[ \t]+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      section = heading[1]!.trim();
      if (sections.has(section)) throw new Error("Block section headings must be unique.");
      sections.set(section, []);
    } else if (section) sections.get(section)!.push(line);
  }
  const instructions = sections.get("Instructions")?.join("\n").trim();
  const result = sections.get("Expected result")?.join("\n").trim();
  if (!text(instructions, MAX_FILE_BYTES) || !text(result, MAX_FILE_BYTES))
    throw new Error("Block needs nonempty Instructions and Expected result sections.");
  return {id, name: metadata.name.trim(), description: metadata.description.trim(), instructions, expected_result: result};
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

  private async readScope(root: string, origin: DefinitionOrigin, signal: AbortSignal, byteCounter: {value: number}, rulesSource?: (contents: string) => void): Promise<DefinitionScopeRead> {
    const scope: DefinitionScopeRead = {status: "unavailable", rules: [], blocks: [], issues: [], inputs: []};
    const base = origin === "global" ? this.globalDefinitionsPath() : ".t3-supervisor";
    const showPath = (path: string) => path === "" ? base : `${base}/${path.replace(/^\.t3-supervisor\//, "")}`;
    const issue = (path: string, code: string, message: string) => scope.issues.push({path, code, message});
    try {
      let entries: Awaited<ReturnType<ProjectFiles["list"]>>;
      if (origin === "global") {
        if (!await this.files.directoryExists(root, signal)) {
          scope.inputs.push(["home", "unavailable"]);
          issue(base, "global_home_unavailable", "The T3 server user's home directory is unavailable.");
          return scope;
        }
        try {entries = await this.files.list(root, ".t3-supervisor", signal);}
        catch (error) {
          if (error instanceof ProjectFileError && error.code === "missing") {
            scope.inputs.push(["home-folder", "missing"]);
            scope.status = "missing";
            return scope;
          }
          scope.status = error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable";
          issue(base, scope.status, "The global definition folder became unreadable after its presence was observed.");
          return scope;
        }
        scope.inputs.push(["home-folder", "directory"]);
      } else {
        if (!await this.files.directoryExists(root, signal)) {
          scope.inputs.push(["workspace", "unavailable"]);
          issue("", "workspace_missing", "The T3 workspace directory is unavailable.");
          return scope;
        }
        const folderExists = await this.files.directoryExists(posix.join(root, ".t3-supervisor"), signal);
        scope.inputs.push(["folder", folderExists]);
        if (!folderExists) {scope.status = "missing";return scope;}
        try {entries = await this.files.list(root, ".t3-supervisor", signal);}
        catch (error) {
          if (error instanceof ProjectFileError && error.code === "missing") {scope.inputs.push(["folder", false]);scope.status = "missing";return scope;}
          throw error;
        }
        scope.inputs.push(["folder", true]);
      }
      scope.inputs.push(["listing", {...entries, entries: [...entries.entries].sort((a, b) => a.path.localeCompare(b.path))}]);
      const read = async (path: string) => {
        const file = await this.files.read(root, path, signal);
        scope.inputs.push([path, file]);
        const decodedBytes = Buffer.byteLength(file.contents, "utf8");
        byteCounter.value += file.byteLength;
        if (byteCounter.value > MAX_TOTAL_BYTES) throw new DefinitionReadLimit("Definition files exceed the 512 KiB combined limit.");
        if (file.truncated || file.byteLength > MAX_FILE_BYTES || (decodedBytes !== file.byteLength && decodedBytes + 3 !== file.byteLength))
          throw new Error("Definition files must be complete, at most 64 KiB each and 512 KiB combined.");
        return file.contents;
      };
      const parseFile = async (path: string, accept: (contents: string) => void) => {
        try {accept(await read(path));}
        catch (error) {
          if (error instanceof DefinitionReadLimit) throw error;
          if (error instanceof ProjectFileError && error.code !== "missing" && error.code !== "invalid_file") throw error;
          issue(showPath(path), error instanceof ProjectFileError ? error.code === "missing" ? "file_missing" : "invalid_file" : "invalid_definition", error instanceof Error ? error.message : "Invalid definition.");
        }
      };
      if (entries.truncated) issue(base, "listing_truncated", "The definition directory listing is incomplete.");
      const rulesPath = ".t3-supervisor/rules.yaml";
      if (entries.entries.some(entry => entry.path === rulesPath && entry.kind === "file")) {
        await parseFile(rulesPath, contents => {
          scope.rules = parseDefinitionRules(contents).map(rule => ({...rule, origin, path: showPath(rulesPath)}));
          if (origin === "project") rulesSource?.(contents);
        });
      } else issue(showPath(rulesPath), "rules_missing", "Add rules.yaml with a rules list; use rules: [] for no requirements.");
      const blocksPath = ".t3-supervisor/blocks";
      if (entries.entries.some(entry => entry.path === blocksPath && entry.kind === "directory")) {
        const blocks = await this.files.list(root, blocksPath, signal);
        scope.inputs.push(["blocks-listing", {...blocks, entries: [...blocks.entries].sort((a, b) => a.path.localeCompare(b.path))}]);
        const blockFiles = blocks.entries.filter(entry => entry.kind === "file" && entry.path.endsWith(".md"));
        if (blocks.truncated || blockFiles.length > MAX_FILES || new Set(blocks.entries.map(entry => entry.path)).size !== blocks.entries.length)
          issue(showPath(blocksPath), "block_limit", "The block listing is incomplete, duplicated or exceeds 100 Markdown blocks.");
        for (const entry of blockFiles.slice(0, MAX_FILES).sort((a, b) => a.path.localeCompare(b.path))) {
          const match = /^\.t3-supervisor\/blocks\/([a-z0-9][a-z0-9_-]{0,63})\.md$/.exec(entry.path);
          if (!match) {issue(showPath(blocksPath), "block_path_invalid", "Blocks must be direct Markdown files with simple lowercase identifiers.");continue;}
          await parseFile(entry.path, contents => {
            scope.blocks.push({...parseDefinitionBlock(match[1]!, contents), origin, path: showPath(entry.path), sourceId: match[1]!});
          });
        }
      }
      scope.status = scope.issues.length ? "invalid" : "ready";
    } catch (error) {
      scope.status = error instanceof DefinitionReadLimit ? "invalid" : error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable";
      issue(base, scope.status, error instanceof ProjectFileError || error instanceof DefinitionReadLimit ? error.message : "Project definitions could not be read; check the T3 connection and workspace.");
      if (!(error instanceof DefinitionReadLimit)) {
        scope.rules = [];
        scope.blocks = [];
      }
    }
    return scope;
  }

  private namespaceGlobal(global: DefinitionScopeRead, project: DefinitionScopeRead): DefinitionScopeRead {
    const usedIds = new Set(project.blocks.map(block => block.id));
    const sourceIds = new Set<string>();
    for (const block of global.blocks) sourceIds.add(block.sourceId ?? block.id);
    for (const rule of global.rules) for (const id of rule.required_blocks) sourceIds.add(id);
    const idMap = new Map<string, string>();
    for (const sourceId of [...sourceIds].sort()) {
      let counter = 0;
      let id: string;
      do {
        const digest = createHash("sha256").update(`global-block\0${sourceId}\0${counter++}`).digest("hex");
        id = `g${digest.slice(0, 63)}`;
      } while (usedIds.has(id));
      usedIds.add(id);
      idMap.set(sourceId, id);
    }
    global.blocks = global.blocks.map(block => ({...block, id: idMap.get(block.sourceId ?? block.id)!}));
    const usedNames = new Set(project.rules.map(rule => rule.name));
    global.rules = global.rules.map(rule => {
      let name = rule.name;
      if (usedNames.has(name)) {
        const baseSuffix = ` [global ${createHash("sha256").update(`global-rule\0${rule.name}`).digest("hex").slice(0, 12)}]`;
        let suffix = baseSuffix;
        const prefix = "Global: ";
        let available = 160 - prefix.length - suffix.length;
        name = `${prefix}${rule.name.slice(0, available)}${suffix}`;
        let duplicate = 1;
        while (usedNames.has(name)) {
          suffix = `${baseSuffix.slice(0, -1)}-${duplicate++}]`;
          available = 160 - prefix.length - suffix.length;
          name = `${prefix}${rule.name.slice(0, available)}${suffix}`;
        }
      }
      usedNames.add(name);
      return {...rule, name, required_blocks: rule.required_blocks.map(id => idMap.get(id)!), origin: "global", path: `${this.globalDefinitionsPath()}/rules.yaml`};
    });
    return global;
  }

  private fingerprintGlobalScope(scope: DefinitionScopeRead): string | null {
    if (scope.status === "unavailable" || scope.status === "permission_required" ||
      scope.issues.some(item => item.code === "listing_truncated" || item.code === "block_limit" || item.code === "invalid_file" ||
        item.message.includes("512 KiB combined limit"))) return null;
    return createHash("sha256").update(JSON.stringify([this.globalDefinitionsPath(), scope.status, scope.inputs])).digest("hex");
  }

  async globalFingerprint(signal: AbortSignal): Promise<string | null> {
    if (!this.globalRoot) return null;
    const scope = await this.readScope(this.globalRoot, "global", signal, {value: 0});
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
        : "Only the two new .t3-supervisor setup files may be changed before commit."};
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
    const rulesPath = ".t3-supervisor/rules.yaml";
    const markerPath = ".t3-supervisor/blocks/.gitkeep";
    const rulesContents = "rules: []\n";
    let safetyMessage: string | null = null;
    const safeWrite = async (filePath: string, contents: string): Promise<"written" | "conflict" | "stale" | "permission_required" | "unavailable" | "uncertain"> => {
      try {
        safetyMessage = null;
        // native writeFile has no create-only precondition, so the existence guard cannot eliminate external races.
        if (signal.aborted) return "stale";
        const presence = await this.scopePresence(root, origin === "global", signal);
        if (filePath === rulesPath && presence.status === "present") return "conflict";
        if (filePath === rulesPath && presence.status === "unavailable") return "uncertain";
        if (filePath === markerPath) {
          if (presence.status !== "present") return "uncertain";
          const contentsListing = await this.files.list(root, ".t3-supervisor", signal);
          if (contentsListing.truncated) return "uncertain";
          const allowedEntries = new Set([rulesPath, ".t3-supervisor/blocks"]);
          if (contentsListing.entries.some(entry => !allowedEntries.has(entry.path) || entry.path === rulesPath && entry.kind !== "file" || entry.path === ".t3-supervisor/blocks" && entry.kind !== "directory")) return "conflict";
          if (contentsListing.entries.some(entry => entry.path === ".t3-supervisor/blocks")) return "conflict";
          const rules = await this.files.read(root, rulesPath, signal);
          if (rules.truncated || rules.contents !== rulesContents) return "conflict";
        }
        if (signal.aborted) return "stale";
        if (origin === "project" && projectId && action === "create_and_commit") {
          const expectedPaths = filePath === markerPath ? [rulesPath] : [];
          const safety = await this.checkCommitSafety(projectId, threadId ?? null, root, expectedBranch ?? null, expectedPaths, signal);
          if (safety.status !== "safe") safetyMessage = safety.message;
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
        return readback.truncated || readback.contents !== contents ? "uncertain" : "written";
      } catch (error) {
        if (error instanceof ProjectFileError && error.code === "permission_required") return "permission_required";
        return "uncertain";
      }
    };
    const rulesResult = await safeWrite(rulesPath, rulesContents);
    if (rulesResult !== "written") return this.setupOutcome(rulesResult === "permission_required" ? "permission_required" : rulesResult === "conflict" ? "conflict" : rulesResult === "stale" ? "stale" : rulesResult === "unavailable" ? "unavailable" : "uncertain", root, expectedBranch ?? null,
      rulesResult === "stale" ? "Setup stopped because the selected checkout changed or was canceled before writing." :
        rulesResult === "conflict" ? safetyMessage ?? "The target changed during setup; existing files were preserved." :
          rulesResult === "unavailable" ? safetyMessage ?? "A fresh local Git status could not be verified; no setup files were written." :
            "The new rules file could not be confirmed; a partial scaffold may remain, left uncommitted, and setup was not enabled.", path);
    const markerResult = await safeWrite(markerPath, "");
    if (markerResult !== "written") return this.setupOutcome(markerResult === "permission_required" ? "permission_required" : markerResult === "conflict" ? "conflict" : markerResult === "stale" ? "stale" : markerResult === "unavailable" ? "unavailable" : "uncertain", root, expectedBranch ?? null,
      markerResult === "stale" ? "Setup stopped because the selected checkout changed or was canceled. The rules file was created and left uncommitted." :
        markerResult === "conflict" ? safetyMessage ? safetyMessage + " The rules file was created and left uncommitted." : "The target changed during setup. The rules file was created and left uncommitted; existing files were preserved." :
          markerResult === "unavailable" ? (safetyMessage ?? "A fresh local Git status could not be confirmed.") + " The rules file was created and left uncommitted." :
          "The blocks marker could not be confirmed. The rules file may remain, left uncommitted, and setup was not enabled.", path);
    if (action === "create") return this.setupOutcome("created", root, expectedBranch ?? null, "Created .t3-supervisor/rules.yaml and blocks/.gitkeep; both files are uncommitted.", path);
    if (!setupWriter.commitFiles) return this.setupOutcome("permission_required", root, expectedBranch ?? null, "The files were created, but a dedicated source-control write credential is required to commit them.", path);
    if (origin === "project" && projectId) {
      const rules = await this.files.read(root, rulesPath, signal);
      const marker = await this.files.read(root, markerPath, signal);
      if (rules.truncated || marker.truncated || rules.contents !== rulesContents || marker.contents !== "")
        return this.setupOutcome("conflict", root, expectedBranch ?? null, "The setup files changed before commit; they were left uncommitted.", path);
      let folderEntries: Awaited<ReturnType<ProjectFiles["list"]>>;
      let blockEntries: Awaited<ReturnType<ProjectFiles["list"]>>;
      try {
        folderEntries = await this.files.list(root, ".t3-supervisor", signal);
        blockEntries = await this.files.list(root, ".t3-supervisor/blocks", signal);
      } catch {
        return this.setupOutcome("uncertain", root, expectedBranch ?? null, "T3 could not verify that the setup folder contains only the two new files; they were left uncommitted.", path);
      }
      if (folderEntries.truncated || blockEntries.truncated)
        return this.setupOutcome("uncertain", root, expectedBranch ?? null, "T3 returned an incomplete setup folder listing; the files were left uncommitted.", path);
      const folderContents = folderEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      const blockContents = blockEntries.entries.map(entry => [entry.path, entry.kind] as const).sort(([a], [b]) => a.localeCompare(b));
      if (JSON.stringify(folderContents) !== JSON.stringify([[".t3-supervisor/blocks", "directory"], [rulesPath, "file"]]) ||
        JSON.stringify(blockContents) !== JSON.stringify([[markerPath, "file"]]))
        return this.setupOutcome("conflict", root, expectedBranch ?? null, "The setup folder contains other files; the new setup files were left uncommitted.", path);
      if (signal.aborted) return this.setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; the files were left uncommitted.", path);
      const safety = await this.checkCommitSafety(projectId, threadId ?? null, root, expectedBranch ?? null, [rulesPath, markerPath], signal);
      if (safety.status !== "safe") return this.setupOutcome(safety.status, root, safety.branch, `${safety.message} The setup files were left uncommitted.`, path);
    }
    if (signal.aborted) return this.setupOutcome("stale", root, expectedBranch ?? null, "Setup was canceled; the files were left uncommitted.", path);
    const actionId = `supervisor-setup-${createHash("sha256").update(JSON.stringify([origin, root, expectedBranch, rulesContents])).digest("hex").slice(0, 32)}`;
    try {
      const commit = await setupWriter.commitFiles(root, [rulesPath, markerPath], "Initialize T3 Supervisor definitions", actionId, signal);
      if (commit.status === "uncertain") return this.setupOutcome("uncertain", root, expectedBranch ?? null, "The commit result is uncertain. The setup paths were submitted and may remain staged; inspect the checkout and commit history before retrying.", path);
      if (!commit.commitSha) return this.setupOutcome("uncertain", root, expectedBranch ?? null, "The commit result could not be verified. Refresh the checkout before retrying.", path);
      return this.setupOutcome("committed", root, expectedBranch ?? null, "T3 completed the requested setup commit. Repository hooks and signing apply; hooks can change which files it contains.", path);
    } catch (error) {
      if (error instanceof ProjectFileError && error.code === "permission_required") return this.setupOutcome("permission_required", root, expectedBranch ?? null, "The files were created, but native source-control write permission is unavailable.", path);
      return this.setupOutcome("uncertain", root, expectedBranch ?? null, "The files were created, but the native commit result is uncertain. Refresh the checkout before retrying.", path);
    }
  }

  async load(projectId: string, threadId: string | null = null, parentSignal?: AbortSignal, rulesSource?: (contents: string) => void): Promise<ProjectDefinitionSnapshot> {
    const result: MutableSnapshot = {projectId, threadId, workspaceRoot: "", globalOnly: false, revision: null, editingAvailable: false, status: "unavailable", rules: [], blocks: [], issues: []};
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
      const byteCounter = {value: 0};
      const emptyScope = (): DefinitionScopeRead => ({status: "missing", rules: [], blocks: [], issues: [], inputs: []});
      const globalScope = globalEnabled && this.globalRoot ? await this.readScope(this.globalRoot, "global", signal, byteCounter) : emptyScope();
      result.globalRevision = globalEnabled ? this.fingerprintGlobalScope(globalScope) : null;
      inputs.push(["global", globalEnabled ? globalScope.inputs : ["disabled"]]);
      const projectScope = scratch ? emptyScope() : await this.readScope(root, "project", signal, byteCounter, rulesSource);
      inputs.push(["project", scratch ? ["global-only", root] : projectScope.inputs]);
      const namespacedGlobal = globalEnabled ? this.namespaceGlobal(globalScope, projectScope) : globalScope;
      result.rules = [...namespacedGlobal.rules, ...projectScope.rules];
      result.blocks = [...namespacedGlobal.blocks, ...projectScope.blocks];
      result.issues.push(...namespacedGlobal.issues, ...projectScope.issues);
      if (result.rules.length > MAX_FILES) issue(".t3-supervisor/rules.yaml", "combined_rule_limit", "The combined global and project collection exceeds 100 rules.");
      if (result.blocks.length > MAX_FILES) issue(".t3-supervisor/blocks", "combined_block_limit", "The combined global and project collection exceeds 100 blocks.");
      const ids = new Set(result.blocks.map(block => block.id));
      for (const rule of result.rules) for (const id of rule.required_blocks) {
        if (!ids.has(id)) issue(rule.path ?? ".t3-supervisor/rules.yaml", "block_reference_missing", `Rule ${rule.name} references missing or invalid block ${id}.`);
      }
      const activeScopes = [...(globalEnabled ? [globalScope] : []), ...(!scratch ? [projectScope] : [])];
      if (activeScopes.some(scope => scope.status === "permission_required")) result.status = "permission_required";
      else if (activeScopes.some(scope => scope.status === "unavailable")) result.status = "unavailable";
      else if (activeScopes.some(scope => scope.status === "invalid") || result.issues.length) result.status = "invalid";
      else if (scratch && globalEnabled) result.status = globalScope.status;
      else if (scratch) result.status = "ready";
      else if (projectScope.status === "missing") result.status = "missing";
      else result.status = "ready";
      if (result.status === "missing" && scratch && globalEnabled && !result.issues.length)
        issue(this.globalDefinitionsPath(), "global_definitions_missing", "Create the global .t3-supervisor folder to make shared definitions available in Scratch.");
      if (result.status === "ready") result.revision = createHash("sha256").update(JSON.stringify([projectId, threadId, root, scratch, inputs])).digest("hex");
      if (result.status === "permission_required" || result.status === "unavailable") {
        result.rules = [];
        result.blocks = [];
        if (!result.issues.length) issue(this.globalDefinitionsPath(), result.status, result.status === "permission_required"
          ? "The active global or project definition scope requires filesystem:read access."
          : "An active definition scope could not be read; no empty rules were assumed.");
      }
    } catch (error) {
      result.rules = []; result.blocks = [];
      result.status = error instanceof DefinitionReadLimit ? "invalid" : error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable";
      issue(this.globalDefinitionsPath(), result.status, error instanceof ProjectFileError || error instanceof DefinitionReadLimit ? error.message : "Project definitions could not be read; check the T3 connection and workspace.");
    }
    return result;
  }
}
