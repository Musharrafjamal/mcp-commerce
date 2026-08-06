import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { POLICY } from '@/src/config/policy'
import { getAction } from '@/src/services/approvals'
import type { Actor } from '@/src/services/types'
import { PROMPT_DESCRIPTIONS, RESOURCE_DESCRIPTIONS, TOOL_DESCRIPTIONS, TOOL_TITLES } from './descriptions'
import * as S from './schemas'
import * as T from './tools'

/**
 * Registration order is the workflow order, so `tools/list` reads top to bottom as the
 * sequence an agent should follow.
 *
 * All four annotations are set explicitly on every tool. `destructiveHint` and
 * `openWorldHint` both default to TRUE in the spec, so omitting them silently
 * advertises a read-only tool as destructive and open-world. Annotations are hints a
 * client MAY ignore — the actual guarantees live in the policy engine, the single-use
 * plan claim, the effect fingerprint and the append-only log, all of which hold even
 * if a client ignores every annotation here.
 */
export function registerAll(server: McpServer, actor: Actor): void {
  // --- 1 -------------------------------------------------------------------
  server.registerTool(
    'ops_list_delayed_shipments',
    {
      title: TOOL_TITLES.ops_list_delayed_shipments,
      description: TOOL_DESCRIPTIONS.ops_list_delayed_shipments,
      inputSchema: S.listInput,
      outputSchema: S.listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => T.listDelayedShipments(args, actor),
  )

  // --- 2 -------------------------------------------------------------------
  server.registerTool(
    'ops_investigate_delivery_exception',
    {
      title: TOOL_TITLES.ops_investigate_delivery_exception,
      description: TOOL_DESCRIPTIONS.ops_investigate_delivery_exception,
      inputSchema: S.investigateInput,
      outputSchema: S.investigateOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => T.investigateDeliveryException(args, actor),
  )

  // --- 3 -------------------------------------------------------------------
  server.registerTool(
    'ops_verify_carrier_exception',
    {
      title: TOOL_TITLES.ops_verify_carrier_exception,
      description: TOOL_DESCRIPTIONS.ops_verify_carrier_exception,
      inputSchema: S.verifyInput,
      outputSchema: S.verifyOutput,
      annotations: {
        // Persists a verification and an audit entry, so readOnly would be a lie —
        // a small one a sharp reviewer catches. openWorld because it reaches a
        // third-party system whose answer we do not control.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async args => T.verifyCarrier(args, actor),
  )

  // --- 4 -------------------------------------------------------------------
  server.registerTool(
    'ops_preview_refund',
    {
      title: TOOL_TITLES.ops_preview_refund,
      description: TOOL_DESCRIPTIONS.ops_preview_refund,
      inputSchema: S.previewInput,
      outputSchema: S.previewOutput,
      annotations: {
        // Moves no money, but persists the proposal so that every proposal — including
        // the refused ones — is auditable. Claiming readOnly: true here would be the
        // convenient lie rather than the true statement.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false, // each call mints a new single-use plan
        openWorldHint: false,
      },
    },
    async args => T.previewRefund(args, actor),
  )

  // --- 5 -------------------------------------------------------------------
  server.registerTool(
    'ops_issue_refund',
    {
      title: TOOL_TITLES.ops_issue_refund,
      description: TOOL_DESCRIPTIONS.ops_issue_refund,
      inputSchema: S.issueInput,
      outputSchema: S.issueOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true, // same plan_id replays rather than refunding twice
        openWorldHint: true,
      },
    },
    async args => T.issueRefund(args, actor),
  )

  // --- resources -----------------------------------------------------------

  // Rendered from the SAME constants the engine evaluates, so the published policy
  // cannot drift from enforced behaviour.
  server.registerResource(
    'policy',
    'ops://policy/current',
    { title: 'Refund policy in force', description: RESOURCE_DESCRIPTIONS.policy, mimeType: 'text/markdown' },
    async uri => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderPolicy() }],
    }),
  )

  server.registerResource(
    'runbook',
    'ops://runbook/delivery-exception',
    { title: 'Delivery-exception runbook', description: RESOURCE_DESCRIPTIONS.runbook, mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: RUNBOOK }] }),
  )

  server.registerResource(
    'audit',
    'ops://audit/{action_id}',
    { title: 'Audit record', description: RESOURCE_DESCRIPTIONS.audit, mimeType: 'application/json' },
    async uri => {
      const id = uri.href.split('/').pop() ?? ''
      const doc = await getAction(id)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(doc ?? { error: `No audit record ${id}` }, null, 2),
          },
        ],
      }
    },
  )

  // --- prompt ---------------------------------------------------------------
  // The prompt is what puts the METHOD on the server, not just the data access.
  server.registerPrompt(
    'ops_triage_delayed_order',
    {
      title: 'Triage a delayed or disputed delivery',
      description: PROMPT_DESCRIPTIONS.ops_triage_delayed_order,
      argsSchema: z.object({
        order_ref: z.string().optional().describe('An order reference, if you already have one.'),
      }),
    },
    ({ order_ref }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              order_ref
                ? `Work order ${order_ref} through to a resolution.`
                : 'Work the delivery-exception queue, starting with the most severe item.',
              '',
              'Follow this order and do not skip a step:',
              order_ref ? '' : '1. ops_list_delayed_shipments — pick the top item.',
              '2. ops_investigate_delivery_exception — establish what happened and how confident we are.',
              '   If requires_human_judgment is true, STOP. Report the competing explanations and',
              '   do not choose between them.',
              '3. ops_verify_carrier_exception — our data cannot tell a lost parcel from a delayed one.',
              '   If the carrier says IN_TRANSIT, a refund is premature: report the revised ETA and stop.',
              '4. ops_preview_refund — the server computes the amount. You never supply one.',
              '5. ops_issue_refund with the plan id.',
              '',
              'Then re-run ops_investigate_delivery_exception to confirm the outcome.',
              '',
              'If policy denies, do not retry with a smaller amount or fewer lines — the rule is not a',
              'threshold. If policy requires approval, issuing it queues it for a manager with the',
              'evidence attached; that is the correct outcome, not a failure.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
      ],
    }),
  )
}

function renderPolicy(): string {
  const usd = (m: number) => `$${(m / 100).toFixed(2)}`
  return `# Refund policy in force

Generated from the same constants the policy engine evaluates. If this document and the
server's behaviour ever disagree, this document is wrong by construction — it is rendered
from \`POLICY\`, not maintained separately.

## Thresholds

| Setting | Value |
|---|---|
| Auto-approval ceiling | **${usd(POLICY.refundCeilingMinor)}** flat |
| Ceiling window | rolling ${POLICY.ceilingWindowHours}h per order |
| Carrier verification must be newer than | ${POLICY.verificationFreshnessHours}h |
| Carrier silence before an order is flagged | ${POLICY.scanGapSlaDays} days |
| Delivery geo tolerance | ${POLICY.deliveryGeoToleranceM}m |
| Plan lifetime | ${POLICY.planTtlMinutes} minutes, single use |
| Identical-effect dedupe window | ${POLICY.effectDedupeHours}h |
| Circuit breaker | ${POLICY.circuitBreaker.maxExecutedPerActorPer10Min} refunds / actor / 10 min, ${usd(POLICY.circuitBreaker.maxAutoApprovedMinorPer24h)} auto-approved / 24h |

## The nine rules

| Rule | Fires when | Verdict |
|---|---|---|
| P1_REFUND_CEILING | rolling 24h refund total for the order exceeds ${usd(POLICY.refundCeilingMinor)} | require_approval |
| P2_REFUND_LE_CAPTURED | refunds would exceed the amount captured | **deny** |
| P3_CARRIER_VERIFIED | no verification, a stale one, or the carrier says IN_TRANSIT | **deny** |
| P4_LOW_CONFIDENCE | explanations cannot be separated | require_approval |
| P5_DISPUTED_DELIVERY | carrier recorded a delivery, customer reports non-receipt | require_approval, at any amount |
| P6_DEAD_INSTRUMENT | the original instrument can no longer receive funds | require_approval |
| P7_NO_DUPLICATE_REMEDY | an identical effect executed within ${POLICY.effectDedupeHours}h | **deny** |
| P8_CIRCUIT_BREAKER | blast-radius limits reached | **deny** |
| P9_ORDER_STATE | order cancelled, or already refunded in full | **deny** |

Any \`deny\` wins; otherwise any \`require_approval\` wins; otherwise \`allow\`.

## Things this server will never do

- Accept an amount, a quantity or an idempotency key from a model. There is no such field.
- Move money without a server-computed plan bound to a fresh diagnosis and a fresh carrier verification.
- Affect more than one order in a single call. There is no bulk anything.
- Approve its own approval requests. No tool can decide an approval.
- Refund more than was captured, or refund the same effect twice, however the request is phrased.
- Return a raw database document, collection name, or query language to a caller.
- Delete anything. The action log is append-only.
`
}

const RUNBOOK = `# Runbook — delayed, lost and disputed deliveries

## Order of operations

1. **Find the work.** \`ops_list_delayed_shipments\`. Ranked worst-first by severity, money at risk, then age.
2. **Establish what happened.** \`ops_investigate_delivery_exception\`. Read the confidence band before the root cause.
3. **Ask the carrier.** \`ops_verify_carrier_exception\`. Our records cannot separate a lost parcel from a delayed one.
4. **Cost it.** \`ops_preview_refund\`. The server derives the amount from the payment ledger.
5. **Act.** \`ops_issue_refund\` with the plan id.
6. **Confirm.** \`ops_investigate_delivery_exception\` again.

## What each verdict means

**allow** — every condition passed. The refund executes immediately and lands in the audit log.

**require_approval** — a judgment call: over the ceiling, low confidence, a disputed delivery, or a dead
payment instrument. Issuing it queues it for a manager together with the evidence. This is a successful
outcome. Tell the operator it is awaiting approval and move on.

**deny** — a condition no approval could make correct: refunding more than was captured, refunding twice,
or refunding a parcel the carrier has just confirmed is still moving. Do not reshape and retry.

## What to tell the customer

- *Verified lost, refund executed* — "The carrier has confirmed the parcel is lost. Your refund has been issued and will appear in 3-5 business days."
- *Delayed with a revised ETA* — "The carrier has located your parcel and expects delivery by <date>. We will refund without further questions if it misses that date."
- *Disputed delivery* — do not promise an outcome. "We are reviewing the delivery record with the carrier and will come back to you within one working day."

## When the engine says it does not know

A low confidence band with competing hypotheses is a real answer, not a gap. Escalate with the evidence;
do not pick the more plausible-sounding explanation on the engine's behalf.
`
