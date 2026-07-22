/**
 * MCP bridge — PURE helpers (no SDK, no native deps → strip-types testable).
 *
 * The stateful HTTP/MCP server lives in `mcpServer.ts`; this file only holds the
 * pure pieces that are worth testing on their own: the Tool→MCP-tool mapping, the
 * `--mcp-config` JSON, the `--allowedTools` list, the env gate, and a tiny
 * module-level holder for the currently-live bridge endpoint so `claudeSpawn.ts`
 * can attach it to every `claude -p` without importing the server.
 */
import type { JSONSchema, Tool } from './types.ts';

/** Server name Claude Code namespaces our tools under: `mcp__alfred__<tool>`. */
export const MCP_SERVER_NAME = 'alfred';

export interface McpEndpoint {
  url: string;
  token: string;
}

/** MCP tool name as Claude Code exposes it to the model: `mcp__<server>__<tool>`. */
export function mcpToolName(tool: string, server: string = MCP_SERVER_NAME): string {
  return `mcp__${server}__${tool}`;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/** Map Alfred's registry tools to MCP tool descriptors (name, description, schema). */
export function toMcpTools(tools: Tool[]): McpToolDescriptor[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** The `--mcp-config` value: one Streamable-HTTP server, bearer-authenticated. */
export function buildMcpConfig(ep: McpEndpoint, server: string = MCP_SERVER_NAME): {
  mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }>;
} {
  return {
    mcpServers: {
      [server]: { type: 'http', url: ep.url, headers: { Authorization: `Bearer ${ep.token}` } },
    },
  };
}

/** `--allowedTools` entries auto-approving every Alfred tool (governance still runs host-side). */
export function buildAllowedTools(toolNames: string[], server: string = MCP_SERVER_NAME): string[] {
  return toolNames.map((n) => mcpToolName(n, server));
}

/** Bridge on by default; ALFRED_MCP_BRIDGE=0/false/off/no disables it. */
export function bridgeEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.ALFRED_MCP_BRIDGE ?? '').trim().toLowerCase();
  if (v === '') return true;
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** The live bridge, or null. */
export interface ActiveBridge extends McpEndpoint {
  tools: string[];
}

let active: ActiveBridge | null = null;

/** Set by the MCP server on start (endpoint + tool names) and cleared on shutdown. */
export function setActiveMcpBridge(b: ActiveBridge | null): void {
  active = b;
}

export function getActiveMcpBridge(): ActiveBridge | null {
  return active;
}

/**
 * Extra `claude` CLI args attaching the Alfred MCP bridge to a spawn — `[]` when
 * no bridge is live or the env disabled it (the fallback: `claude -p` runs with
 * only its own tools). The config is passed inline as a JSON string (Claude Code
 * accepts `--mcp-config <json-string>`), so no temp file to write or clean up.
 *
 * `--strict-mcp-config` pins the child to ONLY Alfred's server: it ignores any
 * MCP servers the user has configured globally/per-project, so a delegated
 * `claude -p` reaches exactly Alfred's governed tools and nothing else — no
 * surprise external servers, no OAuth prompts, deterministic surface.
 */
export function mcpCliArgs(
  env: Record<string, string | undefined>,
  bridge: ActiveBridge | null = getActiveMcpBridge(),
): string[] {
  if (!bridge || !bridgeEnabled(env)) return [];
  const config = JSON.stringify(buildMcpConfig(bridge));
  const allowed = buildAllowedTools(bridge.tools).join(',');
  return ['--mcp-config', config, '--strict-mcp-config', '--allowedTools', allowed];
}
