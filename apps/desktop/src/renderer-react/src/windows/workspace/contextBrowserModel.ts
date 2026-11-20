import type { ContextRequestDetail } from "@reina/protocol";

export const CONTEXT_BROWSER_CATEGORIES = ["system", "tools", "user", "injected", "assistant", "toolResults"] as const;
export type ContextBrowserCategory = (typeof CONTEXT_BROWSER_CATEGORIES)[number];
export type ContextBrowserSort = "order" | "tokens" | "name";
type DetailItem = ContextRequestDetail["sections"][number]["items"][number] & {
  category?: ContextBrowserCategory;
  source?: string;
  role?: string;
};

export interface ContextBrowserItem {
  id: string;
  originalId: string;
  sectionId: string;
  label: string;
  name: string;
  content: string;
  data: Record<string, unknown> | null;
  category: ContextBrowserCategory;
  source: string | null;
  tokens: number | null;
  truncated: boolean;
  omitted: boolean;
  order: number;
}

export interface ContextBrowserGroup {
  category: ContextBrowserCategory;
  items: ContextBrowserItem[];
  count: number;
  tokens: number | null;
  countDelta: number | null;
  tokenDelta: number | null;
  incomplete: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseContent(content: string): Record<string, unknown> | null {
  try { return record(JSON.parse(content)); } catch { return null; }
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function categoryOf(sectionId: string, item: DetailItem, data: Record<string, unknown> | null): ContextBrowserCategory {
  if (item.category && CONTEXT_BROWSER_CATEGORIES.includes(item.category)) return item.category;
  if (sectionId === "system") return "system";
  if (sectionId === "tools") return "tools";
  if (sectionId === "observations" || record(data?.toolResult)) return "toolResults";
  if (sectionId === "reminders") return "injected";
  const role = item.role ?? data?.role ?? /^\d+\. (system|user|assistant|tool)$/.exec(item.label)?.[1];
  if (role === "system") return "system";
  if (role === "tool") return "toolResults";
  if (role === "assistant") return "assistant";
  if (role === "user" && !data?.origin && !data?.contextState && !data?.ephemeral) return "user";
  // Preserve unfamiliar/older sections as injected input instead of dropping them.
  return "injected";
}

export function contextBrowserItems(detail: ContextRequestDetail): ContextBrowserItem[] {
  const items: ContextBrowserItem[] = [];
  const seen = new Map<string, number>();
  for (const section of detail.sections) {
    for (const item of section.items) {
      const data = parseContent(item.content);
      const tool = record(data?.toolResult);
      const category = categoryOf(section.id, item, data);
      const name = nonempty(tool?.name) ?? nonempty(data?.name) ?? item.label;
      const base = JSON.stringify([section.id, item.id]);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const metadata = item as DetailItem;
      const mcp = (category === "tools" || category === "toolResults") ? /^mcp__(.+?)__(.+)$/.exec(name) : null;
      const source = nonempty(metadata.source);
      items.push({
        id: `${base}:${occurrence}`, originalId: item.id, sectionId: section.id,
        label: item.label, name, content: item.content, data, category,
        source: source && source !== name && !["system", "user", "assistant", "tool"].includes(source)
          ? source : mcp ? `MCP · ${mcp[1]}` : null,
        tokens: typeof item.tokens === "number" && Number.isFinite(item.tokens) && item.tokens >= 0 ? item.tokens : null,
        truncated: item.truncated === true,
        omitted: item.id === `${section.id}-omitted` && item.truncated === true,
        order: items.length,
      });
    }
  }
  return items;
}

export function contextBrowserGroups(detail: ContextRequestDetail, previousDetail: ContextRequestDetail | null): ContextBrowserGroup[] {
  const current = contextBrowserItems(detail);
  const previous = previousDetail ? contextBrowserItems(previousDetail) : null;
  const total = (items: ContextBrowserItem[]) => items.some((item) => item.tokens === null || item.omitted)
    ? null : items.reduce((sum, item) => sum + item.tokens!, 0);
  return CONTEXT_BROWSER_CATEGORIES.map((category) => {
    const items = current.filter((item) => item.category === category);
    const oldItems = previous?.filter((item) => item.category === category) ?? null;
    const count = items.filter((item) => !item.omitted).length;
    const tokens = total(items);
    const oldTokens = oldItems ? total(oldItems) : null;
    const incomplete = [...items, ...(oldItems ?? [])].some((item) => item.truncated);
    return {
      category, items, count, tokens, incomplete,
      countDelta: oldItems ? count - oldItems.filter((item) => !item.omitted).length : null,
      tokenDelta: !incomplete && tokens !== null && oldTokens !== null ? tokens - oldTokens : null,
    };
  });
}

export function filterContextBrowserItems(items: ContextBrowserItem[], query: string, sort: ContextBrowserSort): ContextBrowserItem[] {
  const needle = query.trim().toLocaleLowerCase();
  const visible = items.filter((item) => !needle || `${item.label}\n${item.name}\n${item.source ?? ""}\n${item.content}`.toLocaleLowerCase().includes(needle));
  return visible.sort((a, b) => {
    if (sort === "tokens") return (b.tokens ?? -1) - (a.tokens ?? -1) || a.order - b.order;
    if (sort === "name") return a.name.localeCompare(b.name) || a.order - b.order;
    return a.order - b.order;
  });
}

export type ContextContentBlock = { kind: "content" | "reasoning" | "arguments" | "result" | "schema" | "description" | "error" | "metadata"; text: string; markdown: boolean };
export type ContextAttachment = { name: string; kind: string; mime: string };

/** Expand structured snapshots only when a row is opened. Raw mode always
 * remains available, including fields unfamiliar to this renderer. */
export function contextBrowserContent(item: ContextBrowserItem): { blocks: ContextContentBlock[]; attachments: ContextAttachment[] } {
  const data = item.data;
  if (!data) return { blocks: [{ kind: "content", text: item.content, markdown: true }], attachments: [] };
  const blocks: ContextContentBlock[] = [];
  const add = (kind: ContextContentBlock["kind"], value: unknown, markdown = false) => {
    if (value === undefined || value === null || value === "") return;
    blocks.push({ kind, text: typeof value === "string" ? value : JSON.stringify(value, null, 2), markdown });
  };
  const tool = record(data.toolResult);
  if (item.category === "tools") {
    add("description", data.description, true);
    add("schema", data.inputSchema ?? data.parameters ?? data.schema);
  } else if (item.category === "toolResults") {
    add("arguments", tool?.input ?? data.input ?? data.arguments);
    add("result", tool?.output ?? data.output ?? data.content, true);
    add("error", tool?.error ?? data.error, true);
  } else {
    add("reasoning", data.reasoning, true);
    if (!data.reasoning) add("reasoning", data.reasoningTrace);
    add("content", data.content, true);
  }
  const attachmentValues = [data.attachments, tool?.attachments].flatMap((value) => Array.isArray(value) ? value : []);
  const attachments = attachmentValues.flatMap((value): ContextAttachment[] => {
    const attachment = record(value);
    if (!attachment) return [];
    return [{ name: nonempty(attachment.name) ?? "", kind: nonempty(attachment.kind) ?? "file", mime: nonempty(attachment.mime) ?? "" }];
  });
  if (!blocks.length && !attachments.length) add("metadata", data);
  return { blocks, attachments };
}
