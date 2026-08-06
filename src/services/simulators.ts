/**
 * Stand-ins for the two external systems this workflow depends on.
 *
 * Both are deterministic and in-process. They are MOCKS OF EXTERNAL SYSTEMS, not
 * advisory no-ops: everything on our side of the boundary — the ledger write, the
 * idempotency claim, the audit record — is real. Swapping these for a real PSP and a
 * real carrier API is a change to two files.
 */

import { createHash } from 'node:crypto'
import type { CarrierVerification, Money, Shipment } from '@/src/domain/types'

const HOUR = 3_600_000

/** Deterministic gateway reference, so an idempotent replay reproduces byte-for-byte. */
const refFor = (prefix: string, seed: string) =>
  `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 18)}`

export type GatewayRefundResult = {
  ok: true
  gatewayRef: string
  gatewayCode: 'approved'
  gatewayMessage: string
}

/**
 * Issue a refund against the payment gateway.
 *
 * Keyed on the plan id rather than a clock, so calling it twice with the same plan
 * yields an identical result. It cannot fail here by design: the failure modes that
 * matter (dead instrument, over-capture) are caught by policy before execution, so a
 * random gateway error would only add noise the workflow has no way to act on.
 */
export function simGatewayRefund(planId: string, amount: Money, originalRef: string): GatewayRefundResult {
  return {
    ok: true,
    gatewayRef: refFor('re', `${planId}:${originalRef}:${amount.minor}`),
    gatewayCode: 'approved',
    gatewayMessage: `Refunded ${(amount.minor / 100).toFixed(2)} ${amount.currency}.`,
  }
}

/**
 * Ask the carrier's system of record what actually happened to a parcel.
 *
 * Reads `shipment.simCarrierTruth`, which the seed plants and nothing else ever
 * touches — no detector, no diagnosis rule, no policy rule, and it is never returned
 * to the agent. The only route from that field to a decision is through this call,
 * which is the point: the carrier's answer has to be fetched, not assumed.
 */
export function simCarrierVerify(shipment: Shipment, now = new Date()): CarrierVerification {
  const truth = shipment.simCarrierTruth
  return {
    status: truth.status,
    verifiedAt: now,
    carrierRef: refFor('cv', `${shipment.trackingNumber}:${truth.status}`),
    revisedEta:
      truth.revisedEtaDays !== undefined
        ? new Date(now.getTime() - truth.revisedEtaDays * 24 * HOUR)
        : undefined,
    note: truth.note,
  }
}

export const VERIFICATION_TTL_HOURS = 24
