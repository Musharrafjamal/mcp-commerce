import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ACTOR, TEST_NOW, closeDb, refundTxns, reseed, verify } from './helpers'
import { executeAction } from '@/src/services/actions'
import { mintPlan } from '@/src/services/plans'
import { decide, getAction, listPending } from '@/src/services/approvals'
import { getDb } from '@/src/db/client'
import { COLLECTIONS } from '@/src/db/collections'

beforeAll(reseed)
afterAll(closeDb)

const later = (ms: number) => new Date(TEST_NOW.getTime() + ms)

describe('I1 — exactly-once', () => {
  test('executing the same plan twice refunds once and replays byte-for-byte', async () => {
    await verify('ORD-1007')
    const plan = await mintPlan('ORD-1007', { mode: 'full_order' }, ACTOR, TEST_NOW)
    expect(plan.policy.decision).toBe('allow')

    const first = await executeAction(plan.planId, ACTOR, {}, later(1000))
    expect(first.status).toBe('executed')
    expect(first.replayed).toBe(false)

    const second = await executeAction(plan.planId, ACTOR, {}, later(2000))

    expect(second.replayed).toBe(true)
    expect(second.isError).toBe(false) // an error here would invite a fresh plan
    expect(second.status).toBe('executed')
    // Byte-identical apart from the replay marker: the cached result is returned, not recomputed.
    expect({ ...second, replayed: false }).toEqual({ ...first, replayed: false })

    // The assertion that actually matters.
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(1)
  })

  test('a second plan with an identical effect replays instead of refunding again', async () => {
    // The failure plan-level idempotency cannot catch: agent hits a problem, dutifully
    // re-previews, and executes a DIFFERENT plan id with the same effect.
    await reseed()
    await verify('ORD-1001')

    const a = await mintPlan('ORD-1001', { mode: 'full_order' }, ACTOR, TEST_NOW)
    const b = await mintPlan('ORD-1001', { mode: 'full_order' }, ACTOR, TEST_NOW)
    expect(a.planId).not.toBe(b.planId)

    await executeAction(a.planId, ACTOR, {}, later(1000))
    const second = await executeAction(b.planId, ACTOR, {}, later(2000))

    expect(second.replayed).toBe(true)
    expect((await refundTxns(a.computed.targetPaymentId)).length).toBe(1)
  })
})

describe('I2 — stale plans fail closed', () => {
  test('a refund settling out of band invalidates a plan, and nothing is written', async () => {
    await reseed()
    await verify('ORD-1001')
    const plan = await mintPlan('ORD-1001', { mode: 'full_order' }, ACTOR, TEST_NOW)

    // Someone refunds by hand in the admin while the plan is in flight.
    const db = await getDb()
    await db.collection(COLLECTIONS.payments).updateOne({ _id: plan.computed.targetPaymentId as never }, {
      $push: {
        transactions: {
          txnId: 'TXN-OUTOFBAND',
          kind: 'refund',
          status: 'succeeded',
          amount: plan.computed.amount,
          at: later(500),
          gatewayRef: 're_manual',
          gatewayCode: 'approved',
        },
      },
    } as never)

    const out = await executeAction(plan.planId, ACTOR, {}, later(1000))

    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('STALE_PLAN')
    expect(out.error?.message).toContain('settled refund')
    // Exactly one recovery call, never a menu.
    expect(out.error?.recovery).toContain('ops_preview_refund')
    // Only the manual one exists; the plan added nothing.
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(1)
  })

  test('an expired plan cannot execute', async () => {
    await reseed()
    await verify('ORD-1007')
    const plan = await mintPlan('ORD-1007', { mode: 'full_order' }, ACTOR, TEST_NOW)

    const out = await executeAction(plan.planId, ACTOR, {}, later(20 * 60_000))

    expect(out.isError).toBe(true)
    expect(out.error?.code).toBe('PLAN_EXPIRED')
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(0)
  })

  test('a plan id the agent invented is rejected without a lookup-alike fallback', async () => {
    const out = await executeAction('PLAN-TOTALLYMADEUP', ACTOR, {}, TEST_NOW)
    expect(out.error?.code).toBe('PLAN_NOT_FOUND')
    expect(out.error?.message).toContain('cannot be constructed')
  })
})

describe('I3 — the human gate actually gates', () => {
  test('over-ceiling: queued with evidence, zero money moved', async () => {
    await reseed()
    await verify('ORD-1002')
    const plan = await mintPlan('ORD-1002', { mode: 'full_order' }, ACTOR, TEST_NOW)
    expect(plan.policy.decision).toBe('require_approval')

    const out = await executeAction(plan.planId, ACTOR, {}, later(1000))

    expect(out.status).toBe('requires_approval')
    expect(out.isError).toBe(false) // a successful queueing, not a failure
    expect(out.approval?.summaryMd).toContain('P1_REFUND_CEILING')
    expect(out.approval?.approvalUrl).toBe(`/approvals/${plan.planId}`)
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(0)

    expect((await listPending()).map(a => a._id)).toContain(plan.planId)
  })

  test('approving it executes exactly one refund and records who and why', async () => {
    const pending = await listPending()
    const id = pending[0]._id

    const out = await decide(id, 'approve', 'priya@example.com', 'Carrier confirmed loss; goodwill refund.', later(5000))

    expect(out.status).toBe('executed')
    const doc = await getAction(id)
    expect(doc?.approval?.decidedBy).toBe('priya@example.com')
    expect(doc?.approval?.decisionNote).toContain('Carrier confirmed loss')
    expect((await refundTxns(doc!.computed!.targetPaymentId)).length).toBe(1)
  })

  test('a decision is single-use', async () => {
    const pending = await listPending()
    expect(pending.length).toBe(0) // the one item was consumed by the approval above

    // An unknown action is refused rather than silently created.
    let unknown: string | null = null
    try {
      await decide('PLAN-NOPE', 'approve', 'x@y.z', 'note')
    } catch (e) {
      unknown = (e as Error).message
    }
    expect(unknown).toContain('No action')
  })

  test('an already-decided action cannot be decided a second time', async () => {
    await reseed()
    await verify('ORD-1002')
    const plan = await mintPlan('ORD-1002', { mode: 'full_order' }, ACTOR, TEST_NOW)
    await executeAction(plan.planId, ACTOR, {}, later(1000))
    await decide(plan.planId, 'approve', 'priya@example.com', 'First and only decision.', later(2000))

    let second: string | null = null
    try {
      await decide(plan.planId, 'approve', 'someone.else@example.com', 'Second bite.', later(3000))
    } catch (e) {
      second = (e as Error).message
    }
    expect(second).toContain('not awaiting approval')
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(1)
  })

  test('rejecting never moves money, and the note is mandatory', async () => {
    await reseed()
    await verify('ORD-1002')
    const plan = await mintPlan('ORD-1002', { mode: 'full_order' }, ACTOR, TEST_NOW)
    await executeAction(plan.planId, ACTOR, {}, later(1000))

    await expect(decide(plan.planId, 'reject', 'priya@example.com', '   ')).rejects.toThrow(/note is required/i)

    const out = await decide(plan.planId, 'reject', 'priya@example.com', 'Customer already compensated offline.')
    expect(out.status).toBe('rejected')
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(0)
  })

  test('a signature overrides require_approval but NOT a hard invariant', async () => {
    // The reason approval re-enters executeAction instead of calling the effect: if the
    // world changed while the request sat in the queue, approving it still must not pay.
    await reseed()
    await verify('ORD-1002')
    const plan = await mintPlan('ORD-1002', { mode: 'full_order' }, ACTOR, TEST_NOW)
    await executeAction(plan.planId, ACTOR, {}, later(1000))

    const db = await getDb()
    await db.collection(COLLECTIONS.payments).updateOne({ _id: plan.computed.targetPaymentId as never }, {
      $push: {
        transactions: {
          txnId: 'TXN-BEATENTOIT',
          kind: 'refund',
          status: 'succeeded',
          amount: plan.computed.amount,
          at: later(2000),
          gatewayRef: 're_manual2',
          gatewayCode: 'approved',
        },
      },
    } as never)

    const out = await decide(plan.planId, 'approve', 'priya@example.com', 'Approved, but the world moved.', later(9000))

    expect(out.status).not.toBe('executed')
    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(1) // the manual one only
  })
})

describe('I4 — concurrency', () => {
  test('five parallel executions of one plan produce exactly one refund', async () => {
    await reseed()
    await verify('ORD-1007')
    const plan = await mintPlan('ORD-1007', { mode: 'full_order' }, ACTOR, TEST_NOW)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => executeAction(plan.planId, ACTOR, {}, later(1000))),
    )

    const executed = results.filter(r => r.status === 'executed' && !r.replayed)
    expect(executed.length).toBe(1)

    // Losers must be replays or a distinct retryable IN_FLIGHT — never a crash, and
    // never a generic failure that would make the model re-preview and double-refund.
    for (const r of results.filter(r => !(r.status === 'executed' && !r.replayed))) {
      const ok = r.replayed || r.error?.code === 'IN_FLIGHT'
      expect(ok).toBe(true)
      if (r.error?.code === 'IN_FLIGHT') expect(r.error.retryAfterMs).toBeGreaterThan(0)
    }

    expect((await refundTxns(plan.computed.targetPaymentId)).length).toBe(1)
  })
})

describe('the verification precondition end to end', () => {
  test('without verification the plan is denied; verifying flips the same order to allow', async () => {
    await reseed()

    const unverified = await mintPlan('ORD-1007', { mode: 'full_order' }, ACTOR, TEST_NOW)
    expect(unverified.policy.decision).toBe('deny')
    const denied = await executeAction(unverified.planId, ACTOR, {}, later(1000))
    expect(denied.isError).toBe(false) // a refusal is not an error
    expect(denied.status).toBe('denied')
    expect(denied.policy?.doNotRetry).toBe(true)
    expect((await refundTxns(unverified.computed.targetPaymentId)).length).toBe(0)

    await verify('ORD-1007', later(2000))
    const verified = await mintPlan('ORD-1007', { mode: 'full_order' }, ACTOR, later(3000))
    expect(verified.policy.decision).toBe('allow')
  })

  test('ORD-1006 is refused as premature even after verification', async () => {
    await reseed()
    const v = await verify('ORD-1006')
    expect(v.verification.status).toBe('IN_TRANSIT')

    const plan = await mintPlan('ORD-1006', { mode: 'full_order' }, ACTOR, later(1000))
    expect(plan.policy.decision).toBe('deny')
    expect(plan.policy.guidance).toContain('Do not retry')
  })

  test('every attempt is recorded, including the refused ones', async () => {
    // Self-contained: produce the denial inside this test rather than relying on one
    // left behind by an earlier test, which a reseed would silently erase.
    await reseed()
    const plan = await mintPlan('ORD-1007', { mode: 'full_order' }, ACTOR, TEST_NOW) // unverified -> deny
    const out = await executeAction(plan.planId, ACTOR, {}, later(1000))
    expect(out.status).toBe('denied')

    const db = await getDb()
    const doc = await db.collection(COLLECTIONS.actionLog).findOne({ _id: plan.planId as never })

    // The refusal is as auditable as a success: who asked, what it would have done,
    // which rules fired, and the verbatim response the agent was given.
    expect(doc?.status).toBe('denied')
    expect(doc?.policy?.decision).toBe('deny')
    expect(doc?.policy?.rules?.length).toBe(9)
    expect(doc?.actor?.label).toBe(ACTOR.label)
    expect(doc?.computed?.amount).toBeDefined()
    expect(doc?.result).toBeDefined()
    expect(doc?.transitions?.map((t: { status: string }) => t.status)).toEqual(['planned', 'claimed', 'denied'])
  })
})
