import { getDb } from './client'
import { COLLECTIONS } from './collections'

/**
 * Idempotent — safe to run on every seed.
 *
 * Only the first group does real work at demo scale. The read-pattern indexes are
 * honestly decorative across 28 orders; they are here because they are the indexes
 * this shape of query needs at any scale worth having, and saying so is more useful
 * than pretending 28 documents need them.
 *
 * Deliberately NO TTL index on action_log. Plan expiry is computed on read —
 * audit records must never evaporate.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb()

  // --- load-bearing -------------------------------------------------------
  await db.collection(COLLECTIONS.orders).createIndex({ orderNumber: 1 }, { unique: true })
  await db.collection(COLLECTIONS.shipments).createIndex({ trackingNumber: 1 }, { unique: true })
  // the semantic-dedupe lookup: "has this exact effect already executed recently?"
  await db
    .collection(COLLECTIONS.actionLog)
    .createIndex({ effectFingerprint: 1, status: 1, completedAt: -1 })

  // --- read patterns ------------------------------------------------------
  await db.collection(COLLECTIONS.orders).createIndex({ status: 1, placedAt: -1 })
  // the prior-claim signal for disputed deliveries
  await db.collection(COLLECTIONS.orders).createIndex({ 'customer.id': 1, placedAt: -1 })
  await db.collection(COLLECTIONS.orderEvents).createIndex({ orderId: 1, at: 1 })
  await db.collection(COLLECTIONS.payments).createIndex({ orderId: 1 })
  await db.collection(COLLECTIONS.shipments).createIndex({ orderId: 1 })
  await db.collection(COLLECTIONS.actionLog).createIndex({ orderId: 1, createdAt: -1 })
  await db.collection(COLLECTIONS.actionLog).createIndex({ status: 1, createdAt: -1 })
}
