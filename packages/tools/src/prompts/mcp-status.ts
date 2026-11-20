export const description =
  'Reports health of every MCP server available to the active agent profile. Each entry: `{ status: "connected" }` (reachable), `{ status: "failed", error }` (last connect failed), or `{ status: "disabled" }` (in config but off). Use after an MCP call errored to decide retry vs. wait vs. surface failure. Usage: `mcp_status({})`.';
