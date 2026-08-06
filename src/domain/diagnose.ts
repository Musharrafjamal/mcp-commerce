/**
 * Diagnosis: ranked root causes with supporting AND contradicting evidence.
 *
 * Five rules, one table-driven shape. Confidence is COMPUTED from a stated formula,
 * never hand-assigned per scenario:
 *
 *     confidence = base x (matched / required) x 0.8 ^ contradicting
 *
 * and the band is forced to 'low' when the top two causes are within
 * POLICY.confidenceTieMargin of each other. A near-tie between two explanations is
 * not knowledge, however high the absolute score.
 *
 * Every rule is a predicate over the EvidenceBundle. No rule may reference an order
 * id — if one did, its own test would fail.
 */

import { POLICY } from '@/src/config/policy'
import {
  captureTxn,
  daysBetween,
  daysSinceLastScan,
  deliveredScan,
  deliveryGeoDriftM,
  deliveryGeoMatches,
  disputeContact,
  hasDeadInstrument,
  isFullyRefunded,
  lastFailedRefund,
  lastScan,
  primaryShipment,
  priorClaimsInWindow,
  promiseBreached,
  refundedTotal,
  verification,
  verificationIsFresh,
} from './evidence'
import { formatMoney, type ConfidenceBand, type Evidence, type EvidenceBundle, type RootCause } from './types'

export type Diagnosis = {
  rootCauses: RootCause[]
  confidence: number
  confidenceBand: ConfidenceBand
  requiresHumanJudgment: boolean
  /** Non-hypothesis facts a human should weigh. Feeds policy, never the ranking. */
  signals: string[]
  eligibleRemedies: ('refund' | 'wait_for_revised_eta' | 'none')[]
}

/**
 * `optional: true` marks corroborating evidence that may simply not exist yet — a
 * carrier verification nobody has requested, for example. Optional facts add a small
 * bonus when present but never divide the score when absent, so a rule is not punished
 * for evidence the operator has not gone and fetched.
 */
type Fact = { when: boolean; ev: Evidence; optional?: boolean }

type Rule = {
  code: string
  label: string
  base: number
  /** Applies at all? If false the rule is not a candidate. */
  applies: (b: EvidenceBundle) => boolean
  supporting: (b: EvidenceBundle) => Fact[]
  contradicting: (b: EvidenceBundle) => Fact[]
}

const ev = (ref: string, at: Date, fact: string): Evidence => ({ ref, at, fact })

const RULES: Rule[] = [
  {
    code: 'CARRIER_LOST_IN_TRANSIT',
    label: 'Parcel lost in the carrier network',
    base: 0.9,
    applies: b => {
      const s = primaryShipment(b)
      return !!s && s.status !== 'delivered'
    },
    supporting: b => {
      const s = primaryShipment(b)!
      const gap = daysSinceLastScan(b) ?? 0
      const scan = lastScan(b)
      return [
        {
          when: gap >= POLICY.scanGapSlaDays,
          ev: ev(
            scan ? `scan@${scan.at.toISOString()}` : s._id,
            scan?.at ?? b.now,
            `No carrier scan in ${Math.floor(gap)} days (SLA is ${POLICY.scanGapSlaDays}); last movement was "${scan?.code ?? 'none'}" at ${scan?.location ?? 'unknown'}.`,
          ),
        },
        {
          when: promiseBreached(b),
          ev: ev(
            s._id,
            s.promisedDeliveryDate,
            `Promised delivery date passed ${Math.floor(daysBetween(b.now, s.promisedDeliveryDate))} days ago with no delivery scan.`,
          ),
        },
        {
          when: verification(b)?.status === 'LOST_IN_TRANSIT',
          optional: true,
          ev: ev(
            `carrier-verification/${s.trackingNumber}`,
            verification(b)?.verifiedAt ?? b.now,
            'Carrier system of record confirms the parcel is lost in transit.',
          ),
        },
      ]
    },
    contradicting: b => {
      const s = primaryShipment(b)!
      return [
        {
          when: verification(b)?.status === 'IN_TRANSIT',
          ev: ev(
            `carrier-verification/${s.trackingNumber}`,
            verification(b)?.verifiedAt ?? b.now,
            'Carrier system of record reports the parcel is still moving, not lost.',
          ),
        },
        {
          when: isFullyRefunded(b),
          ev: ev(
            `payment/${b.payment?._id ?? 'none'}`,
            b.now,
            `A refund of ${formatMoney(refundedTotal(b))} already settled, so the loss has already been remediated.`,
          ),
        },
      ]
    },
  },

  {
    code: 'CARRIER_DELAYED_NOT_LOST',
    label: 'Parcel delayed but located; a revised ETA has been issued',
    base: 0.95,
    applies: b => verification(b)?.status === 'IN_TRANSIT',
    supporting: b => {
      const v = verification(b)!
      const s = primaryShipment(b)!
      return [
        {
          when: true,
          ev: ev(
            `carrier-verification/${s.trackingNumber}`,
            v.verifiedAt,
            `Carrier located the parcel and reports it in transit${v.revisedEta ? `, revised ETA ${v.revisedEta.toISOString().slice(0, 10)}` : ''}.`,
          ),
        },
      ]
    },
    contradicting: () => [],
  },

  {
    code: 'DELIVERED_THEN_LOST',
    label: 'Delivered to the correct address, then lost or taken',
    base: 0.55,
    applies: b => !!deliveredScan(b) && !!disputeContact(b),
    supporting: b => {
      const d = deliveredScan(b)!
      const drift = deliveryGeoDriftM(b)
      return [
        { when: true, ev: ev(`scan@${d.at.toISOString()}`, d.at, `Carrier recorded a completed delivery at ${d.location}.`) },
        {
          when: deliveryGeoMatches(b),
          ev: ev(
            `geo/${primaryShipment(b)!.trackingNumber}`,
            d.at,
            `Delivery coordinates are ${drift}m from the shipping address, inside the ${POLICY.deliveryGeoToleranceM}m tolerance.`,
          ),
        },
      ]
    },
    contradicting: b => {
      const c = disputeContact(b)!
      return [
        { when: true, ev: ev(c._id, c.at, 'Customer reports the parcel was never received.') },
      ]
    },
  },

  {
    code: 'CARRIER_FALSE_DELIVERY_SCAN',
    label: 'Carrier recorded a delivery that did not happen',
    base: 0.55,
    applies: b => !!deliveredScan(b) && !!disputeContact(b),
    supporting: b => {
      const c = disputeContact(b)!
      const drift = deliveryGeoDriftM(b)
      return [
        { when: true, ev: ev(c._id, c.at, 'Customer reports the parcel was never received.') },
        {
          when: !deliveryGeoMatches(b),
          optional: true,
          ev: ev(
            `geo/${primaryShipment(b)!.trackingNumber}`,
            c.at,
            `Delivery coordinates are ${drift ?? 'unknown'}m from the shipping address, outside the ${POLICY.deliveryGeoToleranceM}m tolerance.`,
          ),
        },
      ]
    },
    contradicting: b => {
      const d = deliveredScan(b)!
      const drift = deliveryGeoDriftM(b)
      return [
        {
          when: deliveryGeoMatches(b),
          ev: ev(
            `geo/${primaryShipment(b)!.trackingNumber}`,
            d.at,
            `Carrier delivery coordinates are only ${drift}m from the shipping address, which supports the carrier's account.`,
          ),
        },
      ]
    },
  },

  {
    code: 'ALREADY_REMEDIATED',
    label: 'This order has already been refunded in full',
    base: 0.95,
    applies: b => isFullyRefunded(b),
    supporting: b => {
      const cap = captureTxn(b)
      return [
        {
          when: true,
          ev: ev(
            `payment/${b.payment?._id ?? 'none'}`,
            b.now,
            `Payment ledger shows ${formatMoney(refundedTotal(b))} already refunded against a capture of ${formatMoney(cap?.amount ?? refundedTotal(b))}.`,
          ),
        },
        {
          when: b.order.status !== 'refunded',
          optional: true,
          ev: ev(
            b.order._id,
            b.order.updatedAt,
            `Order status still reads "${b.order.status}" — the storefront record is stale, the ledger is authoritative.`,
          ),
        },
      ]
    },
    contradicting: () => [],
  },
]

const band = (score: number): ConfidenceBand =>
  score >= POLICY.confidenceBands.high ? 'high' : score >= POLICY.confidenceBands.medium ? 'medium' : 'low'

export function diagnose(b: EvidenceBundle): Diagnosis {
  const rootCauses: RootCause[] = []

  for (const rule of RULES) {
    if (!rule.applies(b)) continue
    const sup = rule.supporting(b)
    const con = rule.contradicting(b).filter(f => f.when)
    const matched = sup.filter(f => f.when)
    if (!matched.length) continue

    // Only REQUIRED facts form the denominator. Absent optional evidence must not
    // look like a failed check — ORD-1001 is no less lost for the fact that nobody
    // has called the carrier yet.
    const required = sup.filter(f => !f.optional)
    const matchedRequired = required.filter(f => f.when).length
    const matchedOptional = matched.filter(f => f.optional).length
    const coverage = required.length ? matchedRequired / required.length : 1

    const confidence = Math.min(
      0.99,
      rule.base * coverage * (1 + 0.05 * matchedOptional) * Math.pow(0.8, con.length),
    )
    rootCauses.push({
      code: rule.code,
      label: rule.label,
      confidence: Math.round(confidence * 100) / 100,
      evidence: matched.map(f => f.ev),
      contradictingEvidence: con.map(f => f.ev),
    })
  }

  rootCauses.sort((a, c) => c.confidence - a.confidence)

  const top = rootCauses[0]?.confidence ?? 0
  const second = rootCauses[1]?.confidence ?? 0
  const tie = rootCauses.length > 1 && top - second < POLICY.confidenceTieMargin
  const confidenceBand: ConfidenceBand = tie ? 'low' : band(top)

  // "No rule matched" is NOT ambiguity — it means this is not a delivery exception,
  // and there is no judgment call to escalate. Only a weak or contested explanation
  // demands a human. Conflating the two would route every healthy order to a manager.
  const requiresHumanJudgment = rootCauses.length > 0 && confidenceBand === 'low'

  // Signals are facts a human should weigh. They never move the ranking — a customer's
  // history is not evidence about where this particular parcel went.
  const signals: string[] = []
  const priors = priorClaimsInWindow(b)
  if (priors.length && disputeContact(b)) {
    signals.push(
      `This customer has ${priors.length} earlier non-receipt claim(s) in the last ${POLICY.priorClaimWindowDays} days: ${priors.map(p => p.orderId).join(', ')}.`,
    )
  }
  if (hasDeadInstrument(b)) {
    signals.push(
      `A previous refund failed with gateway code "${lastFailedRefund(b)!.gatewayCode}" — the original instrument cannot receive funds.`,
    )
  }
  if (!verificationIsFresh(b) && primaryShipment(b)?.status !== 'delivered') {
    signals.push('No carrier verification in the last 24 hours. A refund cannot be authorised until one is obtained.')
  }

  // Remedies the engine is willing to put in front of an operator at all. Policy still
  // has the final say; this only prevents proposing something incoherent.
  let eligibleRemedies: Diagnosis['eligibleRemedies']
  if (requiresHumanJudgment) eligibleRemedies = ['none']
  else if (top === 0) eligibleRemedies = ['none']
  else if (rootCauses[0].code === 'CARRIER_DELAYED_NOT_LOST') eligibleRemedies = ['wait_for_revised_eta']
  else if (rootCauses[0].code === 'ALREADY_REMEDIATED') eligibleRemedies = ['none']
  else eligibleRemedies = ['refund']

  return {
    rootCauses,
    confidence: top,
    confidenceBand,
    requiresHumanJudgment,
    signals,
    eligibleRemedies,
  }
}
