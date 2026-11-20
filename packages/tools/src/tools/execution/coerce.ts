import { z } from "zod";

/** Coerce model-supplied stringy booleans ("true"/"1"/"yes" …) into real
 * booleans. Some providers emit tool arguments where every value is a string;
 * without this, `runInBackground: "true"` would fail strict boolean parsing.
 * Shared by the run_shell tool and the background-shell tools. */
export const semanticBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return value;
}, z.boolean());

/** Coerce a stringy integer milliseconds value into a bounded number. */
export const semanticTimeoutMs = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return value;
  return Number(normalized);
}, z.number().int().min(0).max(600000));
