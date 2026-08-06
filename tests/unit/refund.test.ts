import { describe, expect, test } from 'bun:test'
import { computeRefund } from '@/src/domain/refund'
import { effectFingerprint, stateHash } from '@/src/domain/fingerprint'
import { buildBundle } from '@/src/fixtures/scenarios'
import { usd, type EvidenceBundle } from '@/src/domain/types'

const NOW = new Date('2026-08-06T12:00:00.000Z')

/** Settle a partial refund so the ledger and the order total deliberately disagree. */
function withPartialRefund(b: EvidenceBundle, refundedMinor: number): EvidenceBundle {
  return {
    ...b,
    payment: {
      ...b.payment!,
      transactions: [
        ...b.payment!.transactions,
        {
          txnId: 'TXN-PARTIAL',
          kind: 'refund',
          status: 'succeeded',
          amount: usd(refundedMinor),
          at: new Date(NOW.getTime() - 3_600_000),
          gatewayRef: 're_partial',
          gatewayCode: 'approved',
        },
      ],
    },
  }
}

describe('U9 — the amount is DERIVED from the ledger, never read off the order', () => {
  test('a full-order refund equals captured minus settled refunds, not the order total', () => {
    const b = buildBundle('ORD-1001', NOW)
    const grandTotal = b.order.totals.grandTotal.minor
    const partial = withPartialRefund(b, 2_000)

    const c = computeRefund(partial, { mode: 'full_order' })

    expect(c.amount.minor).toBe(grandTotal - 2_000)
    // The distinction that matters: reading order.totals.grandTotal here would
    // double-refund the $20 that has already gone back to the customer.
    expect(c.amount.minor).not.toBe(grandTotal)
    expect(c.alreadyRefunded.minor).toBe(2_000)
    expect(c.capturedTotal.minor).toBe(grandTotal)
  })

  test('the refund targets the settled capture transaction, not an arbitrary one', () => {
    const c = computeRefund(buildBundle('ORD-1001', NOW), { mode: 'full_order' })
    expect(c.targetTxnId).toMatch(/-C$/)
    expect(c.targetPaymentId).toBe('PAY-1001')
  })

  test('a line-level refund is capped at what is actually still refundable', () => {
    const b = buildBundle('ORD-1001', NOW)
    const lineId = b.order.lines[0].lineId
    const partial = withPartialRefund(b, b.order.totals.grandTotal.minor - 1_000)

    const c = computeRefund(partial, { mode: 'lines', lineIds: [lineId] })

    // The line is worth more than $10, but only $10 remains. The cap is not optional:
    // without it, refunding "just one line" could exceed the captured total.
    expect(c.amount.minor).toBe(1_000)
    expect(b.order.lines[0].unitPrice.minor).toBeGreaterThan(1_000)
  })

  test('an unknown line id is rejected with the valid ones named', () => {
    const b = buildBundle('ORD-1001', NOW)
    expect(() => computeRefund(b, { mode: 'lines', lineIds: ['ORD-1001-L9'] })).toThrow(/ORD-1001-L1/)
  })

  test('a fully refunded order cannot be costed at all', () => {
    const b = buildBundle('ORD-1004', NOW)
    expect(() => computeRefund(b, { mode: 'full_order' })).toThrow(/nothing left to refund/i)
  })

  test('line ids are normalised so the same request always fingerprints the same', () => {
    const b = buildBundle('ORD-1001', NOW)
    const ids = b.order.lines.map(l => l.lineId)
    const a = computeRefund(b, { mode: 'lines', lineIds: [...ids].reverse() })
    const c = computeRefund(b, { mode: 'lines', lineIds: ids })
    expect(a.lineIds).toEqual(c.lineIds)
  })
})

describe('fingerprints', () => {
  test('an identical effect fingerprints identically, whichever plan proposed it', () => {
    const b = buildBundle('ORD-1001', NOW)
    const one = computeRefund(b, { mode: 'full_order' })
    const two = computeRefund(b, { mode: 'full_order' })
    expect(effectFingerprint('refund', b.order._id, one)).toBe(effectFingerprint('refund', b.order._id, two))
  })

  test('a different amount fingerprints differently', () => {
    const b = buildBundle('ORD-1001', NOW)
    const one = computeRefund(b, { mode: 'full_order' })
    const two = { ...one, amount: usd(one.amount.minor - 1) }
    expect(effectFingerprint('refund', b.order._id, one)).not.toBe(effectFingerprint('refund', b.order._id, two))
  })

  test('the state hash is stable for an unchanged bundle', () => {
    const b = buildBundle('ORD-1001', NOW)
    expect(stateHash(b)).toBe(stateHash(buildBundle('ORD-1001', NOW)))
  })

  test('a settled refund changes the state hash even though the order document did not', () => {
    // The precise drift order.updatedAt would miss. This is why the hash covers the
    // payment ledger, the shipment and the verification, not just the order.
    const b = buildBundle('ORD-1001', NOW)
    expect(stateHash(withPartialRefund(b, 2_000))).not.toBe(stateHash(b))
  })

  test('a new carrier verification changes the state hash', () => {
    const b = buildBundle('ORD-1001', NOW)
    const v: EvidenceBundle = {
      ...b,
      shipments: [
        {
          ...b.shipments[0],
          carrierVerification: {
            status: 'LOST_IN_TRANSIT',
            verifiedAt: NOW,
            carrierRef: 'CV-1',
            note: 'n',
          },
        },
      ],
    }
    expect(stateHash(v)).not.toBe(stateHash(b))
  })

  test('a failed refund flipping to settled changes the hash without changing array length', () => {
    const b = buildBundle('ORD-1005', NOW) // has a failed refund transaction
    const flipped: EvidenceBundle = {
      ...b,
      payment: {
        ...b.payment!,
        transactions: b.payment!.transactions.map(t =>
          t.status === 'failed' ? { ...t, status: 'succeeded' as const } : t,
        ),
      },
    }
    expect(flipped.payment!.transactions.length).toBe(b.payment!.transactions.length)
    expect(stateHash(flipped)).not.toBe(stateHash(b))
  })
})
