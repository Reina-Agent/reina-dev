import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, nowIso } from "@reina/protocol";
import type { ChatMessage, SessionState, ToolCallRecord } from "@reina/protocol";
import { MemoryController } from "./memory.js";
import { SessionStore } from "../store/session-store.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  const now = nowIso();
  return {
    id: overrides.id ?? createId("ses"),
    title: overrides.title ?? "Reina",
    agent: overrides.agent ?? "default",
    cwd: overrides.cwd ?? "/tmp/workspace",
    permissionMode: overrides.permissionMode ?? "default",
    model: overrides.model ?? { provider: "deterministic", model: "reina-deterministic" },
    messages: overrides.messages ?? [],
    toolCalls: overrides.toolCalls ?? [],
    todos: overrides.todos ?? [],
    pendingQuestions: overrides.pendingQuestions ?? [],
    skills: overrides.skills ?? [],
    trace: overrides.trace ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  } as SessionState;
}

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: createId("msg"), role, content, createdAt: nowIso() };
}

function call(name: string, input: unknown): ToolCallRecord {
  return {
    id: createId("call"),
    name: name as ToolCallRecord["name"],
    input,
    summary: name,
    permission: "state",
    status: "running",
    createdAt: nowIso(),
  };
}

describe("MemoryController search/consolidate", () => {
  let store: SessionStore;
  let session: SessionState;
  let controller: MemoryController;

  beforeEach(() => {
    store = SessionStore.open("/ignored", { inMemory: true });
    session = makeSession({ title: "current work" });
    store.persistSession(session);
    controller = new MemoryController({ session, sessionStore: store });
  });

  afterEach(() => {
    store.close();
  });

  describe("search", () => {
    it("finds cross-session message hits labeled with the source session title", () => {
      const other = makeSession({
        title: "webpack debugging",
        messages: [makeMessage("user", "the webpack build fails with ENOENT")],
      });
      store.persistSession(other);
      const obs = controller.search(call("search_memory", { query: "webpack" }));
      expect(obs.error).toBeUndefined();
      expect(obs.output).toContain("webpack debugging");
      expect(obs.output).toContain("Conversation history");
      // Retrieval-as-signal: a past-session hit means the knowledge was
      // needed twice — the output nudges promoting it to the global notebook.
      expect(obs.output).toContain('scope:"global"');
    });

    it("does not nudge promotion when every hit is from the current session", () => {
      session.messages = [makeMessage("user", "the vite build fails with EPERM")];
      store.persistSession(session);
      const obs = controller.search(call("search_memory", { query: "vite" }));
      expect(obs.output).toContain("Conversation history");
      expect(obs.output).not.toContain('scope:"global"');
    });

    it("does not nudge promotion for subagent/archived-session hits (not 'needed twice' evidence)", () => {
      store.persistSession(
        makeSession({
          title: "throwaway worker",
          isSubagent: true,
          subagentDepth: 1,
          messages: [makeMessage("assistant", "the docker daemon crashed during the probe")],
        }),
      );
      const obs = controller.search(call("search_memory", { query: "docker" }));
      expect(obs.output).toContain("Conversation history"); // the hit itself still surfaces
      expect(obs.output).not.toContain('scope:"global"'); // but it's no promotion signal
    });

    it("finds offloaded chunk hits with a recall pointer (offload enabled)", () => {
      const prev = process.env.REINA_COMPACTION_OFFLOAD;
      process.env.REINA_COMPACTION_OFFLOAD = "1";
      try {
        store.insertMemoryChunks(session.id, [
          {
            id: "c_001",
            sessionId: session.id,
            createdAt: nowIso(),
            topicLine: "investigate the flaky signer",
            toolNames: ["run_shell"],
            tokenCount: 99,
            messageIds: ["m1"],
            content: "we traced the flaky signer bug to a race in the queue",
          },
        ]);
        const obs = controller.search(call("search_memory", { query: "flaky signer" }));
        expect(obs.output).toContain("c_001");
        expect(obs.output).toContain("recall_memory_chunk");
      } finally {
        if (prev === undefined) delete process.env.REINA_COMPACTION_OFFLOAD;
        else process.env.REINA_COMPACTION_OFFLOAD = prev;
      }
    });

    it("suppresses chunk pointers when offload is disabled (recall would refuse them)", () => {
      const prev = process.env.REINA_COMPACTION_OFFLOAD;
      delete process.env.REINA_COMPACTION_OFFLOAD;
      try {
        store.insertMemoryChunks(session.id, [
          {
            id: "c_001",
            sessionId: session.id,
            createdAt: nowIso(),
            topicLine: "investigate the flaky signer",
            toolNames: ["run_shell"],
            tokenCount: 99,
            messageIds: ["m1"],
            content: "we traced the flaky signer bug to a race in the queue",
          },
        ]);
        const obs = controller.search(call("search_memory", { query: "flaky signer" }));
        expect(obs.output).not.toContain("recall_memory_chunk");
      } finally {
        if (prev !== undefined) process.env.REINA_COMPACTION_OFFLOAD = prev;
      }
    });

    it("finds note-index hits by title/tags with a read_note pointer", () => {
      const noteDefaults = { status: "open" as const, author: "tester", createdAt: nowIso(), refs: [] };
      session.notes = [{ ...noteDefaults, id: "n_007", title: "auth bypass in login flow", tags: ["sev:high"] }];
      session.globalNotes = [{ ...noteDefaults, id: "g_002", title: "prefers pnpm over npm", tags: [] }];
      const auth = controller.search(call("search_memory", { query: "auth bypass" }));
      expect(auth.output).toContain('read_note("n_007")');
      const pnpm = controller.search(call("search_memory", { query: "pnpm" }));
      expect(pnpm.output).toContain('read_note("g_002")');
      expect(pnpm.output).toContain("[global]");
    });

    it("survives FTS-hostile queries instead of throwing", () => {
      const obs = controller.search(call("search_memory", { query: 'un"balanced AND (' }));
      expect(obs.error).toBeUndefined();
      expect(obs.output).toBeTruthy();
    });

    it("errors on an empty query and reports no-hit queries cleanly", () => {
      expect(controller.search(call("search_memory", { query: "  " })).error).toMatch(/non-empty/);
      const none = controller.search(call("search_memory", { query: "zzzznothinghere" }));
      expect(none.output).toContain("No memory hits");
    });
  });

  describe("consolidate + background dream gate", () => {
    // Seeded sessions sit 7h in the past — past the default 6h idle filter,
    // so they count as settled material. Fresh-session behaviour is covered
    // by its own test below.
    function seedSessions(n: number, ageMs = 7 * 3600_000): void {
      for (let i = 0; i < n; i++) {
        store.persistSession(
          makeSession({
            title: `job ${i}`,
            summary: `did thing ${i}`,
            updatedAt: new Date(Date.now() - ageMs - (i + 1) * 60_000).toISOString(),
          }),
        );
      }
    }

    it("returns briefs excluding the current session and stamps the clock", () => {
      seedSessions(3);
      const obs = controller.consolidate(call("consolidate_memory", {}));
      expect(obs.output).toContain("consolidation_material");
      expect(obs.output).toContain("job 0");
      expect(obs.output).not.toContain("current work");
      expect(store.getWorkspaceMeta("memory_consolidated_at")).toBeTruthy();
    });

    it("reports nothing to fold when no sessions accumulated since the stamp", () => {
      seedSessions(2);
      controller.consolidate(call("consolidate_memory", {}));
      const again = controller.consolidate(call("consolidate_memory", {}));
      expect(again.output).toContain("nothing to fold");
    });

    it("ignores subagent sessions in both the gate and the material", () => {
      for (let i = 0; i < 12; i++) {
        store.persistSession(makeSession({ title: `worker ${i}`, isSubagent: true, subagentDepth: 1 }));
      }
      expect(controller.consolidationDue()).toBe(false); // 12 workers ≠ real sessions
      const obs = controller.consolidate(call("consolidate_memory", {}));
      expect(obs.output).toContain("nothing to fold");
    });

    it("is due only past the session threshold, and goes quiet after consolidation", () => {
      seedSessions(2);
      expect(controller.consolidationDue()).toBe(false); // 2 idle < 10 (the fresh current session never counts)
      seedSessions(8);
      expect(controller.consolidationDue()).toBe(true); // 10 idle sessions hit the default gate
      controller.consolidate(call("consolidate_memory", {}));
      expect(controller.consolidationDue()).toBe(false); // cooldown
    });

    it("beginConsolidation returns the directive and stamps BEFORE the run", () => {
      seedSessions(11);
      expect(controller.consolidationDue()).toBe(true);
      const directive = controller.beginConsolidation();
      expect(directive).toContain("consolidation_material");
      expect(directive).toContain("global notebook");
      // The stamp lands at begin (grok stamps via its dream lock the same
      // way) so a concurrent session in this workspace can't double-fire.
      expect(store.getWorkspaceMeta("memory_consolidated_at")).toBeTruthy();
      expect(store.getWorkspaceMeta("memory_consolidation_cursor")).toBeTruthy();
      expect(controller.consolidationDue()).toBe(false);
    });

    it("background cursor stops at the idle cutoff: sessions settling inside the window are folded later, not lost", () => {
      seedSessions(11); // settled material (7h+ old)
      store.persistSession(
        makeSession({
          title: "gap work",
          summary: "settled during the idle window",
          updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), // 3h — inside the 6h window
        }),
      );
      const background = controller.beginConsolidation();
      expect(background).toContain("job 0");
      expect(background).not.toContain("gap work"); // still inside the idle window
      // The cursor stamped the CUTOFF, not `now` — so "gap work" stays ahead
      // of it and the next (here: manual) consolidation still sees it.
      const manual = controller.consolidate(call("consolidate_memory", {}));
      expect(manual.output).toContain("gap work");
    });

    it("still-active sessions don't open the background gate (idle filter)", () => {
      seedSessions(12, 0); // updated minutes ago — inside the 6h idle window
      expect(controller.consolidationDue()).toBe(false);
    });

    it("the manual tool skips the idle filter: an explicit fold takes fresh sessions too", () => {
      seedSessions(12, 0); // finished minutes ago
      const obs = controller.consolidate(call("consolidate_memory", {}));
      expect(obs.output).toContain("consolidation_material");
      expect(obs.output).toContain("job 0");
    });

    it("directive carries the prune mandate alongside the fold instructions", () => {
      seedSessions(11);
      const directive = controller.beginConsolidation();
      expect(directive).toContain("prune");
      expect(directive).toContain("delete_note");
    });

    it("settings-page config drives the gate: dream:false closes it, minSessions lowers it", () => {
      seedSessions(4);
      const withConfig = (memoryConfig: { dream?: boolean; minSessions?: number }) =>
        new MemoryController({ session, sessionStore: store, memoryConfig });
      expect(withConfig({ minSessions: 3 }).consolidationDue()).toBe(true); // 4 idle ≥ 3
      expect(withConfig({ dream: false, minSessions: 3 }).consolidationDue()).toBe(false);
    });

    it("REINA_MEMORY_* env is the developer override and beats the config value", () => {
      seedSessions(4);
      process.env.REINA_MEMORY_MIN_SESSIONS = "20";
      try {
        const c = new MemoryController({ session, sessionStore: store, memoryConfig: { minSessions: 3 } });
        expect(c.consolidationDue()).toBe(false); // env 20 wins over config 3
      } finally {
        delete process.env.REINA_MEMORY_MIN_SESSIONS;
      }
    });

    it("REINA_MEMORY_DREAM=0 disables the background gate but not the tool", () => {
      process.env.REINA_MEMORY_DREAM = "0";
      try {
        seedSessions(12);
        expect(controller.consolidationDue()).toBe(false);
        const obs = controller.consolidate(call("consolidate_memory", {}));
        expect(obs.output).toContain("consolidation_material"); // manual path unaffected
      } finally {
        delete process.env.REINA_MEMORY_DREAM;
      }
    });

    it("REINA_MEMORY_DREAM boolean semantics: false/off disable, blank falls through to config, 1 overrides dream:false", () => {
      seedSessions(12);
      const withDream = (dream: boolean | undefined) =>
        new MemoryController({ session, sessionStore: store, memoryConfig: dream === undefined ? {} : { dream } });
      try {
        process.env.REINA_MEMORY_DREAM = "false";
        expect(withDream(undefined).consolidationDue()).toBe(false);
        process.env.REINA_MEMORY_DREAM = "off";
        expect(withDream(undefined).consolidationDue()).toBe(false);
        // A blank env var is "unset", not "some value other than 0" — the
        // settings-page dream:false must survive an exported-but-empty var.
        process.env.REINA_MEMORY_DREAM = "";
        expect(withDream(false).consolidationDue()).toBe(false);
        expect(withDream(undefined).consolidationDue()).toBe(true);
        // A set env wins in both directions.
        process.env.REINA_MEMORY_DREAM = "1";
        expect(withDream(false).consolidationDue()).toBe(true);
      } finally {
        delete process.env.REINA_MEMORY_DREAM;
      }
    });

    it("knob values are clamped into the advertised range at the point of use", () => {
      // 200h-idle sessions: a hand-edited idleHours of 100000 would push the
      // cutoff ~11 years back and match nothing; the clamp caps it at 168h so
      // these sessions still qualify as settled material.
      seedSessions(3, 200 * 3600_000);
      const c = new MemoryController({
        session,
        sessionStore: store,
        memoryConfig: { idleHours: 100_000, minSessions: 3 },
      });
      expect(c.consolidationDue()).toBe(true);
    });
  });
});
