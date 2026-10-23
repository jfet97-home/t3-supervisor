import {redact} from "./credential-redaction.js";
import {Schema} from "effect";

export type SupportingReference = string;
export type DefinitionGuidance = {readonly references?: readonly string[]; readonly skills?: readonly string[]};
export const definitionReferenceLimits = {maxPaths: 100, maxPathLength: 4096, maxSkillNameLength: 256} as const;

const referenceProblemText = {
  references_not_list: "references must be a list of relative file paths",
  references_too_many: `references may list at most ${definitionReferenceLimits.maxPaths} paths`,
  reference_not_text: "each reference must be a text path",
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
  skills_not_list: "skills must be a list of relative SKILL.md paths or exact catalog names",
  skills_too_many: `skills may list at most ${definitionReferenceLimits.maxPaths} entries`,
  skill_not_text: "each skill must be a text path or catalog name",
  skill_empty: "a skill cannot be empty",
  skill_too_long: "a skill path can have at most 4096 characters and a catalog name at most 256",
  skill_surrounding_whitespace: "a skill cannot start or end with whitespace",
  skill_control_character: "a skill cannot contain control or formatting characters",
  skill_credential_like: "a skill cannot contain credential-like text",
  skill_path_invalid: "a skill path must be a canonical checkout-relative path with forward slashes and no traversal or scheme",
  skill_path_not_skill_md: "a skill path must name SKILL.md exactly",
  skill_name_invalid: "a skill name must match the exact catalog name with optional colon namespaces",
  skill_duplicate: "a skill cannot appear more than once",
} as const;

export type DefinitionReferenceProblemCode = keyof typeof referenceProblemText;
/** A fixed reason, field and zero-based position. Rejected input is never included. */
export type DefinitionReferenceProblem = {field: "references" | "skills"; code: DefinitionReferenceProblemCode; index: number | null};

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

const skillProblem = (value: unknown): DefinitionReferenceProblemCode | null => {
  if (typeof value !== "string") return "skill_not_text";
  if (!value.length) return "skill_empty";
  if (value.length > definitionReferenceLimits.maxPathLength) return "skill_too_long";
  if (value.trim() !== value) return "skill_surrounding_whitespace";
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) return "skill_control_character";
  if (redact(value) !== value) return "skill_credential_like";
  if (value.includes("/") || /\.md$/iu.test(value)) {
    if (pathProblem(value) || value.split("/").some(segment => segment === "" || segment === ".")) return "skill_path_invalid";
    return value.split("/").at(-1) === "SKILL.md" ? null : "skill_path_not_skill_md";
  }
  if (value.length > definitionReferenceLimits.maxSkillNameLength) return "skill_too_long";
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/u.test(value) ? null : "skill_name_invalid";
};

// validate original strings without normalizing source-bound or authenticated input
export const SupportingReference = Schema.declare((value): value is string => pathProblem(value) === null);
export const SupportingReferences = Schema.Array(SupportingReference).check(Schema.makeFilter(value => value.length <= definitionReferenceLimits.maxPaths));
export const SupportingSkill = Schema.declare((value): value is string => skillProblem(value) === null);
export const SupportingSkills = Schema.Array(SupportingSkill).check(Schema.makeFilter(value => value.length <= definitionReferenceLimits.maxPaths && new Set(value).size === value.length));

export const definitionReferenceProblem = (value: unknown, field: "references" | "skills" = "references"): DefinitionReferenceProblem | null => {
  if (!Array.isArray(value)) return {field, code: field === "skills" ? "skills_not_list" : "references_not_list", index: null};
  if (value.length > definitionReferenceLimits.maxPaths) return {field, code: field === "skills" ? "skills_too_many" : "references_too_many", index: null};
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const code = field === "skills" ? skillProblem(entry) : pathProblem(entry);
    if (code) return {field, code, index};
    if (field === "skills" && seen.has(entry as string)) return {field, code: "skill_duplicate", index};
    seen.add(entry as string);
  }
  return null;
};
export const definitionGuidanceProblem = (value: Record<string, unknown>): DefinitionReferenceProblem | null => {
  for (const field of ["references", "skills"] as const) {
    const problem = Object.hasOwn(value, field) ? definitionReferenceProblem(value[field], field) : null;
    if (problem) return problem;
  }
  return null;
};
export const validDefinitionGuidance = (value: Record<string, unknown>): boolean => definitionGuidanceProblem(value) === null;

/** Describes a rejected list with fixed text and a numeric position only. */
export const describeDefinitionReferenceProblem = (problem: DefinitionReferenceProblem): string =>
  `${problem.field}${problem.index === null ? "" : `[${problem.index}]`} is invalid: ${referenceProblemText[problem.code]}.`;

export const definitionGuidanceFields = ({references, skills}: {readonly references?: readonly string[] | undefined; readonly skills?: readonly string[] | undefined}): DefinitionGuidance => ({
  ...(references === undefined ? {} : {references: [...references]}),
  ...(skills === undefined ? {} : {skills: [...skills]}),
});
export const sameStringList = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((entry, index) => entry === right?.[index]);
export const sameDefinitionGuidance = (left: DefinitionGuidance, right: DefinitionGuidance): boolean =>
  sameStringList(left.references, right.references) && sameStringList(left.skills, right.skills);

export const supportingReferencesJsonSchema = {
  type: "array", maxItems: definitionReferenceLimits.maxPaths,
  items: {type: "string", minLength: 1, maxLength: definitionReferenceLimits.maxPathLength},
} as const;
export const supportingSkillsJsonSchema = {...supportingReferencesJsonSchema, uniqueItems: true,
  description: "Canonical checkout-relative SKILL.md paths or exact catalog names (up to 256 characters, optional colon namespaces)."} as const;
