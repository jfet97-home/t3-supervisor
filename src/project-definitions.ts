import { Effect } from "effect";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import { ProjectFileError, type ProjectFiles } from "./project-files.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
type MutableSnapshot = {-readonly [K in keyof ProjectDefinitionSnapshot]: ProjectDefinitionSnapshot[K] extends ReadonlyArray<infer V> ? V[] : ProjectDefinitionSnapshot[K]};
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

/** Loads working-tree definitions without executing them or changing existing guidance rules. */
export class ProjectDefinitionLoader {
  constructor(readonly source: Pick<StoreShape, "catalog">, readonly t3: Pick<T3ClientShape, "projection">, readonly files: ProjectFiles) {}

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

  async load(projectId: string, threadId: string | null = null, parentSignal?: AbortSignal, rulesSource?: (contents: string) => void): Promise<ProjectDefinitionSnapshot> {
    const result: MutableSnapshot = {projectId, threadId, workspaceRoot: "", revision: null, editingAvailable: false, status: "unavailable", rules: [], blocks: [], issues: []};
    const inputs: unknown[] = [];
    const revision = () => createHash("sha256").update(JSON.stringify([projectId, threadId, result.workspaceRoot, inputs])).digest("hex");
    const deadline = AbortSignal.timeout(30_000);
    const signal = parentSignal ? AbortSignal.any([deadline, parentSignal]) : deadline;
    const issue = (path: string, code: string, message: string) => result.issues.push({path, code, message});
    try {
      const catalog = await Effect.runPromise(this.source.catalog(), {signal});
      const project = catalog.projects.find(p => p.project.id === projectId && p.available);
      if (!project) {issue("", "project_unavailable", "Select an available registered project."); return result;}
      let root = project.project.workspaceRoot;
      if (threadId !== null) {
        const snapshot = await Effect.runPromise(this.t3.projection(threadId), {signal});
        const thread = snapshot.projection.thread;
        if (thread.id !== threadId || thread.projectId !== projectId || thread.deletedAt || thread.archivedAt) {
          issue("", "thread_unavailable", "The conversation does not belong to this available project."); return result;
        }
        if (thread.worktreePath === undefined) {issue("", "workspace_invalid", "T3 did not supply the conversation's worktree binding."); return result;}
        if (thread.worktreePath !== null) {
          if (!text(thread.worktreePath, 4096)) {issue("", "workspace_invalid", "T3 returned an invalid worktree binding."); return result;}
          root = thread.worktreePath;
        }
      }
      if (!text(root, 4096) || !posix.isAbsolute(root) || root.includes("\0") || root.includes("\\")) {
        issue("", "workspace_invalid", "T3 must supply an absolute Mac or Linux workspace path."); return result;
      }
      root = posix.normalize(root);
      result.workspaceRoot = root;
      if (!await this.files.directoryExists(root, signal)) {issue("", "workspace_missing", "The T3 workspace directory is unavailable."); return result;}
      if (!await this.files.directoryExists(posix.join(root, ".supervisor"), signal)) {
        result.status = "missing";issue(".supervisor", "definitions_missing", "This project has no .supervisor directory.");return result;
      }
      let entries: Awaited<ReturnType<ProjectFiles["list"]>>;
      try {entries = await this.files.list(root, ".supervisor", signal);}
      catch (error) {
        if (error instanceof ProjectFileError && error.code === "missing") {
          result.status = "missing";issue(".supervisor", "definitions_missing", "This project has no .supervisor directory.");return result;
        }
        throw error;
      }
      let bytes = 0;
      inputs.push({...entries, entries: [...entries.entries].sort((a, b) => a.path.localeCompare(b.path))});
      const read = async (path: string) => {
        const file = await this.files.read(root, path, signal);
        inputs.push([path, file]);
        const decodedBytes = Buffer.byteLength(file.contents, "utf8");
        bytes += file.byteLength;
        if (bytes > MAX_TOTAL_BYTES) throw new DefinitionReadLimit("Definition files exceed the 512 KiB total limit.");
        // T3 may remove a UTF-8 BOM while reporting the original file's byte length
        if (file.truncated || file.byteLength > MAX_FILE_BYTES || (decodedBytes !== file.byteLength && decodedBytes + 3 !== file.byteLength))
          throw new Error("Definition files must be complete, at most 64 KiB each and 512 KiB in total.");
        return file.contents;
      };
      const parseFile = async (path: string, accept: (contents: string) => void) => {
        try {accept(await read(path));}
        catch (error) {
          if (error instanceof DefinitionReadLimit) throw error;
          if (error instanceof ProjectFileError && error.code !== "missing" && error.code !== "invalid_file") throw error;
          issue(path, error instanceof ProjectFileError ? error.code === "missing" ? "file_missing" : "invalid_file" : "invalid_definition", error instanceof Error ? error.message : "Invalid definition.");
        }
      };
      if (entries.truncated) issue(".supervisor", "listing_truncated", "The definition directory listing is incomplete.");
      if (entries.entries.some(e => e.path === ".supervisor/rules.yaml" && e.kind === "file"))
        await parseFile(".supervisor/rules.yaml", contents => {result.rules = [...parseDefinitionRules(contents)];rulesSource?.(contents);});
      else issue(".supervisor/rules.yaml", "rules_missing", "Add rules.yaml with a rules list; use rules: [] for no requirements.");
      if (entries.entries.some(e => e.path === ".supervisor/blocks" && e.kind === "directory")) {
        const blocks = await this.files.list(root, ".supervisor/blocks", signal);
        inputs.push({...blocks, entries: [...blocks.entries].sort((a, b) => a.path.localeCompare(b.path))});
        if (blocks.truncated || blocks.entries.length > MAX_FILES || new Set(blocks.entries.map(e => e.path)).size !== blocks.entries.length)
          issue(".supervisor/blocks", "block_limit", "The block listing is incomplete, duplicated or exceeds 100 entries.");
        for (const entry of blocks.entries.slice(0, MAX_FILES).sort((a, b) => a.path.localeCompare(b.path))) {
          if (entry.kind !== "file" || !entry.path.endsWith(".md")) continue;
          const match = /^\.supervisor\/blocks\/([a-z0-9][a-z0-9_-]{0,63})\.md$/.exec(entry.path);
          if (!match) {issue(".supervisor/blocks", "block_path_invalid", "Blocks must be direct Markdown files with simple lowercase identifiers.");continue;}
          await parseFile(entry.path, contents => {result.blocks.push(parseDefinitionBlock(match[1]!, contents));});
        }
      }
      const ids = new Set(result.blocks.map(b => b.id));
      for (const rule of result.rules) for (const id of rule.required_blocks) {
        if (!ids.has(id)) issue(".supervisor/rules.yaml", "block_reference_missing", `Rule ${rule.name} references missing or invalid block ${id}.`);
      }
      result.status = result.issues.length ? "invalid" : "ready";
      if (result.issues.every(i => i.code === "block_reference_missing")) result.revision = revision();
    } catch (error) {
      result.rules = []; result.blocks = [];
      result.status = error instanceof DefinitionReadLimit ? "invalid" : error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable";
      issue(".supervisor", result.status, error instanceof ProjectFileError || error instanceof DefinitionReadLimit ? error.message : "Project definitions could not be read; check the T3 connection and workspace.");
    }
    return result;
  }
}
