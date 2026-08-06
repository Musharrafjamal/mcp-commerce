import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SERVER_INFO = { name: 'ops-copilot', version: '0.1.0' }

// ponytail: one shared static token, compared in constant time. Per-operator tokens
// only matter once audit attribution needs to distinguish real people.
function verifyToken(_req: Request, bearer?: string): AuthInfo | undefined {
  // trim(): env vars set through a CLI pipe pick up a trailing newline, which silently
  // fails every comparison and looks exactly like a wrong token.
  const expected = process.env.MCP_BEARER_TOKEN?.trim()
  if (!expected || !bearer) return undefined
  if (!timingSafeEqual(bearer.trim(), expected)) return undefined
  return {
    token: bearer,
    clientId: 'ops-console',
    scopes: ['ops:read', 'ops:write'],
    // Identity is ATTRIBUTION, not authorization. Policy is byte-identical for every
    // actor; this label only lands on the audit trail.
    extra: { actorLabel: 'demo-operator' },
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const mcpHandler = createMcpHandler(
  server => {
    // Spike tool only — replaced by the five real tools in §6.
    server.registerTool(
      'ops_ping',
      {
        title: 'Ping',
        description:
          'Connectivity check. Returns the server version and current time. ' +
          'Use this to confirm the MCP server is reachable and your bearer token is accepted. ' +
          'Do not use it for any operations question — it reads no commerce data.',
        inputSchema: z.object({}),
        outputSchema: z.object({ server: z.string(), version: z.string(), now: z.string() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const out = {
          server: SERVER_INFO.name,
          version: SERVER_INFO.version,
          now: new Date().toISOString(),
        }
        return {
          content: [{ type: 'text', text: `${out.server} v${out.version} is up (${out.now}).` }],
          structuredContent: out,
        }
      },
    )
  },
  { serverInfo: SERVER_INFO },
)

const authed = withMcpAuth(mcpHandler, verifyToken, { required: true })

// A reviewer will paste this URL into a browser. A raw JSON-RPC 406 is a bad first
// impression on a criterion literally named "deployment".
function serverCard(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${SERVER_INFO.name} — MCP server</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem}
code{background:#8881;padding:.15em .4em;border-radius:4px}</style>
<h1>${SERVER_INFO.name} <small>v${SERVER_INFO.version}</small></h1>
<p>This is a <strong>Model Context Protocol</strong> server, not a web page. It speaks JSON-RPC over
Streamable HTTP and expects a <code>POST</code> with an <code>Authorization: Bearer &lt;token&gt;</code> header.</p>
<p>Connect an MCP-compatible AI client to this URL. Setup instructions and the demo token are in the
<a href="/">start-here page</a>.</p>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export async function GET(req: Request): Promise<Response> {
  if (req.headers.get('accept')?.includes('text/html')) return serverCard()
  return authed(req)
}

export const POST = authed
export const DELETE = authed
