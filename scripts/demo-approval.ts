/**
 * Put one refund into the approval queue, so `/approvals` has something in it.
 *
 * Useful before recording a demo, and as a smoke test that the escalation path writes
 * everything the approvals UI needs.
 *
 *   bun run scripts/demo-approval.ts [ORD-1002]
 */

import { executeAction } from '@/src/services/actions'
import { mintPlan, verifyCarrierException } from '@/src/services/plans'

const orderRef = process.argv[2] ?? 'ORD-1002' // $219.92 — over the $150 ceiling
const actor = { label: 'demo-operator' }

const v = await verifyCarrierException(orderRef, actor)
console.log(`carrier says ${v.verification.status} for ${v.trackingNumber}`)

const plan = await mintPlan(orderRef, { mode: 'full_order' }, actor)
console.log(`plan ${plan.planId} -> policy ${plan.policy.decision}`)

const out = await executeAction(plan.planId, actor)
console.log(`status: ${out.status}`)
console.log(out.approval ? `queued at ${out.approval.approvalUrl}` : out.effectSummary)

process.exit(0)
