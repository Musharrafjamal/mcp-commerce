# Product decisions, assumptions and exclusions

The per-decision audit trail — including the ones that got overturned — is in
[`docs/DECISION-LOG.md`](./docs/DECISION-LOG.md). The client email thread is in
[`docs/client/`](./docs/client/). This document is the reasoning.

---

## The bounded problem

**User:** an operations specialist at a mid-size DTC brand. They can see the storefront admin. They
cannot see the payment gateway ledger or the carrier scan history, so every cross-system question
becomes a Slack message to an engineer who hand-writes queries and then performs the fix himself.

**Workflow, exactly one:** a delayed, lost or disputed delivery → a verified carrier exception → the
refund decision that follows.

I originally proposed something wider — stuck-order triage across orders, payments, inventory and
fulfilment. The client narrowed it, and they were right: four domains in a four-hour budget buys four
shallow detectors instead of one credible investigation.

### In scope

A remotely hosted TypeScript MCP server on Vercel; five task-shaped tools, three resources and one
prompt; deterministic server-side detection and diagnosis; a nine-rule policy engine; plan-gated writes
that perform **real mutations**; two-layer exactly-once; a manager-approval queue; an append-only audit
log; a deliberately plain console; 93 assertions plus 73 over the wire.

### Out of scope, and why

| Excluded | Why |
|---|---|
| Payment-failure recovery, returns, inventory | Client instruction: *"do not span all four domains."* |
| Reship as a remedy | It pulls inventory back in. The client named the refund decision specifically. |
| OAuth 2.1 / protected-resource metadata | Client asked for a static bearer token. Publishing an OAuth document with no authorization server behind it dead-ends a compliant client — worse than no OAuth. |
| User management, roles | Explicitly not expected. Identity here is attribution, not authorization. |
| A real PSP or carrier | Simulated at the boundary. Everything on our side of it is real. |
| An in-app LLM chat playground | See below — the most interesting exclusion. |
| CI/CD | Explicitly not expected. `bun run test` and `bun run verify:deployed`. |
| Frontend polish | The console is the approval boundary, not a product surface. |
| The 4–5 minute demo video | Cut for time on the final day — my call, not a client agreement. The deployed console walkthrough and `docs/transcript.md` stand in. See D-010, which also corrects an inaccurate commit message that claimed otherwise. |

---

## Why the MCP looks like this

### Task-shaped tools, not a database wrapper

There is no `query_orders(filter)`, no `get_order`, no `get_payment`. The temptation is real — one
generic query tool would have been faster to write and would have "supported" every question.

It would also have moved the entire product into the chat transcript. If the model performs the join
between the payment ledger and the carrier scans, then the causal reasoning lives in a conversation that
is different every time, cannot be tested, and cannot be audited. **The join is the product.** A tool
called `ops_investigate_delivery_exception` can be unit-tested; a transcript cannot.

The count is five because each tool is a distinct risk boundary — read, external call, proposal,
execution — not because five is a nice number. The happy path from a named order is three calls.

### The descriptions are the interface

They were written **before any handler body**, and the schemas were made to serve them. Each follows one
six-element shape: what it does (first clause decides selection), when to use it, when *not* to and which
sibling instead, preconditions, cost, what comes back and what to call next.

Two things I would not have done a year ago. **Chaining hints go in the response, not only the
description** — `next: "ops_issue_refund(plan_id: \"PLAN-…\")"` is read at the moment of decision, while
a description was read forty thousand tokens earlier. And **every description says what the tool is
*not* for**, because an agent choosing between five similar tools is failing at discrimination, not
comprehension.

### Two tools are honestly marked `readOnlyHint: false`

`ops_verify_carrier_exception` and `ops_preview_refund` move no money. Marking them read-only would have
been convenient and would have suppressed a confirmation prompt in some clients. They both persist
records — a verification, a proposal — and *every proposal is auditable, including the ones never
executed*. Claiming read-only is a small lie a sharp reviewer catches, so the description explains the
nuance instead.

### There is no `dry_run` boolean

A flag that flips a tool between safe and dangerous makes its annotation dishonest in one of the two
modes, and an omitted flag becomes a real charge. Preview and execute are separate tools with separate
annotations.

---

## The safety model, and the one decision I reversed

Write tools perform **real mutations**. An advisory-only design was considered and rejected: it makes
"act safely, then verify" theatre, never exercises the idempotency ledger or the compare-and-swap, and
deletes the most interesting property — that the engine *discriminates*, auto-approving a verified $87
loss while refusing an identical-looking $97 one because the carrier says the parcel is still moving.

**I initially decided against an approval queue**, on the grounds that an ops specialist waiting for a
second approver is only marginally better off than one waiting for an engineer. The client overruled
that, and I built it. On reflection they were right for a reason I had underweighted: without a queue,
every case outside the autonomous envelope simply *dead-ends*, and a system that refuses the hard half
of the work is not obviously better than the Slack message it replaced.

### Where `deny` survives

The client said to escalate *"rather than denying it"*. Taken literally that removes `deny` entirely —
but they also said *"do not exceed the paid amount"*, which no manager approval can make correct. So:

- **`deny`** only where approval is meaningless: refunding more than was captured, refunding twice,
  refunding a parcel the carrier just confirmed is moving, an order already fully refunded, the circuit
  breaker.
- **`require_approval`** for every judgment call: over the ceiling, low confidence, a disputed delivery,
  a dead payment instrument.

This reading is raised to the client in the submission email as a one-line change if wrong. It is the
one interpretation in the build that is mine rather than theirs.

### A refusal is not an error

`deny` and `require_approval` return as **ordinary results** with `isError: false`. Only mechanical
faults — a stale plan, an expired plan, a concurrent execution — are errors, each with exactly one
recovery call.

This is the single most consequential line in the codebase. An error invites a retry. Had "refund
denied" arrived as an error, a capable agent would dutifully reshape the request — fewer lines, a
smaller scope — and try again until something slipped through. Returning it as a result carrying
`do_not_retry` removes the incentive. `P1` also evaluates a **rolling 24-hour window** rather than the
amount in hand, so splitting a refused refund into two smaller ones does not evade the ceiling either.

### The agent cannot approve anything

There is no MCP tool that resolves an approval. The agent can raise one and read its status; a decision
exists only as a server action in the console. That single omission is what makes the human gate real
rather than theatrical.

---

## Why no in-app chat playground

The brief asks that the workflow be testable without local setup, which argues for one. I built the
hosted MCP URL and a start-here page instead, for three reasons — the third being decisive.

It costs roughly half the engineering budget. It reintroduces the frontend the brief says not to build,
plus a public model key on the attack surface. And **a bespoke chat UI obscures the MCP boundary rather
than demonstrating it**: from a chat transcript a reviewer cannot tell whether the diagnosis is
deterministic server-side logic or the model improvising over a query wrapper — and that distinction is
exactly what is being graded.

If I had another day the first thing I would add is not a chat but a headless console that server-renders
`tools/list` and generates a form per tool from its `inputSchema`. No model, no key, no spend, and it
shows the contract rather than hiding it.

---

## The objection I would raise if I were reviewing this

**I wrote both the fixtures and the rules that detect them.** "You planted the bugs and then found them"
is fair, and it strikes the load-bearing claim: that the server holds real reasoning rather than a lookup
table keyed on order id. Four things were done about it.

1. **Three orders exist only to be ignored.** ORD-1021 is silent for four days but inside SLA and before
   its promise date. ORD-1022 was delivered on time. ORD-0977 is delivered, disputed *and* refunded. A
   detector that fires on 100% of a dataset proves nothing; one that discriminates against deliberate
   lookalikes is a rule.
2. **ORD-1003 is deliberately undiagnosable,** and the *correct* output is low confidence, competing
   hypotheses each carrying contradicting evidence, and no recommendation. An engine that can fail
   honestly is the one you can believe when it succeeds.
3. **ORD-1006 is identical to ORD-1001 in our own data** and opposite in reality. Nothing on our side
   can separate them; only the carrier call can. That is what makes the verification step a mechanism
   rather than a label, and `U11` asserts all three states from one bundle.
4. **The tests key on the `EvidenceBundle`, never on an order id.** A rule that special-cased
   `ORD-1003` would fail its own test. `U3` removes the dispute contact from the bundle and asserts the
   ambiguity disappears.

It is still a synthetic dataset written by the same person as the rules. The mitigations narrow that
objection; they do not eliminate it.

---

## Assumptions

Beyond what the client answered: refunds go to the original instrument; line-level refunds cover line
subtotals only, with shipping and tax not apportioned; a carrier verification is meaningful for 24 hours;
a parcel silent for 7 days past its promise date is an exception; a delivery within 30 m of the shipping
address supports the carrier's account; prior non-receipt claims are surfaced for 180 days but never
weighted into the ranking, because a customer's history is not evidence about where *this* parcel went.

Every one of these is a single constant in `src/config/policy.ts`, and the published policy resource is
rendered from that same object — so it cannot drift from what is enforced.

## What another day would buy

An agentic eval asserting no refund fires without a preceding verification and preview in-trace; a claim
reaper for the stuck-`claimed` edge case; per-operator tokens so audit attribution names real people;
MCP elicitation so the approval prompt is protocol-native for clients that support it; and the headless
tool console described above.
