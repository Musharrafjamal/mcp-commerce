/**
 * Policy counters, read from `action_log` rather than held in memory.
 *
 * A restarted process must not forget that it already issued three refunds this
 * minute. Every blast-radius limit therefore counts durable records, which also means
 * the limits survive a redeploy mid-incident.
 */

import { actionLog } from '@/src/db/collections'
import { POLICY } from '@/src/config/policy'
import type { PolicyCounters } from '@/src/domain/policy'
import type { EvidenceBundle } from '@/src/domain/types'

const HOUR = 3_600_000

export async function computeCounters(
  b: EvidenceBundle,
  actorLabel: string,
  effectFingerprint: string,
  now = new Date(),
): Promise<PolicyCounters> {
  const log = await actionLog()

  const ceilingSince = new Date(now.getTime() - POLICY.ceilingWindowHours * HOUR)
  const dedupeSince = new Date(now.getTime() - POLICY.effectDedupeHours * HOUR)
  const breakerSince = new Date(now.getTime() - 10 * 60_000)
  const daySince = new Date(now.getTime() - 24 * HOUR)

  const [windowRefunds, duplicate, byActor, autoApproved] = await Promise.all([
    // Settled refunds for THIS order inside the ceiling window. Read from the payment
    // ledger, not from the action log, so refunds issued outside this system still count.
    Promise.resolve(
      (b.payment?.transactions ?? [])
        .filter(t => t.kind === 'refund' && t.status === 'succeeded' && t.at >= ceilingSince)
        .reduce((n, t) => n + t.amount.minor, 0),
    ),
    log.findOne({ effectFingerprint, status: 'executed', completedAt: { $gte: dedupeSince } }),
    log.countDocuments({ 'actor.label': actorLabel, status: 'executed', completedAt: { $gte: breakerSince } }),
    log
      .find({ status: 'executed', completedAt: { $gte: daySince }, 'policy.decision': 'allow' })
      .toArray(),
  ])

  return {
    refundedInWindowMinor: windowRefunds,
    duplicateEffectExecutedRecently: duplicate !== null,
    executedByActorLast10Min: byActor,
    autoApprovedMinorLast24h: autoApproved.reduce((n, a) => n + (a.computed?.amount.minor ?? 0), 0),
  }
}
