/**
 * Writes the synthetic dataset to Atlas. No real customer data, no production credentials.
 *
 *   bun run seed
 *
 * The scenarios live in src/fixtures/scenarios.ts so the unit tests assert against
 * exactly the data the demo runs on; the write itself lives in src/services/reseed.ts
 * so the in-app reset button cannot drift from this script.
 */

import { dbName } from '@/src/db/client'
import { COLLECTIONS } from '@/src/db/collections'
import { getDb } from '@/src/db/client'
import { reseedDemoData } from '@/src/services/reseed'
import { ALL_SCENARIOS, HEALTHY_COUNT, SCENARIOS, buildScenario, seedNow } from '@/src/fixtures/scenarios'
import { formatMoney } from '@/src/domain/types'

const now = seedNow()
console.log(`\nseeding "${dbName()}"  (SEED_NOW = ${now.toISOString()})\n`)

const { orders, events } = await reseedDemoData(now)

// --- manifest: doubles as the demo script AND the test expectation table -----

const built = ALL_SCENARIOS().map((s, i) => buildScenario(s, i, now))
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
console.log(`  = ${orders} orders, ${events} events\n`)

const db = await getDb()
const counts = await Promise.all(
  Object.values(COLLECTIONS).map(async n => `${n}=${await db.collection(n).countDocuments()}`),
)
console.log(`  ${counts.join('  ')}\n`)

process.exit(0)
