export {} // top-level await needs this file to be a module

/**
 * End-to-end verification of the deployed MCP server over raw HTTP JSON-RPC.
 *
 * No MCP client SDK on purpose: this asserts the actual wire contract a reviewer's
 * client will hit, not the SDK's interpretation of it.
 *
 *   bun run verify:local
 *   bun run scripts/verify-mcp.ts <url> <token>
 */

const URL_ = process.argv[2] ?? process.env.MCP_URL ?? 'http://localhost:3000/api/mcp'
const TOKEN = process.argv[3] ?? process.env.MCP_BEARER_TOKEN ?? ''

const PROTOCOL_VERSION = '2025-06-18'

const EXPECTED_TOOLS = [
  'ops_list_delayed_shipments',
  'ops_investigate_delivery_exception',
  'ops_verify_carrier_exception',
  'ops_preview_refund',
  'ops_issue_refund',
]

/**
 * Wire payloads are deliberately untyped here.
 *
 * This script exists to check what the server ACTUALLY returns. Giving the responses a
 * known TypeScript shape would assume the very thing under test — the assertions below
 * are the validation, not the type system. Hence one scoped escape hatch rather than
 * types that quietly agree with the code they are checking.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>

type RpcBody = { result?: Wire; error?: Wire } & Wire

type ToolDef = {
  name: string
  description?: string
  inputSchema?: { properties?: Wire }
  outputSchema?: Wire
  annotations?: Record<string, boolean>
}

type ToolResult = {
  structuredContent?: Wire
  content?: { text: string }[]
  isError?: boolean
}

let failures = 0
let sessionId: string | undefined

function check(name: string, okFlag: boolean, detail = '') {
  console.log(`${okFlag ? '  ok  ' : ' FAIL '} ${name}${detail && !okFlag ? ` — ${detail}` : ''}`)
  if (!okFlag) failures++
}

let nextId = 1

async function rpc(method: string, params: unknown, token = TOKEN, notify = false) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId

  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params }
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) })

  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid

  const text = await res.text()
  let parsed: RpcBody | null = null
  if (text.trim()) {
    const dataLines = text
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
    try {
      parsed = JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text)
    } catch {
      // Not JSON at all — an HTML auth wall, a proxy error page. Keep the raw body so
      // isPlatformWall() can still recognise it.
      parsed = { raw: text }
    }
  }
  return { status: res.status, body: parsed }
}

/** Unwrap a tools/call result into its structuredContent, failing loudly on isError. */
async function callTool(name: string, args: Record<string, unknown>) {
  const r = await rpc('tools/call', { name, arguments: args })
  const result = r.body?.result
  if (!result) throw new Error(`${name}: no result — ${JSON.stringify(r.body).slice(0, 400)}`)
  return result as ToolResult
}

console.log(`\nverifying ${URL_}\n`)

// ---------------------------------------------------------------------------
// E0 — nothing is standing in front of the server
// ---------------------------------------------------------------------------
// Vercel Deployment Protection answers EVERY request with 401, which makes the auth
// matrix below pass for entirely the wrong reason. Assert we reach our own server
// before trusting any 401 as ours.
function isPlatformWall(body: unknown): boolean {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  return /vercel_auth|sso-api|Protected deployment|Authentication Required/i.test(s)
}

const wallProbe = await rpc('initialize', {}, '')
check(
  'E0   no platform auth wall in front of the server',
  !isPlatformWall(wallProbe.body),
  "Deployment Protection is ON — a reviewer's MCP client will never reach this server",
)

// ---------------------------------------------------------------------------
// E3 — auth matrix
// ---------------------------------------------------------------------------
check('E3a  no bearer token is rejected', wallProbe.status === 401 && !isPlatformWall(wallProbe.body), `got ${wallProbe.status}`)
const badAuth = await rpc('initialize', {}, 'not-the-token')
check('E3b  wrong bearer token is rejected', badAuth.status === 401 && !isPlatformWall(badAuth.body), `got ${badAuth.status}`)

// The D-007 path-token fallback, for clients that cannot send a custom header
// (claude.ai custom connectors among them). A bare fetch rather than rpc(): this
// must not share the main run's session, and must send NO Authorization header.
async function pathInit(token: string) {
  return fetch(`${URL_.replace(/\/$/, '')}/t/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9001,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'verify-mcp', version: '1.0.0' } },
    }),
  })
}
const viaPath = await pathInit(TOKEN)
check('E3d  path-token fallback authenticates with no header', viaPath.status === 200, `got ${viaPath.status}`)
const viaBadPath = await pathInit('not-the-token')
check('E3e  a wrong path token gets the same 401', viaBadPath.status === 401, `got ${viaBadPath.status}`)

// ---------------------------------------------------------------------------
// handshake
// ---------------------------------------------------------------------------
const init = await rpc('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'verify-mcp', version: '1.0.0' },
})
check('E3c  correct bearer token is accepted', init.status === 200, `got ${init.status}: ${JSON.stringify(init.body).slice(0, 300)}`)
check('     initialize returns serverInfo', !!init.body?.result?.serverInfo, JSON.stringify(init.body).slice(0, 300))
check(
  '     server ships instructions for the agent',
  typeof init.body?.result?.instructions === 'string' && init.body.result.instructions.length > 200,
)
await rpc('notifications/initialized', {}, TOKEN, true)

// ---------------------------------------------------------------------------
// E1 — the MCP contract itself
// ---------------------------------------------------------------------------
const list = await rpc('tools/list', {})
const tools = (list.body?.result?.tools ?? []) as ToolDef[]

check('E1a  tools/list returns exactly 5 tools', tools.length === 5, `got ${tools.length}: ${tools.map(t => t.name).join(', ')}`)
check(
  'E1b  registered in workflow order',
  JSON.stringify(tools.map(t => t.name)) === JSON.stringify(EXPECTED_TOOLS),
  tools.map(t => t.name).join(', '),
)

const BANNED = /query|search|find|exec|schema|health/i
for (const t of tools) {
  const d: string = t.description ?? ''
  check(`E1c  ${t.name}: task-shaped name, not a data-access verb`, !BANNED.test(t.name))
  check(`E1d  ${t.name}: description says when to use it`, /use this/i.test(d))
  check(`E1e  ${t.name}: description says when NOT to`, /do not use/i.test(d))
  check(`E1f  ${t.name}: description is substantive`, d.length >= 400, `${d.length} chars`)
  check(`E1g  ${t.name}: has inputSchema`, !!t.inputSchema)
  check(`E1h  ${t.name}: has outputSchema`, !!t.outputSchema)
  const a = t.annotations ?? {}
  check(
    `E1i  ${t.name}: all four annotations set explicitly`,
    ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every(k => k in a),
    JSON.stringify(a),
  )
}

const readTools = tools.filter(t => ['ops_list_delayed_shipments', 'ops_investigate_delivery_exception'].includes(t.name))
check('E1j  read tools declare readOnlyHint true', readTools.every(t => t.annotations?.readOnlyHint === true))
const issue = tools.find(t => t.name === 'ops_issue_refund')
check('E1k  the money-moving tool declares destructiveHint true', issue?.annotations?.destructiveHint === true)
check('E1l  the money-moving tool declares idempotentHint true', issue?.annotations?.idempotentHint === true)
// The structural claim the whole submission rests on: there is no field anywhere for a
// model to put a dollar figure in. Checked per tool so a failure names the culprit.
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {})
  const offending = props.filter(p => /amount|minor|total|price|value|idempot/i.test(p))
  check(`E1m  ${t.name}: no input field accepts an amount or an idempotency key`, offending.length === 0, offending.join(', '))
}

// resources + prompt
const res = await rpc('resources/list', {})
const resources = (res.body?.result?.resources ?? []) as { uri?: string }[]
check('E1n  policy resource is published', resources.some(r => String(r.uri).includes('policy')), JSON.stringify(resources).slice(0, 200))
const prompts = await rpc('prompts/list', {})
check('E1o  the triage prompt is published', (prompts.body?.result?.prompts ?? []).length >= 1)

// ---------------------------------------------------------------------------
// E2 — the whole workflow over the wire
// ---------------------------------------------------------------------------
try {
  const queue = await callTool('ops_list_delayed_shipments', { min_severity: 'all', limit: 25 })
  // `?? {}` so a missing payload fails the assertions below rather than throwing
  // before they run — E2a is the check that it was there at all.
  const q = queue.structuredContent ?? {}
  check('E2a  the queue returns structuredContent', !!q, JSON.stringify(queue).slice(0, 300))
  check('E2b  detectors filter — some orders, not all 28', q.total_open > 0 && q.total_open < 28, `total_open=${q?.total_open}`)

  // ORD-1007 is the auto-approve case in the seed manifest.
  const inv = await callTool('ops_investigate_delivery_exception', { order_ref: 'ORD-1007' })
  const i = inv.structuredContent ?? {}
  check('E2c  investigate joins payment and carrier data', !!i?.shipment && !!i?.captured)
  check('E2d  root causes carry traceable evidence', (i?.root_causes?.[0]?.evidence ?? []).length > 0)
  check('E2e  no verification on file yet', i?.shipment?.carrier_verification === null)
  check('E2f  it names the next call', typeof i?.next === 'string' && i.next.includes('ops_verify_carrier_exception'))

  // Refund must be refused until the carrier has been asked.
  const early = await callTool('ops_preview_refund', { order_ref: 'ORD-1007', target: { mode: 'full_order' } })
  check('E2g  refund is DENIED before carrier verification', early.structuredContent?.policy?.decision === 'deny')
  check('E2h  the denial is not an error', early.isError !== true)

  const ver = await callTool('ops_verify_carrier_exception', { order_ref: 'ORD-1007' })
  check('E2i  carrier confirms the loss', ver.structuredContent?.status === 'LOST_IN_TRANSIT', JSON.stringify(ver.structuredContent).slice(0, 200))
  check('E2j  the precondition is now met', ver.structuredContent?.refund_precondition_met === true)

  const prev = await callTool('ops_preview_refund', { order_ref: 'ORD-1007', target: { mode: 'full_order' } })
  const p = prev.structuredContent ?? {}
  check('E2k  the same order now previews as allow', p?.policy?.decision === 'allow', JSON.stringify(p?.policy).slice(0, 300))
  check('E2l  a single-use plan id is minted server-side', /^PLAN-[A-Z0-9]{20}$/.test(p?.plan_id ?? ''), p?.plan_id)
  check('E2m  the amount is computed by the server', p?.computed?.amount?.minor > 0)
  check('E2n  all nine rules report a verdict', (p?.policy?.rules ?? []).length === 9, `${p?.policy?.rules?.length}`)

  const done = await callTool('ops_issue_refund', { plan_id: p.plan_id })
  check('E2o  the refund executes', done.structuredContent?.status === 'executed', JSON.stringify(done.structuredContent).slice(0, 300))
  check('E2p  it was not a replay', done.structuredContent?.replayed === false)

  const again = await callTool('ops_issue_refund', { plan_id: p.plan_id })
  check('E2q  re-issuing the same plan replays instead of refunding twice', again.structuredContent?.replayed === true)
  check('E2r  the replay is not an error', again.isError !== true)

  const after = await callTool('ops_investigate_delivery_exception', { order_ref: 'ORD-1007' })
  check('E2s  the refund appears in the verified timeline', after.structuredContent?.refunded?.minor === p.computed.amount.minor)

  // An invented plan id must be refused at the schema boundary.
  const bogus = await callTool('ops_issue_refund', { plan_id: 'PLAN-IMADETHISUPMYSELF1' })
  check('E2t  an invented plan id is refused', bogus.isError === true)
} catch (e) {
  check('E2   full workflow completed', false, (e as Error).message)
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`}\n`)
process.exit(failures === 0 ? 0 : 1)
