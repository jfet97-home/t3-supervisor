const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeJson = (value: unknown, depth = 0): unknown => {
  if (depth > 64) throw new Error("json_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeJson(item, depth + 1));
  if (!isRecord(value)) throw new Error("json_value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("json_prototype");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) result[key] = normalizeJson(value[key], depth + 1);
  return result;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value));
