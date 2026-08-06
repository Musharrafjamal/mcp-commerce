/**
 * The single cross-system fan-out.
 *
 * Every read of the world happens here, once, into one EvidenceBundle. Nothing
 * downstream issues a query — which is what makes detection, diagnosis, refund maths
 * and policy pure functions that can be tested without a database.
 */

import { actionLog, orderEvents, orders, payments, shipments } from '@/src/db/collections'
import type { EvidenceBundle } from '@/src/domain/types'
import { POLICY } from '@/src/config/policy'

const DAY = 86_400_000

export class OrderNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(
      `No order matches "${ref}". Accepted formats: "ORD-1004", "#1004" or "1004". ` +
        'If you do not have an order number, call ops_list_delayed_shipments to see the current queue.',
    )
    this.name = 'OrderNotFoundError'
  }
}

/**
 * Resolve a human-typed reference to a canonical order id.
 *
 * Deliberately EXACT — no fuzzy matching, no nearest-neighbour. An operator saying
 * "1004" means ORD-1004; an agent hallucinating "ORD-9999" must get an error, never
 * the closest order that happens to exist. Fuzzy matching on a money-touching
 * identifier is how you refund the wrong customer.
 */
export function normaliseOrderRef(ref: string): { id: string; orderNumber: string } | null {
  const t = ref.trim().toUpperCase()
  const digits = t.replace(/[^0-9]/g, '')
  if (!digits) return null
  if (/^ORD-\d+$/.test(t)) return { id: t, orderNumber: `#${digits}` }
  if (/^#?\d+$/.test(t)) return { id: `ORD-${digits}`, orderNumber: `#${digits}` }
  return null
}

export async function loadEvidenceBundle(ref: string, now = new Date()): Promise<EvidenceBundle> {
  const norm = normaliseOrderRef(ref)
  if (!norm) throw new OrderNotFoundError(ref)

  const ordersC = await orders()
  const order = await ordersC.findOne({ _id: norm.id })
  if (!order) throw new OrderNotFoundError(ref)

  const [events, payment, ships, actions, priorOrders] = await Promise.all([
    (await orderEvents()).find({ orderId: order._id }).sort({ at: 1 }).toArray(),
    (await payments()).findOne({ orderId: order._id }),
    (await shipments()).find({ orderId: order._id }).toArray(),
    (await actionLog()).find({ orderId: order._id }).sort({ createdAt: -1 }).limit(20).toArray(),
    // Prior orders by the same customer, for the non-receipt claim signal.
    ordersC
      .find({ 'customer.id': order.customer.id, _id: { $ne: order._id } })
      .sort({ placedAt: -1 })
      .limit(20)
      .toArray(),
  ])

  // A prior claim is a previous order where this customer contacted support after a
  // recorded delivery. Only the ids and dates travel — never the customer's prose.
  const priorClaims: EvidenceBundle['priorClaims'] = []
  if (priorOrders.length) {
    const priorEvents = await (await orderEvents())
      .find({ orderId: { $in: priorOrders.map(o => o._id) }, type: 'customer_contact' })
      .toArray()
    for (const e of priorEvents) {
      if (now.getTime() - e.at.getTime() > POLICY.priorClaimWindowDays * DAY) continue
      const o = priorOrders.find(x => x._id === e.orderId)!
      priorClaims.push({
        orderId: o._id,
        at: e.at,
        summary: `${o.orderNumber}: customer reported non-receipt; order status is "${o.status}".`,
      })
    }
  }

  return { order, events, payment, shipments: ships, priorClaims, recentActions: actions, now }
}

/** Every open order, for the triage queue. Bounded — this is not a reporting tool. */
export async function loadOpenBundles(limit = 60, now = new Date()): Promise<EvidenceBundle[]> {
  const candidates = await (await orders())
    .find({ status: { $in: ['open', 'fulfilled'] } })
    .sort({ placedAt: 1 })
    .limit(limit)
    .toArray()

  return Promise.all(candidates.map(o => loadEvidenceBundle(o._id, now)))
}
