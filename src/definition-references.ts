import {redact} from "./credential-redaction.js";
import {Schema} from "effect";

export type SupportingReference = string
  | {readonly skill: {readonly scope: "local"; readonly path: string}}
  | {readonly skill: {readonly scope: "global"; readonly name: string}};

export const definitionReferenceLimits = {maxPaths: 100, maxPathLength: 4096} as const;

const referenceProblemText = {
  references_not_list: "references must be a list of relative file paths or explicit skill references",
  references_too_many: `references may list at most ${definitionReferenceLimits.maxPaths} paths`,
  reference_not_text: "each reference must be a text path or an explicit skill reference",
  reference_empty: "a reference cannot be empty",
  reference_too_long: `a reference can have at most ${definitionReferenceLimits.maxPathLength} characters`,
  reference_surrounding_whitespace: "a reference cannot start or end with whitespace",
  reference_control_character: "a reference cannot contain control or formatting characters",
  reference_backslash: "a reference must use forward slashes",
  reference_absolute_path: "a reference must be relative to the checkout root, not absolute",
  reference_home_path: "a reference cannot start with a home directory alias",
  reference_url_like: "a reference must be a file path, not a URL or scheme",
  reference_credential_like: "a reference cannot contain credential-like text",
  reference_traversal: "a reference cannot contain parent directory traversal",
  reference_skill_shape: "a skill reference needs exactly a local scope and path or a global scope and name",
  reference_skill_path: "a local skill path must name SKILL.md relative to the checkout root",
  reference_skill_name: "a global skill name must be an exact catalog name with optional colon namespaces",
} as const;

export type DefinitionReferenceProblemCode = keyof typeof referenceProblemText;
/** A rejected reference list: a fixed reason code and, for a single entry, its zero-based position. Input text is never included. */
export type DefinitionReferenceProblem = {code: DefinitionReferenceProblemCode; index: number | null};

const pathProblem = (path: unknown): DefinitionReferenceProblemCode | null => {
  if (typeof path !== "string") return "reference_not_text";
  if (path.length === 0) return "reference_empty";
  if (path.length > definitionReferenceLimits.maxPathLength) return "reference_too_long";
  if (path.trim() !== path) return "reference_surrounding_whitespace";
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(path)) return "reference_control_character";
  if (path.includes("\\")) return "reference_backslash";
  if (path.startsWith("/")) return "reference_absolute_path";
  if (path.startsWith("~")) return "reference_home_path";
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return "reference_url_like";
  if (redact(path) !== path) return "reference_credential_like";
  if (path.split("/").includes("..")) return "reference_traversal";
  return null;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const referenceProblem = (value: unknown): DefinitionReferenceProblemCode | null => {
  if (typeof value === "string") return pathProblem(value);
  if (!record(value)) return "reference_not_text";
  if (!exactKeys(value, ["skill"]) || !record(value.skill)) return "reference_skill_shape";
  const skill = value.skill;
  if (skill.scope === "local") {
    if (!exactKeys(skill, ["scope", "path"])) return "reference_skill_shape";
    const problem = pathProblem(skill.path);
    if (problem) return problem;
    return typeof skill.path === "string" && /(?:^|\/)SKILL\.md$/u.test(skill.path) ? null : "reference_skill_path";
  }
  if (skill.scope === "global") {
    if (!exactKeys(skill, ["scope", "name"])) return "reference_skill_shape";
    if (typeof skill.name !== "string") return "reference_skill_name";
    if (redact(skill.name) !== skill.name) return "reference_credential_like";
    if (skill.name.length > definitionReferenceLimits.maxPathLength) return "reference_too_long";
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/u.test(skill.name) ? null : "reference_skill_name";
  }
  return "reference_skill_shape";
};

// validate the original representation, including excess keys, without stripping or normalizing authenticated values
export const SupportingReference = Schema.declare((value): value is SupportingReference => referenceProblem(value) === null);
export const SupportingReferences = Schema.Array(SupportingReference).check(Schema.makeFilter(value => value.length <= definitionReferenceLimits.maxPaths));

export const definitionReferenceProblem = (value: unknown): DefinitionReferenceProblem | null => {
  if (!Array.isArray(value)) return {code: "references_not_list", index: null};
  if (value.length > definitionReferenceLimits.maxPaths) return {code: "references_too_many", index: null};
  for (const [index, path] of value.entries()) {
    const code = referenceProblem(path);
    if (code) return {code, index};
  }
  return null;
};

export const validDefinitionReferences = (value: unknown): value is readonly SupportingReference[] => definitionReferenceProblem(value) === null;

/** Describes a rejected reference list with fixed text and a numeric position only. */
export const describeDefinitionReferenceProblem = (problem: DefinitionReferenceProblem): string =>
  `${problem.index === null ? "references" : `references[${problem.index}]`} is invalid: ${referenceProblemText[problem.code]}.`;

const copyReference = (reference: SupportingReference): SupportingReference => typeof reference === "string" ? reference
  : reference.skill.scope === "local" ? {skill: {scope: "local", path: reference.skill.path}}
    : {skill: {scope: "global", name: reference.skill.name}};
export const definitionReferenceFields = (references: readonly SupportingReference[] | undefined): {references?: readonly SupportingReference[]} =>
  references === undefined ? {} : {references: references.map(copyReference)};

export const supportingReferenceLabel = (reference: SupportingReference): string => typeof reference === "string" ? `File: ${reference}`
  : reference.skill.scope === "local" ? `Local skill: ${reference.skill.path}` : `Global skill: ${reference.skill.name}`;

export const sameDefinitionReferences = (left: readonly SupportingReference[] | undefined, right: readonly SupportingReference[] | undefined): boolean =>
  (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((reference, index) => {
    const other = right?.[index];
    if (typeof reference === "string") return reference === other;
    if (!other || typeof other === "string") return false;
    return reference.skill.scope === "local" ? other.skill.scope === "local" && reference.skill.path === other.skill.path
      : other.skill.scope === "global" && reference.skill.name === other.skill.name;
  });

const skillSchema = (scope: "local" | "global", key: "path" | "name") => ({
  type: "object", additionalProperties: false, required: ["skill"], properties: {skill: {
    type: "object", additionalProperties: false, required: ["scope", key],
    properties: {scope: {const: scope}, [key]: {type: "string", minLength: 1, maxLength: definitionReferenceLimits.maxPathLength}},
  }},
});
export const supportingReferencesJsonSchema = {
  type: "array", maxItems: definitionReferenceLimits.maxPaths,
  items: {oneOf: [{type: "string", minLength: 1, maxLength: definitionReferenceLimits.maxPathLength}, skillSchema("local", "path"), skillSchema("global", "name")]},
} as const;
