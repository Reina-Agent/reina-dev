import type { ContextRequestDetail } from "@reina/protocol";
import { contextBrowserItems } from "./contextBrowserModel";

export type ContextFileKind = "read" | "write" | "search" | "image";
export type ContextFileStatus = "recorded" | "completed" | "failed";
export interface ContextFileOperation {
  id: string;
  tool: string;
  kind: ContextFileKind;
  status: ContextFileStatus;
  input: unknown;
  output: string;
  error: string;
  truncated: boolean;
  order: number;
}
export interface ContextFileEntry {
  path: string;
  operations: ContextFileOperation[];
  counts: Record<ContextFileKind, number>;
}
export interface ContextFileActivity {
  files: ContextFileEntry[];
  counts: Record<ContextFileKind, number>;
  calls: number;
  unresolved: number;
  truncated: boolean;
}

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "grep", "glob"]);
const counts = (): Record<ContextFileKind, number> => ({ read: 0, write: 0, search: 0, image: 0 });
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => typeof value === "string" ? value : "";

function inputRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
}

function filePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) return null;
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return path !== "." && path !== "/dev/null" ? path : null;
}

/** Inspect only unified diff file headers, never header-like text inside a
 * hunk. Quoted git paths are left unresolved rather than decoded incorrectly. */
export function contextPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split(/\r?\n/);
  let oldLines = 0;
  let newLines = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (oldLines > 0 || newLines > 0) {
      if (line.startsWith(" ") || line.startsWith("-")) oldLines--;
      if (line.startsWith(" ") || line.startsWith("+")) newLines--;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) { oldLines = Number(hunk[1] ?? 1); newLines = Number(hunk[2] ?? 1); continue; }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      for (const header of [line.slice(4), lines[++index]!.slice(4)]) {
        const path = /^[ab]\/(.+)$/.exec(header.split("\t")[0]!)?.[1];
        const resolved = filePath(path);
        if (resolved) paths.add(resolved);
      }
    }
    const renamed = /^(?:rename|copy) (?:from|to) ([^"].*)$/.exec(line);
    if (renamed) {
      const resolved = filePath(renamed[1]);
      if (resolved) paths.add(resolved);
    }
  }
  return [...paths];
}

function searchPaths(tool: string, input: Record<string, unknown> | null, output: string, truncated: boolean): string[] {
  const mode = tool === "glob" ? "files_with_matches" : input?.output_mode ?? "files_with_matches";
  const listHeader = tool === "glob" ? /<note>\d+ file\(s\) matching [\s\S]*?<\/note>\r?\n/ : /<note>\d+ file\(s\) with matches[^\n]*<\/note>\r?\n/;
  let body = output;
  if (mode === "files_with_matches") {
    const header = listHeader.exec(output);
    if (!header) return [];
    body = output.slice(header.index + header[0].length);
  }
  // Runtime replay cuts by characters and inserts its own newline before the
  // marker. In path-list mode that last fragment is not a confirmed filename.
  // Tool-level "truncated N lines/bytes" markers retain whole lines instead.
  const replayCut = /\r?\n… \[\d+ chars truncated\] …(?:\r?\n|$)/.exec(body);
  if (replayCut) {
    body = body.slice(0, replayCut.index);
    if (mode === "files_with_matches") body = body.slice(0, body.lastIndexOf("\n") + 1);
  } else if (truncated && mode === "files_with_matches" && !body.endsWith("\n")) {
    body = body.slice(0, body.lastIndexOf("\n") + 1);
  }
  const paths = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (!line || line === "--" || line.startsWith("<note>")) continue;
    // The tool and replay layer append these trailers outside the rg payload.
    if (/^(?:…|\.\.\.|The output above was truncated|\[Full output saved)/.test(line)) break;
    const candidate = mode === "files_with_matches" ? line
      : mode === "count" ? /^(.+):\d+$/.exec(line)?.[1]
        : input?.["-n"] === false ? undefined : /^(.+?):\d+:/.exec(line)?.[1];
    const path = filePath(candidate);
    if (path) paths.add(path);
  }
  return [...paths];
}

type RetainedCall = { id: string; tool: string; input: unknown; output: string; error: string; status: ContextFileStatus; image: boolean; truncated: boolean; order: number };

export function contextFileActivity(detail: ContextRequestDetail): ContextFileActivity {
  const calls = new Map<string, RetainedCall>();
  for (const item of contextBrowserItems(detail)) {
    if (item.category !== "toolResults" || !item.data) continue;
    const data = item.data;
    const pair = record(data.toolResult) ?? data;
    const tool = text(pair.name);
    if (!FILE_TOOLS.has(tool)) continue;
    const callId = text(pair.callId) || text(data.callId) || item.id;
    const id = `${tool}:${callId}`;
    const previous = calls.get(id);
    const error = text(pair.error) || text(data.error) || previous?.error || "";
    const failed = error !== "" || pair.isError === true || ["failed", "rejected"].includes(text(pair.status));
    const completed = ["completed", "success"].includes(text(pair.status));
    const attachmentValues = [pair.attachments, data.attachments].flatMap((value) => Array.isArray(value) ? value : []);
    calls.set(id, {
      id, tool, input: pair.input ?? pair.arguments ?? previous?.input,
      output: text(pair.output) || text(data.content) || previous?.output || "", error,
      status: failed || previous?.status === "failed" ? "failed" : completed || previous?.status === "completed" ? "completed" : "recorded",
      image: previous?.image === true || attachmentValues.some((entry) => record(entry)?.kind === "image"),
      truncated: item.truncated || previous?.truncated === true,
      order: previous?.order ?? item.order,
    });
  }
  const files = new Map<string, ContextFileEntry>();
  let unresolved = 0;
  let truncated = false;
  const totals = counts();
  for (const call of calls.values()) {
    const input = inputRecord(call.input);
    let paths: string[];
    let kind: ContextFileKind;
    if (call.tool === "grep" || call.tool === "glob") {
      kind = "search";
      paths = call.status === "failed" ? [] : searchPaths(call.tool, input, call.output, call.truncated);
    } else if (call.tool === "apply_patch") {
      kind = "write";
      paths = contextPatchPaths(text(input?.patch ?? input?.diff ?? call.input));
    } else {
      const path = filePath(input?.path ?? input?.filePath ?? input?.file_path ?? input?.file ?? input?.filename
        ?? (call.tool === "read_file" && !input ? call.input : undefined));
      paths = path ? [path] : [];
      kind = call.tool === "read_file" ? call.image ? "image" : "read" : "write";
    }
    const noMatches = (call.tool === "grep" || call.tool === "glob") && /^No (?:matches for \/|files match `)/.test(call.output);
    if (!paths.length && !noMatches) unresolved++;
    truncated ||= call.truncated || /(?:chars truncated|\.\.\.\[truncated \d+ (?:lines|bytes) from (?:head|tail)\]|output above was truncated|<note>Output capped|capped at head_limit)/.test(call.output);
    if (paths.length) totals[kind]++;
    for (const path of paths) {
      const entry = files.get(path) ?? { path, operations: [], counts: counts() };
      entry.operations.push({ ...call, kind });
      entry.counts[kind]++;
      files.set(path, entry);
    }
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), counts: totals, calls: calls.size, unresolved, truncated };
}
