/**
 * THE SINGLE WRITE PATH.
 *
 * Exactly one function moves money, so there is exactly one surface to reason about
 * and exactly one to test. The manager-approval route re-enters here rather than
 * duplicating the effect, which means a human signature cannot bypass the freshness
 * check or the hard invariants — it only overrides `require_approval`.
 *
 *   1. CLAIM      conditional planned -> claimed. A single-document atomic transition,
 *                 and therefore the mutual-exclusion primitive.
 *   2. DEDUPE     an identical effect executed recently replays instead of repeating.
 *   3. FRESHNESS  the world must not have moved since the plan was minted.
 *   4. POLICY     re-evaluated from a FRESH bundle. Preview is never trusted.
 *   5. EFFECT     the ledger write.
 *   6. COMPLETE   cache the verbatim result so a replay is byte-identical.
 */

import { actionLog, orderEvents, orders, payments } from '@/src/db/collections'
import { POLICY } from '@/src/config/policy'
import { diagnose } from '@/src/domain/diagnose'
import { buildEscalation } from '@/src/domain/escalation'
import { effectFingerprint, stateHash } from '@/src/domain/fingerprint'
import { evaluatePolicy } from '@/src/domain/policy'
import { formatMoney, type ActionLogEntry, type ActionStatus, type EvidenceBundle } from '@/src/domain/types'
import { loadEvidenceBundle } from './evidenceLoader'
import { computeCounters } from './counters'
import { simGatewayRefund } from './simulators'
import type { ActionOutcome, Actor } from './types'

const HOUR = 3_600_000

export const approvalUrlFor = (actionId: string) => `/approvals/${actionId}`

async function transition(id: string, status: ActionStatus, by: string, set: Record<string, unknown> = {}) {
  await (await actionLog()).updateOne(
    { _id: id },
    { $set: { status, ...set }, $push: { transitions: { status, at: new Date(), by } } } as never,
  )
}

/** Cache the outcome verbatim so an idempotent replay reproduces it byte-for-byte. */
async function complete(id: string, status: ActionStatus, by: string, outcome: ActionOutcome, now: Date) {
  await transition(id, status, by, { result: outcome, completedAt: now })
  return outcome
}

export type ExecuteOptions = {
  /** Set when a manager has signed off. Overrides require_approval ONLY. */
  humanApproval?: { by: string; note: string }
}

export async function executeAction(
  planId: string,
  actor: Actor,
  opts: ExecuteOptions = {},
  now = new Date(),
): Promise<ActionOutcome> {
  const log = await actionLog()
  const approving = !!opts.humanApproval
  const claimableFrom: ActionStatus = approving ? 'requires_approval' : 'planned'

  // --- 1. CLAIM -----------------------------------------------------------
  // A human decision is not subject to the 15-minute plan TTL: the manager is
  // reviewing something the engine queued, possibly hours later. Freshness is still
  // enforced at step 3 against live data, which is the check that actually matters.
  const claimFilter = approving
    ? { _id: planId, status: claimableFrom }
    : { _id: planId, status: claimableFrom, expiresAt: { $gt: now } }

  const claimed = await log.findOneAndUpdate(
    claimFilter as never,
    { $set: { status: 'claimed', claimedAt: now }, $push: { transitions: { status: 'claimed', at: now, by: actor.label } } } as never,
    { returnDocument: 'after' },
  )

  if (!claimed) return classifyFailedClaim(await log.findOne({ _id: planId }), planId, now, approving)

  const plan = claimed as unknown as ActionLogEntry
  const by = opts.humanApproval?.by ?? actor.label

  // --- 2. SEMANTIC DEDUPE -------------------------------------------------
  // The control for the one failure plan-level idempotency cannot catch: the agent
  // hits STALE_PLAN, re-previews, and executes a second plan with an identical effect.
  // Two plan ids, one refund. Deliberately NOT a unique index — a genuinely FAILED
  // action must stay retryable with a fresh plan.
  const twin = await log.findOne({
    _id: { $ne: planId },
    effectFingerprint: plan.effectFingerprint,
    status: 'executed',
    completedAt: { $gte: new Date(now.getTime() - POLICY.effectDedupeHours * HOUR) },
  })
  if (twin?.result) {
    const replay = { ...(twin.result as ActionOutcome), replayed: true, actionId: plan._id }
    return complete(planId, 'executed', by, replay, now)
  }

  // --- 3. FRESHNESS -------------------------------------------------------
  const bundle = await loadEvidenceBundle(plan.orderId, now)
  const fresh = stateHash(bundle)
  if (fresh !== plan.stateHash) {
    const outcome: ActionOutcome = {
      actionId: planId,
      status: 'failed',
      replayed: false,
      isError: true,
      effectSummary: 'Nothing was written.',
      error: {
        code: 'STALE_PLAN',
        message: `${describeDrift(bundle, plan)} The plan was built against a different state and is no longer safe to execute.`,
        recovery: `ops_preview_refund(order_ref: "${plan.orderId}")`,
      },
    }
    return complete(planId, 'failed', by, outcome, now)
  }

  // --- 4. POLICY, RE-EVALUATED FROM LIVE DATA -----------------------------
  const diagnosis = diagnose(bundle)
  const computed = plan.computed!
  const fingerprint = effectFingerprint('refund', bundle.order._id, computed)
  const counters = await computeCounters(bundle, actor.label, fingerprint, now)
  const verdict = evaluatePolicy({ bundle, effect: computed, diagnosis, actor, counters })

  const policyBlock = {
    decision: verdict.decision,
    rules: verdict.rules,
    guidance: verdict.guidance,
    doNotRetry: verdict.doNotRetry,
  }

  if (verdict.decision === 'deny') {
    // A denial is NOT an error. Returning it as one would train the model to reshape
    // the request and retry until something slipped through.
    const outcome: ActionOutcome = {
      actionId: planId,
      status: 'denied',
      replayed: false,
      isError: false,
      effectSummary: 'No money moved. Policy refused this remedy.',
      policy: policyBlock,
      computed,
    }
    return complete(planId, 'denied', by, outcome, now)
  }

  if (verdict.decision === 'require_approval' && !approving) {
    const escalation = buildEscalation(bundle, computed, diagnosis, verdict)
    const outcome: ActionOutcome = {
      actionId: planId,
      status: 'requires_approval',
      replayed: false,
      isError: false,
      effectSummary: `No money moved. Queued for manager approval: ${formatMoney(computed.amount)}.`,
      policy: policyBlock,
      approval: {
        reason: escalation.reason,
        summaryMd: escalation.summaryMd,
        approvalUrl: approvalUrlFor(planId),
        recommendedAction: escalation.recommendedAction,
      },
      computed,
      next: `Report to the operator that ${bundle.order.orderNumber} is awaiting approval at ${approvalUrlFor(planId)}, then continue with the next order.`,
    }
    // The escalation lives on the SAME document. The action log is simultaneously the
    // plan store, the idempotency ledger, the approval queue and the audit trail.
    await (await actionLog()).updateOne(
      { _id: planId },
      { $set: { approval: { reason: escalation.reason } } } as never,
    )
    return complete(planId, 'requires_approval', by, outcome, now)
  }

  // A human signature overrides require_approval and nothing else. Every `deny` above
  // still stands, which is why the approval route re-enters this function rather than
  // calling the effect directly.

  // --- 5. EFFECT ----------------------------------------------------------
  const original = bundle.payment!.transactions.find(t => t.txnId === computed.targetTxnId)!
  const gateway = simGatewayRefund(planId, computed.amount, original.gatewayRef)
  const txnId = `TXN-${planId}`

  // Single-document atomic $push, guarded so the same plan can never append twice even
  // if the claim were somehow bypassed. The money is written FIRST and the ledger is
  // authoritative; everything after this is derived and self-healing.
  await (await payments()).updateOne(
    { _id: computed.targetPaymentId, 'transactions.txnId': { $ne: txnId } } as never,
    {
      $push: {
        transactions: {
          txnId,
          kind: 'refund',
          status: 'succeeded',
          amount: computed.amount,
          at: now,
          gatewayRef: gateway.gatewayRef,
          gatewayCode: gateway.gatewayCode,
          gatewayMessage: gateway.gatewayMessage,
          actionId: planId,
        },
      },
    } as never,
  )

  const outcome: ActionOutcome = {
    actionId: planId,
    status: 'executed',
    replayed: false,
    isError: false,
    effectSummary: `Refunded ${formatMoney(computed.amount)} to ${bundle.order.customer.name} for ${bundle.order.orderNumber}.`,
    policy: policyBlock,
    computed,
    next: `Confirm with ops_investigate_delivery_exception(order_ref: "${bundle.order._id}") — the refund should now appear in the timeline.`,
  }

  // --- 6. COMPLETE (audit truth, written before the derived records) ------
  await complete(planId, 'executed', by, outcome, now)

  // Derived records. If the process died here the ledger would still be correct, which
  // is the whole reason nothing is denormalised.
  const refundedAfter = computed.alreadyRefunded.minor + computed.amount.minor
  await (await orderEvents()).insertOne({
    _id: `EVT-${planId}`,
    orderId: bundle.order._id,
    at: now,
    type: 'refund_succeeded',
    source: 'ops-copilot',
    summary: `Refunded ${formatMoney(computed.amount)}${opts.humanApproval ? ` (approved by ${opts.humanApproval.by})` : ' (auto-approved within policy)'}.`,
    data: { actionId: planId, gatewayRef: gateway.gatewayRef },
    actionId: planId,
  } as never)

  await (await orders()).updateOne(
    { _id: bundle.order._id },
    {
      $set: {
        updatedAt: now,
        ...(refundedAfter >= computed.capturedTotal.minor ? { status: 'refunded' as const } : {}),
      },
    } as never,
  )

  return outcome
}

/** Turn a lost claim race into a specific, actionable answer. */
function classifyFailedClaim(
  doc: ActionLogEntry | null,
  planId: string,
  now: Date,
  approving: boolean,
): ActionOutcome {
  const base = { actionId: planId, replayed: false, effectSummary: 'Nothing was written.' }

  if (!doc) {
    return {
      ...base,
      status: 'failed',
      isError: true,
      error: {
        code: 'PLAN_NOT_FOUND',
        message: `No plan "${planId}" exists. Plan ids are minted by the server and cannot be constructed.`,
        recovery: 'ops_preview_refund(order_ref: "<the order>")',
      },
    }
  }

  // Already done: replay the cached response byte-for-byte. Explicitly NOT an error —
  // an error here would invite a fresh plan and a second refund.
  if (doc.status === 'executed' && doc.result) {
    return { ...(doc.result as ActionOutcome), replayed: true }
  }
  if ((doc.status === 'denied' || doc.status === 'requires_approval' || doc.status === 'rejected') && doc.result) {
    return { ...(doc.result as ActionOutcome), replayed: true }
  }

  if (doc.status === 'claimed') {
    return {
      ...base,
      status: 'claimed',
      isError: true,
      error: {
        code: 'IN_FLIGHT',
        // Distinct and retryable on purpose. A generic failure here would make the
        // model re-preview and double-refund.
        message: 'This exact plan is already executing in another request.',
        recovery: `Wait, then call ops_issue_refund(plan_id: "${planId}") again — it will replay the result, not refund twice.`,
        retryAfterMs: 1500,
      },
    }
  }

  if (doc.expiresAt <= now && !approving) {
    return {
      ...base,
      status: 'failed',
      isError: true,
      error: {
        code: 'PLAN_EXPIRED',
        message: `Plan ${planId} expired at ${doc.expiresAt.toISOString()}. Plans are single-use and live ${POLICY.planTtlMinutes} minutes.`,
        recovery: `ops_preview_refund(order_ref: "${doc.orderId}")`,
      },
    }
  }

  return {
    ...base,
    status: doc.status,
    isError: true,
    error: {
      code: 'PLAN_ALREADY_CONSUMED',
      message: `Plan ${planId} is in state "${doc.status}" and cannot be executed.`,
      recovery: `ops_preview_refund(order_ref: "${doc.orderId}")`,
    },
  }
}

/** Name what changed, so the agent knows why it must re-investigate rather than retry. */
function describeDrift(b: EvidenceBundle, plan: ActionLogEntry): string {
  const bits: string[] = []
  const refunded = (b.payment?.transactions ?? []).filter(t => t.kind === 'refund' && t.status === 'succeeded')
  if (refunded.length) bits.push(`${refunded.length} settled refund(s) now on the payment record`)
  const s = b.shipments[0]
  if (s) bits.push(`shipment status is "${s.status}"`)
  if (s?.carrierVerification) bits.push(`carrier verification is ${s.carrierVerification.status}`)
  return `Order ${plan.orderId} changed after this plan was created (${bits.join('; ')}).`
}
