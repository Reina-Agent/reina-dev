// Verbatim port of the two format.js helpers the HITL dock renderer needs.
// Kept tiny + local so the copied legacy hitl.js stays dependency-free.

export function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncate(value: unknown, max: number): string {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
