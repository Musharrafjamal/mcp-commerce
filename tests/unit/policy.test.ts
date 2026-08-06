import { describe, expect, test } from 'bun:test'
import { EMPTY_COUNTERS, evaluatePolicy, type PolicyCounters, type PolicyInput } from '@/src/domain/policy'
import { diagnose } from '@/src/domain/diagnose'
import { computeRefund } from '@/src/domain/refund'
import { buildBundle } from '@/src/fixtures/scenarios'
import { POLICY } from '@/src/config/policy'
import { usd, type CarrierVerification, type EvidenceBundle, type RuleResult } from '@/src/domain/types'

const NOW = new Date('2026-08-06T12:00:00.000Z')

/** Attach a fresh carrier verification, as ops_verify_carrier_exception would. */
function verified(b: EvidenceBundle, status: CarrierVerification['status'] = 'LOST_IN_TRANSIT'): EvidenceBundle {
  return {
    ...b,
    shipments: [
      {
        ...b.shipments[0],
        carrierVerification: {
          status,
          verifiedAt: new Date(NOW.getTime() - 60_000),
          carrierRef: 'CV-TEST',
          note: 'test verification',
        },
      },
    ],
  }
}

/** Override the captured amount so boundary maths can be stated exactly. */
function withCapture(b: EvidenceBundle, capturedMinor: number, refundedMinor = 0): EvidenceBundle {
  const txns = [
    {
      txnId: 'TXN-T-C',
      kind: 'capture' as const,
      status: 'succeeded' as const,
      amount: usd(capturedMinor),
      at: new Date(NOW.getTime() - 10 * 86_400_000),
      gatewayRef: 'ch_test',
      gatewayCode: 'approved' as const,
    },
  ]
  if (refundedMinor > 0) {
    txns.push({
      txnId: 'TXN-T-R',
      kind: 'refund' as never,
      status: 'succeeded' as const,
      amount: usd(refundedMinor),
      at: new Date(NOW.getTime() - 3_600_000),
      gatewayRef: 're_test',
      gatewayCode: 'approved' as const,
    })
  }
  return { ...b, payment: { ...b.payment!, transactions: txns } }
}

function policyFor(b: EvidenceBundle, counters: Partial<PolicyCounters> = {}): PolicyInput {
  return {
    bundle: b,
    effect: computeRefund(b, { mode: 'full_order' }),
    diagnosis: diagnose(b),
    actor: { label: 'demo-operator' },
    counters: { ...EMPTY_COUNTERS, ...counters },
  }
}

const ruleFor = (rules: RuleResult[], id: string): RuleResult => {
  const r = rules.find(x => x.id === id)
  if (!r) throw new Error(`policy did not report rule ${id}`)
  return r
}

describe('U4 — the auto-approval ceiling, on both sides of the boundary', () => {
  const base = verified(buildBundle('ORD-1001', NOW))

  test(`exactly at the ceiling (${POLICY.refundCeilingMinor}) is allowed`, () => {
    const v = evaluatePolicy(policyFor(withCapture(base, POLICY.refundCeilingMinor)))
    expect(ruleFor(v.rules, 'P1_REFUND_CEILING').verdict).toBe('allow')
    expect(v.decision).toBe('allow')
  })

  test('one minor unit over the ceiling requires approval', () => {
    const v = evaluatePolicy(policyFor(withCapture(base, POLICY.refundCeilingMinor + 1)))
    expect(ruleFor(v.rules, 'P1_REFUND_CEILING').verdict).toBe('require_approval')
    expect(v.decision).toBe('require_approval')
  })

  test('the rolling window closes the binary-search hole', () => {
    // $120 already refunded on this order today; a further $60 is individually under
    // the ceiling but takes the 24h total past it. Without the window an agent refused
    // a large refund could simply split it into two small ones.
    const b = withCapture(base, 30_000, 0)
    const v = evaluatePolicy(policyFor(b, { refundedInWindowMinor: 12_000 }))
    expect(ruleFor(v.rules, 'P1_REFUND_CEILING').verdict).toBe('require_approval')
    expect(ruleFor(v.rules, 'P1_REFUND_CEILING').detail).toContain('already refunded')
  })
})

describe('U5 — the hard invariant: never refund more than was captured', () => {
  const base = verified(buildBundle('ORD-1001', NOW))

  test('refunding exactly the remaining balance is allowed', () => {
    // 10000 captured, 4000 already refunded, so 6000 remains and is refundable.
    const v = evaluatePolicy(policyFor(withCapture(base, 10_000, 4_000)))
    expect(ruleFor(v.rules, 'P2_REFUND_LE_CAPTURED').verdict).toBe('allow')
  })

  test('one minor unit beyond the captured total is DENIED, never escalated', () => {
    // Constructed directly: computeRefund caps at the remaining balance by design, so
    // the only way to reach P2 is to hand it an effect that overshoots. This is the
    // guard for a future caller that does not go through computeRefund.
    const b = withCapture(base, 10_000, 4_000)
    const input = policyFor(b)
    const overshoot = {
      ...input,
      effect: { ...input.effect, amount: usd(6_001) },
    }
    const v = evaluatePolicy(overshoot)
    expect(ruleFor(v.rules, 'P2_REFUND_LE_CAPTURED').verdict).toBe('deny')
    expect(v.decision).toBe('deny')
    // No manager can authorise refunding money that was never taken.
    expect(v.decision).not.toBe('require_approval')
  })
})

describe('U6 — the disputed-delivery rule is not amount-driven', () => {
  test('a $5 disputed delivery still requires approval', () => {
    const b = withCapture(verified(buildBundle('ORD-1003', NOW), 'DELIVERED'), 500)
    const v = evaluatePolicy(policyFor(b))
    expect(ruleFor(v.rules, 'P1_REFUND_CEILING').verdict).toBe('allow') // well under the ceiling
    expect(ruleFor(v.rules, 'P5_DISPUTED_DELIVERY').verdict).toBe('require_approval')
    expect(v.decision).toBe('require_approval')
  })

  test('the prior-claim history is surfaced to the approver', () => {
    const b = verified(buildBundle('ORD-1003', NOW), 'DELIVERED')
    const v = evaluatePolicy(policyFor(b))
    expect(ruleFor(v.rules, 'P5_DISPUTED_DELIVERY').detail).toContain('earlier non-receipt claim')
  })
})

describe('U7 — policy carries domain knowledge, not just arithmetic', () => {
  test('a dead payment instrument requires approval regardless of amount', () => {
    const b = verified(buildBundle('ORD-1005', NOW))
    const v = evaluatePolicy(policyFor(b))
    expect(ruleFor(v.rules, 'P1_REFUND_CEILING').verdict).toBe('allow') // $121.64, under $150
    expect(ruleFor(v.rules, 'P6_DEAD_INSTRUMENT').verdict).toBe('require_approval')
    expect(ruleFor(v.rules, 'P6_DEAD_INSTRUMENT').detail).toContain('source_account_closed')
    expect(v.approvalReason).toContain('alternate disbursement')
  })
})

describe('U8 — a refusal is not an error, and never invites a reshaped retry', () => {
  test('deny carries doNotRetry and explicit guidance against retrying smaller', () => {
    const v = evaluatePolicy(policyFor(buildBundle('ORD-1006', NOW))) // unverified -> P3 deny
    expect(v.decision).toBe('deny')
    expect(v.doNotRetry).toBe(true)
    expect(v.guidance).toContain('Do not retry with a smaller amount')
    expect(v.guidance.length).toBeGreaterThan(40)
  })

  test('require_approval does NOT set doNotRetry — it is a successful queueing', () => {
    const b = withCapture(verified(buildBundle('ORD-1001', NOW)), POLICY.refundCeilingMinor + 5_000)
    const v = evaluatePolicy(policyFor(b))
    expect(v.decision).toBe('require_approval')
    expect(v.doNotRetry).toBe(false)
    expect(v.approvalReason).toBeTruthy()
  })

  test('every rule reports a verdict and a human-readable reason, including the passing ones', () => {
    const v = evaluatePolicy(policyFor(verified(buildBundle('ORD-1001', NOW))))
    expect(v.rules.length).toBe(9)
    for (const r of v.rules) {
      expect(['allow', 'deny', 'require_approval']).toContain(r.verdict)
      expect(r.detail.length).toBeGreaterThan(10)
    }
  })
})

describe('U11b — the verification precondition is enforced by policy, not just diagnosis', () => {
  test('no verification on file -> deny, with the exact recovery call named', () => {
    const v = evaluatePolicy(policyFor(buildBundle('ORD-1001', NOW)))
    expect(ruleFor(v.rules, 'P3_CARRIER_VERIFIED').verdict).toBe('deny')
    expect(ruleFor(v.rules, 'P3_CARRIER_VERIFIED').detail).toContain('ops_verify_carrier_exception')
  })

  test('a stale verification does not satisfy the precondition', () => {
    const b = buildBundle('ORD-1001', NOW)
    const stale: EvidenceBundle = {
      ...b,
      shipments: [
        {
          ...b.shipments[0],
          carrierVerification: {
            status: 'LOST_IN_TRANSIT',
            verifiedAt: new Date(NOW.getTime() - (POLICY.verificationFreshnessHours + 1) * 3_600_000),
            carrierRef: 'CV-OLD',
            note: 'stale',
          },
        },
      ],
    }
    const v = evaluatePolicy(policyFor(stale))
    expect(ruleFor(v.rules, 'P3_CARRIER_VERIFIED').verdict).toBe('deny')
    expect(ruleFor(v.rules, 'P3_CARRIER_VERIFIED').detail).toContain('older than')
  })

  test('IN_TRANSIT -> deny as premature; the same order verified LOST -> allow', () => {
    const premature = evaluatePolicy(policyFor(verified(buildBundle('ORD-1006', NOW), 'IN_TRANSIT')))
    expect(premature.decision).toBe('deny')
    expect(ruleFor(premature.rules, 'P3_CARRIER_VERIFIED').detail).toContain('premature')

    const lost = evaluatePolicy(policyFor(verified(buildBundle('ORD-1006', NOW), 'LOST_IN_TRANSIT')))
    expect(lost.decision).toBe('allow')
  })
})

describe('blast-radius limits are counted from the ledger, not from memory', () => {
  const b = verified(buildBundle('ORD-1001', NOW))

  test('too many refunds by one actor in ten minutes halts', () => {
    const v = evaluatePolicy(policyFor(b, { executedByActorLast10Min: 3 }))
    expect(ruleFor(v.rules, 'P8_CIRCUIT_BREAKER').verdict).toBe('deny')
    expect(v.decision).toBe('deny')
  })

  test('an identical effect already executed is denied as a duplicate', () => {
    const v = evaluatePolicy(policyFor(b, { duplicateEffectExecutedRecently: true }))
    expect(ruleFor(v.rules, 'P7_NO_DUPLICATE_REMEDY').verdict).toBe('deny')
  })

  test('the 24h auto-approved cap halts before it is breached', () => {
    const v = evaluatePolicy(policyFor(b, { autoApprovedMinorLast24h: POLICY.circuitBreaker.maxAutoApprovedMinorPer24h }))
    expect(ruleFor(v.rules, 'P8_CIRCUIT_BREAKER').verdict).toBe('deny')
  })
})

describe('the seeded scenarios reach the verdicts the manifest promises', () => {
  const cases: [string, 'allow' | 'deny' | 'require_approval', CarrierVerification['status']][] = [
    ['ORD-1007', 'allow', 'LOST_IN_TRANSIT'],
    ['ORD-1001', 'allow', 'LOST_IN_TRANSIT'],
    ['ORD-1002', 'require_approval', 'LOST_IN_TRANSIT'],
    ['ORD-1006', 'deny', 'IN_TRANSIT'],
    ['ORD-1003', 'require_approval', 'DELIVERED'],
    ['ORD-1005', 'require_approval', 'LOST_IN_TRANSIT'],
  ]

  for (const [id, expected, status] of cases) {
    test(`${id} -> ${expected}`, () => {
      expect(evaluatePolicy(policyFor(verified(buildBundle(id, NOW), status))).decision).toBe(expected)
    })
  }

  test('ORD-1004 cannot even be costed — there is nothing left to refund', () => {
    // The order still says "open" but the ledger is fully refunded. computeRefund
    // refuses before policy is ever consulted, which is the earliest possible failure.
    expect(() => computeRefund(verified(buildBundle('ORD-1004', NOW)), { mode: 'full_order' })).toThrow(
      /nothing left to refund/i,
    )
  })
})
