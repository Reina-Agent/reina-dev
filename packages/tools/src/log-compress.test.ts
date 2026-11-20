import { describe, expect, it } from "vitest";
import { compressLogOutput } from "./log-compress.js";

describe("compressLogOutput", () => {
  it("leaves short output untouched", () => {
    const text = ["build started", "compiling", "done in 1.2s"].join("\n");
    const r = compressLogOutput(text);
    expect(r.compressed).toBe(false);
    expect(r.content).toBe(text);
  });

  it("returns the original when savings fall below the threshold", () => {
    // 60 distinct, all-signal lines: nothing is droppable, so compressing
    // would save ~nothing → original returned unchanged.
    const text = Array.from({ length: 60 }, (_, i) => `error: thing ${i} broke`).join("\n");
    const r = compressLogOutput(text);
    expect(r.compressed).toBe(false);
    expect(r.content).toBe(text);
  });

  it("always keeps an error line buried in noise, with surrounding context", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`info: processed item ${i}`);
    lines.push("about to do the risky thing");
    lines.push("TypeError: cannot read property 'x' of undefined");
    lines.push("recovering gracefully");
    for (let i = 0; i < 100; i++) lines.push(`info: cleanup step ${i}`);

    const r = compressLogOutput(lines.join("\n"));
    expect(r.compressed).toBe(true);
    expect(r.content).toContain("TypeError: cannot read property 'x' of undefined");
    // context window (contextLines=2) keeps the neighbours
    expect(r.content).toContain("about to do the risky thing");
    expect(r.content).toContain("recovering gracefully");
    // the bulk of the info noise is gone
    expect(r.content).toContain("lines omitted");
    expect(r.content).not.toContain("info: processed item 40");
  });

  it("keeps a contiguous stack trace attached to its error", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(`debug: tick ${i}`);
    lines.push("Error: boom");
    lines.push("    at doThing (src/a.js:10:5)");
    lines.push("    at main (src/index.js:3:1)");
    lines.push("    at Object.<anonymous> (src/index.js:20:1)");
    for (let i = 0; i < 60; i++) lines.push(`debug: tick after ${i}`);

    const r = compressLogOutput(lines.join("\n"));
    expect(r.content).toContain("Error: boom");
    expect(r.content).toContain("at doThing (src/a.js:10:5)");
    expect(r.content).toContain("at main (src/index.js:3:1)");
    expect(r.content).toContain("at Object.<anonymous> (src/index.js:20:1)");
  });

  it("folds adjacent near-identical progress lines", () => {
    const lines: string[] = [];
    lines.push("error: real failure up top");
    // a short gap (< minGapToCollapse handling collapses dupes within it is
    // exercised via a longer run here) of repeating spinner lines:
    for (let i = 0; i < 50; i++) lines.push(`downloaded chunk ${i}/50`);
    const r = compressLogOutput(lines.join("\n"));
    expect(r.compressed).toBe(true);
    expect(r.content).toContain("error: real failure up top");
  });

  it("compresses a realistic noisy build log substantially", () => {
    // ~520 lines: a long webpack/npm-style progress wall, one real error
    // block in the middle, then more progress noise.
    const lines: string[] = [];
    lines.push("> project@1.0.0 build");
    lines.push("> webpack --mode production");
    for (let i = 0; i < 250; i++) {
      lines.push(`[webpack] building module ${i} of 900 [${"=".repeat(i % 30)}>]`);
    }
    lines.push("ERROR in ./src/components/Widget.tsx");
    lines.push("Module not found: Error: Can't resolve './missing' in '/app/src/components'");
    lines.push("    at factoryCallback (/app/node_modules/webpack/lib/Compilation.js:2:1)");
    lines.push("    at /app/node_modules/webpack/lib/NormalModuleFactory.js:5:9");
    for (let i = 0; i < 250; i++) {
      lines.push(`[webpack] emitting asset ${i}.chunk.js [cached]`);
    }
    lines.push("webpack compiled with 1 error");

    const original = lines.join("\n");
    const r = compressLogOutput(original);

    expect(r.compressed).toBe(true);
    // The error block + its trace + the final verdict all survive.
    expect(r.content).toContain("ERROR in ./src/components/Widget.tsx");
    expect(r.content).toContain("Module not found");
    expect(r.content).toContain("at factoryCallback");
    expect(r.content).toContain("webpack compiled with 1 error");
    // And we shaved off the vast majority of the progress wall.
    expect(r.savings).toBeGreaterThan(0.8);

    // eslint-disable-next-line no-console
    console.log(
      `[log-compress] ${r.inputLines}→${r.outputLines} lines, ` +
        `${r.inputBytes}→${r.outputBytes} bytes, saved ${(r.savings * 100).toFixed(1)}%`,
    );
  });
});
