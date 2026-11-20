// Some tools have their *descriptor* declared in this package (so the model
// sees a uniform tool catalog) but their *behavior* implemented by
// AgentEngine's dispatch switch (packages/core/src/engine.ts:executeToolOrEngine).
// Their execute() is a sentinel that should never actually run — the engine
// intercepts the call by name first.
//
// The risk this module closes: if a stub's engine switch case is removed or
// renamed, the call falls through to runTool, which executes the stub and
// returns the sentinel STRING to the model as if it were a real result —
// silently. By building every stub's execute() through `engineHandledExecute`
// we record its name here; the engine's fallback-dispatch guard then throws a
// loud error if any such name ever reaches runTool, turning a silent failure
// into an obvious one. The registry test asserts the set matches the stubs.

const engineHandledNames = new Set<string>();

/** Build the execute() stub for an engine-handled tool, and register its name
 * so the engine can guard against a missing dispatch case. The returned
 * function ignores its arguments — the engine runs the real logic by name
 * before this would ever be invoked. */
export function engineHandledExecute(name: string): () => Promise<string> {
  engineHandledNames.add(name);
  return async () => `${name} is handled by AgentEngine.`;
}

/** Live set of engine-handled tool names, populated as the stub tool modules
 * load (which they do transitively via the registry). Read by the engine's
 * fallback-dispatch guard and by the registry test. */
export function engineHandledToolNames(): ReadonlySet<string> {
  return engineHandledNames;
}
