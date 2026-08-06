import { describe, expect, test } from 'bun:test'
import { detect, rankExceptions } from '@/src/domain/detect'
import { ALL_SCENARIOS, buildBundle } from '@/src/fixtures/scenarios'

// Pin time so a fixture's "9-day scan gap" is exactly that, every run.
const NOW = new Date('2026-08-06T12:00:00.000Z')

describe('U1 — detection is real and discriminating', () => {
  const all = ALL_SCENARIOS()

  test('every scenario produces exactly the exception it is supposed to', () => {
    const actual = all.map(s => [s.id, detect(buildBundle(s.id, NOW))?.exceptionCode ?? null] as const)
    const expected = all.map(s => [s.id, s.expectDetected] as const)
    expect(actual).toEqual(expected)
  })

  test('the two near-miss orders are NOT flagged', () => {
    // ORD-1021: silent for 4 days, but inside SLA and the promise date has not passed.
    // ORD-1022: delivered on time, no complaint.
    // A detector that fires on 100% of a dataset proves nothing; these prove it is a rule.
    expect(detect(buildBundle('ORD-1021', NOW))).toBeNull()
    expect(detect(buildBundle('ORD-1022', NOW))).toBeNull()
  })

  test('a closed order is not an open operational problem', () => {
    // ORD-0977 is delivered + disputed + refunded. It exists only as the prior-claim
    // signal on ORD-1003 and must never appear in a queue.
    expect(detect(buildBundle('ORD-0977', NOW))).toBeNull()
  })

  test('none of the 18 healthy filler orders is flagged', () => {
    const filler = all.filter(s => s.expect === 'healthy')
    expect(filler.length).toBe(18)
    expect(filler.filter(s => detect(buildBundle(s.id, NOW)) !== null)).toEqual([])
  })

  test('detects 7 of 28 orders — the detectors filter', () => {
    const hits = all.map(s => detect(buildBundle(s.id, NOW))).filter(Boolean)
    expect(all.length).toBe(28)
    expect(hits.length).toBe(7)
  })

  test('a stale order status does not hide a real exception', () => {
    // ORD-1004 was refunded by hand but nobody updated the order. The storefront still
    // says "open", so it correctly shows up in the queue — and policy will refuse it.
    const b = buildBundle('ORD-1004', NOW)
    expect(b.order.status).toBe('open')
    expect(detect(b)?.exceptionCode).toBe('CARRIER_SCAN_GAP')
  })

  test('ranking puts the most severe, highest-value exception first', () => {
    const hits = ALL_SCENARIOS()
      .map(s => detect(buildBundle(s.id, NOW)))
      .filter((x): x is NonNullable<typeof x> => x !== null)
    const ranked = rankExceptions(hits)
    expect(ranked[0].orderId).toBe('ORD-1003') // critical, $339.80 at risk
    expect(ranked.length).toBe(hits.length)
  })
})
