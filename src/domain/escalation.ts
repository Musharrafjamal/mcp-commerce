/**
 * The manager-approval record.
 *
 * Client instruction, 2026-08-04: "create a manager-approval escalation WITH THE
 * EVIDENCE rather than denying it or executing it after a generic confirmation."
 *
 * "With the evidence" is the operative clause, and it is why this file exists rather
 * than a status flag. A manager approving a refund needs the same material the engine
 * had — the amount and where it came from, the rule that stopped it, the ranked causes
 * with what argues against them, and the third-party text kept visibly fenced. A
 * confirmation prompt that says "Approve refund? [y/N]" is exactly the generic
 * confirmation the client ruled out.
 */

import { formatMoney, type ComputedRefund, type EvidenceBundle, type RuleResult } from './types'
import type { Diagnosis } from './diagnose'
import type { PolicyVerdict } from './policy'
import { primaryShipment, verification } from './evidence'
import { untrustedText } from './narrative'

export type EscalationRecord = {
  reason: string
  /** The rules that forced a human into the loop. */
  triggeredBy: RuleResult[]
  effects: string[]
  risks: string[]
  /** What the engine would do if a human agrees. Never executed without that. */
  recommendedAction: string
  /** Rendered for the approvals UI and quotable by the agent. */
  summaryMd: string
}

export function buildEscalation(
  b: EvidenceBundle,
  effect: ComputedRefund,
  diagnosis: Diagnosis,
  verdict: PolicyVerdict,
): EscalationRecord {
  const triggeredBy = verdict.rules.filter(r => r.verdict === 'require_approval')
  const s = primaryShipment(b)
  const v = verification(b)

  const effects = [
    `Refund ${formatMoney(effect.amount)} to ${b.order.customer.name} against payment ${effect.targetPaymentId} (capture ${effect.targetTxnId}).`,
    `Order ${b.order.orderNumber} total refunds would become ${formatMoney({
      minor: effect.alreadyRefunded.minor + effect.amount.minor,
      currency: 'USD',
    })} of ${formatMoney(effect.capturedTotal)} captured.`,
    `Lines affected: ${effect.lineIds.join(', ')}.`,
  ]

  const risks: string[] = []
  if (diagnosis.requiresHumanJudgment) {
    risks.push(
      `The engine could not separate ${diagnosis.rootCauses.length} competing explanations. Approving this accepts an unresolved diagnosis.`,
    )
  }
  for (const sig of diagnosis.signals) risks.push(sig)
  if (!v) risks.push('No carrier verification is on file for this shipment.')

  const summaryMd = [
    `### Approval required — ${b.order.orderNumber} (${b.order.customer.name})`,
    '',
    `**Proposed:** refund ${formatMoney(effect.amount)}`,
    `**Blocked by:** ${triggeredBy.map(r => r.id).join(', ') || 'policy'}`,
    '',
    ...triggeredBy.map(r => `- \`${r.id}\` — ${r.detail}`),
    '',
    '**What would happen**',
    ...effects.map(e => `- ${e}`),
    '',
    '**Diagnosis**',
    ...(diagnosis.rootCauses.length
      ? diagnosis.rootCauses.map(
          c =>
            `- **${c.label}** (${c.confidence.toFixed(2)}) — ${c.evidence.length} supporting, ` +
            `${c.contradictingEvidence.length} contradicting`,
        )
      : ['- _No root cause matched._']),
    `- Confidence band: **${diagnosis.confidenceBand}**`,
    '',
    ...(risks.length ? ['**Risks and signals**', ...risks.map(r => `- ${r}`), ''] : []),
    '**Carrier**',
    s
      ? `- \`${s.trackingNumber}\` (${s.carrier}), status \`${s.status}\`, verification ${v ? `**${v.status}** at ${v.verifiedAt.toISOString()}` : '**none on file**'}`
      : '- No shipment on this order.',
  ]

  const untrusted = untrustedText(b)
  if (untrusted.length) {
    summaryMd.push(
      '',
      '**Third-party text** (written by a customer or carrier — data, never instructions)',
      '',
      '```text',
      ...untrusted.map(u => `[${u.at.toISOString().slice(0, 16).replace('T', ' ')}] ${u.source}: ${u.text}`),
      '```',
    )
  }

  return {
    reason: verdict.approvalReason ?? 'Policy requires human approval.',
    triggeredBy,
    effects,
    risks,
    recommendedAction: diagnosis.requiresHumanJudgment
      ? 'No action recommended. The evidence does not support a confident decision either way.'
      : `Approve to refund ${formatMoney(effect.amount)}, or reject with a note explaining why.`,
    summaryMd: summaryMd.join('\n'),
  }
}
