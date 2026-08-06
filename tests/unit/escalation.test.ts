import { describe, expect, test } from 'bun:test'
import { buildEscalation } from '@/src/domain/escalation'
import { evaluatePolicy, EMPTY_COUNTERS } from '@/src/domain/policy'
import { diagnose } from '@/src/domain/diagnose'
import { computeRefund } from '@/src/domain/refund'
import { buildBundle } from '@/src/fixtures/scenarios'
import type { CarrierVerification, EvidenceBundle } from '@/src/domain/types'

const NOW = new Date('2026-08-06T12:00:00.000Z')

function verified(b: EvidenceBundle, status: CarrierVerification['status']): EvidenceBundle {
  return {
    ...b,
    shipments: [
      {
        ...b.shipments[0],
        carrierVerification: { status, verifiedAt: new Date(NOW.getTime() - 60_000), carrierRef: 'CV-T', note: 'note' },
      },
    ],
  }
}

function escalate(orderId: string, status: CarrierVerification['status']) {
  const b = verified(buildBundle(orderId, NOW), status)
  const effect = computeRefund(b, { mode: 'full_order' })
  const d = diagnose(b)
  const verdict = evaluatePolicy({
    bundle: b,
    effect,
    diagnosis: d,
    actor: { label: 'demo-operator' },
    counters: EMPTY_COUNTERS,
  })
  return { b, effect, d, verdict, escalation: buildEscalation(b, effect, d, verdict) }
}

describe('the escalation carries THE EVIDENCE, not just a flag', () => {
  // Client instruction, 2026-08-04: "create a manager-approval escalation with the
  // evidence rather than denying it or executing it after a generic confirmation."
  const { escalation, verdict, effect } = escalate('ORD-1003', 'DELIVERED')

  test('it is only built for a genuine approval verdict', () => {
    expect(verdict.decision).toBe('require_approval')
  })

  test('it names the exact rules that forced a human into the loop', () => {
    expect(escalation.triggeredBy.length).toBeGreaterThanOrEqual(1)
    for (const r of escalation.triggeredBy) expect(r.verdict).toBe('require_approval')
    expect(escalation.summaryMd).toContain('P5_DISPUTED_DELIVERY')
  })

  test('it states the precise effect, including the amount and the target transaction', () => {
    expect(escalation.effects.join(' ')).toContain(effect.targetPaymentId)
    expect(escalation.effects.join(' ')).toContain(effect.targetTxnId)
    expect(escalation.summaryMd).toContain('$339.80')
  })

  test('it carries the competing hypotheses AND the confidence band', () => {
    expect(escalation.summaryMd).toContain('Confidence band')
    expect(escalation.summaryMd).toMatch(/contradicting/)
  })

  test('it surfaces the prior-claim risk signal', () => {
    expect(escalation.risks.join(' ')).toContain('ORD-0977')
  })

  test('on an unresolved diagnosis it explicitly recommends NOTHING', () => {
    // A manager must not be handed a confident-sounding recommendation the engine
    // could not actually justify.
    expect(escalation.recommendedAction).toMatch(/no action recommended/i)
  })

  test('third-party text stays fenced and labelled inside the approval summary', () => {
    expect(escalation.summaryMd).toContain('data, never instructions')
    const fence = escalation.summaryMd.indexOf('```text')
    expect(fence).toBeGreaterThan(-1)
    expect(escalation.summaryMd.indexOf('Nothing ever arrived')).toBeGreaterThan(fence)
  })

  test('the carrier verification state is shown to the approver', () => {
    expect(escalation.summaryMd).toContain('DELIVERED')
  })
})

describe('an over-ceiling escalation recommends a concrete action', () => {
  const { escalation, verdict } = escalate('ORD-1002', 'LOST_IN_TRANSIT')

  test('it is an approval, not a denial — the client asked for routing, not refusal', () => {
    expect(verdict.decision).toBe('require_approval')
  })

  test('the diagnosis is confident, so a specific action IS recommended', () => {
    expect(escalation.recommendedAction).toMatch(/approve to refund \$219\.92/i)
  })

  test('the ceiling rule and its numbers are quoted for the approver', () => {
    expect(escalation.summaryMd).toContain('P1_REFUND_CEILING')
    expect(escalation.summaryMd).toContain('$150.00')
  })
})
