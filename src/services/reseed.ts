import { getDb } from '@/src/db/client'
import { COLLECTIONS } from '@/src/db/collections'
import { ensureIndexes } from '@/src/db/indexes'
import { ALL_SCENARIOS, buildScenario, seedNow } from '@/src/fixtures/scenarios'

/**
 * Restore the demo dataset.
 *
 * Not a nice-to-have: without it, the second reviewer to open this finds a workflow
 * the first one already resolved and concludes the detectors are broken.
 *
 * Shared by `bun run seed` and the reset button so the two can never drift.
 */
export async function reseedDemoData(now = seedNow()): Promise<{ orders: number; events: number }> {
  const db = await getDb()
  for (const name of Object.values(COLLECTIONS)) await db.collection(name).deleteMany({})
  await ensureIndexes()

  const built = ALL_SCENARIOS().map((s, i) => buildScenario(s, i, now))
  await db.collection(COLLECTIONS.orders).insertMany(built.map(b => b.order) as never[])
  await db.collection(COLLECTIONS.shipments).insertMany(built.map(b => b.shipment) as never[])
  await db.collection(COLLECTIONS.payments).insertMany(built.map(b => b.payment) as never[])
  const events = built.flatMap(b => b.events)
  await db.collection(COLLECTIONS.orderEvents).insertMany(events as never[])

  return { orders: built.length, events: events.length }
}
