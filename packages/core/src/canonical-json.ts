import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | string
  | number
  | boolean
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function normalizeJsonValue(value: unknown): CanonicalJsonValue {
  const active = new WeakSet<object>();
  const visit = (entry: unknown): CanonicalJsonValue => {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    )
      return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry))
        throw new Error("JSON numbers must be finite.");
      return entry;
    }
    if (!entry || typeof entry !== "object")
      throw new Error("Value is not JSON serializable.");
    if (active.has(entry)) throw new Error("JSON values cannot be cyclic.");
    active.add(entry);
    try {
      if (Array.isArray(entry)) return entry.map(visit);
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("JSON objects must be plain objects.");
      return Object.fromEntries(
        Object.entries(entry).map(([key, item]) => [key, visit(item)]),
      );
    } finally {
      active.delete(entry);
    }
  };
  return visit(value);
}

function stableNormalizedJson(value: CanonicalJsonValue): string {
  if (Array.isArray(value))
    return `[${value.map(stableNormalizedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableNormalizedJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableJson(value: unknown): string {
  return stableNormalizedJson(normalizeJsonValue(value));
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
