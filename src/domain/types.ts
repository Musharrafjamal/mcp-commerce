/**
 * The domain model. PURE — this file and everything else under src/domain/ imports
 * nothing from `mongodb`, `next`, or `@modelcontextprotocol/*`.
 *
 * Scope is deliberately narrow (client instruction, 2026-08-04): delayed / lost order
 * -> verified carrier exception -> refund decision. No inventory, no variants catalogue.
 */

// ---------------------------------------------------------------------------
// Money — integer minor units, never floats. 0.1 + 0.2 has no place near a refund.
// ---------------------------------------------------------------------------

export type Money = { minor: number; currency: 'USD' }

export const usd = (minor: number): Money => ({ minor, currency: 'USD' })
export const addMoney = (a: Money, b: Money): Money => usd(a.minor + b.minor)
export const sumMoney = (xs: Money[]): Money => usd(xs.reduce((n, m) => n + m.minor, 0))
export const formatMoney = (m: Money): string => `$${(m.minor / 100).toFixed(2)}`

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type LineStatus = 'pending' | 'shipped' | 'delivered' | 'refunded' | 'cancelled'

export type OrderLine = {
  lineId: string
  sku: string
  title: string
  qty: number
  unitPrice: Money
  status: LineStatus
  shipmentId?: string
}

export type Address = {
  name: string
  line1: string
  city: string
  region: string
  postalCode: string
  country: string
  geo: { lat: number; lng: number }
}

export type OrderStatus = 'open' | 'fulfilled' | 'cancelled' | 'refunded'

export type Order = {
  _id: string // ORD-1001 — a string an LLM can quote back. ObjectId hex is hallucination bait.
  orderNumber: string // #1001
  placedAt: Date
  status: OrderStatus
  customer: { id: string; name: string; email: string } // embedded snapshot, no customers collection
  lines: OrderLine[]
  totals: { subtotal: Money; shipping: Money; tax: Money; grandTotal: Money }
  shipTo: Address
  promisedDeliveryDate?: Date
  updatedAt: Date
  // NOTE: there is deliberately no `refunded` total. Denormalised counters are the #1
  // source of "the data says X but reality is Y" — precisely the bug class this product
  // exists to investigate. Refunded amount is derived from payments.transactions.
}

// ---------------------------------------------------------------------------
// Order events — append-only. `summary` is one line, written to be read by an LLM.
// ---------------------------------------------------------------------------

export type OrderEventType =
  | 'order_placed'
  | 'payment_authorized'
  | 'payment_captured'
  | 'payment_failed'
  | 'label_created'
  | 'shipment_dispatched'
  | 'carrier_scan'
  | 'delivery_exception'
  | 'delivered'
  | 'customer_contact'
  | 'carrier_verified'
  | 'refund_requested'
  | 'refund_succeeded'
  | 'refund_failed'
  | 'order_cancelled'

export type EventSource = 'storefront' | 'psp' | 'carrier' | 'support' | 'ops-copilot'

export type OrderEvent = {
  _id: string
  orderId: string
  at: Date
  type: OrderEventType
  source: EventSource
  summary: string
  data?: Record<string, unknown>
  actionId?: string
}

// ---------------------------------------------------------------------------
// Payments — transactions are EMBEDDED so appending a refund is a single-document
// atomic $push. The schema is shaped so the dangerous write needs no transaction.
// ---------------------------------------------------------------------------

export type TxnKind = 'authorization' | 'capture' | 'refund'
export type TxnStatus = 'succeeded' | 'failed' | 'pending'

/** Gateway codes that mean the original instrument can no longer receive a refund. */
export const DEAD_INSTRUMENT_CODES = ['source_account_closed', 'card_expired', 'account_frozen'] as const
export type GatewayCode = 'approved' | (typeof DEAD_INSTRUMENT_CODES)[number] | 'insufficient_funds' | 'do_not_honor'

export type PaymentTransaction = {
  txnId: string
  kind: TxnKind
  status: TxnStatus
  amount: Money
  at: Date
  gatewayRef: string
  gatewayCode: GatewayCode
  gatewayMessage?: string
  /** Set only by ops-copilot writes — links a refund back to its action_log entry. */
  actionId?: string
}

export type Payment = {
  _id: string
  orderId: string
  method: { brand: string; last4: string; exp: string }
  transactions: PaymentTransaction[]
}

// ---------------------------------------------------------------------------
// Shipments — carrier scans embedded.
// ---------------------------------------------------------------------------

export type ScanCode =
  | 'label_created'
  | 'picked_up'
  | 'departed_facility'
  | 'arrived_hub'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'

export type CarrierScan = {
  at: Date
  code: ScanCode
  location: string
  /** Third-party free text. NEVER read by detect/diagnose/policy — fenced as untrusted. */
  description: string
}

export type ShipmentStatus = 'label_created' | 'in_transit' | 'delivered' | 'exception'

/** What the carrier's system of record says. Written by ops_verify_carrier_exception. */
export type CarrierVerificationStatus = 'LOST_IN_TRANSIT' | 'IN_TRANSIT' | 'DELIVERED' | 'UNKNOWN'

export type CarrierVerification = {
  status: CarrierVerificationStatus
  verifiedAt: Date
  carrierRef: string
  revisedEta?: Date
  /** Third-party free text — untrusted, fenced on the way out. */
  note: string
}

export type Shipment = {
  _id: string
  orderId: string
  lineIds: string[]
  carrier: string
  trackingNumber: string
  status: ShipmentStatus
  promisedDeliveryDate: Date
  shippedAt?: Date
  deliveredAt?: Date
  scans: CarrierScan[]
  lastScanAt?: Date
  /** Where the carrier claims it was left. Compared against shipTo.geo for disputed claims. */
  deliveryGeo?: { lat: number; lng: number }
  /** Latest verification result. Absent until ops_verify_carrier_exception is called. */
  carrierVerification?: CarrierVerification

  /**
   * SIMULATION ONLY. Stands in for the carrier's external API and is read exclusively
   * by services/simCarrier.ts — never by a detector, a diagnosis rule, or the policy
   * engine, and never returned to the agent. Seeded so the carrier's answer is
   * deterministic across reseeds.
   */
  simCarrierTruth: { status: CarrierVerificationStatus; note: string; revisedEtaDays?: number }
}

// ---------------------------------------------------------------------------
// action_log — simultaneously plan store, idempotency ledger, approval queue and
// audit trail. One append-only document per attempted remediation, INCLUDING the
// ones policy refused.
// ---------------------------------------------------------------------------

export type PolicyDecision = 'allow' | 'deny' | 'require_approval'

export type RuleResult = {
  id: string
  verdict: PolicyDecision
  detail: string
}

export type ActionStatus =
  | 'planned' // preview minted a plan; nothing executed
  | 'claimed' // execution in flight (the mutual-exclusion state)
  | 'executed'
  | 'denied'
  | 'requires_approval'
  | 'rejected' // a human said no
  | 'failed'

export type RefundTarget = { mode: 'full_order' } | { mode: 'lines'; lineIds: string[] }

/** The computed effect of a proposed refund. The ONLY place an amount comes from. */
export type ComputedRefund = {
  amount: Money
  targetPaymentId: string
  targetTxnId: string
  lineIds: string[]
  capturedTotal: Money
  alreadyRefunded: Money
}

export type DiagnosisSnapshot = {
  topCauseCode: string
  confidence: number
  confidenceBand: ConfidenceBand
  requiresHumanJudgment: boolean
}

export type ActionLogEntry = {
  _id: string // PLAN-… — this IS the plan_id, the action_id, and the idempotency key
  mode: 'preview' | 'execute' | 'verify'
  action: 'refund' | 'verify_carrier'
  orderId: string
  input: Record<string, unknown>
  computed?: ComputedRefund
  diagnosisSnapshot?: DiagnosisSnapshot
  /** sha256(action|orderId|paymentId|amountMinor|sortedLineIds) — semantic dedupe key. */
  effectFingerprint?: string
  /** Hash of the evidence the plan was built from; mismatch at execute => STALE_PLAN. */
  stateHash?: string
  policy?: { decision: PolicyDecision; rules: RuleResult[] }
  status: ActionStatus
  transitions: { status: ActionStatus; at: Date; by: string }[]
  /** The VERBATIM tool response, cached so an idempotent replay is byte-identical. */
  result?: unknown
  error?: string
  actor: { label: string; clientInfo?: string }
  approval?: {
    reason: string
    decidedAt?: Date
    decidedBy?: string
    decisionNote?: string
  }
  expiresAt: Date
  createdAt: Date
  claimedAt?: Date
  completedAt?: Date
}

// ---------------------------------------------------------------------------
// Diagnosis / detection outputs
// ---------------------------------------------------------------------------

export type ConfidenceBand = 'high' | 'medium' | 'low'

export type ExceptionCode =
  | 'CARRIER_SCAN_GAP' // in transit, no scan for longer than the SLA, promise date passed
  | 'PROMISE_DATE_BREACHED' // past promised delivery, still not delivered
  | 'DISPUTED_DELIVERY' // carrier says delivered, customer says not received

export type Severity = 'critical' | 'high' | 'medium'

export type OrderException = {
  orderId: string
  orderNumber: string
  customerName: string
  exceptionCode: ExceptionCode
  severity: Severity
  ageDays: number
  revenueAtRisk: Money
  oneLineWhy: string
  nextStep: string
}

export type Evidence = {
  ref: string // a real event/scan/txn id a reviewer can trace back
  at: Date
  fact: string
}

export type RootCause = {
  code: string
  label: string
  confidence: number
  evidence: Evidence[]
  contradictingEvidence: Evidence[]
}

// ---------------------------------------------------------------------------
// The architectural seam. Loaded ONCE per request; every pure function is a
// function of this and nothing else.
// ---------------------------------------------------------------------------

export type EvidenceBundle = {
  order: Order
  events: OrderEvent[]
  payment: Payment | null
  shipments: Shipment[]
  /** Same customer, earlier not-received claims. Feeds the disputed-delivery signal. */
  priorClaims: { orderId: string; at: Date; summary: string }[]
  recentActions: ActionLogEntry[]
  now: Date
}
