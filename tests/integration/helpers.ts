/**
 * Integration-test harness.
 *
 * Runs against a SEPARATE database (`opscopilot_test`) so a test run can never touch
 * the data a reviewer is looking at. The database is dropped and reseeded before each
 * test file, so ordering between files cannot matter.
 */

import { clientPromise, getDb } from '@/src/db/client'
import { COLLECTIONS } from '@/src/db/collections'
import { ensureIndexes } from '@/src/db/indexes'
import { ALL_SCENARIOS, buildScenario } from '@/src/fixtures/scenarios'
import { verifyCarrierException } from '@/src/services/plans'
import type { Actor } from '@/src/services/types'

process.env.MONGODB_DB = 'opscopilot_test'

export const TEST_NOW = new Date('2026-08-06T12:00:00.000Z')
export const ACTOR: Actor = { label: 'test-operator' }

export async function reseed(): Promise<void> {
  const db = await getDb()
  for (const name of Object.values(COLLECTIONS)) await db.collection(name).deleteMany({})
  await ensureIndexes()

  const built = ALL_SCENARIOS().map((s, i) => buildScenario(s, i, TEST_NOW))
  await db.collection(COLLECTIONS.orders).insertMany(built.map(b => b.order) as never[])
  await db.collection(COLLECTIONS.shipments).insertMany(built.map(b => b.shipment) as never[])
  await db.collection(COLLECTIONS.payments).insertMany(built.map(b => b.payment) as never[])
  await db.collection(COLLECTIONS.orderEvents).insertMany(built.flatMap(b => b.events) as never[])
}

/** Most refund paths need a fresh carrier verification first — that is rule P3. */
export async function verify(orderRef: string, now = TEST_NOW) {
  return verifyCarrierException(orderRef, ACTOR, now)
}

export async function refundTxns(paymentId: string) {
  const db = await getDb()
  const p = await db.collection(COLLECTIONS.payments).findOne({ _id: paymentId as never })
  return ((p?.transactions ?? []) as { kind: string; status: string }[]).filter(
    t => t.kind === 'refund' && t.status === 'succeeded',
  )
}

export async function closeDb() {
  await (await clientPromise).close()
}
