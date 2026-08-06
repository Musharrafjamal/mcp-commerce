# Decision log

Append-only. One entry per decision that changed what got built. Entries are never edited after the
fact — a decision that turns out wrong gets a **superseding entry**, not a rewrite.

Two decision sources: **internal** (mine) and **client** (Deepak / DiligenceAI, via the email thread in
`docs/client/`). Client instructions win over internal ones; where one overrides the other, both entries
stay and cross-reference.

---

### D-001 · Bounded workflow

**Date:** 2026-08-03 **Status:** SUPERSEDED by D-006 **Decided by:** deferred to client

**Question:** Which operations workflow should the submission be bounded to?

**Options considered:**
- **A. Stuck-order triage** — one order goes bad; investigate across payment, inventory and fulfillment
  to find root cause, then resolve. Widest demo surface, richest MCP tools.
- **B. Payment-failure recovery** — failed charges, declines, dunning, duplicate charges. Tighter, but
  only exercises one of the four domains.
- **C. Oversell / inventory reconciliation** — orders accepted for stock that doesn't exist. Strong
  safety story, weaker cross-system investigation story.

**Chosen:** none internally. Escalated to the client as Q1 of `email-01-scope-proposal.md`, proposing A
with reasoning and asking them to veto rather than choose.

**Rationale:** the brief explicitly grades collaboration and says to treat the assessor as the client.
Picking a workflow unilaterally when the client's context would change the answer wastes the strongest
collaboration signal available.

**Superseded because:** the client narrowed it further than any of the three options — see D-006.

---

### D-002 · Write-tool autonomy model

**Date:** 2026-08-03 **Status:** SUPERSEDED by D-005 **Decided by:** Musharraf

**Question:** How far should the MCP's write tools go?

**Options considered:**
- **A. Real writes behind a human approval queue** — preview/execute modes, idempotency keys, a
  server-side policy engine, a human queue for anything over threshold, append-only audit log.
- **B. Read-only / advisory** — the agent investigates and recommends; a human executes elsewhere.
  Safest and fastest, but concedes the most interesting half of the brief.
- **C. Real writes, no approval queue** — policy caps and idempotency, auto-execute within policy,
  refuse outside it. No second-human dependency.

**Chosen:** C

**Rationale (verbatim):** *"high impact and no human dependency"* — a queue reintroduces exactly the
waiting-on-someone-else problem the product exists to remove.

**Consequences at the time:** policy verdicts became `allow` / `deny` / `escalate`; the `/approvals` UI
was cut; escalation returned a paste-ready handoff rather than queueing.

**Known cost, recorded at the time:** high-value and ambiguous cases dead-end at a refusal rather than
being routed for sign-off. A production deployment would likely want the queue back.

**Superseded because:** client instruction 2026-08-04 — see D-005.

---

### D-003 · Reviewer access

**Date:** 2026-08-03 **Status:** Decided **Decided by:** Musharraf

**Question:** How should the assessors exercise the workflow? The brief requires it be testable without
local setup.

**Options considered:**
- **A. Hosted MCP URL + an in-app chat playground** — reviewers who use an MCP client connect directly;
  everyone else drives the same server through an embedded chat. ~2–3h of a 4h budget.
- **B. Hosted MCP URL only** — README documents exact connection steps for each client.
- **C. MCP URL + an approval UI, no chat.**

**Chosen:** B

**Rationale:** a chat playground costs most of the engineering budget, reintroduces the frontend the
brief says not to build, and puts a public model key on the attack surface. Decisively: **a bespoke chat
UI obscures the MCP boundary rather than demonstrating it** — a reviewer cannot tell from a chat
transcript whether the diagnosis is deterministic server-side logic or the model improvising over a
query wrapper, and that distinction is exactly what is being graded.

**Replaced by, at ~55 min total:** a start-here page with copy-paste client configs and demo prompts; a
human-readable HTML response on `GET /api/mcp`; a verbatim captured client transcript in the README; and
a deterministic reset endpoint.

**Note:** the rejection paragraph in `DECISIONS.md` is worth more than the feature would have been.
If there were another day, the first addition would be a headless console that server-renders
`tools/list` and generates a form per tool from its `inputSchema` — no model, no key, no spend — not a chat.

---

### D-004 · Overall scope and budget

**Date:** 2026-08-03 **Status:** Decided **Decided by:** Musharraf

**Question:** How much to build, given a stated ~3–4 focused hours but a full week of wall clock?

**Options considered:**
- **A. Brief-faithful ~4–5h** — one workflow, real guardrails, focused tests, then spend the remaining
  time on README, DECISIONS, worklog and video, which are also graded.
- **B. Stretch ~8–10h** — richer dataset, second workflow, more polished console.
- **C. Build broad, submit narrow.**

**Chosen:** A

**Rationale:** *"thoughtful prioritization is part of the evaluation"* and *"a small, coherent solution
is preferable to a broad or polished implementation"* are both stated in the brief. Overbuilding is a
scored failure here, not a bonus. A committed drop order is written into `TASKS.md` up front so cuts are
decided in advance rather than under pressure.

---

### D-005 · Manager-approval escalation reinstated

**Date:** 2026-08-04 **Status:** Decided **Decided by:** Client (Deepak, DiligenceAI)

**Client instruction (verbatim):**
> "An automated refund is allowed only when every approved condition passes. Otherwise, create a
> manager-approval escalation with the evidence rather than denying it or executing it after a generic
> confirmation."

**Effect:** reverses D-002.
- Verdicts become `allow` / `deny` / `require_approval`.
- `/approvals` and `/approvals/[actionId]` rebuilt — pending queue, evidence bundle, computed effect,
  full policy rule list, Approve/Reject with a required note.
- `approvals.decide()` re-enters `executeAction()` at the **freshness** step, not the effect step, so
  freshness and policy are re-checked against live data at the moment of sign-off. There remains exactly
  one code path that moves money.
- Test I3 rewritten to prove the gate holds: over-ceiling → `pending_approval` with **zero** payment
  transactions; approve → exactly one; reject → zero, ever.

**Note:** this reversal is itself a submission artifact. `DECISIONS.md` and `AI-WORKLOG.md` both cite
it as a decision changed on client feedback.

---

### D-006 · Scope narrowed to delivery exceptions

**Date:** 2026-08-04 **Status:** Decided **Decided by:** Client (Deepak, DiligenceAI)

**Client instruction (verbatim):**
> "Build one delayed or lost-order workflow with a verified carrier exception and the refund decision
> that follows; do not span all four domains."

**Effect:** supersedes D-001, and narrows further than any option offered.
- Workflow is now: delayed / lost order → verified carrier exception → refund decision.
- **Inventory is out of scope entirely.** `ops_reship_order` and `ops_release_inventory_hold` cut.
- Tools 6 → **5**. Collections 8 → **5** (`inventory`, `inventory_ledger`, `variants` removed).
- All seed scenarios rewritten around delivery exceptions.
- "**Verified**" is implemented as a hard precondition, not a label — see D-008.

**Assessment:** the client was right and the original proposal was too wide. Four domains in a four-hour
budget would have meant four shallow detectors instead of one credible investigation.

---

### D-007 · Static bearer token on the hosted MCP

**Date:** 2026-08-04 **Status:** Decided **Decided by:** Client (Deepak, DiligenceAI)

**Client instruction (verbatim):**
> "Use any MCP-compatible AI client for the demo. Use a static bearer token for the hosted MCP; no
> custom authentication system is needed."

**Effect:** reverses the earlier default of requiring no token so that any client connects.
- Bearer check in the route handler, mapped to an actor label stamped on every `action_log` entry.
  **Identity is attribution, not authorization** — policy is byte-identical for every actor.
- No OAuth 2.1, no protected-resource metadata. Publishing an `oauth-protected-resource` document with
  no authorization server behind it dead-ends a compliant client, which is worse than no auth.
- New risk: some clients are known to drop custom headers on `tools/call`. A path-token fallback
  `/api/mcp/t/<token>` ships alongside and is documented.
- Test E3 added: no bearer → 401, wrong bearer → 401, correct bearer → 200.

---

### D-008 · `deny` reserved for conditions no approval can make correct

**Date:** 2026-08-05 **Status:** Decided, **flagged to client for correction** **Decided by:** Musharraf

**Question:** The client said to escalate *"rather than denying it."* Taken literally that removes `deny`
entirely. But they also said *"do not exceed the paid amount"* — a rule no manager approval can make
correct. How should the two instructions be reconciled?

**Chosen reading:**
- **`deny`** only where approval is meaningless: refund > amount captured (`P2`), a duplicate of an
  already-executed refund (`P7`), the carrier confirming the parcel is still in transit (`P3`), an order
  already cancelled or fully refunded (`P9`), circuit breaker tripped (`P8`).
- **`require_approval`** for every *judgment* call: over ceiling (`P1`), low diagnostic confidence
  (`P4`), disputed delivery (`P5`), dead payment instrument (`P6`).
- **`allow`** only when every condition passes — exactly as specified.

**Rationale:** escalating "refund more than was captured" to a manager would present a human with an
option that is never correct, which is worse product design than refusing it. But everything that is a
*business* judgment gets routed, per their instruction.

**Open:** stated back to the client in `email-02-scope-confirmed.md` as a one-line change if they
disagree. **If they respond, a superseding entry goes here rather than an edit to this one.**

---

### D-009 · No caller-supplied idempotency keys

**Date:** 2026-08-05 **Status:** Decided **Decided by:** Musharraf, rejecting an AI suggestion

**Suggestion rejected:** every write tool takes an `idempotency_key: string` argument supplied by the
caller — the standard REST/PSP pattern, and what the model proposed first.

**Why rejected:** an LLM is not a well-behaved API client. It reuses one key across different operations
in the same turn, and mints a *fresh* key when it retries after an error — which is exactly backwards
and defeats the entire mechanism at the moment it matters most.

**Replacement:** the server-minted, single-use, 15-minute, state-bound `plan_id` **is** the idempotency
key. Write tools accept nothing else. Execution is a conditional `planned → claimed` transition on a
single document, which is atomic in MongoDB and therefore the mutual-exclusion primitive. A second layer
— an `effectFingerprint` semantic dedupe over a 24h window — catches the specific failure the first layer
misses: agent hits `STALE_PLAN`, re-previews, re-executes.

**Consequence:** the agent cannot supply a dollar amount, a quantity, or an idempotency key on any tool.
There is no field for it. Proven by tests U9 and I1.
