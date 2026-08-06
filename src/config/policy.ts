/**
 * Every threshold in one object.
 *
 * This constant is the single source of truth: the policy engine evaluates it, and
 * the `ops://policy/current` MCP resource is rendered from it at request time. The
 * published policy therefore cannot drift from the policy that is actually enforced.
 */
export const POLICY = {
  /**
   * Flat auto-approval ceiling for a refund, in minor units.
   * Client instruction 2026-08-04: "Use a flat $150 limit and do not exceed the paid amount."
   */
  refundCeilingMinor: 15_000,

  /**
   * Evaluated against the ROLLING TOTAL refunded for an order in this window, not just
   * the amount in front of us. Without this, an agent refused a $220 full refund could
   * slip through with two sub-ceiling line refunds.
   */
  ceilingWindowHours: 24,

  /** A carrier verification older than this does not satisfy the refund precondition. */
  verificationFreshnessHours: 24,

  /** In transit with no carrier scan for this long is an exception worth a human's time. */
  scanGapSlaDays: 7,

  /**
   * Carrier delivery geo within this distance of the shipping address supports the
   * carrier's account of events; beyond it suggests misdelivery.
   */
  deliveryGeoToleranceM: 30,

  /** Prior not-received claims by the same customer inside this window are surfaced. */
  priorClaimWindowDays: 180,

  /** Gateway codes meaning the original instrument can no longer receive a refund. */
  deadInstrumentCodes: ['source_account_closed', 'card_expired', 'account_frozen'] as const,

  /** Blast-radius limits, counted from action_log rather than from memory. */
  circuitBreaker: {
    maxExecutedPerActorPer10Min: 3,
    maxAutoApprovedMinorPer24h: 50_000,
  },

  /** A minted plan is single-use and expires. */
  planTtlMinutes: 15,

  /** Semantic dedupe window for an identical effect. */
  effectDedupeHours: 24,

  /** Confidence at or above this is 'high'; at or above the second is 'medium'. */
  confidenceBands: { high: 0.75, medium: 0.5 },

  /**
   * If the top two root causes are within this margin, confidence is forced to 'low'
   * regardless of absolute score. A near-tie between explanations is not knowledge.
   */
  confidenceTieMargin: 0.15,
} as const

export type PolicyConfig = typeof POLICY
