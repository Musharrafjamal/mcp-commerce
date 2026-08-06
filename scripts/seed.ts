/**
 * Deterministic synthetic seed. No real customer data, no production credentials.
 *
 *   bun run seed
 *
 * Determinism: the 10 fixtures are LITERAL. The PRNG is used only for filler orders
 * and is never called conditionally, so the same input always produces the same
 * database. Timestamps are offsets from a single SEED_NOW (overridable by env so
 * tests can pin absolutely), which means "a 9-day scan gap" is still 9 days when a
 * reviewer opens this next Tuesday.
 */

import { ensureIndexes } from '@/src/db/indexes'
import { getDb, DB_NAME } from '@/src/db/client'
import { COLLECTIONS } from '@/src/db/collections'
import {
  usd,
  formatMoney,
  type Address,
  type CarrierScan,
  type Order,
  type OrderEvent,
  type Payment,
  type PaymentTransaction,
  type Shipment,
  type ScanCode,
  type CarrierVerificationStatus,
  type GatewayCode,
} from '@/src/domain/types'

// --- determinism ------------------------------------------------------------

const SEED_NOW = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date()
const DAY = 86_400_000

const daysAgo = (n: number) => new Date(SEED_NOW.getTime() - n * DAY)
const hoursAgo = (n: number) => new Date(SEED_NOW.getTime() - n * 3_600_000)

/** mulberry32 — small, fast, deterministic. Filler data only. */
function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0xc0ffee)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]

// --- fixture vocabulary -----------------------------------------------------

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
    line1: `${100 + (i * 37) % 800} Alder St`,
    city: c.city,
    region: c.region,
    postalCode: c.postalCode,
    country: 'US',
    geo: c.geo,
  }
}

// --- builders ---------------------------------------------------------------

type ScanSpec = { daysAgo: number; code: ScanCode; location: string; description: string }

type Scenario = {
  id: string
  num: string
  customer: { id: string; name: string; email: string }
  subtotalMinor: number
  placedDaysAgo: number
  promisedDaysAgo: number // positive = in the past (breached), negative = future
  scans: ScanSpec[]
  shipmentStatus: Shipment['status']
  deliveredDaysAgo?: number
  /** Metres of drift between the carrier's delivery geo and shipTo. Disputed-claim signal. */
  deliveryGeoDriftM?: number
  captureCode?: GatewayCode
  /** A refund that already succeeded — makes a second refund exceed the captured total. */
  priorRefundMinor?: number
  /** A failed refund attempt, e.g. the instrument died. */
  failedRefund?: { minor: number; code: GatewayCode; message: string }
  customerContact?: { daysAgo: number; text: string }
  simCarrierTruth: { status: CarrierVerificationStatus; note: string; revisedEtaDays?: number }
  orderStatus?: Order['status']
  /** Documentation only — printed in the manifest, never read by any rule. */
  expect: string
}

const money = (subtotal: number) => {
  const shipping = 500
  const tax = Math.round(subtotal * 0.08)
  return { subtotal: usd(subtotal), shipping: usd(shipping), tax: usd(tax), grandTotal: usd(subtotal + shipping + tax) }
}

function build(s: Scenario, idx: number) {
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
        status: s.priorRefundMinor ? 'refunded' : delivered ? 'delivered' : 'shipped',
        shipmentId,
      },
    ],
    totals,
    shipTo: address(s.customer.name, idx),
    promisedDeliveryDate: promised,
    updatedAt: placedAt,
  }

  // A metre of latitude is ~1/111_320 of a degree. Drift is what separates
  // "delivered to the right doorstep" from "delivered somewhere else entirely".
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
    deliveryGeo: delivered
      ? { lat: order.shipTo.geo.lat + drift, lng: order.shipTo.geo.lng }
      : undefined,
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

  // --- events -------------------------------------------------------------
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
    evt(placedAt, 'payment_authorized', 'psp', `Authorized ${formatMoney(totals.grandTotal)} on visa ••${payment.method.last4}.`),
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
      evt(daysAgo(2), 'refund_failed', 'psp', `Refund of ${formatMoney(usd(s.failedRefund.minor))} failed: ${s.failedRefund.code}.`, {
        gatewayCode: s.failedRefund.code,
      }),
    )
  }
  if (s.priorRefundMinor) {
    events.push(evt(daysAgo(1), 'refund_succeeded', 'psp', `Refunded ${formatMoney(usd(s.priorRefundMinor))}.`))
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime())

  return { order, shipment, payment, events, totals }
}

// --- the planted scenarios --------------------------------------------------

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

const SCENARIOS: Scenario[] = [
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
    expect: 'ALLOW  -> auto-refunds. Also the idempotency-replay demo (run it twice).',
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
    expect: 'ALLOW  -> auto-refunds. The engine acting on its own authority.',
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
    expect: 'DENY (premature) -> looks identical to a lost parcel until you VERIFY. Proves the verification step is load-bearing.',
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
    expect: 'REQUIRE_APPROVAL at any amount + LOW confidence -> competing hypotheses, no recommended action. Video centrepiece.',
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
    priorRefundMinor: 6332, // == grandTotal: already fully refunded by hand
    orderStatus: 'refunded',
    simCarrierTruth: { status: 'LOST_IN_TRANSIT', note: 'Trace closed. Parcel declared lost in transit.' },
    expect: 'DENY -> already fully refunded. A second refund would exceed the captured total (P2/P9).',
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
    expect: 'REQUIRE_APPROVAL -> original instrument is dead; alternate disbursement needed. Policy with domain knowledge, not arithmetic.',
  },

  // --- the prior-claim history for ORD-1003's customer -----------------------
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
    simCarrierTruth: { status: 'DELIVERED', note: 'GPS-confirmed delivery at address.' },
    expect: 'NOT DETECTED (closed, refunded) -> exists only to be the prior-claim signal on ORD-1003.',
  },

  // --- near misses: exist only to NOT be flagged ----------------------------
  {
    id: 'ORD-1021',
    num: '#1021',
    customer: cust(21, 'Omar', 'Haddad'),
    subtotalMinor: 6200,
    placedDaysAgo: 5,
    promisedDaysAgo: -3, // promise date is in the FUTURE
    scans: LOST_SCANS(4),
    shipmentStatus: 'in_transit',
    simCarrierTruth: { status: 'IN_TRANSIT', note: 'Moving normally.' },
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
    expect: 'NOT DETECTED -> delivered on time, no complaint.',
  },
]

// --- filler: healthy in-flight and delivered orders --------------------------

function filler(i: number): Scenario {
  const n = 30 + i
  const first = FIRST[i % FIRST.length]
  const last = LAST[i % LAST.length]
  const deliveredDaysAgo = 2 + (i % 5)
  return {
    id: `ORD-${1030 + i}`,
    num: `#${1030 + i}`,
    customer: cust(n, first, last),
    subtotalMinor: 2500 + Math.floor(rand() * 12000),
    placedDaysAgo: deliveredDaysAgo + 4,
    promisedDaysAgo: deliveredDaysAgo, // delivered on or before the promise
    scans: [
      ...LOST_SCANS(deliveredDaysAgo + 2).slice(0, 3),
      { daysAgo: deliveredDaysAgo, code: 'delivered', location: pick(CITIES).city, description: 'Delivered' },
    ],
    shipmentStatus: 'delivered',
    deliveredDaysAgo,
    deliveryGeoDriftM: 4,
    simCarrierTruth: { status: 'DELIVERED', note: 'Delivered.' },
    expect: 'healthy',
  }
}

// --- run --------------------------------------------------------------------

const HEALTHY_COUNT = 18
const all: Scenario[] = [...SCENARIOS, ...Array.from({ length: HEALTHY_COUNT }, (_, i) => filler(i))]

const db = await getDb()
console.log(`\nseeding "${DB_NAME}"  (SEED_NOW = ${SEED_NOW.toISOString()})\n`)

for (const name of Object.values(COLLECTIONS)) {
  await db.collection(name).deleteMany({})
}
await ensureIndexes()

const built = all.map((s, i) => build(s, i))

await db.collection(COLLECTIONS.orders).insertMany(built.map(b => b.order) as never[])
await db.collection(COLLECTIONS.shipments).insertMany(built.map(b => b.shipment) as never[])
await db.collection(COLLECTIONS.payments).insertMany(built.map(b => b.payment) as never[])
await db.collection(COLLECTIONS.orderEvents).insertMany(built.flatMap(b => b.events) as never[])

// --- manifest: doubles as the demo script AND the test expectation table -----

console.log('MANIFEST — planted scenarios\n')
const w = (s: string, n: number) => s.padEnd(n)
console.log(`  ${w('ORDER', 10)}${w('TOTAL', 10)}${w('CARRIER TRUTH', 17)}EXPECTED`)
console.log(`  ${'-'.repeat(96)}`)
for (let i = 0; i < SCENARIOS.length; i++) {
  const s = SCENARIOS[i]
  console.log(
    `  ${w(s.id, 10)}${w(formatMoney(built[i].totals.grandTotal), 10)}${w(s.simCarrierTruth.status, 17)}${s.expect}`,
  )
}
console.log(`\n  + ${HEALTHY_COUNT} healthy filler orders (must not be detected)`)
console.log(`  = ${all.length} orders, ${built.flatMap(b => b.events).length} events\n`)

const counts = await Promise.all(
  Object.values(COLLECTIONS).map(async n => `${n}=${await db.collection(n).countDocuments()}`),
)
console.log(`  ${counts.join('  ')}\n`)

process.exit(0)
