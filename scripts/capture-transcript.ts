export {} // top-level await needs this file to be a module

/**
 * Capture a verbatim wire transcript against the deployed MCP server.
 *
 *   bun run capture:transcript          # writes docs/transcript.md
 *
 * IMPORTANT, and stated in the output itself: this script chooses the tool sequence.
 * It is real evidence of what the server does — every request and response below is
 * genuine, unedited, against production — but it is NOT evidence that a live model
 * picks the right tools in the right order. That gap is named in the README and an
 * agentic eval is the fix.
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const URL_ = process.argv[2] ?? 'https://ops-copilot-musharraf008s-projects.vercel.app/api/mcp'
const TOKEN = process.argv[3] ?? process.env.MCP_BEARER_TOKEN?.trim() ?? ''

let sessionId: string | undefined
let nextId = 1

async function rpc(method: string, params: unknown, notify = false) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params }
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  const data = text
    .split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trim())
  try {
    return JSON.parse(data.length ? data[data.length - 1] : text)
  } catch {
    return { raw: text }
  }
}

const out: string[] = []
const say = (s = '') => out.push(s)

/** Trim deep payloads so the transcript stays readable without being edited. */
function pick(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return obj
  const o = obj as Record<string, unknown>
  const r: Record<string, unknown> = {}
  for (const k of keys) if (k in o) r[k] = o[k]
  return r
}

const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```'

async function step(heading: string, note: string, name: string, args: Record<string, unknown>, keys: string[]) {
  const r = await rpc('tools/call', { name, arguments: args })
  const result = r?.result ?? r
  say(`## ${heading}`)
  say()
  say(note)
  say()
  say('**Request**')
  say(json({ method: 'tools/call', params: { name, arguments: args } }))
  say()
  // Error results carry no structuredContent by design — the payload is the guidance
  // text. Printing an empty JSON block there would be noise.
  if (result.structuredContent && keys.length) {
    say('**Response** — `structuredContent`, trimmed to the fields that matter')
    say(json(pick(result.structuredContent, keys)))
    say()
  }
  if (result.isError) say('**Response** — `isError: true`, and the text the agent receives:')
  say()
  return result
}

// --- handshake --------------------------------------------------------------

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'capture-transcript', version: '1.0.0' },
})
await rpc('notifications/initialized', {}, true)
const tools = (await rpc('tools/list', {}))?.result?.tools ?? []

say('# Captured wire transcript')
say()
say(`Against \`${URL_}\` on ${new Date().toISOString().slice(0, 10)}.`)
say()
say(
  '> **What this is.** Every request and response below is genuine and unedited, captured over raw ' +
    'JSON-RPC against the deployed server by `scripts/capture-transcript.ts`. Responses are trimmed to ' +
    'the relevant fields — nothing is rewritten.',
)
say('>')
say(
  '> **What this is not.** The *script* chose the tool sequence, not a language model. This proves what ' +
    'the server does; it does not prove a live model picks the right tools in the right order. That gap ' +
    'is named in the README, and an agentic eval is the fix.',
)
say()
say('---')
say()
say(`**Server:** \`${init?.result?.serverInfo?.name}\` v${init?.result?.serverInfo?.version}  `)
say(`**Tools:** ${tools.map((t: { name: string }) => `\`${t.name}\``).join(', ')}`)
say()
say('---')
say()

// --- 1. the queue -----------------------------------------------------------

const queue = await step(
  '1. What needs attention',
  'The triage queue. 7 of 28 seeded orders are open exceptions — the other 21 are healthy and correctly absent.',
  'ops_list_delayed_shipments',
  { min_severity: 'all', limit: 25 },
  ['total_open', 'showing'],
)
const first = queue.structuredContent?.exceptions?.[0]
say('First row:')
say(json(pick(first, ['order_id', 'exception_code', 'severity', 'age_days', 'one_line_why', 'next_step'])))
say()

// --- 2. investigate ---------------------------------------------------------

await step(
  '2. Investigate ORD-1001',
  'One call joins the order, the payment ledger and the carrier scan history, and returns ranked causes ' +
    'with the evidence for each. Note `carrier_verification: null` — no refund can be authorised yet.',
  'ops_investigate_delivery_exception',
  { order_ref: 'ORD-1001' },
  ['order_id', 'captured', 'refunded', 'refundable_now', 'confidence_band', 'requires_human_judgment', 'eligible_remedies', 'next'],
)

// --- 3. refused before verification -----------------------------------------

await step(
  '3. Try to refund before asking the carrier',
  'Refused. Rule `P3` requires a carrier verification less than 24 hours old. Note this comes back as a ' +
    'normal result, **not** an error — an error would invite the model to reshape the request and retry.',
  'ops_preview_refund',
  { order_ref: 'ORD-1001', target: { mode: 'full_order' } },
  ['policy', 'next'],
)

// --- 4. verify --------------------------------------------------------------

await step(
  '4. Ask the carrier',
  'The step that separates a lost parcel from a merely late one. Our own records cannot.',
  'ops_verify_carrier_exception',
  { order_ref: 'ORD-1001' },
  ['order_id', 'tracking_number', 'status', 'refund_precondition_met', 'carrier_note', 'next'],
)

// --- 5. preview -------------------------------------------------------------

const prev = await step(
  '5. Preview the refund',
  'The same order, now allowed. The amount is computed by the server from the payment ledger — there is ' +
    'no input field anywhere for a model to supply one. All nine policy rules report a verdict.',
  'ops_preview_refund',
  { order_ref: 'ORD-1001', target: { mode: 'full_order' } },
  ['plan_id', 'expires_at', 'execute_with', 'computed', 'effects'],
)
const planId = prev.structuredContent?.plan_id
say('Policy verdict:')
say(json(pick(prev.structuredContent?.policy, ['decision', 'do_not_retry', 'guidance'])))
say()

// --- 6. execute -------------------------------------------------------------

await step(
  '6. Execute',
  'The only input is the plan id.',
  'ops_issue_refund',
  { plan_id: planId },
  ['action_id', 'status', 'replayed', 'effect_summary', 'audit_url', 'next'],
)

// --- 7. replay --------------------------------------------------------------

await step(
  '7. Issue the identical plan again',
  '`replayed: true`, and the cached result is returned byte-for-byte. One refund transaction exists, not two.',
  'ops_issue_refund',
  { plan_id: planId },
  ['action_id', 'status', 'replayed', 'effect_summary'],
)

// --- 8. the premature case --------------------------------------------------

await step(
  '8. ORD-1006 — indistinguishable from ORD-1001 in our data',
  'Same scan gap, same breached promise date. Ask the carrier and the answer is different.',
  'ops_verify_carrier_exception',
  { order_ref: 'ORD-1006' },
  ['status', 'revised_eta', 'refund_precondition_met', 'carrier_note', 'next'],
)
await step(
  '9. So the refund is refused as premature',
  'This is the client’s "verified carrier exception" doing real work rather than being a label.',
  'ops_preview_refund',
  { order_ref: 'ORD-1006', target: { mode: 'full_order' } },
  ['policy'],
)

// --- 10. the undecidable case -----------------------------------------------

const disputed = await step(
  '10. ORD-1003 — the engine declines to conclude',
  'A delivered scan 28 m from the door, and a customer reporting non-receipt. Competing explanations that ' +
    'cannot be separated on the evidence.',
  'ops_investigate_delivery_exception',
  { order_ref: 'ORD-1003' },
  ['confidence_band', 'requires_human_judgment', 'eligible_remedies', 'signals'],
)
say('Root causes — each carrying evidence **against** it as well as for:')
say(
  json(
    (disputed.structuredContent?.root_causes ?? []).map((c: Record<string, unknown>) => ({
      code: c.code,
      confidence: c.confidence,
      supporting: (c.evidence as unknown[])?.length,
      contradicting: (c.contradicting_evidence as unknown[])?.length,
    })),
  ),
)
say()

// --- 11. hard invariant -----------------------------------------------------

const already = await step(
  '11. ORD-1004 — the ledger outranks the order record',
  'The order status still reads `open`, but the payment ledger shows it was already refunded in full. ' +
    'This one fails before policy is even consulted.',
  'ops_preview_refund',
  { order_ref: 'ORD-1004', target: { mode: 'full_order' } },
  [],
)
say('```text\n' + (already.content?.[0]?.text ?? '') + '\n```')
say()

// --- 12. invented plan id ---------------------------------------------------

const bogus = await step(
  '12. An invented plan id',
  'Plan ids are minted by the server and regex-pinned in the schema. A fabricated one cannot execute.',
  'ops_issue_refund',
  { plan_id: 'PLAN-IMADETHISUPMYSELF1' },
  [],
)
say('```text\n' + (bogus.content?.[0]?.text ?? '') + '\n```')
say()

say('---')
say()
say(
  'Regenerate with `bun run capture:transcript`. Reset the dataset afterwards with `bun run seed` or the ' +
    'console button, since this transcript executes a real refund.',
)
say()

mkdirSync('docs', { recursive: true })
writeFileSync('docs/transcript.md', out.join('\n'), 'utf8')
console.log(`wrote docs/transcript.md (${out.join('\n').length} chars)`)
process.exit(0)
