import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // Many tests exercise real I/O (session stores, git worktrees, spawned
    // shells, the host bridge). Vitest's 5s default is tight for these under
    // full-suite parallelism — especially on contended CI runners — and caused
    // a flaky timeout on the otherwise-fast AgentHost "host closes" test. 20s
    // gives headroom without masking a genuine hang (still well under the
    // compaction tests, which set their own longer per-test timeouts).
    testTimeout: 20000,
  },
});
