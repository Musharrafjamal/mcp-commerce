/**
 * Detection: which orders are open delivery exceptions right now.
 *
 * Three detectors, one shape. They read only typed event codes, dates and numbers —
 * never customer or carrier prose — so no third-party text can influence whether an
 * order appears in an operator's queue.
 */

import { POLICY } from '@/src/config/policy'
import {
  daysBetween,
  deliveryGeoMatches,
  disputeContact,
  deliveredScan,
  daysSinceLastScan,
  isClosed,
  primaryShipment,
  promiseBreached,
  remainingRefundable,
} from './evidence'
import type { EvidenceBundle, OrderException, Severity } from './types'

type Detector = (b: EvidenceBundle) => Omit<OrderException, 'orderId' | 'orderNumber' | 'customerName' | 'revenueAtRisk' | 'ageDays'> | null

const severityFor = (ageDays: number, atRiskMinor: number): Severity => {
  if (ageDays >= 10 || atRiskMinor >= 20_000) return 'critical'
  if (ageDays >= 5 || atRiskMinor >= 10_000) return 'high'
  return 'medium'
}

/**
 * In transit, silent for longer than the SLA, and past the promised date.
 *
 * Both conditions matter. A parcel can be quiet for days and still be perfectly fine
 * if it is not yet due — which is exactly what ORD-1021 exists to prove.
 */
const scanGap: Detector = b => {
  const s = primaryShipment(b)
  if (!s || s.status === 'delivered') return null
  const gap = daysSinceLastScan(b)
  if (gap === null || gap < POLICY.scanGapSlaDays) return null
  if (!promiseBreached(b)) return null
  return {
    exceptionCode: 'CARRIER_SCAN_GAP',
    severity: 'high',
    oneLineWhy: `No carrier scan for ${Math.floor(gap)} days; last seen at ${s.scans.at(-1)?.location ?? 'unknown'}, past the promised delivery date.`,
    nextStep: 'ops_investigate_delivery_exception',
  }
}

/** Past the promised date, still moving, but not yet silent long enough to be a scan gap. */
const promiseBreach: Detector = b => {
  const s = primaryShipment(b)
  if (!s || s.status === 'delivered') return null
  if (!promiseBreached(b)) return null
  const gap = daysSinceLastScan(b)
  if (gap !== null && gap >= POLICY.scanGapSlaDays) return null // scanGap owns this one
  return {
    exceptionCode: 'PROMISE_DATE_BREACHED',
    severity: 'medium',
    oneLineWhy: `Past the promised delivery date by ${Math.floor(daysBetween(b.now, s.promisedDeliveryDate))} days and still in transit.`,
    nextStep: 'ops_investigate_delivery_exception',
  }
}

/** The carrier says delivered; the customer says otherwise. */
const disputedDelivery: Detector = b => {
  if (!deliveredScan(b)) return null
  if (!disputeContact(b)) return null
  return {
    exceptionCode: 'DISPUTED_DELIVERY',
    severity: 'critical',
    oneLineWhy: `Carrier recorded a delivery${deliveryGeoMatches(b) ? ' at the shipping address' : ' away from the shipping address'}, but the customer reports non-receipt.`,
    nextStep: 'ops_investigate_delivery_exception',
  }
}

const DETECTORS: Detector[] = [scanGap, promiseBreach, disputedDelivery]

/**
 * At most one exception per order — an operator triages an order, not a rule.
 * Returns null for healthy orders and for orders that are already closed.
 */
export function detect(b: EvidenceBundle): OrderException | null {
  // A refunded or cancelled order is not an open operational problem, however odd
  // its carrier history looks. ORD-0977 is here to prove that.
  if (isClosed(b)) return null

  for (const d of DETECTORS) {
    const hit = d(b)
    if (!hit) continue
    const atRisk = remainingRefundable(b)
    const ageDays = Math.floor(daysBetween(b.now, b.order.placedAt))
    return {
      orderId: b.order._id,
      orderNumber: b.order.orderNumber,
      customerName: b.order.customer.name,
      ageDays,
      revenueAtRisk: atRisk,
      ...hit,
      severity: severityFor(ageDays, atRisk.minor),
    }
  }
  return null
}

/** Ranked worst-first: revenue at risk, then age. */
export function rankExceptions(xs: OrderException[]): OrderException[] {
  const weight = { critical: 3, high: 2, medium: 1 } as const
  return [...xs].sort(
    (a, b) =>
      weight[b.severity] - weight[a.severity] ||
      b.revenueAtRisk.minor - a.revenueAtRisk.minor ||
      b.ageDays - a.ageDays,
  )
}
