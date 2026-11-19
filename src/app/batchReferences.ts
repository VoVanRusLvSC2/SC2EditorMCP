export function resolveBatchReferences(
  value: unknown,
  results: Map<string, unknown>,
  depth = 0,
): unknown {
  if (depth > 30) throw new Error("MCP_BATCH_DEPTH");
  if (Array.isArray(value)) return value.map((v) => resolveBatchReferences(v, results, depth + 1));
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length === 1 && typeof v.$from === "string") {
      const parts = v.$from.split(".");
      if (
        parts.length > 12 ||
        parts.some((p) => !/^\w+$/.test(p) || ["__proto__", "prototype", "constructor"].includes(p))
      )
        throw new Error("MCP_BATCH_REFERENCE_UNSAFE");
      let found = results.get(parts.shift()!);
      for (const key of parts) {
        if (!found || typeof found !== "object" || !Object.hasOwn(found, key))
          throw new Error("MCP_BATCH_REFERENCE_MISSING: " + v.$from);
        found = (found as Record<string, unknown>)[key];
      }
      if (found === undefined) throw new Error("MCP_BATCH_REFERENCE_MISSING: " + v.$from);
      return structuredClone(found);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("MCP_BATCH_KEY_UNSAFE");
      out[key] = resolveBatchReferences(item, results, depth + 1);
    }
    return out;
  }
  return value;
}
export const hasBatchReference = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(hasBatchReference)
    : value && typeof value === "object"
      ? Object.entries(value).some(([key, item]) => key === "$from" || hasBatchReference(item))
      : false;
