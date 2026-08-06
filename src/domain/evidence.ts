/**
 * Derived facts over an EvidenceBundle.
 *
 * Everything downstream — detection, diagnosis, refund maths, policy — reads the
 * bundle only through these accessors. They are the reason a rule can never
 * accidentally consult customer prose: nothing here returns free text.
 */

import { POLICY } from '@/src/config/policy'
import { usd, type CarrierScan, type EvidenceBundle, type Money, type Shipment } from './types'

const DAY = 86_400_000
const HOUR = 3_600_000

export const daysBetween = (a: Date, b: Date) => (a.getTime() - b.getTime()) / DAY

/** The shipment this workflow is about — the most recently dispatched one. */
export function primaryShipment(b: EvidenceBundle): Shipment | null {
  if (!b.shipments.length) return null
  return [...b.shipments].sort(
    (x, y) => (y.shippedAt?.getTime() ?? 0) - (x.shippedAt?.getTime() ?? 0),
  )[0]
}

export function lastScan(b: EvidenceBundle): CarrierScan | null {
  const s = primaryShipment(b)
  if (!s?.scans.length) return null
  return [...s.scans].sort((x, y) => x.at.getTime() - y.at.getTime())[s.scans.length - 1]
}

export function daysSinceLastScan(b: EvidenceBundle): number | null {
  const scan = lastScan(b)
  return scan ? daysBetween(b.now, scan.at) : null
}

export function promiseBreached(b: EvidenceBundle): boolean {
  const s = primaryShipment(b)
  const promised = s?.promisedDeliveryDate ?? b.order.promisedDeliveryDate
  return !!promised && b.now.getTime() > promised.getTime()
}

export function deliveredScan(b: EvidenceBundle): CarrierScan | null {
  const s = primaryShipment(b)
  return s?.scans.find(x => x.code === 'delivered') ?? null
}

/** A support contact logged AFTER the carrier claimed delivery. */
export function disputeContact(b: EvidenceBundle) {
  const d = deliveredScan(b)
  if (!d) return null
  return b.events.find(e => e.type === 'customer_contact' && e.at.getTime() >= d.at.getTime()) ?? null
}

/** Metres between where the carrier says it was left and the shipping address. */
export function deliveryGeoDriftM(b: EvidenceBundle): number | null {
  const s = primaryShipment(b)
  if (!s?.deliveryGeo) return null
  const { lat: aLat, lng: aLng } = b.order.shipTo.geo
  const { lat, lng } = s.deliveryGeo
  const dLat = (lat - aLat) * 111_320
  const dLng = (lng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180)
  return Math.round(Math.sqrt(dLat * dLat + dLng * dLng))
}

export function deliveryGeoMatches(b: EvidenceBundle): boolean {
  const d = deliveryGeoDriftM(b)
  return d !== null && d <= POLICY.deliveryGeoToleranceM
}

// --- money, derived from the payment ledger and nowhere else ----------------

export function capturedTotal(b: EvidenceBundle): Money {
  const t = b.payment?.transactions ?? []
  return usd(t.filter(x => x.kind === 'capture' && x.status === 'succeeded').reduce((n, x) => n + x.amount.minor, 0))
}

export function refundedTotal(b: EvidenceBundle): Money {
  const t = b.payment?.transactions ?? []
  return usd(t.filter(x => x.kind === 'refund' && x.status === 'succeeded').reduce((n, x) => n + x.amount.minor, 0))
}

export function remainingRefundable(b: EvidenceBundle): Money {
  return usd(Math.max(0, capturedTotal(b).minor - refundedTotal(b).minor))
}

export function isFullyRefunded(b: EvidenceBundle): boolean {
  const cap = capturedTotal(b).minor
  return cap > 0 && refundedTotal(b).minor >= cap
}

/** The most recent failed refund, if any — carries the gateway's reason. */
export function lastFailedRefund(b: EvidenceBundle) {
  const t = b.payment?.transactions ?? []
  return (
    [...t]
      .filter(x => x.kind === 'refund' && x.status === 'failed')
      .sort((a, c) => c.at.getTime() - a.at.getTime())[0] ?? null
  )
}

export function hasDeadInstrument(b: EvidenceBundle): boolean {
  const f = lastFailedRefund(b)
  return !!f && (POLICY.deadInstrumentCodes as readonly string[]).includes(f.gatewayCode)
}

/** The successful capture a refund would be issued against. */
export function captureTxn(b: EvidenceBundle) {
  return b.payment?.transactions.find(x => x.kind === 'capture' && x.status === 'succeeded') ?? null
}

// --- carrier verification ---------------------------------------------------

export function verification(b: EvidenceBundle) {
  return primaryShipment(b)?.carrierVerification ?? null
}

/** A verification only counts if it is recent — a stale one proves nothing today. */
export function verificationIsFresh(b: EvidenceBundle): boolean {
  const v = verification(b)
  if (!v) return false
  return b.now.getTime() - v.verifiedAt.getTime() <= POLICY.verificationFreshnessHours * HOUR
}

export function priorClaimsInWindow(b: EvidenceBundle) {
  return b.priorClaims.filter(c => daysBetween(b.now, c.at) <= POLICY.priorClaimWindowDays)
}

/** An order that is closed is not an open operational problem. */
export function isClosed(b: EvidenceBundle): boolean {
  return b.order.status === 'refunded' || b.order.status === 'cancelled'
}
