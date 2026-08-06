/**
 * The policy engine. Nine rules, pure, evaluated TWICE — advisory at preview so the
 * agent can plan against the rules instead of probing them, and binding at execute
 * from a freshly reloaded bundle. Preview is never trusted to have happened.
 *
 * Three verdicts, per the client's instruction of 2026-08-04:
 *
 *   allow            every condition passed; the refund executes
 *   require_approval a JUDGMENT call — queued for a manager WITH the evidence
 *   deny             a condition no approval could make correct
 *
 * The client said to escalate "rather than denying it". `deny` survives only where
 * approval would be meaningless: you cannot authorise refunding more than was
 * captured, refunding twice, or refunding a parcel the carrier has just confirmed is
 * still moving. Everything that is a business judgment escalates. That reading is
 * flagged back to them in docs/client/email-02-scope-confirmed.md.
 */

import { POLICY } from '@/src/config/policy'
import {
  deliveredScan,
  disputeContact,
  hasDeadInstrument,
  isFullyRefunded,
  lastFailedRefund,
  verification,
  verificationIsFresh,
} from './evidence'
import { formatMoney, usd, type ComputedRefund, type EvidenceBundle, type PolicyDecision, type RuleResult } from './types'
import type { Diagnosis } from './diagnose'

/**
 * Counts the engine cannot derive from a single order. Supplied by the service layer
 * from `action_log` — never from memory, so a restarted process cannot forget that it
 * already issued three refunds this minute.
 */
export type PolicyCounters = {
  /** Settled refunds for THIS order inside POLICY.ceilingWindowHours. */
  refundedInWindowMinor: number
  /** Refunds this actor has executed in the last 10 minutes. */
  executedByActorLast10Min: number
  /** Auto-approved refund value across all orders in the last 24h. */
  autoApprovedMinorLast24h: number
  /** An identical effect fingerprint already executed inside the dedupe window. */
  duplicateEffectExecutedRecently: boolean
}

export const EMPTY_COUNTERS: PolicyCounters = {
  refundedInWindowMinor: 0,
  executedByActorLast10Min: 0,
  autoApprovedMinorLast24h: 0,
  duplicateEffectExecutedRecently: false,
}

export type PolicyInput = {
  bundle: EvidenceBundle
  effect: ComputedRefund
  diagnosis: Diagnosis
  actor: { label: string }
  counters: PolicyCounters
}

export type PolicyVerdict = {
  decision: PolicyDecision
  rules: RuleResult[]
  /** True only for `deny`. Tells the agent not to reshape the request and try again. */
  doNotRetry: boolean
  guidance: string
  /** Populated for `require_approval` — why a human is being asked. */
  approvalReason?: string
}

type Rule = { id: string; evaluate: (i: PolicyInput) => RuleResult }

const ok = (id: string, detail: string): RuleResult => ({ id, verdict: 'allow', detail })

const RULES: Rule[] = [
  {
    id: 'P1_REFUND_CEILING',
    evaluate: ({ effect, counters }) => {
      // Evaluated against the ROLLING TOTAL for this order, not just the amount in
      // front of us. Without the window, an agent refused a $220 full refund could
      // slip through with two sub-ceiling line refunds.
      const total = effect.amount.minor + counters.refundedInWindowMinor
      if (total > POLICY.refundCeilingMinor) {
        return {
          id: 'P1_REFUND_CEILING',
          verdict: 'require_approval',
          detail:
            `${formatMoney(effect.amount)} proposed` +
            (counters.refundedInWindowMinor
              ? ` plus ${formatMoney(usd(counters.refundedInWindowMinor))} already refunded in the last ${POLICY.ceilingWindowHours}h`
              : '') +
            ` exceeds the ${formatMoney(usd(POLICY.refundCeilingMinor))} auto-approval ceiling.`,
        }
      }
      return ok('P1_REFUND_CEILING', `${formatMoney(effect.amount)} is within the ${formatMoney(usd(POLICY.refundCeilingMinor))} ceiling.`)
    },
  },

  {
    id: 'P2_REFUND_LE_CAPTURED',
    evaluate: ({ effect }) => {
      // Hard invariant. "Do not exceed the paid amount" — client, 2026-08-04.
      const after = effect.alreadyRefunded.minor + effect.amount.minor
      if (after > effect.capturedTotal.minor) {
        return {
          id: 'P2_REFUND_LE_CAPTURED',
          verdict: 'deny',
          detail: `Refunding ${formatMoney(effect.amount)} would bring total refunds to ${formatMoney(usd(after))} against ${formatMoney(effect.capturedTotal)} captured.`,
        }
      }
      return ok(
        'P2_REFUND_LE_CAPTURED',
        `${formatMoney(usd(after))} total refunds stays within ${formatMoney(effect.capturedTotal)} captured.`,
      )
    },
  },

  {
    id: 'P3_CARRIER_VERIFIED',
    evaluate: ({ bundle }) => {
      // The client's "VERIFIED carrier exception", made structural. Without this rule
      // ORD-1006 — a delayed parcel that is indistinguishable from a lost one in our
      // own data — would be refunded while it is still moving.
      const v = verification(bundle)
      if (!v) {
        return {
          id: 'P3_CARRIER_VERIFIED',
          verdict: 'deny',
          detail: 'No carrier verification on file. Call ops_verify_carrier_exception before proposing a refund.',
        }
      }
      if (!verificationIsFresh(bundle)) {
        return {
          id: 'P3_CARRIER_VERIFIED',
          verdict: 'deny',
          detail: `The carrier verification is older than ${POLICY.verificationFreshnessHours}h and no longer proves anything about today. Re-verify.`,
        }
      }
      if (v.status === 'IN_TRANSIT') {
        return {
          id: 'P3_CARRIER_VERIFIED',
          verdict: 'deny',
          detail: `The carrier reports the parcel is still in transit${v.revisedEta ? `, revised ETA ${v.revisedEta.toISOString().slice(0, 10)}` : ''}. A refund is premature.`,
        }
      }
      return ok('P3_CARRIER_VERIFIED', `Carrier verification is ${v.status}, obtained ${v.verifiedAt.toISOString()}.`)
    },
  },

  {
    id: 'P4_LOW_CONFIDENCE',
    evaluate: ({ diagnosis }) =>
      diagnosis.requiresHumanJudgment
        ? {
            id: 'P4_LOW_CONFIDENCE',
            verdict: 'require_approval',
            detail: `Diagnostic confidence is ${diagnosis.confidenceBand} with ${diagnosis.rootCauses.length} competing explanations. The engine cannot separate them on the available evidence.`,
          }
        : ok('P4_LOW_CONFIDENCE', `Diagnostic confidence is ${diagnosis.confidenceBand}.`),
  },

  {
    id: 'P5_DISPUTED_DELIVERY',
    evaluate: ({ bundle }) => {
      // Not amount-driven, on purpose. A $5 disputed delivery still escalates, because
      // the question is "whose account of events do we believe", not "how much".
      // Client instruction: make no assumption about which team owns this.
      if (deliveredScan(bundle) && disputeContact(bundle)) {
        const priors = bundle.priorClaims.length
        return {
          id: 'P5_DISPUTED_DELIVERY',
          verdict: 'require_approval',
          detail:
            'The carrier recorded a delivery and the customer reports non-receipt. This is a judgment call about conflicting accounts, not an arithmetic one.' +
            (priors ? ` This customer has ${priors} earlier non-receipt claim(s) on file.` : ''),
        }
      }
      return ok('P5_DISPUTED_DELIVERY', 'No delivery dispute on this order.')
    },
  },

  {
    id: 'P6_DEAD_INSTRUMENT',
    evaluate: ({ bundle }) =>
      hasDeadInstrument(bundle)
        ? {
            id: 'P6_DEAD_INSTRUMENT',
            verdict: 'require_approval',
            detail: `A previous refund failed with "${lastFailedRefund(bundle)!.gatewayCode}". The original instrument cannot receive funds; an alternate disbursement must be arranged by a human.`,
          }
        : ok('P6_DEAD_INSTRUMENT', 'The original payment instrument is usable.'),
  },

  {
    id: 'P7_NO_DUPLICATE_REMEDY',
    evaluate: ({ counters }) =>
      counters.duplicateEffectExecutedRecently
        ? {
            id: 'P7_NO_DUPLICATE_REMEDY',
            verdict: 'deny',
            detail: `An identical refund already executed within the last ${POLICY.effectDedupeHours}h. Issuing it again would double-refund the customer.`,
          }
        : ok('P7_NO_DUPLICATE_REMEDY', 'No identical refund in the dedupe window.'),
  },

  {
    id: 'P8_CIRCUIT_BREAKER',
    evaluate: ({ effect, counters, actor }) => {
      const { maxExecutedPerActorPer10Min, maxAutoApprovedMinorPer24h } = POLICY.circuitBreaker
      if (counters.executedByActorLast10Min >= maxExecutedPerActorPer10Min) {
        return {
          id: 'P8_CIRCUIT_BREAKER',
          verdict: 'deny',
          detail: `${actor.label} has executed ${counters.executedByActorLast10Min} refunds in the last 10 minutes. Halting and escalating rather than continuing.`,
        }
      }
      if (counters.autoApprovedMinorLast24h + effect.amount.minor > maxAutoApprovedMinorPer24h) {
        return {
          id: 'P8_CIRCUIT_BREAKER',
          verdict: 'deny',
          detail: `Auto-approved refunds would reach ${formatMoney(usd(counters.autoApprovedMinorLast24h + effect.amount.minor))} in 24h, past the ${formatMoney(usd(maxAutoApprovedMinorPer24h))} limit. Halting and escalating.`,
        }
      }
      return ok('P8_CIRCUIT_BREAKER', 'Within blast-radius limits.')
    },
  },

  {
    id: 'P9_ORDER_STATE',
    evaluate: ({ bundle, effect }) => {
      if (bundle.order.status === 'cancelled') {
        return { id: 'P9_ORDER_STATE', verdict: 'deny', detail: 'The order is cancelled.' }
      }
      if (isFullyRefunded(bundle)) {
        return {
          id: 'P9_ORDER_STATE',
          verdict: 'deny',
          detail: `The payment ledger shows this order is already refunded in full (${formatMoney(effect.alreadyRefunded)} of ${formatMoney(effect.capturedTotal)}), whatever the order status says.`,
        }
      }
      return ok('P9_ORDER_STATE', `Order status "${bundle.order.status}" permits a refund.`)
    },
  },
]

const DENY_GUIDANCE =
  'Do not retry with a smaller amount or a different line selection. This is a hard rule, not a threshold — ' +
  'a reshaped request will be refused for the same reason. Report the finding and stop.'

const APPROVAL_GUIDANCE =
  'This has been queued for a manager with the full evidence bundle attached. Do not attempt to execute it ' +
  'another way. Tell the operator it is awaiting approval and move on to the next order.'

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const rules = RULES.map(r => r.evaluate(input))

  const denied = rules.filter(r => r.verdict === 'deny')
  const escalated = rules.filter(r => r.verdict === 'require_approval')

  if (denied.length) {
    return {
      decision: 'deny',
      rules,
      doNotRetry: true,
      guidance: `${denied.map(d => d.detail).join(' ')} ${DENY_GUIDANCE}`,
    }
  }
  if (escalated.length) {
    return {
      decision: 'require_approval',
      rules,
      doNotRetry: false,
      guidance: APPROVAL_GUIDANCE,
      approvalReason: escalated.map(e => e.detail).join(' '),
    }
  }
  return {
    decision: 'allow',
    rules,
    doNotRetry: false,
    guidance: 'Every condition passed. Execute the plan with ops_issue_refund.',
  }
}
