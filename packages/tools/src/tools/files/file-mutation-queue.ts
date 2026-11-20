import { realpath } from "node:fs/promises";
import path from "node:path";

const queues = new Map<string, Promise<void>>();
let registration = Promise.resolve();

async function mutationKey(file: string): Promise<string> {
  let existing = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try {
      const key = path.join(await realpath(existing), ...missing);
      return process.platform === "win32" ? key.toLowerCase() : key;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(existing);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Reserve every path together; callbacks on unrelated files remain concurrent. */
export async function withFileMutationQueue<T>(
  files: string[],
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const reserved = registration.then(async () => {
    const keys = [...new Set(await Promise.all(files.map(mutationKey)))].sort();
    const previousByKey = keys.map((key) => queues.get(key) ?? Promise.resolve());
    const previous = Promise.all(previousByKey).then(() => {});
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelWait!: () => void;
    const waitCancelled = new Promise<void>((resolve) => {
      cancelWait = resolve;
    });
    const completed = previous.then(() => current);
    const chained = keys.map((key, index) => {
      // A cancelled multi-file waiter no longer needs to convoy every path
      // behind its slowest predecessor. Each path still waits for its own
      // predecessor, so later mutations cannot overtake work already running.
      const skipped = waitCancelled.then(() => previousByKey[index]!);
      const tail = Promise.race([completed, skipped]);
      queues.set(key, tail);
      return tail;
    });
    return { keys, previous, chained, release, cancelWait };
  });
  // Only key resolution and reservation are serialized, never the file I/O itself.
  registration = reserved.then(
    () => {},
    () => {},
  );
  const { keys, previous, chained, release, cancelWait } = await reserved;
  let started = false;
  try {
    await waitForTurn(previous, signal);
    signal?.throwIfAborted();
    // Do not race the callback against abort: an in-flight write/process must
    // finish before another mutation can acquire these paths.
    started = true;
    const result = await fn();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (!started) cancelWait();
    throw error;
  } finally {
    release();
    for (const [index, tail] of chained.entries()) {
      void tail.then(() => {
        const key = keys[index]!;
        if (queues.get(key) === tail) queues.delete(key);
      });
    }
  }
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}
