export const description =
  'Lists resources exposed by MCP servers available to the active agent profile; each item carries a `server` field. Use `mcp_list_resources({})` to list from every permitted server, or `mcp_list_resources({ server: "filesystem" })` to filter. Empty results are normal — many MCP servers expose tools but no resources.';
