/**
 * The manager-approval queue.
 *
 * There is deliberately NO MCP tool that reaches this file. The agent can create
 * approval requests and read their status, but it can never decide one — that is what
 * makes the human gate real rather than theatrical. Approval happens only through a
 * server action in the Next.js app.
 */

import { actionLog } from '@/src/db/collections'
import type { ActionLogEntry } from '@/src/domain/types'
import { executeAction } from './actions'
import type { ActionOutcome, Actor } from './types'

export async function listPending(limit = 25): Promise<ActionLogEntry[]> {
  return (await actionLog())
    .find({ status: 'requires_approval' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as unknown as ActionLogEntry[]
}

export async function getAction(actionId: string): Promise<ActionLogEntry | null> {
  return (await actionLog()).findOne({ _id: actionId }) as unknown as ActionLogEntry | null
}

export async function listAudit(limit = 100): Promise<ActionLogEntry[]> {
  return (await actionLog())
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as unknown as ActionLogEntry[]
}

export type Decision = 'approve' | 'reject'

/**
 * Record a manager's decision.
 *
 * Approval re-enters `executeAction`, which re-checks freshness and re-runs the full
 * policy engine against live data. A signature therefore overrides `require_approval`
 * and nothing else: if the parcel was delivered while the request sat in the queue, or
 * the order was refunded by someone else, approving it still will not move money.
 *
 * A note is required in both directions. An audit trail that records *what* was decided
 * but not *why* is only half a trail.
 */
export async function decide(
  actionId: string,
  decision: Decision,
  decidedBy: string,
  note: string,
  now = new Date(),
): Promise<ActionOutcome> {
  if (!note.trim()) throw new Error('A decision note is required, for approvals and rejections alike.')

  const doc = await getAction(actionId)
  if (!doc) throw new Error(`No action ${actionId}.`)
  if (doc.status !== 'requires_approval') {
    throw new Error(`Action ${actionId} is "${doc.status}", not awaiting approval. Decisions are single-use.`)
  }

  if (decision === 'reject') {
    const outcome: ActionOutcome = {
      actionId,
      status: 'rejected',
      replayed: false,
      isError: false,
      effectSummary: `No money moved. Rejected by ${decidedBy}: ${note}`,
      computed: doc.computed,
    }
    await (await actionLog()).updateOne(
      { _id: actionId },
      {
        $set: {
          status: 'rejected',
          result: outcome,
          completedAt: now,
          'approval.decidedAt': now,
          'approval.decidedBy': decidedBy,
          'approval.decisionNote': note,
        },
        $push: { transitions: { status: 'rejected', at: now, by: decidedBy } },
      } as never,
    )
    return outcome
  }

  await (await actionLog()).updateOne(
    { _id: actionId },
    {
      $set: {
        'approval.decidedAt': now,
        'approval.decidedBy': decidedBy,
        'approval.decisionNote': note,
      },
    } as never,
  )

  const actor: Actor = doc.actor
  return executeAction(actionId, actor, { humanApproval: { by: decidedBy, note } }, now)
}
