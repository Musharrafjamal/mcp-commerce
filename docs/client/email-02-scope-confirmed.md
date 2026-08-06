# Email 02 — scope confirmed (outbound)

**To:** Deepak, DiligenceAI Team
**Date:** 2026-08-05
**Status:** ready to send
**In reply to:** their 2026-08-04 answers to Q1–Q5 (see `email-01-scope-proposal.md`)

---

**Subject:** Re: Take-home — scope confirmed, building now

Hi Deepak,

Thanks — that's exactly the steer I needed. Confirming what I'm building, and flagging one place where I want to make sure I've read you correctly.

**Narrowed scope, per your point 1.** One workflow: a delayed or lost order → a verified carrier exception → the refund decision that follows. Inventory is now out of scope entirely — I've cut the reship and inventory-hold tools that would have pulled it back in, which takes the MCP from six tools to five and the data model from eight collections to five. Narrower is better here and I'm glad you pushed.

I'm treating "**verified** carrier exception" as a hard precondition rather than a label: the policy engine refuses any refund without a carrier verification less than 24 hours old, and refuses again if the carrier comes back "in transit, revised ETA" rather than "lost." One of my seeded cases exists specifically to be *refused as premature* on those grounds, so the verification step is demonstrably load-bearing rather than decorative.

**Approval escalation, per points 2 and 4.** I've reversed my earlier position and built the manager-approval queue. Anything that isn't a clean auto-approve now becomes an escalation carrying the full evidence bundle — the merged timeline, the computed refund amount, the specific rule that fired, and the recommended action — and a manager approves or rejects it with a required note. Delivered-but-not-received escalates at any amount, with no assumption about which team picks it up.

**One thing I want to confirm I've read correctly.** You said to escalate *rather than deny*. I've kept a small number of hard denials for conditions that no approval could make correct — refunding more than was captured (your point 3), issuing a duplicate of a refund that already executed, and refunding an order the carrier has just confirmed is still in transit. Everything that is a *judgment* call — over the ceiling, low diagnostic confidence, disputed delivery, a dead payment instrument — escalates rather than dead-ends. **If you'd rather even those three go to a manager instead of being refused outright, say the word; it's a one-line change.**

**Points 3 and 5 are in as specified:** a flat $150 ceiling, never exceeding the amount captured, and a static bearer token on the hosted MCP with no custom auth system. I'll include the URL and token in the README so any MCP-compatible client connects in under a minute.

I'll send a short update once the server is deployed and connectable, and again if anything material changes. All data is synthetic and self-generated.

Best,
Musharraf Jamal
Software Developer

---

## What this email commits us to

| Their point | Implemented as | Verified by |
|---|---|---|
| 1 · one delayed/lost-order workflow, verified carrier exception, no four-domain sprawl | 5 tools, 5 collections, inventory removed | `E1` (exactly 5 tools) |
| 1 · "**verified**" carrier exception | rule `P3` — refund denied without a <24h verification, or if it returns `IN_TRANSIT` | `U11` |
| 2 · auto-refund only if every condition passes, else manager escalation with evidence | verdicts `allow` / `deny` / `require_approval`; `/approvals` queue | `I3` |
| 3 · flat $150, never exceed paid | `P1` (rolling 24h window) + `P2` (hard invariant) | `U4`, `U5` |
| 4 · no team assumption on not-received / fraud | `P5` — escalates at any amount | `U6` |
| 5 · any MCP client, static bearer token | bearer check in the route handler, path-token fallback | `E3` |
