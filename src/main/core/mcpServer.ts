/**
 * In-process MCP server (Streamable HTTP) that exposes Alfred's tool registry to
 * the Claude Code brain (`claude -p`). It runs INSIDE Alfred's main process, so
 * every MCP tool call executes the real `Tool.execute(args, ctx)` with the real
 * orchestrator ToolCtx — meaning governance (risk tiers, HITL approvals, trifecta,
 * DANGEROUS mode), the audit trail, and the UI stream events all apply. The
 * result: `claude -p` gains Alfred's tools WITH Alfred's safety, no bypass.
 *
 * Transport: Streamable HTTP, one session per client (the standard pattern — a new
 * transport is created on the `initialize` request and keyed by its Mcp-Session-Id;
 * later requests reuse it; nested `claude -p` delegations each get their own). Bound
 * to an ephemeral 127.0.0.1 port (never off-host). Auth: a random per-boot bearer
 * token; requests without it get 401, so other local processes can't drive Alfred.
 *
 * Fallback: if anything here throws (SDK/transport/bind), `startMcpBridge` returns
 * null and logs a warning; `claude -p` then simply runs with its own tools, the
 * prior behaviour. No crash.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolCtx } from './types.ts';
import { runGovernedTool } from './governance.ts';
import { MCP_SERVER_NAME, setActiveMcpBridge, toMcpTools, type McpEndpoint } from './mcpConfig.ts';

export interface McpBridgeHandle {
  endpoint: McpEndpoint;
  shutdown(): Promise<void>;
}

/** Constant-time bearer check (no early-out on the first wrong byte). */
function bearerOk(header: string | string[] | undefined, token: string): boolean {
  const got = Array.isArray(header) ? header[0] : header;
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read and JSON-parse a request body (undefined when empty/invalid). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Start the bridge. Returns a handle (endpoint + shutdown) or null if it could
 * not start (caller treats null as "run claude -p without Alfred tools").
 */
export async function startMcpBridge(tools: Tool[], ctx: ToolCtx): Promise<McpBridgeHandle | null> {
  try {
    const token = randomBytes(24).toString('hex');
    const transports = new Map<string, StreamableHTTPServerTransport>();

    // A fresh MCP Server (same tool set + governed executor) per client session.
    const makeServer = (): Server => {
      const server = new Server({ name: MCP_SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools(tools) }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const t = tools.find((x) => x.name === req.params.name);
        if (!t) return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
        // The heart of the bridge: the same governed execution the agent loop uses.
        const result = await runGovernedTool(t, req.params.arguments ?? {}, ctx);
        const isError = !!(result && typeof result === 'object' && 'error' in result);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError };
      });
      return server;
    };

    const handle = async (httpReq: IncomingMessage, httpRes: ServerResponse): Promise<void> => {
      if (!bearerOk(httpReq.headers['authorization'], token)) {
        httpRes.writeHead(401, { 'content-type': 'application/json' });
        httpRes.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const sid = httpReq.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing) {
        await existing.handleRequest(httpReq, httpRes);
        return;
      }

      // No session yet: only a POST carrying an `initialize` request may open one.
      const body = httpReq.method === 'POST' ? await readBody(httpReq) : undefined;
      if (!isInitializeRequest(body)) {
        httpRes.writeHead(400, { 'content-type': 'application/json' });
        httpRes.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'No valid session' } }));
        return;
      }

      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await makeServer().connect(transport);
      await transport.handleRequest(httpReq, httpRes, body);
    };

    const http = createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[alfred] MCP request failed:', err instanceof Error ? err.message : err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });

    const addr = http.address();
    if (!addr || typeof addr === 'string') {
      http.close();
      throw new Error('MCP server did not bind to a TCP port');
    }
    const endpoint: McpEndpoint = { url: `http://127.0.0.1:${addr.port}/mcp`, token };
    setActiveMcpBridge({ ...endpoint, tools: tools.map((t) => t.name) });
    // Never log the token.
    console.log(`[alfred] MCP bridge up on 127.0.0.1:${addr.port} (${tools.length} tools)`);

    return {
      endpoint,
      async shutdown() {
        setActiveMcpBridge(null);
        for (const t of transports.values()) await t.close().catch(() => {});
        transports.clear();
        await new Promise<void>((r) => http.close(() => r()));
      },
    };
  } catch (err) {
    console.error(
      '[alfred] MCP bridge failed to start — claude -p will run without Alfred tools:',
      err instanceof Error ? err.message : err,
    );
    setActiveMcpBridge(null);
    return null;
  }
}
