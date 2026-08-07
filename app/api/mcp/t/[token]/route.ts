import { GET as baseGet, POST as basePost, DELETE as baseDelete } from '../../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * D-007's path-token fallback: some MCP clients (claude.ai custom connectors among
 * them) cannot send a custom Authorization header. The token travels in the path and
 * is re-injected as the bearer header here, then the request delegates to the same
 * authed handler — so token verification lives in exactly one place, and a wrong path
 * token gets the same 401 as a wrong header.
 *
 * Tradeoff, accepted for a public demo token: a credential in a URL is a credential
 * in every access log along the way.
 */
type Ctx = { params: Promise<{ token: string }> }

async function withBearer(req: Request, ctx: Ctx): Promise<Request> {
  const { token } = await ctx.params
  const headers = new Headers(req.headers)
  headers.set('authorization', `Bearer ${decodeURIComponent(token)}`)
  // Present the parent endpoint's URL so the delegated request is indistinguishable
  // from a direct /api/mcp call, whatever the handler keys on.
  const url = new URL(req.url)
  url.pathname = url.pathname.replace(/\/t\/[^/]+\/?$/, '')
  // duplex is required by undici when the body is a stream; TS's RequestInit lags it.
  return new Request(url, {
    method: req.method,
    headers,
    body: req.body,
    duplex: 'half',
  } as RequestInit)
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return baseGet(await withBearer(req, ctx))
}
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return basePost(await withBearer(req, ctx))
}
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return baseDelete(await withBearer(req, ctx))
}
