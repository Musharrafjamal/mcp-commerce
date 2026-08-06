import { createHash } from 'node:crypto'
import type { ComputedRefund, EvidenceBundle } from './types'
import { primaryShipment } from './evidence'

const sha = (parts: (string | number)[]) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)

/**
 * A hash of everything a refund decision depended on.
 *
 * Stored on the plan at preview and recomputed from a fresh read at execute. A
 * mismatch means the world moved underneath the plan — the parcel was delivered, a
 * refund settled, the carrier changed its mind — and the plan must not execute.
 *
 * Deliberately wider than `order.updatedAt`: the drift that matters here lives in the
 * payment ledger, the shipment status and the carrier verification, none of which
 * touch the order document.
 */
export function stateHash(b: EvidenceBundle): string {
  const s = primaryShipment(b)
  const txns = b.payment?.transactions ?? []
  return sha([
    b.order._id,
    b.order.status,
    b.order.updatedAt.getTime(),
    txns.length,
    // Amounts too, not just the count: a failed refund flipping to settled changes
    // nothing about the length of the array but everything about what is owed.
    txns.map(t => `${t.txnId}:${t.status}:${t.amount.minor}`).join(','),
    s?.status ?? 'none',
    s?.lastScanAt?.getTime() ?? 0,
    s?.carrierVerification?.status ?? 'unverified',
    s?.carrierVerification?.verifiedAt.getTime() ?? 0,
  ])
}

/**
 * Identifies an effect by what it DOES, not by which plan proposed it.
 *
 * This is the control for the one failure plan-level idempotency cannot catch: the
 * agent hits STALE_PLAN, dutifully re-previews, and executes a second, differently
 * identified plan with an identical effect. Two plan ids, one refund.
 */
export function effectFingerprint(action: string, orderId: string, effect: ComputedRefund): string {
  return sha([
    action,
    orderId,
    effect.targetPaymentId,
    effect.targetTxnId,
    effect.amount.minor,
    [...effect.lineIds].sort().join(','),
  ])
}
