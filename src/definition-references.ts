import {redact} from "./credential-redaction.js";

export const definitionReferenceLimits = {maxPaths: 100, maxPathLength: 4096} as const;

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
  return null;
};

export const definitionReferenceProblem = (value: unknown): DefinitionReferenceProblem | null => {
  if (!Array.isArray(value)) return {code: "references_not_list", index: null};
  if (value.length > definitionReferenceLimits.maxPaths) return {code: "references_too_many", index: null};
  for (const [index, path] of value.entries()) {
    const code = pathProblem(path);
    if (code) return {code, index};
  }
  return null;
};

export const validDefinitionReferences = (value: unknown): value is readonly string[] => definitionReferenceProblem(value) === null;

/** Describes a rejected reference list with fixed text and a numeric position only. */
export const describeDefinitionReferenceProblem = (problem: DefinitionReferenceProblem): string =>
  `${problem.index === null ? "references" : `references[${problem.index}]`} is invalid: ${referenceProblemText[problem.code]}.`;

export const definitionReferenceFields = (references: readonly string[] | undefined): {references?: readonly string[]} =>
  references === undefined ? {} : {references: [...references]};

export const sameDefinitionReferences = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((path, index) => path === right?.[index]);
