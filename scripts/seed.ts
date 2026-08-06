/**
 * Writes the synthetic dataset to Atlas. No real customer data, no production credentials.
 *
 *   bun run seed
 *
 * The scenarios themselves live in src/fixtures/scenarios.ts so the unit tests assert
 * against exactly the data the demo runs on.
 */

import { ensureIndexes } from '@/src/db/indexes'
import { getDb, DB_NAME } from '@/src/db/client'
import { COLLECTIONS } from '@/src/db/collections'
import { ALL_SCENARIOS, HEALTHY_COUNT, SCENARIOS, buildScenario, seedNow } from '@/src/fixtures/scenarios'
import { formatMoney } from '@/src/domain/types'

const now = seedNow()
const all = ALL_SCENARIOS()

const db = await getDb()
console.log(`\nseeding "${DB_NAME}"  (SEED_NOW = ${now.toISOString()})\n`)

for (const name of Object.values(COLLECTIONS)) {
  await db.collection(name).deleteMany({})
}
await ensureIndexes()

const built = all.map((s, i) => buildScenario(s, i, now))

await db.collection(COLLECTIONS.orders).insertMany(built.map(b => b.order) as never[])
await db.collection(COLLECTIONS.shipments).insertMany(built.map(b => b.shipment) as never[])
await db.collection(COLLECTIONS.payments).insertMany(built.map(b => b.payment) as never[])
await db.collection(COLLECTIONS.orderEvents).insertMany(built.flatMap(b => b.events) as never[])

// --- manifest: doubles as the demo script AND the test expectation table -----

const pad = (s: string, n: number) => s.padEnd(n)

console.log('MANIFEST - planted scenarios\n')
console.log(`  ${pad('ORDER', 10)}${pad('TOTAL', 10)}${pad('CARRIER TRUTH', 17)}${pad('DETECTED AS', 22)}EXPECTED`)
console.log(`  ${'-'.repeat(118)}`)
for (let i = 0; i < SCENARIOS.length; i++) {
  const s = SCENARIOS[i]
  console.log(
    `  ${pad(s.id, 10)}${pad(formatMoney(built[i].order.totals.grandTotal), 10)}` +
      `${pad(s.simCarrierTruth.status, 17)}${pad(s.expectDetected ?? '(none)', 22)}${s.expect}`,
  )
}
console.log(`\n  + ${HEALTHY_COUNT} healthy filler orders (must not be detected)`)
console.log(`  = ${all.length} orders, ${built.flatMap(b => b.events).length} events\n`)

const counts = await Promise.all(
  Object.values(COLLECTIONS).map(async n => `${n}=${await db.collection(n).countDocuments()}`),
)
console.log(`  ${counts.join('  ')}\n`)

process.exit(0)
