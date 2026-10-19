export const definitionReferenceLimits = {maxPaths: 100, maxPathLength: 4096} as const;

export const validDefinitionReferences = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= definitionReferenceLimits.maxPaths && value.every(path =>
    typeof path === "string" && path.length > 0 && path.length <= definitionReferenceLimits.maxPathLength &&
    path.trim() === path && !/[\u0000-\u001f\u007f\\]/u.test(path) && !path.startsWith("/") && !path.startsWith("~") &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(path));

export const definitionReferenceFields = (references: readonly string[] | undefined): {references?: readonly string[]} =>
  references === undefined ? {} : {references: [...references]};

export const sameDefinitionReferences = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((path, index) => path === right?.[index]);
