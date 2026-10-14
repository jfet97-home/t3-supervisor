import { stringify, parseDocument, isSeq, isMap } from "yaml";
import { ProjectDefinitionLoader, parseDefinitionRules } from "./project-definitions.js";
import { ProjectFileError, type ProjectWriter } from "./project-files.js";
import type { ProjectDefinitionSnapshot, ProjectRuleSave, ProjectRuleSaveOutcome } from "./project-definitions-contract.js";

/** Saves only project rules; native T3 resolves the fixed path within the selected workspace. */
export class ProjectRuleEditor {
  private readonly active = new Map<string, Promise<void>>();
  constructor(readonly loader: ProjectDefinitionLoader, readonly writer: ProjectWriter,
    readonly onSaved?: (definitions: ProjectDefinitionSnapshot, expectedRevision: string) => void) {}

  async save(input: ProjectRuleSave, parentSignal?: AbortSignal): Promise<ProjectRuleSaveOutcome> {
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const outcome = (status: ProjectRuleSaveOutcome["status"], message: string, definitions: ProjectDefinitionSnapshot | null = null): ProjectRuleSaveOutcome =>
      ({status, message, definitions: definitions ? {...definitions, editingAvailable: true} : null});
    let contents: string;
    try {
      if (input.rules.some(rule => rule.origin === "global")) throw new Error("global_rules_readonly");
      const rules = input.rules.map(({name, description, required_blocks}) => ({name, description, required_blocks}));
      contents = stringify({rules}, {lineWidth: 0});
      parseDefinitionRules(contents);
      if (Buffer.byteLength(contents) > 64 * 1024 || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new Error("invalid");
    } catch {return outcome("invalid", "Check rule names, descriptions, required blocks and the 64 KiB rules-file limit.");}
    const initial = await this.loader.load(input.projectId, input.threadId, signal);
    if (initial.globalOnly) return outcome("unavailable", "Shared global definitions cannot be saved through the project rule editor.", initial);
    if (!initial.revision) return outcome(initial.status === "permission_required" ? "permission_required" : "unavailable", "Definitions cannot be edited until file access and validation problems are resolved.", initial);
    const root = initial.workspaceRoot;
    const previous = this.active.get(root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {release = resolve;});
    const queued = previous.then(() => current);
    this.active.set(root, queued);
    try {
      await previous;
      if (signal.aborted) return outcome("unavailable", "The save expired before writing. Refresh the definitions.");
      let raw = "";
      const fresh = await this.loader.load(input.projectId, input.threadId, signal, source => {raw = source;});
      if (!fresh.revision || fresh.workspaceRoot !== root || fresh.revision !== input.expectedRevision)
        return outcome("conflict", "The working directory, rules or blocks changed. Your draft was kept; refresh before saving again.", fresh);
      if (fresh.globalOnly) return outcome("conflict", "The selected definition scope changed. Refresh before saving.", fresh);
      const ids = new Set(fresh.blocks.filter(block => block.origin !== "global").map(b => b.id));
      if (input.rules.some(r => r.required_blocks.some(id => !ids.has(id))))
        return outcome("invalid", "Every required block must exist and be valid in this working directory.", fresh);
      const intended = parseDefinitionRules(contents);
      const document = parseDocument(raw);
      const existing = document.get("rules", true);
      if (!isSeq(existing)) return outcome("conflict", "The rules file is no longer editable. Refresh before saving.");
      const prior = [...existing.items];
      existing.items = intended.map((rule, index) => {
        const matching = prior.find(node => isMap(node) && String(node.get("name")).trim() === rule.name);
        const candidate = matching ?? (prior.length === intended.length ? prior[index] : null);
        if (!isMap(candidate)) return document.createNode(rule);
        const node = candidate.clone();
        node.set("name", rule.name);node.set("description", rule.description);
        const required = node.get("required_blocks", true);
        if (isSeq(required)) {
          required.items = rule.required_blocks.map(id => required.items.find(item => String(item) === id) ?? document.createNode(id));
        } else node.set("required_blocks", rule.required_blocks);
        return node;
      });
      contents = document.toString({lineWidth: 0});
      if (Buffer.byteLength(contents) > 64 * 1024 || JSON.stringify(parseDefinitionRules(contents)) !== JSON.stringify(intended))
        return outcome("invalid", "The edited YAML could not preserve the intended rules within the file limit.");
      try {
        if (!await this.writer.checkRulesFile(root, signal))
          return outcome("unavailable", "Editing requires an existing regular rules.yaml and .t3-supervisor directory. Symlinks and incomplete listings cannot be edited.");
      } catch (error) {return outcome(error instanceof ProjectFileError && error.code === "permission_required" ? "permission_required" : "unavailable", "Could not verify the rules-file write target. Check the write credential's filesystem:read scope.");}
      if (await this.loader.currentWorkspace(input.projectId, input.threadId, signal) !== root)
        return outcome("conflict", "The selected working directory changed before writing. Refresh before saving again.");
      if (signal.aborted) return outcome("unavailable", "The save expired before writing. Refresh the definitions.");
      try {await this.writer.writeRules(root, contents, signal);}
      catch (error) {
        if (error instanceof ProjectFileError && error.code === "permission_required")
          return outcome("permission_required", error.message, fresh);
        return outcome("uncertain", "The write outcome could not be confirmed. Your draft was kept. Refresh and inspect rules.yaml before retrying.");
      }
      const verified = await this.loader.load(input.projectId, input.threadId, signal);
      try {
        const bytes = await this.loader.files.read(root, ".t3-supervisor/rules.yaml", signal);
        if (!await this.writer.checkRulesFile(root, signal) || bytes.truncated || bytes.contents !== contents || bytes.byteLength !== Buffer.byteLength(contents))
          return outcome("uncertain", "The file changed or could not be confirmed after writing. Refresh and inspect rules.yaml before retrying.", verified);
      } catch {return outcome("uncertain", "The write was accepted, but the file could not be confirmed. Refresh before retrying.", verified);}
      const projectRules = verified.rules.filter(rule => rule.origin !== "global").map(({name, description, required_blocks}) => ({name, description, required_blocks}));
      if (verified.workspaceRoot !== root || !verified.revision || JSON.stringify(projectRules) !== JSON.stringify(parseDefinitionRules(contents)))
        return outcome("uncertain", "T3 accepted the write, but readback could not confirm it. Refresh and inspect rules.yaml before retrying.", verified);
      if (verified.status === "ready") {
        try {this.onSaved?.(verified, input.expectedRevision);}
        catch {return outcome("uncertain", "The file was saved, but its user-authorization record could not be retained. Refresh before retrying.", verified);}
      }
      return outcome("saved", "Saved .t3-supervisor/rules.yaml. Rule changes are recorded as user input; independent block changes still require review.", verified);
    } finally {
      release();
      if (this.active.get(root) === queued) this.active.delete(root);
    }
  }
}
