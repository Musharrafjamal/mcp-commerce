/**
 * Refund arithmetic.
 *
 * This is the ONLY place in the codebase a refund amount comes into existence. No MCP
 * tool accepts an amount, no adapter computes one, and the agent has no field to put
 * one in. That is what makes "the model cannot refund $9,999" a structural property
 * rather than a promise.
 *
 * The amount is derived from the PAYMENT LEDGER — captures minus settled refunds —
 * never from `order.totals.grandTotal`. The order record can be stale (ORD-1004 proves
 * it); the ledger cannot.
 */

import { formatMoney, usd, type ComputedRefund, type EvidenceBundle, type RefundTarget } from './types'
import { capturedTotal, captureTxn, refundedTotal, remainingRefundable } from './evidence'

export class RefundComputationError extends Error {
  constructor(
    readonly code: 'NO_PAYMENT' | 'NO_CAPTURE' | 'NOTHING_REFUNDABLE' | 'UNKNOWN_LINE',
    message: string,
  ) {
    super(message)
    this.name = 'RefundComputationError'
  }
}

export function computeRefund(b: EvidenceBundle, target: RefundTarget): ComputedRefund {
  if (!b.payment) {
    throw new RefundComputationError('NO_PAYMENT', `Order ${b.order._id} has no payment record to refund against.`)
  }
  const capture = captureTxn(b)
  if (!capture) {
    throw new RefundComputationError(
      'NO_CAPTURE',
      `Order ${b.order._id} has no settled capture. Nothing was ever charged, so there is nothing to refund.`,
    )
  }

  const captured = capturedTotal(b)
  const already = refundedTotal(b)
  const remaining = remainingRefundable(b)

  let requestedMinor: number
  let lineIds: string[]

  if (target.mode === 'full_order') {
    requestedMinor = remaining.minor
    lineIds = b.order.lines.map(l => l.lineId)
  } else {
    const known = new Map(b.order.lines.map(l => [l.lineId, l]))
    const unknown = target.lineIds.filter(id => !known.has(id))
    if (unknown.length) {
      throw new RefundComputationError(
        'UNKNOWN_LINE',
        `Order ${b.order._id} has no line(s) ${unknown.join(', ')}. Valid lines: ${[...known.keys()].join(', ')}.`,
      )
    }
    lineIds = [...target.lineIds].sort()
    // Line subtotals only; shipping and tax are not apportioned per line in this model.
    // Capped at what is actually still refundable — a line total can exceed the
    // remaining balance once a partial refund has already settled.
    requestedMinor = Math.min(
      remaining.minor,
      lineIds.reduce((n, id) => n + known.get(id)!.unitPrice.minor * known.get(id)!.qty, 0),
    )
  }

  if (requestedMinor <= 0) {
    throw new RefundComputationError(
      'NOTHING_REFUNDABLE',
      // Formatted, not raw minor units: this string is read by an agent and quoted to
      // an operator. "6332 minor units" is our storage detail, not their language.
      `Order ${b.order._id} has nothing left to refund — ${formatMoney(already)} of ` +
        `${formatMoney(captured)} captured has already been refunded, whatever the order status says.`,
    )
  }

  return {
    amount: usd(requestedMinor),
    targetPaymentId: b.payment._id,
    targetTxnId: capture.txnId,
    lineIds,
    capturedTotal: captured,
    alreadyRefunded: already,
  }
}
