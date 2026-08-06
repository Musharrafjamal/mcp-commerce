import type { ActionStatus, ComputedRefund, PolicyDecision, RuleResult } from '@/src/domain/types'

/**
 * What every write path returns.
 *
 * `isError` is a deliberate design decision, not a convenience flag. A policy refusal
 * is NOT an error — it is the system working. Errors are reserved for mechanical,
 * self-correctable faults (a stale plan, an expired plan, a concurrent execution).
 *
 * The distinction matters because an agent treats the two completely differently: an
 * error invites a retry, so returning "refund denied" as an error trains the model to
 * reshape the request and try again until something slips through. A denial that is
 * not an error, carrying `doNotRetry`, does not.
 */
export type ActionOutcome = {
  actionId: string
  status: ActionStatus
  /** True when this call returned a cached result instead of doing anything. */
  replayed: boolean
  isError: boolean
  effectSummary: string
  policy?: {
    decision: PolicyDecision
    rules: RuleResult[]
    guidance: string
    doNotRetry: boolean
  }
  approval?: {
    reason: string
    summaryMd: string
    approvalUrl: string
    recommendedAction: string
  }
  error?: {
    code: ActionErrorCode
    message: string
    /** Exactly ONE recovery call, never a menu. */
    recovery: string
    retryAfterMs?: number
  }
  computed?: ComputedRefund
  /** The literal next call, including ids. Chaining hints in the response beat a
   *  tool description read forty thousand tokens ago. */
  next?: string
}

export type ActionErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'PLAN_EXPIRED'
  | 'PLAN_ALREADY_CONSUMED'
  | 'IN_FLIGHT'
  | 'STALE_PLAN'
  | 'ORDER_NOT_FOUND'
  | 'NOT_REFUNDABLE'

export type Actor = { label: string; clientInfo?: string }
