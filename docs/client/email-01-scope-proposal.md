# Email 01 — scope proposal (sent) + client reply

**To:** Deepak, DiligenceAI Team
**Sent:** 2026-08-03
**Replied:** 2026-08-04
**Status:** closed — answers folded into `DECISION-LOG.md` D-005 through D-008

---

## Outbound

**Subject:** Take-home — proposed scope, assumptions, and five questions before I build

Hi Deepak,

I want to present my proposed scope to you, since the brief asks me to treat you as the client. Below is what I intend to build, what I'm deliberately leaving out, and five questions where your context would change a decision. If I don't hear back I'll proceed exactly as described. Every assumption will be listed in a DECISIONS.md in the repo.

The user and the problem. I'm building for an ops specialist at a mid-size DTC brand, someone who can see the storefront admin but not the payment gateway ledger, the warehouse reservation table, or the carrier scan history. Today every cross-system question ("why is #1043 stuck?") becomes a Slack message to an engineer who hand-writes database queries and then performs the fix himself. That's the dependency I want to remove.

The workflow is one end-to-end process: stuck-order triage. detect → investigate → preview → act → verify, spanning all four domains the brief names. I considered two narrower alternatives and rejected both: payment-failure recovery (tighter, but really only exercises one domain) and oversell / inventory reconciliation (great safety story, weaker cross-system investigation story). Stuck-order triage is the one where the MCP has to do genuine cross-system reasoning, which is the part I think is worth showing you.

**Q1: Is that the workflow you'd most want to see, or would one of the other two be more useful to your team?**

The MCP is the product. Six task-shaped tools, not a database wrapper. I'm explicitly not shipping a query_orders(filter) tool, because that would put the causal reasoning in the chat transcript instead of on the server. Two read tools (list the triage queue; investigate one order into a merged timeline plus ranked root causes with evidence and a confidence band), one planning tool, and three write tools. Plus resources and a prompt so the methodology lives on the server too.

The safety model, and a decision I'd like to sanity-check with you. Write tools perform real mutations, but the agent never types a dollar amount, a quantity, or an idempotency key. It asks the server to compute a plan, and executes that plan by ID. A server-side policy engine then returns one of three verdicts: allow (executes immediately), deny (a hard invariant e.g. never refund more than was captured), or escalate (beyond the autonomous envelope — over the amount ceiling, low diagnostic confidence, or a dead payment instrument — which returns a complete evidence handoff for a human).

I've deliberately chosen not to build an approval queue, and I want to be explicit about the tradeoff. A queue would let a human sign off on the high-value cases instead of the agent refusing them. I've left it out because it reintroduces exactly the human dependency this product exists to remove — an ops specialist waiting on a second approver is only marginally better off than one waiting on an engineer. Furthermore, a system that queues everything is indistinguishable from a broken one. I'd rather the engine act on its own authority where it can prove the case, and hand off cleanly where it can't. The cost is real: high-value cases dead-end rather than getting routed.

**Q2: does that match how you'd actually deploy something like this, or would your ops org require a human signature on any LLM-initiated refund?** The architecture supports both — it's one constant.

**Q3: what's a realistic auto-approval ceiling for a refund at your scale, and is it a flat amount or a percentage of order value?** I've assumed a flat $150. Flat is more legible; percentage handles a $2,000 order more gracefully. A real number would make the demo more credible than my invented one.

**Q4: Who owns a "delivered but not received" claim — ops, or a fraud/finance team?** This determines whether the escalation path is in-product or a hand-off. I've built the hand-off, which is the smaller assumption.

**Q5: Which MCP client will you actually review in — Claude Code, Claude Desktop, or the MCP Inspector?** This changes real decisions around auth and interactive confirmation prompts. I've defaulted to requiring no token so that any client connects.

Musharraf Jamal
Software Developer

---

## Reply — Deepak, DiligenceAI Team, 2026-08-04

> 1. Build one delayed or lost-order workflow with a verified carrier exception and the refund decision that follows; do not span all four domains.
> 2. An automated refund is allowed only when every approved condition passes. Otherwise, create a manager-approval escalation with the evidence rather than denying it or executing it after a generic confirmation.
> 3. Use a flat $150 limit and do not exceed the paid amount.
> 4. Do not assume a specific team owns a delivered-but-not-received or fraud claim. Create a manager-approval escalation with the relevant evidence for human review.
> 5. Use any MCP-compatible AI client for the demo. Use a static bearer token for the hosted MCP; no custom authentication system is needed.

---

## Disposition

| Q | Answer | Decision entry | Was it a reversal? |
|---|---|---|---|
| 1 | One delayed/lost-order workflow, verified carrier exception, no four-domain sprawl | D-006 | **Yes** — narrower than any option offered |
| 2 | Auto-refund only if every condition passes, else manager-approval escalation with evidence | D-005 | **Yes** — reverses D-002 (no approval queue) |
| 3 | Flat $150, never exceed the amount paid | confirmed `P1` + `P2` | No |
| 4 | No team assumption; escalate with evidence for human review | `P5`, escalates at any amount | Refines the earlier hand-off design |
| 5 | Any MCP client; static bearer token, no custom auth | D-007 | **Yes** — reverses the no-token default |

One point of interpretation raised back to them in `email-02-scope-confirmed.md`: they said escalate
*"rather than denying it"*, but also *"do not exceed the paid amount"* — which no approval can make
correct. See D-008 for the reconciliation and the open question.
