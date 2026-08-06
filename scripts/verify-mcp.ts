/**
 * End-to-end verification of the deployed MCP server over raw HTTP JSON-RPC.
 * No MCP SDK client — this asserts the actual wire contract a reviewer's client will hit.
 *
 *   bun run scripts/verify-mcp.ts [url] [token]
 *
 * Defaults to localhost with the .env.local token.
 */

export {} // top-level await needs this file to be a module

const URL_ = process.argv[2] ?? process.env.MCP_URL ?? 'http://localhost:3000/api/mcp'
const TOKEN = process.argv[3] ?? process.env.MCP_BEARER_TOKEN ?? 'ops-demo-local-token'

const PROTOCOL_VERSION = '2025-06-18'

let failures = 0
let sessionId: string | undefined

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function rpc(method: string, params: unknown, token = TOKEN, id: number | null = 1) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId

  const res = await fetch(URL_, {
    method: 'POST',
    headers,
    body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  })

  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid

  const text = await res.text()
  // Streamable HTTP may answer as SSE; pull the JSON out of the last data: frame.
  let body: any = null
  if (text.trim()) {
    const dataLines = text
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
    try {
      body = JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body }
}

console.log(`\nverifying ${URL_}\n`)

// ---- E0: the platform is not shadowing our server --------------------------
// Vercel Deployment Protection answers EVERY request with 401, which makes the auth
// matrix below pass for entirely the wrong reason. Assert we are talking to our own
// server before trusting any 401 as ours.
function isPlatformWall(body: unknown): boolean {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  return /vercel_auth|sso-api|Protected deployment|Authentication Required/i.test(s)
}

const wallProbe = await rpc('initialize', {}, '')
check(
  'E0   no platform auth wall in front of the server',
  !isPlatformWall(wallProbe.body),
  'Deployment Protection is ON — a reviewer\'s MCP client will never reach this server',
)

// ---- E3: auth matrix -------------------------------------------------------
check('E3a  no bearer token is rejected', wallProbe.status === 401 && !isPlatformWall(wallProbe.body), `got ${wallProbe.status}`)

const badAuth = await rpc('initialize', {}, 'not-the-token')
check(
  'E3b  wrong bearer token is rejected',
  badAuth.status === 401 && !isPlatformWall(badAuth.body),
  `got ${badAuth.status}`,
)

// ---- handshake -------------------------------------------------------------
const init = await rpc('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'verify-mcp', version: '0.1.0' },
})
check('E3c  correct bearer token is accepted', init.status === 200, `got ${init.status}: ${JSON.stringify(init.body).slice(0, 300)}`)
check('     initialize returns serverInfo', !!init.body?.result?.serverInfo, JSON.stringify(init.body).slice(0, 300))

await rpc('notifications/initialized', {}, TOKEN, null)

// ---- E1: the tool contract -------------------------------------------------
const list = await rpc('tools/list', {}, TOKEN, 2)
const tools: any[] = list.body?.result?.tools ?? []
check('E1a  tools/list responds', tools.length > 0, JSON.stringify(list.body).slice(0, 400))

const BANNED = /query|search|find|exec|schema|health/i
for (const t of tools) {
  check(`E1b  ${t.name}: not a generic data-access name`, !BANNED.test(t.name))
  check(`E1c  ${t.name}: has an inputSchema`, !!t.inputSchema)
  check(`E1d  ${t.name}: has an outputSchema`, !!t.outputSchema)
  const a = t.annotations ?? {}
  check(
    `E1e  ${t.name}: all four annotations set explicitly`,
    ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every(k => k in a),
    JSON.stringify(a),
  )
}

// ---- smoke call ------------------------------------------------------------
if (tools.some(t => t.name === 'ops_ping')) {
  const call = await rpc('tools/call', { name: 'ops_ping', arguments: {} }, TOKEN, 3)
  check('     ops_ping returns structuredContent', !!call.body?.result?.structuredContent, JSON.stringify(call.body).slice(0, 300))
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`}\n`)
process.exit(failures === 0 ? 0 : 1)
