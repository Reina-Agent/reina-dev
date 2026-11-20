import type { ToolCallRecord, ToolName } from "@reina/protocol";

// `cwd` scopes a rule to the engine tree it was vetted in. The session
// registry is SHARED between a parent engine and its subagent children
// (spawnChildEngine), and exact-input rules often embed relative paths —
// without the cwd gate, a rule approved in the parent's tree would silently
// transfer to a worktree-isolated child operating on different files.
// Rules live only as long as the process, so an absent cwd (legacy shape)
// simply matches anywhere within this session.
export type SessionApprovalRule =
  | { kind: "shell"; workdir: string; command?: string; commandPrefix?: string; cwd?: string }
  | {
      kind: "tool";
      name: ToolName;
      input: string;
      cwd?: string;
      mcpServer?: string;
      mcpTool?: string;
    };

export function isReadOnlyShellCommand(record: ToolCallRecord): boolean {
  if (record.name !== "run_shell") return false;
  const input = record.input as { command?: unknown };
  if (typeof input.command !== "string") return false;
  // Check the RAW command for chaining before whitespace folding hides a
  // newline-separated second command (see hasCommandChaining).
  if (hasCommandChaining(input.command)) return false;
  const command = normalizeShellCommand(input.command);
  if (!command) return false;
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const head = parts[0]?.toLowerCase().replace(/\.exe$/, "");
  if (!head) return false;
  if (["whoami", "pwd", "cd", "dir", "ls", "gci", "get-childitem", "get-location"].includes(head)) return true;
  if (head !== "git") return false;
  const subcommand = parts[1]?.toLowerCase();
  if (!["status", "diff", "branch", "rev-parse", "log", "show", "remote"].includes(subcommand ?? "")) return false;
  if (
    parts.some((part) => {
      const lowered = part.toLowerCase();
      return lowered === "-o" || lowered === "--output" || lowered.startsWith("--output=");
    })
  )
    return false;
  // `branch` and `remote` are verbs: their mutating forms (git branch -D x,
  // git remote set-url origin …) differ from the read-only list forms ONLY in
  // arguments, so the subcommand name alone must not green-light auto-run —
  // gate on the args and let anything else fall back to a prompt.
  if (subcommand === "branch") {
    return parts.slice(2).every((part) => BRANCH_LIST_ARGS.has(part.toLowerCase()));
  }
  if (subcommand === "remote") {
    const third = parts[2]?.toLowerCase();
    if (third === undefined) return true;
    if ((third === "-v" || third === "--verbose") && parts.length === 3) return true;
    // Remaining args are remote names (plain arguments to git; chaining
    // metachars were already rejected above).
    return third === "show" || third === "get-url";
  }
  return true;
}

/** Args under which `git branch` stays a pure listing. Anything else
 * (positional ref names, -d/-D/-m/--force, …) may create/delete/move refs. */
const BRANCH_LIST_ARGS: ReadonlySet<string> = new Set([
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--merged",
  "--no-merged",
]);

export function sessionApprovalRule(record: ToolCallRecord): SessionApprovalRule {
  if (record.name === "run_shell") {
    const input = record.input as { command?: unknown; workdir?: unknown };
    // Exact rules store the RAW (trimmed) command. Matching must be
    // byte-identical: whitespace folding would let `a\nb` (TWO commands, the
    // second unvetted) match a rule approved for the single command `a b`.
    const command = typeof input.command === "string" ? input.command.trim() : JSON.stringify(record.input);
    const workdir = typeof input.workdir === "string" ? input.workdir.trim() : "";
    const commandPrefix = typeof input.command === "string" ? suggestedShellApprovalPrefix(input.command) : undefined;
    return commandPrefix ? { kind: "shell", workdir, commandPrefix } : { kind: "shell", workdir, command };
  }
  const mcpTarget =
    typeof record.mcpServer === "string" && typeof record.mcpTool === "string"
      ? { mcpServer: record.mcpServer, mcpTool: record.mcpTool }
      : {};
  return { kind: "tool", name: record.name, input: JSON.stringify(record.input), ...mcpTarget };
}

export function matchesSessionApproval(rule: SessionApprovalRule, record: ToolCallRecord): boolean {
  if (rule.kind === "tool") {
    if (record.name !== rule.name || JSON.stringify(record.input) !== rule.input) return false;
    const requiresMcpIdentity =
      rule.name.startsWith("mcp__") ||
      rule.mcpServer !== undefined ||
      rule.mcpTool !== undefined ||
      record.mcpServer !== undefined ||
      record.mcpTool !== undefined;
    if (!requiresMcpIdentity) return true;
    return (
      typeof rule.mcpServer === "string" &&
      typeof rule.mcpTool === "string" &&
      typeof record.mcpServer === "string" &&
      typeof record.mcpTool === "string" &&
      record.mcpServer === rule.mcpServer &&
      record.mcpTool === rule.mcpTool
    );
  }
  if (record.name !== "run_shell") return false;
  const input = record.input as { command?: unknown; workdir?: unknown };
  if (typeof input.command !== "string") return false;
  const workdir = typeof input.workdir === "string" ? input.workdir.trim() : "";
  if (workdir !== rule.workdir) return false;
  // Exact rules compare the RAW (trimmed) command — see sessionApprovalRule.
  // This is what re-approves a vetted compound command: byte-identical only.
  if (rule.command) return input.command.trim() === rule.command;
  if (!rule.commandPrefix) return false;
  // A prefix rule vetted only the command's head. A compound command that
  // merely starts with that prefix can chain an unvetted command after it, so
  // it must go back through approval even against a legitimately-approved prefix.
  if (hasCommandChaining(input.command)) return false;
  return commandMatchesPrefix(normalizeShellCommand(input.command), rule.commandPrefix);
}

function normalizeShellCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** True when the command contains a shell separator or command-substitution
 * metacharacter — i.e. it is a COMPOUND command that can chain a second,
 * unvetted command after a vetted head. Tested against the RAW command, BEFORE
 * normalizeShellCommand folds whitespace: a newline is itself a command
 * separator, so folding it to a space would hide `git status\nrm -rf x` behind
 * an innocent-looking head while execa still runs the raw multi-line command.
 * Shared with permissions.ts so persistent commandPrefix allow rules apply the
 * same gate as session prefix rules. */
export function hasCommandChaining(raw: string): boolean {
  const command = raw.trim();
  // Substitution syntax executes even INSIDE double quotes in POSIX shells,
  // so it is checked before quoted spans are stripped.
  if (command.includes("$(") || command.includes("`")) return true;
  // Separators inside a balanced quoted span are literal argument text
  // (`git commit -m "feat: A & B"`), not chaining — strip those spans first.
  // An unbalanced quote leaves its tail unstripped, which fails safe: any
  // separator in the tail still flags.
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, "");
  return /[;&|<>\n\r]/.test(unquoted);
}

/** Command-prefix arity table: how many leading tokens (command +
 * subcommands) form the "human-understandable command unit" that an
 * always-allow prefix rule should scope to. `git` → 2 turns `git checkout
 * main` into the rule `git checkout`; `npm run` → 3 turns `npm run dev`
 * into `npm run dev`. Longest matching key wins, so `npm run` overrides
 * `npm`. Deliberately ONLY multi-token entries (arity >= 2): single-token
 * commands (rm, cat, curl, …) fall back to an exact-command rule — a
 * one-click "rm *" grant would authorise the whole destructive family.
 * Adapted from opencode's permission/arity.ts (MIT).
 * MIRROR: hitl.js `shellApprovalPrefix` (renderer) keeps a copy of this
 * table and algorithm — update BOTH or the offered label and the minted
 * rule drift apart. */
const PREFIX_ARITY: Record<string, number> = {
  aws: 3, // aws s3 ls
  az: 3, // az storage blob list
  bazel: 2, // bazel build
  brew: 2, // brew install node
  bun: 2, // bun install
  "bun run": 3, // bun run dev
  "bun x": 3, // bun x vite
  cargo: 2, // cargo build
  "cargo add": 3, // cargo add tokio
  "cargo run": 3, // cargo run main
  choco: 2, // choco install nodejs
  cmake: 2, // cmake build
  composer: 2, // composer require laravel
  corepack: 2, // corepack enable
  deno: 2, // deno run server.ts
  "deno task": 3, // deno task dev
  docker: 2, // docker run nginx
  "docker builder": 3, // docker builder prune
  "docker compose": 3, // docker compose up
  "docker container": 3, // docker container ls
  "docker image": 3, // docker image prune
  "docker network": 3, // docker network inspect
  "docker volume": 3, // docker volume ls
  dotnet: 2, // dotnet build
  firebase: 2, // firebase deploy
  flyctl: 2, // flyctl deploy
  gcloud: 3, // gcloud compute instances list
  gh: 3, // gh pr list
  git: 2, // git checkout main
  "git config": 3, // git config user.name
  "git remote": 3, // git remote add origin
  "git stash": 3, // git stash pop
  go: 2, // go build
  gradle: 2, // gradle build
  helm: 2, // helm install mychart
  heroku: 2, // heroku logs
  kind: 2, // kind delete cluster
  "kind create": 3, // kind create cluster
  kubectl: 2, // kubectl get pods
  "kubectl rollout": 3, // kubectl rollout restart deploy/api
  make: 2, // make build
  minikube: 2, // minikube start
  mvn: 2, // mvn compile
  netlify: 2, // netlify deploy
  ng: 2, // ng generate component home
  node: 2, // node scripts/build.mjs
  npm: 2, // npm install
  "npm exec": 3, // npm exec vite
  "npm init": 3, // npm init vue
  "npm run": 3, // npm run dev
  "npm view": 3, // npm view react version
  npx: 2, // npx vitest run
  nvm: 2, // nvm use 18
  nx: 2, // nx build
  pip: 2, // pip install numpy
  pip3: 2, // pip3 install numpy
  pipenv: 2, // pipenv install flask
  pnpm: 2, // pnpm install
  "pnpm dlx": 3, // pnpm dlx create-next-app
  "pnpm exec": 3, // pnpm exec vite
  "pnpm run": 3, // pnpm run dev
  podman: 2, // podman run alpine
  "podman container": 3, // podman container ls
  "podman image": 3, // podman image prune
  poetry: 2, // poetry add requests
  pulumi: 2, // pulumi up
  "pulumi stack": 3, // pulumi stack output
  pyenv: 2, // pyenv install 3.11
  python: 2, // python script.py
  python3: 2, // python3 script.py
  rake: 2, // rake db:migrate
  rustup: 2, // rustup update
  scoop: 2, // scoop install nodejs
  swift: 2, // swift build
  systemctl: 2, // systemctl restart nginx
  terraform: 2, // terraform apply
  "terraform workspace": 3, // terraform workspace select prod
  tmux: 2, // tmux new -s dev
  turbo: 2, // turbo run build
  uv: 2, // uv sync
  "uv run": 3, // uv run pytest
  vercel: 2, // vercel deploy
  volta: 2, // volta install node
  winget: 2, // winget install nodejs
  yarn: 2, // yarn add react
  "yarn dlx": 3, // yarn dlx create-react-app
  "yarn run": 3, // yarn run dev
};

function suggestedShellApprovalPrefix(command: string): string | undefined {
  // Never distil a compound command into a broad prefix rule: approving the
  // head would silently authorise whatever is chained after it. Returning
  // undefined makes sessionApprovalRule fall back to an exact-command rule, so
  // only the byte-identical command the user actually saw is re-approved.
  if (hasCommandChaining(command)) return undefined;
  const parts =
    normalizeShellCommand(command)
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const head = parts[0]?.toLowerCase().replace(/\.exe$/, "");
  if (!head) return undefined;
  const tokens = [head, ...parts.slice(1).map((part) => part.toLowerCase())];
  // Longest matching dictionary key wins ("npm run" beats "npm").
  let arity: number | undefined;
  for (let len = Math.min(tokens.length, 2); len > 0; len--) {
    const hit = PREFIX_ARITY[tokens.slice(0, len).join(" ")];
    if (hit !== undefined) {
      arity = hit;
      break;
    }
  }
  if (arity === undefined) return undefined;
  // Shorter than the command unit ("npm run" with no script): a prefix rule
  // minted here would match EVERY script — fall back to exact instead.
  if (tokens.length < arity) return undefined;
  const kept = tokens.slice(0, arity);
  // A flag in a subcommand slot (`git -C /x status` → "git -c") would mint a
  // rule that doesn't describe the command the user vetted — fall back to
  // exact. Only plain-word subcommand tokens produce a prefix rule.
  if (kept.some((token, index) => index > 0 && token.startsWith("-"))) return undefined;
  return kept.join(" ");
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const normalized = normalizeShellCommand(command).toLowerCase();
  const normalizedPrefix = normalizeShellCommand(prefix).toLowerCase();
  return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix} `);
}
