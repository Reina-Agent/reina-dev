import type { ToolName, ToolObservation } from "@reina/protocol";
import { errorMessage } from "@reina/protocol";
import { ZodError, ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";
import { toolRegistry } from "./registry.js";
import type { ToolExecutionResult, ToolRuntimeOptions } from "./types.js";
import { truncateText } from "./utils.js";

export type RunToolResult = ToolObservation & {
  metadata?: ToolExecutionResult["metadata"];
};

export async function previewTool(name: ToolName, input: unknown, options: ToolRuntimeOptions): Promise<string | undefined> {
  return toolRegistry.get(name)?.preview?.(input, options);
}

export async function runTool(name: ToolName, input: unknown, options: ToolRuntimeOptions): Promise<RunToolResult> {
  const tool = toolRegistry.get(name);
  try {
    if (!tool) return fail(name, `${name} is not implemented by @reina/tools.`);
    return ok(name, await tool.execute(input, options));
  } catch (error) {
    return fail(name, formatToolError(name, input, error, tool?.descriptor.inputSchema));
  }
}

function ok(name: ToolName, result: string | ToolExecutionResult): RunToolResult {
  if (typeof result === "string") return { callId: "", name, output: result };
  return {
    callId: "",
    name,
    output: result.output,
    metadata: result.metadata,
    ...(result.attachments?.length ? { attachments: result.attachments } : {}),
  };
}

function fail(name: ToolName, error: string): ToolObservation {
  return { callId: "", name, error };
}

function formatToolError(name: ToolName, input: unknown, error: unknown, schema?: ZodTypeAny): string {
  if (error instanceof ZodError) return formatValidationError(name, input, error, schema);
  const message = errorMessage(error);
  return [
    `<tool_error tool="${name}" phase="execution">`,
    `<message>${message}</message>`,
    `<received_input>${safeJson(input)}</received_input>`,
    `<retry_guidance>Use the message above to correct the tool input or environment, then retry the same tool if appropriate.</retry_guidance>`,
    "</tool_error>",
  ].join("\n");
}

function formatValidationError(name: ToolName, input: unknown, error: ZodError, schema?: ZodTypeAny): string {
  const topShape = objectShape(schema);
  const acceptedFieldsByPath = new Map<string, string[]>();
  const requiredFields: string[] = [];
  if (topShape) {
    acceptedFieldsByPath.set("(root)", Object.keys(topShape));
    for (const [key, field] of Object.entries(topShape)) {
      if (!field.isOptional()) requiredFields.push(key);
    }
  }
  // Walk each issue back to its container shape so a typo in a nested
  // field (e.g. `edits.0.olText` for `oldText`) sees its sibling fields,
  // not just the top-level object's keys. Closes the most common
  // multi_edit / nested-object self-correction gap.
  if (schema) {
    for (const issue of error.issues) {
      if (issue.path.length === 0) continue;
      const containerPath = issue.path.slice(0, -1);
      if (containerPath.length === 0) continue; // top-level — already covered
      const container = walkSchemaToPath(schema, containerPath);
      const shape = objectShape(container);
      if (!shape) continue;
      const labeled = labelPath(containerPath);
      if (!acceptedFieldsByPath.has(labeled)) {
        acceptedFieldsByPath.set(labeled, Object.keys(shape));
      }
    }
  }
  const lines: Array<string | undefined> = [
    `<tool_error tool="${name}" phase="input_validation">`,
    "<message>Tool input did not match the required schema.</message>",
    "<issues>",
    ...error.issues.map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`),
    "</issues>",
  ];
  for (const [path, fields] of acceptedFieldsByPath) {
    lines.push(`<accepted_fields path="${path}">${fields.join(", ")}</accepted_fields>`);
  }
  if (requiredFields.length > 0) lines.push(`<required_fields>${requiredFields.join(", ")}</required_fields>`);
  lines.push(`<received_input>${safeJson(input)}</received_input>`);
  lines.push(`<retry_guidance>Retry ${name} with corrected JSON arguments. Keep only valid field names and use the expected primitive types shown in the issues.</retry_guidance>`);
  lines.push("</tool_error>");
  return lines.filter((line) => line !== undefined).join("\n");
}

function objectShape(schema: ZodTypeAny | undefined): Record<string, ZodTypeAny> | undefined {
  const unwrapped = schema ? unwrapWrappers(schema) : undefined;
  if (!unwrapped || unwrapped._def.typeName !== ZodFirstPartyTypeKind.ZodObject) return undefined;
  const shape = unwrapped._def.shape;
  return typeof shape === "function" ? shape() : shape;
}

/** Walk a Zod schema along a ZodError issue path so we can reach the
 * container shape of a nested validation failure. Handles object fields,
 * array elements (numeric path segments), tuple elements, and skips
 * optional/nullable/default/effects wrappers. Returns undefined when the
 * path can't be resolved (records, unions, etc.). */
function walkSchemaToPath(root: ZodTypeAny, path: ReadonlyArray<string | number>): ZodTypeAny | undefined {
  let current: ZodTypeAny | undefined = unwrapWrappers(root);
  for (const seg of path) {
    if (!current) return undefined;
    const shape = objectShape(current);
    if (shape) {
      const inner = shape[String(seg)];
      if (!inner) return undefined;
      current = unwrapWrappers(inner);
      continue;
    }
    const def = current._def;
    if (def.typeName === ZodFirstPartyTypeKind.ZodArray) {
      current = unwrapWrappers(def.type as ZodTypeAny);
      continue;
    }
    if (def.typeName === ZodFirstPartyTypeKind.ZodTuple) {
      const items = (def.items as ZodTypeAny[]) ?? [];
      const idx = typeof seg === "number" ? seg : Number.parseInt(String(seg), 10);
      const element = Number.isFinite(idx) ? items[idx] : undefined;
      if (!element) return undefined;
      current = unwrapWrappers(element);
      continue;
    }
    return undefined;
  }
  return current;
}

/** Strip optional/nullable/default/effects wrappers to reach the underlying
 * schema shape. Mirrors the schema-summary walker so paths through the same
 * decorations land on the same inner type. */
function unwrapWrappers(schema: ZodTypeAny): ZodTypeAny {
  const name = schema._def.typeName;
  if (name === ZodFirstPartyTypeKind.ZodOptional) return unwrapWrappers(schema._def.innerType as ZodTypeAny);
  if (name === ZodFirstPartyTypeKind.ZodNullable) return unwrapWrappers(schema._def.innerType as ZodTypeAny);
  if (name === ZodFirstPartyTypeKind.ZodDefault) return unwrapWrappers(schema._def.innerType as ZodTypeAny);
  if (name === ZodFirstPartyTypeKind.ZodEffects) return unwrapWrappers(schema._def.schema as ZodTypeAny);
  return schema;
}

/** Render a Zod issue path as a stable label. Numeric array indices become
 * `[]` so the label points at the element TYPE (which is what
 * accepted_fields advertises) rather than at one specific index. */
function labelPath(path: ReadonlyArray<string | number>): string {
  return path.map((seg) => (typeof seg === "number" ? "[]" : seg)).join(".");
}

function safeJson(value: unknown): string {
  try {
    return truncateText(JSON.stringify(value, null, 2), 4096, 120);
  } catch {
    return String(value);
  }
}
