/**
 * Plan minting and carrier verification.
 *
 * A plan is a server-computed, single-use, state-bound proposal. It is also the
 * idempotency key: the agent never mints one, never names one, and cannot construct
 * one. Write tools accept a plan id and nothing else, so there is no field on any tool
 * into which a hallucinated dollar amount could be placed.
 */

import { randomUUID } from 'node:crypto'
import { actionLog, orderEvents, shipments } from '@/src/db/collections'
import { POLICY } from '@/src/config/policy'
import { diagnose, type Diagnosis } from '@/src/domain/diagnose'
import { effectFingerprint, stateHash } from '@/src/domain/fingerprint'
import { evaluatePolicy, type PolicyVerdict } from '@/src/domain/policy'
import { computeRefund } from '@/src/domain/refund'
import { formatMoney, type ActionLogEntry, type CarrierVerification, type EvidenceBundle, type RefundTarget } from '@/src/domain/types'
import { primaryShipment } from '@/src/domain/evidence'
import { loadEvidenceBundle } from './evidenceLoader'
import { computeCounters } from './counters'
import { simCarrierVerify } from './simulators'
import type { Actor } from './types'

const MINUTE = 60_000

const planId = () => `PLAN-${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`

export type PreviewResult = {
  planId: string
  expiresAt: Date
  executeWith: string
  computed: ReturnType<typeof computeRefund>
  policy: PolicyVerdict
  diagnosis: Diagnosis
  effects: string[]
  bundle: EvidenceBundle
}

/**
 * Compute the exact effect of a proposed refund, evaluate policy, and persist the
 * proposal.
 *
 * The proposal is written to `action_log` even when policy refuses it, which is what
 * makes "every attempt is recorded, including the denied ones" true rather than
 * aspirational. It is also why this operation is annotated `readOnlyHint: false`
 * despite moving no money.
 */
export async function mintPlan(
  orderRef: string,
  target: RefundTarget,
  actor: Actor,
  now = new Date(),
): Promise<PreviewResult> {
  const bundle = await loadEvidenceBundle(orderRef, now)
  const diagnosis = diagnose(bundle)
  const computed = computeRefund(bundle, target) // throws RefundComputationError
  const fingerprint = effectFingerprint('refund', bundle.order._id, computed)
  const counters = await computeCounters(bundle, actor.label, fingerprint, now)
  const policy = evaluatePolicy({ bundle, effect: computed, diagnosis, actor, counters })

  const id = planId()
  const expiresAt = new Date(now.getTime() + POLICY.planTtlMinutes * MINUTE)

  const entry: ActionLogEntry = {
    _id: id,
    mode: 'preview',
    action: 'refund',
    orderId: bundle.order._id,
    input: { orderRef, target },
    computed,
    diagnosisSnapshot: {
      topCauseCode: diagnosis.rootCauses[0]?.code ?? 'NONE',
      confidence: diagnosis.confidence,
      confidenceBand: diagnosis.confidenceBand,
      requiresHumanJudgment: diagnosis.requiresHumanJudgment,
    },
    effectFingerprint: fingerprint,
    stateHash: stateHash(bundle),
    policy: { decision: policy.decision, rules: policy.rules },
    status: 'planned',
    transitions: [{ status: 'planned', at: now, by: actor.label }],
    actor,
    expiresAt,
    createdAt: now,
  }

  await (await actionLog()).insertOne(entry as never)

  const s = primaryShipment(bundle)
  const effects = [
    `Refund ${formatMoney(computed.amount)} against payment ${computed.targetPaymentId} (capture ${computed.targetTxnId}).`,
    `Total refunds on ${bundle.order.orderNumber} would go from ${formatMoney(computed.alreadyRefunded)} to ${formatMoney(
      { minor: computed.alreadyRefunded.minor + computed.amount.minor, currency: 'USD' },
    )} of ${formatMoney(computed.capturedTotal)} captured.`,
    `Lines affected: ${computed.lineIds.join(', ')}.`,
    s ? `Shipment ${s.trackingNumber} is not altered; this is a monetary remedy only.` : 'No shipment on this order.',
  ]

  return { planId: id, expiresAt, executeWith: `ops_issue_refund(plan_id: "${id}")`, computed, policy, diagnosis, effects, bundle }
}

export type VerificationResult = {
  verification: CarrierVerification
  trackingNumber: string
  orderId: string
  /** True when a fresh verification already existed and was reused. */
  reused: boolean
}

/**
 * Ask the carrier what actually happened, and persist the answer.
 *
 * This is the step that separates ORD-1001 from ORD-1006 — two orders that are
 * identical in our own data and opposite in reality. Policy rule P3 refuses any
 * refund without a result from here that is less than 24 hours old.
 */
export async function verifyCarrierException(
  orderRef: string,
  actor: Actor,
  now = new Date(),
): Promise<VerificationResult> {
  const bundle = await loadEvidenceBundle(orderRef, now)
  const shipment = primaryShipment(bundle)
  if (!shipment) {
    throw new Error(
      `Order ${bundle.order._id} has no shipment, so there is no carrier record to verify. ` +
        'This order is not a delivery exception.',
    )
  }

  const verification = simCarrierVerify(shipment, now)

  await (await shipments()).updateOne({ _id: shipment._id }, { $set: { carrierVerification: verification } })

  await (await orderEvents()).insertOne({
    _id: `EVT-${shipment._id}-CV-${now.getTime()}`,
    orderId: bundle.order._id,
    at: now,
    type: 'carrier_verified',
    source: 'ops-copilot',
    summary: `Carrier verification for ${shipment.trackingNumber}: ${verification.status}.`,
    data: { status: verification.status, carrierRef: verification.carrierRef },
  } as never)

  // Verifications are audited too. A refund's authority rests on this call having
  // happened, so it has to be as traceable as the refund itself.
  await (await actionLog()).insertOne({
    _id: `VER-${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`,
    mode: 'verify',
    action: 'verify_carrier',
    orderId: bundle.order._id,
    input: { orderRef, trackingNumber: shipment.trackingNumber },
    status: 'executed',
    transitions: [{ status: 'executed', at: now, by: actor.label }],
    result: verification,
    actor,
    expiresAt: now,
    createdAt: now,
    completedAt: now,
  } as never)

  return { verification, trackingNumber: shipment.trackingNumber, orderId: bundle.order._id, reused: false }
}
