import type { Collection } from 'mongodb'
import { getDb } from './client'
import type { ActionLogEntry, Order, OrderEvent, Payment, Shipment } from '@/src/domain/types'

/** Five collections. Inventory and a variants catalogue are out of scope per the client. */
export const COLLECTIONS = {
  orders: 'orders',
  orderEvents: 'order_events',
  payments: 'payments',
  shipments: 'shipments',
  actionLog: 'action_log',
} as const

export async function orders(): Promise<Collection<Order>> {
  return (await getDb()).collection<Order>(COLLECTIONS.orders)
}

export async function orderEvents(): Promise<Collection<OrderEvent>> {
  return (await getDb()).collection<OrderEvent>(COLLECTIONS.orderEvents)
}

export async function payments(): Promise<Collection<Payment>> {
  return (await getDb()).collection<Payment>(COLLECTIONS.payments)
}

export async function shipments(): Promise<Collection<Shipment>> {
  return (await getDb()).collection<Shipment>(COLLECTIONS.shipments)
}

export async function actionLog(): Promise<Collection<ActionLogEntry>> {
  return (await getDb()).collection<ActionLogEntry>(COLLECTIONS.actionLog)
}
