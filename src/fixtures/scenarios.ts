/**
 * The synthetic dataset, as data.
 *
 * Shared by `scripts/seed.ts` (writes it to Atlas) and the unit tests (build an
 * EvidenceBundle in memory, no database). One source of truth, so a test can never
 * pass against a fixture the demo does not actually contain.
 *
 * Determinism: the 10 planted fixtures are LITERAL. The PRNG is used only for filler
 * orders and is never called conditionally. Timestamps are offsets from a single
 * SEED_NOW so "a 9-day scan gap" is still 9 days whenever a reviewer opens this.
 */

import {
  usd,
  formatMoney,
  type Address,
  type CarrierScan,
  type CarrierVerificationStatus,
  type EvidenceBundle,
  type ExceptionCode,
  type GatewayCode,
  type Order,
  type OrderEvent,
  type Payment,
  type PaymentTransaction,
  type ScanCode,
  type Shipment,
} from '@/src/domain/types'

const DAY = 86_400_000

export function seedNow(): Date {
  return process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date()
}

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CATALOGUE = [
  { sku: 'APL-TEE-BLK-M', title: 'Heavyweight Tee — Black, M' },
  { sku: 'APL-HOD-OAT-L', title: 'Loopback Hoodie — Oat, L' },
  { sku: 'APL-JKT-NVY-S', title: 'Quilted Overshirt — Navy, S' },
  { sku: 'ACC-CAP-GRN-OS', title: 'Corduroy Cap — Green' },
  { sku: 'APL-PNT-CHR-32', title: 'Wide Chino — Charcoal, 32' },
] as const

const CITIES = [
  { city: 'Portland', region: 'OR', postalCode: '97201', geo: { lat: 45.515, lng: -122.678 } },
  { city: 'Austin', region: 'TX', postalCode: '78701', geo: { lat: 30.267, lng: -97.743 } },
  { city: 'Denver', region: 'CO', postalCode: '80202', geo: { lat: 39.749, lng: -104.999 } },
  { city: 'Chicago', region: 'IL', postalCode: '60601', geo: { lat: 41.885, lng: -87.622 } },
] as const

const FIRST = ['Ava', 'Noah', 'Mia', 'Leo', 'Zoe', 'Kai', 'Iris', 'Omar', 'Nina', 'Ravi']
const LAST = ['Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Silva', 'Novak', 'Haddad', 'Berg']

function address(name: string, i: number): Address {
  const c = CITIES[i % CITIES.length]
  return {
    name,
    line1: `${100 + ((i * 37) % 800)} Alder St`,
    city: c.city,
    region: c.region,
    postalCode: c.postalCode,
    country: 'US',
    geo: c.geo,
  }
}

export type ScanSpec = { daysAgo: number; code: ScanCode; location: string; description: string }

export type Scenario = {
  id: string
  num: string
  customer: { id: string; name: string; email: string }
  subtotalMinor: number
  placedDaysAgo: number
  /** positive = in the past (promise breached), negative = still in the future */
  promisedDaysAgo: number
  scans: ScanSpec[]
  shipmentStatus: Shipment['status']
  deliveredDaysAgo?: number
  /** Metres between the carrier's claimed delivery point and shipTo. */
  deliveryGeoDriftM?: number
  captureCode?: GatewayCode
  /** A refund that already succeeded. */
  priorRefundMinor?: number
  /** A refund attempt that failed, e.g. the instrument died. */
  failedRefund?: { minor: number; code: GatewayCode; message: string }
  customerContact?: { daysAgo: number; text: string }
  simCarrierTruth: { status: CarrierVerificationStatus; note: string; revisedEtaDays?: number }
  orderStatus?: Order['status']
  lineStatus?: Order['lines'][number]['status']
  /** Documentation only — printed in the manifest, never read by any rule. */
  expect: string
  /**
   * The exception code detect() must produce for this fixture, or null for "must not
   * be detected". Typed as ExceptionCode rather than string so a typo here is a compile
   * error instead of a test that silently agrees with nothing.
   */
  expectDetected: ExceptionCode | null
}

const money = (subtotal: number) => {
  const shipping = 500
  const tax = Math.round(subtotal * 0.08)
  return {
    subtotal: usd(subtotal),
    shipping: usd(shipping),
    tax: usd(tax),
    grandTotal: usd(subtotal + shipping + tax),
  }
}

export type BuiltScenario = {
  order: Order
  shipment: Shipment
  payment: Payment
  events: OrderEvent[]
}

export function buildScenario(s: Scenario, idx: number, now: Date): BuiltScenario {
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY)
  const totals = money(s.subtotalMinor)
  const item = CATALOGUE[idx % CATALOGUE.length]
  const placedAt = daysAgo(s.placedDaysAgo)
  const promised = daysAgo(s.promisedDaysAgo)
  const shipmentId = `SHP-${s.id.slice(4)}`
  const lineId = `${s.id}-L1`
  const delivered = s.deliveredDaysAgo !== undefined

  const order: Order = {
    _id: s.id,
    orderNumber: s.num,
    placedAt,
    status: s.orderStatus ?? (delivered ? 'fulfilled' : 'open'),
    customer: s.customer,
    lines: [
      {
        lineId,
        sku: item.sku,
        title: item.title,
        qty: 1,
        unitPrice: usd(s.subtotalMinor),
        status: s.lineStatus ?? (delivered ? 'delivered' : 'shipped'),
        shipmentId,
      },
    ],
    totals,
    shipTo: address(s.customer.name, idx),
    promisedDeliveryDate: promised,
    updatedAt: placedAt,
  }

  // ~1/111_320 of a degree of latitude per metre.
  const drift = (s.deliveryGeoDriftM ?? 0) / 111_320

  const scans: CarrierScan[] = s.scans.map(sc => ({
    at: daysAgo(sc.daysAgo),
    code: sc.code,
    location: sc.location,
    description: sc.description,
  }))

  const shipment: Shipment = {
    _id: shipmentId,
    orderId: s.id,
    lineIds: [lineId],
    carrier: 'PacificPost',
    trackingNumber: `PP${s.id.replace(/\D/g, '')}00${idx}`,
    status: s.shipmentStatus,
    promisedDeliveryDate: promised,
    shippedAt: scans.length ? scans[0].at : undefined,
    deliveredAt: delivered ? daysAgo(s.deliveredDaysAgo!) : undefined,
    scans,
    lastScanAt: scans.length ? scans[scans.length - 1].at : undefined,
    deliveryGeo: delivered ? { lat: order.shipTo.geo.lat + drift, lng: order.shipTo.geo.lng } : undefined,
    simCarrierTruth: s.simCarrierTruth,
  }

  const txns: PaymentTransaction[] = [
    {
      txnId: `TXN-${s.id.slice(4)}-A`,
      kind: 'authorization',
      status: 'succeeded',
      amount: totals.grandTotal,
      at: placedAt,
      gatewayRef: `ch_${s.id.toLowerCase()}`,
      gatewayCode: 'approved',
    },
    {
      txnId: `TXN-${s.id.slice(4)}-C`,
      kind: 'capture',
      status: 'succeeded',
      amount: totals.grandTotal,
      at: new Date(placedAt.getTime() + 4000),
      gatewayRef: `ch_${s.id.toLowerCase()}`,
      gatewayCode: s.captureCode ?? 'approved',
    },
  ]
  if (s.priorRefundMinor) {
    txns.push({
      txnId: `TXN-${s.id.slice(4)}-R1`,
      kind: 'refund',
      status: 'succeeded',
      amount: usd(s.priorRefundMinor),
      at: daysAgo(1),
      gatewayRef: `re_${s.id.toLowerCase()}`,
      gatewayCode: 'approved',
      gatewayMessage: 'refunded by ops (manual, pre-copilot)',
    })
  }
  if (s.failedRefund) {
    txns.push({
      txnId: `TXN-${s.id.slice(4)}-RF`,
      kind: 'refund',
      status: 'failed',
      amount: usd(s.failedRefund.minor),
      at: daysAgo(2),
      gatewayRef: `re_${s.id.toLowerCase()}_f`,
      gatewayCode: s.failedRefund.code,
      gatewayMessage: s.failedRefund.message,
    })
  }

  const payment: Payment = {
    _id: `PAY-${s.id.slice(4)}`,
    orderId: s.id,
    method: { brand: 'visa', last4: String(4000 + idx).slice(-4), exp: '11/28' },
    transactions: txns,
  }

  let n = 0
  const evt = (
    at: Date,
    type: OrderEvent['type'],
    source: OrderEvent['source'],
    summary: string,
    data?: Record<string, unknown>,
  ): OrderEvent => ({ _id: `EVT-${s.id.slice(4)}-${++n}`, orderId: s.id, at, type, source, summary, data })

  const events: OrderEvent[] = [
    evt(placedAt, 'order_placed', 'storefront', `Order ${s.num} placed for ${formatMoney(totals.grandTotal)}.`),
    evt(
      placedAt,
      'payment_authorized',
      'psp',
      `Authorized ${formatMoney(totals.grandTotal)} on visa ••${payment.method.last4}.`,
    ),
    evt(new Date(placedAt.getTime() + 4000), 'payment_captured', 'psp', `Captured ${formatMoney(totals.grandTotal)}.`),
  ]
  for (const sc of scans) {
    events.push(
      evt(
        sc.at,
        sc.code === 'delivered' ? 'delivered' : sc.code === 'label_created' ? 'label_created' : 'carrier_scan',
        'carrier',
        `${sc.code.replace(/_/g, ' ')} at ${sc.location}.`,
        { scanCode: sc.code, location: sc.location },
      ),
    )
  }
  if (s.customerContact) {
    events.push(
      evt(daysAgo(s.customerContact.daysAgo), 'customer_contact', 'support', 'Customer contacted support.', {
        // Third-party free text. Fenced as untrusted on the way out; never read by a rule.
        customerText: s.customerContact.text,
      }),
    )
  }
  if (s.failedRefund) {
    events.push(
      evt(
        daysAgo(2),
        'refund_failed',
        'psp',
        `Refund of ${formatMoney(usd(s.failedRefund.minor))} failed: ${s.failedRefund.code}.`,
        { gatewayCode: s.failedRefund.code },
      ),
    )
  }
  if (s.priorRefundMinor) {
    events.push(evt(daysAgo(1), 'refund_succeeded', 'psp', `Refunded ${formatMoney(usd(s.priorRefundMinor))}.`))
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime())

  return { order, shipment, payment, events }
}

// ---------------------------------------------------------------------------
// The planted scenarios
// ---------------------------------------------------------------------------

const LOST_SCANS = (gap: number): ScanSpec[] => [
  { daysAgo: gap + 3, code: 'label_created', location: 'Reno, NV', description: 'Shipping label created' },
  { daysAgo: gap + 2, code: 'picked_up', location: 'Reno, NV', description: 'Picked up by carrier' },
  { daysAgo: gap + 1, code: 'departed_facility', location: 'Reno, NV', description: 'Departed sort facility' },
  { daysAgo: gap, code: 'arrived_hub', location: 'Salt Lake City, UT', description: 'Arrived at regional hub' },
]

const cust = (n: number, first: string, last: string) => ({
  id: `CUS-${1000 + n}`,
  name: `${first} ${last}`,
  email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
})

export const SCENARIOS: Scenario[] = [
  {
    id: 'ORD-1007',
    num: '#1007',
    customer: cust(7, 'Kai', 'Berg'),
    subtotalMinor: 3400,
    placedDaysAgo: 13,
    promisedDaysAgo: 4,
    scans: LOST_SCANS(9),
    shipmentStatus: 'in_transit',
    simCarrierTruth: { status: 'LOST_IN_TRANSIT', note: 'Parcel not located after hub sweep. Loss confirmed.' },
    expectDetected: 'CARRIER_SCAN_GAP',
    expect: 'ALLOW -> auto-refunds. Also the idempotency-replay demo (run it twice).',
  },
  {
    id: 'ORD-1001',
    num: '#1001',
    customer: cust(1, 'Ava', 'Okafor'),
    subtotalMinor: 7600,
    placedDaysAgo: 15,
    promisedDaysAgo: 6,
    scans: LOST_SCANS(11),
    shipmentStatus: 'in_transit',
    simCarrierTruth: { status: 'LOST_IN_TRANSIT', note: 'Trace closed. Parcel declared lost in transit.' },
    expectDetected: 'CARRIER_SCAN_GAP',
    expect: 'ALLOW -> auto-refunds. The engine acting on its own authority.',
  },
  {
    id: 'ORD-1002',
    num: '#1002',
    customer: cust(2, 'Noah', 'Lindqvist'),
    subtotalMinor: 19900,
    placedDaysAgo: 16,
    promisedDaysAgo: 7,
    scans: LOST_SCANS(12),
    shipmentStatus: 'in_transit',
    simCarrierTruth: { status: 'LOST_IN_TRANSIT', note: 'Trace closed. Parcel declared lost in transit.' },
    expectDetected: 'CARRIER_SCAN_GAP',
    expect: 'REQUIRE_APPROVAL -> over the $150 ceiling. Manager approves; the human loop closes.',
  },
  {
    id: 'ORD-1006',
    num: '#1006',
    customer: cust(6, 'Iris', 'Novak'),
    subtotalMinor: 8500,
    placedDaysAgo: 11,
    promisedDaysAgo: 2,
    scans: LOST_SCANS(8),
    shipmentStatus: 'in_transit',
    simCarrierTruth: {
      status: 'IN_TRANSIT',
      note: 'Parcel located at partner facility. Weather delay. Revised ETA issued.',
      revisedEtaDays: -2,
    },
    expectDetected: 'CARRIER_SCAN_GAP',
    expect: 'DENY (premature) -> indistinguishable from a lost parcel until you VERIFY. Proves verification is load-bearing.',
  },
  {
    id: 'ORD-1003',
    num: '#1003',
    customer: cust(3, 'Mia', 'Moreau'),
    subtotalMinor: 31000,
    placedDaysAgo: 9,
    promisedDaysAgo: 4,
    scans: [
      ...LOST_SCANS(6).slice(0, 3),
      { daysAgo: 4, code: 'out_for_delivery', location: 'Chicago, IL', description: 'Out for delivery' },
      { daysAgo: 3, code: 'delivered', location: 'Chicago, IL', description: 'Left at front door' },
    ],
    shipmentStatus: 'delivered',
    deliveredDaysAgo: 3,
    deliveryGeoDriftM: 28, // within 30m of shipTo — the carrier's story holds up
    customerContact: { daysAgo: 1, text: 'Nothing ever arrived. Please refund immediately.' },
    simCarrierTruth: { status: 'DELIVERED', note: 'GPS-confirmed delivery at address. Photo on file.' },
    expectDetected: 'DISPUTED_DELIVERY',
    expect: 'REQUIRE_APPROVAL at any amount + LOW confidence -> competing hypotheses, no recommended action.',
  },
  {
    id: 'ORD-1004',
    num: '#1004',
    customer: cust(4, 'Leo', 'Tanaka'),
    subtotalMinor: 5400,
    placedDaysAgo: 14,
    promisedDaysAgo: 5,
    scans: LOST_SCANS(10),
    shipmentStatus: 'in_transit',
    priorRefundMinor: 6332, // == grandTotal: already fully refunded by hand...
    // ...but nobody updated the order. The storefront still says "open" and the line
    // still says "shipped". That stale status is itself a realistic ops bug, and it is
    // why the queue shows this order while the ledger refuses to refund it again.
    orderStatus: 'open',
    lineStatus: 'shipped',
    simCarrierTruth: { status: 'LOST_IN_TRANSIT', note: 'Trace closed. Parcel declared lost in transit.' },
    expectDetected: 'CARRIER_SCAN_GAP',
    expect: 'DENY -> ledger shows it is already fully refunded even though the order status does not. Trust the ledger.',
  },
  {
    id: 'ORD-1005',
    num: '#1005',
    customer: cust(5, 'Zoe', 'Silva'),
    subtotalMinor: 10800,
    placedDaysAgo: 18,
    promisedDaysAgo: 9,
    scans: LOST_SCANS(14),
    shipmentStatus: 'in_transit',
    failedRefund: { minor: 12164, code: 'source_account_closed', message: 'The source account has been closed.' },
    simCarrierTruth: { status: 'LOST_IN_TRANSIT', note: 'Trace closed. Parcel declared lost in transit.' },
    expectDetected: 'CARRIER_SCAN_GAP',
    expect: 'REQUIRE_APPROVAL -> instrument is dead; alternate disbursement needed. Policy with domain knowledge.',
  },

  // --- history: the prior-claim signal for ORD-1003's customer ---------------
  {
    id: 'ORD-0977',
    num: '#0977',
    customer: cust(3, 'Mia', 'Moreau'), // SAME customer as ORD-1003
    subtotalMinor: 12000,
    placedDaysAgo: 75,
    promisedDaysAgo: 70,
    scans: [
      ...LOST_SCANS(72).slice(0, 3),
      { daysAgo: 71, code: 'delivered', location: 'Chicago, IL', description: 'Left at front door' },
    ],
    shipmentStatus: 'delivered',
    deliveredDaysAgo: 71,
    deliveryGeoDriftM: 22,
    customerContact: { daysAgo: 71, text: 'Package never showed up.' },
    priorRefundMinor: 13460,
    orderStatus: 'refunded',
    lineStatus: 'refunded',
    simCarrierTruth: { status: 'DELIVERED', note: 'GPS-confirmed delivery at address.' },
    expectDetected: null,
    expect: 'NOT DETECTED (closed and refunded) -> exists only to be the prior-claim signal on ORD-1003.',
  },

  // --- near misses: exist only so that detect() does NOT fire ---------------
  {
    id: 'ORD-1021',
    num: '#1021',
    customer: cust(21, 'Omar', 'Haddad'),
    subtotalMinor: 6200,
    placedDaysAgo: 5,
    promisedDaysAgo: -3, // promise date is still in the FUTURE
    scans: LOST_SCANS(4),
    shipmentStatus: 'in_transit',
    simCarrierTruth: { status: 'IN_TRANSIT', note: 'Moving normally.' },
    expectDetected: null,
    expect: 'NOT DETECTED -> 4-day scan gap, but inside SLA and before the promise date.',
  },
  {
    id: 'ORD-1022',
    num: '#1022',
    customer: cust(22, 'Nina', 'Novak'),
    subtotalMinor: 4500,
    placedDaysAgo: 12,
    promisedDaysAgo: 6,
    scans: [
      ...LOST_SCANS(10).slice(0, 3),
      { daysAgo: 8, code: 'out_for_delivery', location: 'Denver, CO', description: 'Out for delivery' },
      { daysAgo: 8, code: 'delivered', location: 'Denver, CO', description: 'Handed to resident' },
    ],
    shipmentStatus: 'delivered',
    deliveredDaysAgo: 8,
    deliveryGeoDriftM: 5,
    simCarrierTruth: { status: 'DELIVERED', note: 'Signed for by resident.' },
    expectDetected: null,
    expect: 'NOT DETECTED -> delivered on time, no complaint.',
  },
]

export const HEALTHY_COUNT = 18

/** Filler orders. Healthy, delivered on time, must never be detected. */
export function fillerScenarios(): Scenario[] {
  const rand = mulberry32(0xc0ffee)
  return Array.from({ length: HEALTHY_COUNT }, (_, i) => {
    const first = FIRST[i % FIRST.length]
    const last = LAST[i % LAST.length]
    const deliveredDaysAgo = 2 + (i % 5)
    const subtotalMinor = 2500 + Math.floor(rand() * 12000)
    const city = CITIES[i % CITIES.length].city
    return {
      id: `ORD-${1030 + i}`,
      num: `#${1030 + i}`,
      customer: cust(30 + i, first, last),
      subtotalMinor,
      placedDaysAgo: deliveredDaysAgo + 4,
      promisedDaysAgo: deliveredDaysAgo,
      scans: [
        ...LOST_SCANS(deliveredDaysAgo + 2).slice(0, 3),
        { daysAgo: deliveredDaysAgo, code: 'delivered' as ScanCode, location: city, description: 'Delivered' },
      ],
      shipmentStatus: 'delivered' as const,
      deliveredDaysAgo,
      deliveryGeoDriftM: 4,
      simCarrierTruth: { status: 'DELIVERED' as CarrierVerificationStatus, note: 'Delivered.' },
      expectDetected: null,
      expect: 'healthy',
    }
  })
}

export const ALL_SCENARIOS = (): Scenario[] => [...SCENARIOS, ...fillerScenarios()]

// ---------------------------------------------------------------------------
// In-memory EvidenceBundle — lets every pure-function test run with no database
// ---------------------------------------------------------------------------

export function buildBundle(orderId: string, now = seedNow()): EvidenceBundle {
  const all = ALL_SCENARIOS()
  const idx = all.findIndex(s => s.id === orderId)
  if (idx < 0) throw new Error(`no fixture for ${orderId}`)
  const built = buildScenario(all[idx], idx, now)

  // Prior not-received claims by the same customer, from other orders.
  const priorClaims = all
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.id !== orderId && s.customer.id === all[idx].customer.id && s.customerContact)
    .map(({ s, i }) => {
      const b = buildScenario(s, i, now)
      return {
        orderId: s.id,
        at: new Date(now.getTime() - s.customerContact!.daysAgo * DAY),
        summary: `${s.num}: customer reported non-receipt; refund ${
          s.priorRefundMinor ? 'was issued' : 'was not issued'
        }.`,
        _events: b.events.length, // keeps the builder honest about being used
      }
    })
    .map(({ orderId: o, at, summary }) => ({ orderId: o, at, summary }))

  return {
    order: built.order,
    events: built.events,
    payment: built.payment,
    shipments: [built.shipment],
    priorClaims,
    recentActions: [],
    now,
  }
}
