import { describe, expect, test } from 'bun:test'
import { diagnose } from '@/src/domain/diagnose'
import { buildBundle } from '@/src/fixtures/scenarios'
import type { CarrierVerification, EvidenceBundle } from '@/src/domain/types'

const NOW = new Date('2026-08-06T12:00:00.000Z')

/** Attach a carrier verification, as ops_verify_carrier_exception would. */
function withVerification(b: EvidenceBundle, v: Partial<CarrierVerification>): EvidenceBundle {
  const shipment = {
    ...b.shipments[0],
    carrierVerification: {
      status: 'LOST_IN_TRANSIT',
      verifiedAt: new Date(NOW.getTime() - 60_000),
      carrierRef: 'CV-TEST',
      note: 'test',
      ...v,
    } as CarrierVerification,
  }
  return { ...b, shipments: [shipment] }
}

describe('U2 — a confident diagnosis cites real, traceable evidence', () => {
  test('ORD-1001 is diagnosed as lost in transit with high confidence', () => {
    const d = diagnose(buildBundle('ORD-1001', NOW))
    expect(d.rootCauses[0].code).toBe('CARRIER_LOST_IN_TRANSIT')
    expect(d.confidenceBand).toBe('high')
    expect(d.confidence).toBeGreaterThanOrEqual(0.8)
    expect(d.eligibleRemedies).toEqual(['refund'])
  })

  test('every piece of evidence carries a traceable reference and a timestamp', () => {
    const d = diagnose(buildBundle('ORD-1001', NOW))
    for (const cause of d.rootCauses) {
      for (const e of [...cause.evidence, ...cause.contradictingEvidence]) {
        expect(e.ref.length).toBeGreaterThan(0)
        expect(e.at).toBeInstanceOf(Date)
        expect(e.fact.length).toBeGreaterThan(10)
      }
    }
  })
})

describe('U3 — the system can say "I do not know"', () => {
  // The single most important behaviour in the submission. Five scenarios prove the
  // engine can act; this one proves it knows when it cannot.
  const d = diagnose(buildBundle('ORD-1003', NOW))

  test('confidence is low and human judgment is demanded', () => {
    expect(d.confidenceBand).toBe('low')
    expect(d.requiresHumanJudgment).toBe(true)
  })

  test('at least two competing hypotheses survive', () => {
    expect(d.rootCauses.length).toBeGreaterThanOrEqual(2)
  })

  test('each competing hypothesis carries BOTH supporting and contradicting evidence', () => {
    for (const c of d.rootCauses.slice(0, 2)) {
      expect(c.evidence.length).toBeGreaterThanOrEqual(1)
      expect(c.contradictingEvidence.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('no remedy is recommended', () => {
    expect(d.eligibleRemedies).toEqual(['none'])
  })

  test('the prior-claim signal is surfaced for the human, not folded into the ranking', () => {
    expect(d.signals.some(s => s.includes('ORD-0977'))).toBe(true)
  })

  test('the verdict is a function of the evidence, not of the order id', () => {
    // Remove the dispute contact and the ambiguity disappears. If a rule special-cased
    // "ORD-1003" this assertion would fail — which is the point of writing it.
    const b = buildBundle('ORD-1003', NOW)
    const withoutDispute = { ...b, events: b.events.filter(e => e.type !== 'customer_contact') }
    const d2 = diagnose(withoutDispute)
    expect(d2.requiresHumanJudgment).toBe(false)
  })
})

describe('U11 — the carrier verification is load-bearing, not decorative', () => {
  // ORD-1001 and ORD-1006 are INDISTINGUISHABLE from stored data alone: same scan-gap
  // shape, same breached promise date. Only the carrier's answer separates
  // "lost, refund it" from "delayed, refunding now is premature".
  test('unverified: both orders look identically lost', () => {
    const a = diagnose(buildBundle('ORD-1001', NOW))
    const b = diagnose(buildBundle('ORD-1006', NOW))
    expect(a.rootCauses[0].code).toBe('CARRIER_LOST_IN_TRANSIT')
    expect(b.rootCauses[0].code).toBe('CARRIER_LOST_IN_TRANSIT')
    expect(a.confidenceBand).toBe(b.confidenceBand)
  })

  test('verified LOST_IN_TRANSIT: refund becomes the eligible remedy', () => {
    const d = diagnose(withVerification(buildBundle('ORD-1006', NOW), { status: 'LOST_IN_TRANSIT' }))
    expect(d.rootCauses[0].code).toBe('CARRIER_LOST_IN_TRANSIT')
    expect(d.eligibleRemedies).toEqual(['refund'])
  })

  test('verified IN_TRANSIT: the same order flips to "wait", and refund is not eligible', () => {
    const d = diagnose(
      withVerification(buildBundle('ORD-1006', NOW), {
        status: 'IN_TRANSIT',
        revisedEta: new Date(NOW.getTime() + 2 * 86_400_000),
      }),
    )
    expect(d.rootCauses[0].code).toBe('CARRIER_DELAYED_NOT_LOST')
    expect(d.eligibleRemedies).toEqual(['wait_for_revised_eta'])
    expect(d.eligibleRemedies).not.toContain('refund')
  })

  test('an IN_TRANSIT verification is recorded as evidence AGAINST the loss hypothesis', () => {
    const d = diagnose(withVerification(buildBundle('ORD-1006', NOW), { status: 'IN_TRANSIT' }))
    const lost = d.rootCauses.find(c => c.code === 'CARRIER_LOST_IN_TRANSIT')
    expect(lost?.contradictingEvidence.length).toBeGreaterThanOrEqual(1)
  })

  test('with no verification on file, the operator is told one is required', () => {
    const d = diagnose(buildBundle('ORD-1001', NOW))
    expect(d.signals.some(s => s.toLowerCase().includes('no carrier verification'))).toBe(true)
  })
})

describe('the payment ledger outranks the order record', () => {
  test('ORD-1004 is diagnosed as already remediated despite an "open" order status', () => {
    const b = buildBundle('ORD-1004', NOW)
    expect(b.order.status).toBe('open') // the storefront is wrong
    const d = diagnose(b)
    expect(d.rootCauses[0].code).toBe('ALREADY_REMEDIATED')
    expect(d.eligibleRemedies).toEqual(['none'])
    expect(d.rootCauses[0].evidence.some(e => e.fact.includes('stale'))).toBe(true)
  })
})
