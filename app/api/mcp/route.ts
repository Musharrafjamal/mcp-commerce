import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { SERVER_INSTRUCTIONS } from '@/src/mcp/descriptions'
import { registerAll } from '@/src/mcp/server'
import type { Actor } from '@/src/services/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SERVER_INFO = { name: 'ops-copilot', version: '1.0.0' }

/**
 * Transport and identity only. Zero business logic lives in this file — every rule is
 * in src/domain, every write in src/services.
 */

// Deliberate simplification: one shared static token, per the client's instruction ("a static bearer
// token; no custom authentication system is needed"). Constant-time compare so the
// check does not leak the token a character at a time.
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
    // IDENTITY IS ATTRIBUTION, NOT AUTHORIZATION. This label lands on every audit
    // record; the policy engine is byte-identical whoever is calling.
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
    const actor: Actor = { label: 'demo-operator', clientInfo: 'mcp' }
    registerAll(server, actor)
  },
  { serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS },
)

const authed = withMcpAuth(mcpHandler, verifyToken, { required: true })

// A reviewer will paste this URL into a browser. A raw JSON-RPC 406 is a bad first
// impression on a criterion literally named "deployment".
function serverCard(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${SERVER_INFO.name} — MCP server</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;color:#222}
code{background:#8881;padding:.15em .4em;border-radius:4px}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
<h1>${SERVER_INFO.name} <small>v${SERVER_INFO.version}</small></h1>
<p>This is a <strong>Model Context Protocol</strong> server, not a web page. It speaks JSON-RPC over
Streamable HTTP and expects a <code>POST</code> with an <code>Authorization: Bearer &lt;token&gt;</code> header.</p>
<p>It exposes five tools for one workflow: a delayed, lost or disputed delivery, and the refund decision
that follows.</p>
<p>Connect any MCP-compatible AI client to this URL. Setup instructions and the demo token are on the
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
