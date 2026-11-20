import type { ToolDescriptor } from "@reina/protocol";
import { z } from "zod";

/** A one-line description of a tool's top-level input parameter, intended for
 * the search_tool result so the model can dispatch on its next turn without a
 * second round-trip to fetch the full descriptor. */
export type ParamInfo = {
  name: string;
  /** Human-readable type, e.g. `string`, `number`, `boolean`, `string[]`,
   * `enum("a"|"b")`, `object`. Falls back to `unknown` for shapes the walker
   * doesn't handle (uncommon — unions of object types, recursive refs, etc). */
  type: string;
  required: boolean;
  /** Per-parameter description from zod `.describe()` or JSON-schema
   * `description`. Truncated to `descriptionCap` chars so a chatty paragraph
   * can't blow up the search output budget. May be undefined. */
  description?: string;
};

const descriptionCap = 200;

/** Memo: descriptors are process-singletons (defined at module load), so the
 * same descriptor reaches `summarizeToolSchema` many times via the catalog
 * provider. Cache the param list to keep search calls cheap. Regular Map is
 * fine here — descriptors live as long as the process. */
const memo = new Map<ToolDescriptor, ParamInfo[]>();

/** Summarise a tool descriptor's top-level input parameters. Prefers
 * `inputJsonSchema` (set by MCP runtime tools, which use a generic
 * passthrough zod schema) and falls back to walking the zod schema. Returns
 * `[]` for tools whose input is not a top-level object (parameterless or
 * `z.unknown()` callers). */
export function summarizeToolSchema(descriptor: ToolDescriptor): ParamInfo[] {
  const cached = memo.get(descriptor);
  if (cached) return cached;

  let params: ParamInfo[] = [];
  if (descriptor.inputJsonSchema && hasJsonSchemaProperties(descriptor.inputJsonSchema)) {
    params = summarizeJsonSchema(descriptor.inputJsonSchema);
  } else {
    params = summarizeZodSchema(descriptor.inputSchema);
  }
  memo.set(descriptor, params);
  return params;
}

/** Test-only escape hatch so unit tests can rebuild a cached entry after
 * mutating a synthetic descriptor. Never used in product code. */
export function clearSchemaSummaryCache(): void {
  memo.clear();
}

function hasJsonSchemaProperties(schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  return typeof props === "object" && props !== null && Object.keys(props as object).length > 0;
}

// ─── zod walker ────────────────────────────────────────────────────────────

function summarizeZodSchema(schema: z.ZodTypeAny): ParamInfo[] {
  const root = unwrapEffects(schema);
  if (!(root instanceof z.ZodObject)) return [];
  const shape = root.shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape).map(([name, fieldSchema]) => {
    const required = !fieldSchema.isOptional();
    const unwrapped = unwrapWrappers(fieldSchema);
    // Read description from the outer wrapper first; `.describe()` placement
    // is inconsistent across the codebase (some put it on the optional, some
    // on the inner type). Falling back recovers both styles.
    const rawDescription = fieldSchema.description ?? unwrapped.description;
    return {
      name,
      type: zodTypeName(unwrapped),
      required,
      description: rawDescription ? truncate(rawDescription) : undefined,
    };
  });
}

/** Strip `.refine()` / `.transform()` / `.brand()` layers that wrap an inner
 * schema. These mostly appear at the root of complex schemas; the walker
 * needs to see through to the ZodObject underneath. */
function unwrapEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodEffects) return unwrapEffects(schema._def.schema);
  return schema;
}

/** Strip optional / nullable / default wrappers to reach the type that
 * actually describes the value's shape. Required-ness was already captured
 * before the unwrap, so losing the optional wrapper here is intentional. */
function unwrapWrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) return unwrapWrappers(schema._def.innerType);
  if (schema instanceof z.ZodNullable) return unwrapWrappers(schema._def.innerType);
  if (schema instanceof z.ZodDefault) return unwrapWrappers(schema._def.innerType);
  if (schema instanceof z.ZodEffects) return unwrapWrappers(schema._def.schema);
  return schema;
}

function zodTypeName(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodArray) return `${zodTypeName(schema.element)}[]`;
  if (schema instanceof z.ZodEnum) return `enum(${(schema.options as readonly string[]).map((o) => JSON.stringify(o)).join("|")})`;
  if (schema instanceof z.ZodNativeEnum) return "enum";
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodUnion) {
    const parts = (schema.options as z.ZodTypeAny[]).map(zodTypeName);
    // dedupe so `string|string` from a refined union collapses
    return [...new Set(parts)].join("|");
  }
  if (schema instanceof z.ZodObject) return "object";
  if (schema instanceof z.ZodRecord) return "object";
  if (schema instanceof z.ZodAny) return "any";
  if (schema instanceof z.ZodUnknown) return "unknown";
  if (schema instanceof z.ZodTuple) return "array";
  return "unknown";
}

// ─── JSON-schema walker (for MCP tools, Phase 2 readiness) ─────────────────

function summarizeJsonSchema(jsonSchema: Record<string, unknown>): ParamInfo[] {
  const properties = jsonSchema.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const requiredList = Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [];
  const requiredSet = new Set(requiredList);
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const prop = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const description = typeof prop.description === "string" ? truncate(prop.description) : undefined;
    return {
      name,
      type: jsonTypeName(prop),
      required: requiredSet.has(name),
      description,
    };
  });
}

function jsonTypeName(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return `enum(${prop.enum.map((v) => JSON.stringify(v)).join("|")})`;
  }
  if (Array.isArray(prop.anyOf) || Array.isArray(prop.oneOf)) {
    const list = (prop.anyOf as Record<string, unknown>[] | undefined) ?? (prop.oneOf as Record<string, unknown>[]);
    const parts = list.map(jsonTypeName);
    return [...new Set(parts)].join("|");
  }
  const t = prop.type;
  if (Array.isArray(t)) return t.join("|");
  if (typeof t !== "string") return "unknown";
  if (t === "array") {
    const items = prop.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      return `${jsonTypeName(items as Record<string, unknown>)}[]`;
    }
    return "array";
  }
  return t;
}

// ─── shared formatting ─────────────────────────────────────────────────────

/** Render a parameter as one indented line for the search_tool XML body. */
export function formatParamLine(info: ParamInfo): string {
  const flag = info.required ? "required" : "optional";
  const head = `${info.name} (${info.type}, ${flag})`;
  return info.description ? `${head} — ${info.description}` : head;
}

function truncate(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= descriptionCap) return cleaned;
  return `${cleaned.slice(0, descriptionCap - 1)}…`;
}

// ─── example synthesis (MCP path) ──────────────────────────────────────────

/** Synthesize a minimal placeholder example from an `inputJsonSchema`,
 * showing the JSON SHAPE of a valid call (required-only) so the model has a
 * concrete template to imitate. Used for MCP tools that don't ship their
 * own examples — addresses the "right tool, wrong args" failure mode the
 * Anthropic tool-design article calls out. Returns `undefined` when the
 * schema has no required fields (an empty `{}` body adds no signal). */
export function synthesizeExampleFromJsonSchema(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const properties = jsonSchema.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const requiredList = Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [];
  if (requiredList.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const name of requiredList) {
    const raw = (properties as Record<string, unknown>)[name];
    if (!raw || typeof raw !== "object") continue;
    out[name] = placeholderForJsonProp(raw as Record<string, unknown>);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function placeholderForJsonProp(prop: Record<string, unknown>): unknown {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  if (Array.isArray(prop.anyOf) && prop.anyOf.length > 0) {
    const first = prop.anyOf[0];
    if (first && typeof first === "object") return placeholderForJsonProp(first as Record<string, unknown>);
  }
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) {
    const first = prop.oneOf[0];
    if (first && typeof first === "object") return placeholderForJsonProp(first as Record<string, unknown>);
  }
  const rawType = prop.type;
  const t = Array.isArray(rawType) ? rawType[0] : rawType;
  if (typeof t !== "string") return null;
  if (t === "string") {
    // Hint with the field's own description when present so the placeholder
    // doesn't read as opaque (`<string>`) for tools with stricter shapes.
    if (typeof prop.description === "string" && prop.description.trim()) {
      const tag = prop.description.trim().split(/\s+/).slice(0, 4).join("-").toLowerCase();
      return `<${tag.slice(0, 32) || "string"}>`;
    }
    return "<string>";
  }
  if (t === "integer" || t === "number") return 0;
  if (t === "boolean") return false;
  if (t === "array") {
    const items = prop.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      return [placeholderForJsonProp(items as Record<string, unknown>)];
    }
    return [];
  }
  if (t === "object") {
    const nested = synthesizeExampleFromJsonSchema(prop);
    return nested ?? {};
  }
  if (t === "null") return null;
  return null;
}
