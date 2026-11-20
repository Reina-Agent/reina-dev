import { z } from "zod";
import { engineHandledExecute } from "../../engine-handled.js";
import type { ToolImplementation } from "../../types.js";
import { description as noteDescription } from "../../prompts/note.js";
import { description as listNotesDescription } from "../../prompts/list-notes.js";
import { description as readNoteDescription } from "../../prompts/read-note.js";
import { description as updateNoteDescription } from "../../prompts/update-note.js";
import { description as deleteNoteDescription } from "../../prompts/delete-note.js";
import { description as declareAuditDoneDescription } from "../../prompts/declare-audit-done.js";

const NoteStatusEnum = z.enum(["open", "confirmed", "dead", "todo"]);

/** Which notebook the tool targets. `workspace` (default) = this project's
 * audit dossier (`.reina/notes`, ids `n_*`). `global` = cross-project durable
 * memory (`<REINA_HOME>/notes`, ids `g_*`) injected into every session:
 * user preferences, reusable techniques, general knowledge. */
const NoteScopeEnum = z
  .enum(["workspace", "global"])
  .optional()
  .describe(
    "Notebook to target: 'workspace' (default, this project) or 'global' (cross-project durable memory — user preferences, reusable techniques, general knowledge).",
  );

export const noteTool: ToolImplementation = {
  descriptor: {
    name: "note",
    description: noteDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1),
      tags: z.array(z.string().min(1)).optional(),
      refs: z.array(z.string().min(1)).optional(),
      status: NoteStatusEnum.optional(),
      scope: NoteScopeEnum,
    }),
    examples: [
      {
        description: "Finding — a standalone claim + evidence, tagged for later chaining",
        input: {
          title: "Export-import endpoint deserializes an attacker-controlled blob (pre-auth)",
          body: "`POST /api/report/import` passes the `payload` field straight into a native object-deserialization sink at src/report/import.ts:88 with no type filter, and the route is registered before the auth middleware (src/server/routes.ts:31), so it is reachable unauthenticated. Enables RCE IF a reachable gadget exists on the classpath — next: enumerate deps.",
          tags: ["kind:finding", "sev:high", "component:report-import"],
          status: "open",
        },
      },
      {
        description: "Hypothesis — pinned across rounds; body states what would confirm or refute it",
        input: {
          title: "Export sink may have a second front via the unauthenticated RMI listener",
          body: "The same routine (import.ts:88) is also called from the RMI handler at src/rpc/rmi.ts:54, which looks unauthenticated. CONFIRM IF a crafted RMI call reaches import.ts:88 with attacker bytes; REFUTE IF the RMI path applies the type filter the HTTP path skips.",
          tags: ["kind:hypothesis", "sev:high", "component:report-import"],
          refs: ["n_001"],
          status: "open",
        },
      },
      {
        description: "Dead end — state WHY and the REVIVE CONDITION so a later round doesn't re-walk it",
        input: {
          title: "Direct gadget chain to the export sink is blocked by the type allowlist",
          body: "The resolver at src/report/filter.ts:20 permits only model types {A,B,C}; the obvious gadget path is rejected there. REVIVE IF (1) a gadget built only from an allowed type is found, or (2) the RMI front in n_002 lands bytes past filter.ts. A blocked lead, not a closed one.",
          tags: ["kind:candidate"],
          refs: ["n_001"],
          status: "dead",
        },
      },
      {
        description: "Confirmed chain — composes earlier notes; cite the evidence via refs",
        input: {
          title: "Confirmed pre-auth RCE: RMI front → export sink → allowed-type gadget",
          body: "Verified end to end — the RMI handler (n_002) reaches the sink (n_001) bypassing filter.ts, and gadget G, built only from allowed type C, fires on deserialization. Repro and captured output saved to tmp/export-rce-repro.md. The filter.ts allowlist is insufficient.",
          tags: ["kind:finding", "sev:high", "component:report-import"],
          refs: ["n_001", "n_002", "n_003"],
          status: "confirmed",
        },
      },
    ],
  },
  execute: engineHandledExecute("note"),
};

export const listNotesTool: ToolImplementation = {
  descriptor: {
    name: "list_notes",
    description: listNotesDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: z.object({
      tags: z.array(z.string().min(1)).optional(),
      status: NoteStatusEnum.optional(),
      refs_any: z.array(z.string().min(1)).optional(),
      since: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      /** Show only directed notes addressed to this name, plus all
       * un-addressed notes. Useful when a worker wants its inbox without
       * the team-wide chatter. Team-mode only. */
      recipient: z.string().min(1).optional(),
      /** Bypass the directed-note filter entirely (subagents normally
       * see only notes addressed to them; the coordinator sees all). */
      includeDirected: z.boolean().optional(),
      scope: NoteScopeEnum,
    }),
  },
  execute: engineHandledExecute("list_notes"),
};

export const readNoteTool: ToolImplementation = {
  descriptor: {
    name: "read_note",
    description: readNoteDescription,
    permission: "read",
    requiresApproval: false,
    concurrencySafe: true,
    inputSchema: z.object({
      id: z.string().min(1).describe("Note id, e.g. n_042 (workspace) or g_007 (global)."),
      scope: NoteScopeEnum,
    }),
  },
  execute: engineHandledExecute("read_note"),
};

export const updateNoteTool: ToolImplementation = {
  descriptor: {
    name: "update_note",
    description: updateNoteDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      id: z.string().min(1).describe("Note id to patch, e.g. n_042 (workspace) or g_007 (global)."),
      title: z.string().min(1).max(200).optional(),
      body: z.string().min(1).optional(),
      tags: z.array(z.string().min(1)).optional(),
      refs: z.array(z.string().min(1)).optional(),
      status: NoteStatusEnum.optional(),
      scope: NoteScopeEnum,
    }),
  },
  execute: engineHandledExecute("update_note"),
};

export const deleteNoteTool: ToolImplementation = {
  descriptor: {
    name: "delete_note",
    description: deleteNoteDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      id: z.string().min(1).describe("Note id to delete, e.g. n_042 (workspace) or g_007 (global)."),
      scope: NoteScopeEnum,
    }),
  },
  execute: engineHandledExecute("delete_note"),
};

export const declareAuditDoneTool: ToolImplementation = {
  descriptor: {
    name: "declare_audit_done",
    description: declareAuditDoneDescription,
    permission: "state",
    requiresApproval: false,
    inputSchema: z.object({
      status: z.enum(["complete", "exhausted", "blocked"]),
      summary: z.string().min(1),
    }),
  },
  execute: engineHandledExecute("declare_audit_done"),
};
