// ErrorEntry.tsx — React port of conversation.js appendErrorEntry + errorHintFor.
// Renders a turn failure / provider error as a .error-entry disclosure in the
// timeline, with an actionable hint (missing env var, 401, network, unknown
// session) and a one-click "Open Models settings" button. Without this, React
// stored `state.error` but nothing showed it — failures were silent.

import { bridge } from "~/lib/bridge";

interface Hint {
  message: string;
  /** When set, render a button that opens the Models settings panel. */
  openModels?: boolean;
}

// Mirror conversation.js errorHintFor: map known error shapes to a remediation
// hint. Returns null for unrecognised errors (the raw detail still shows).
function errorHintFor(text: string): Hint | null {
  const t = String(text || "");
  const envMatch = t.match(/Environment variable ([A-Z_][A-Z0-9_]*) is not set/i);
  if (envMatch) {
    const name = envMatch[1];
    return {
      message: `Set ${name} in the shell that launches Reina (e.g. PowerShell: $env:${name} = "your-key"), then restart the app.`,
      openModels: true,
    };
  }
  if (/\b(401|unauthorized|invalid[_ -]?api[_ -]?key)\b/i.test(t)) {
    return {
      message: "Authentication failed. Double-check the API key value and the provider/baseUrl on the model.",
      openModels: true,
    };
  }
  if (/(ECONNREFUSED|ENOTFOUND|fetch failed|getaddrinfo|network)/i.test(t)) {
    return {
      message: "Network error reaching the provider. Check the baseUrl and your network connection.",
      openModels: true,
    };
  }
  if (/unknown session/i.test(t)) {
    return {
      message: "The agent host lost track of this session — likely because it restarted. Start a new session to continue.",
    };
  }
  return null;
}

// First line as the summary (legacy passed a short summary + full detail; the
// React store carries a single error string, so we split it the same way).
function summaryOf(text: string): string {
  const firstLine = String(text || "").split("\n", 1)[0].trim();
  return firstLine || "Turn failed";
}

export function ErrorEntry({ text }: { text: string }) {
  const hint = errorHintFor(text);
  const summary = summaryOf(text);
  const detail = text.trim() !== summary ? text : "";
  return (
    <details className="entry error-entry" open={!!hint}>
      <summary>{summary}</summary>
      {detail && <pre>{detail}</pre>}
      {hint && (
        <div className="error-entry-actions">
          <div className="error-entry-hint">{hint.message}</div>
          {hint.openModels && (
            <button
              type="button"
              className="settings-action settings-action-accent"
              onClick={(e) => {
                e.preventDefault();
                void bridge().openSettingsWindow("models");
              }}
            >
              Open Models settings
            </button>
          )}
        </div>
      )}
    </details>
  );
}
