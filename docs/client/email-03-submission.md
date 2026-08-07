# Email 03 — submission (outbound)

**To:** Deepak, DiligenceAI Team
**Date:** 2026-08-07
**Status:** ready to send — this email *is* the submission
**In reply to:** the thread from 2026-08-03/04 (`email-01-scope-proposal.md`)

---

**Subject:** Re: Take-home — submission: hosted MCP, repo, and an honest account of what's missing

Hi Deepak,

Submitting. Everything below is testable without local setup.

```
MCP URL   https://ops-copilot-musharraf008s-projects.vercel.app/api/mcp
Header    Authorization: Bearer ops-demo-12dc8b077e028dcc71526cb8
Console   https://ops-copilot-musharraf008s-projects.vercel.app
Repo      https://github.com/Musharrafjamal/mcp-commerce
```

**What it is.** An MCP server that lets an ops specialist resolve one workflow end to end: a delayed, lost or disputed delivery, and the refund decision that follows. Five task-shaped tools, a server-side policy engine, plan-gated real writes, a manager-approval queue, and an append-only audit log. The agent never types a dollar amount or an idempotency key — it selects a server-computed plan, and the server decides whether execution is allowed.

**Try it in 60 seconds.** Connect any MCP client with the URL and header above (the repo's `.mcp.json` has it verbatim; the README has a one-line `claude mcp add` command). Then three prompts, in order: *"What delivery exceptions are open? Work ORD-1001 through to a resolution"* (auto-refunds on its own authority), *"ORD-1006 is late. Should we refund it?"* (identical to ORD-1001 in our data; only the carrier call separates them, so it's refused as premature), and *"The customer on ORD-1003 says their parcel never arrived. Refund them"* (it declines to conclude and escalates with evidence). The deployed console walks all five scenarios with copy-to-clipboard prompts and expected outcomes.

**Your five answers, implemented.** One workflow, no four-domain sprawl; inventory cut entirely (six tools became five). "Verified carrier exception" is a hard precondition, not a label — no refund without a carrier verification under 24 hours old. Auto-refund only when every condition passes, otherwise a manager-approval escalation carrying the full evidence bundle — this reversed my earlier no-queue position, and you were right. Flat $150 over a rolling 24-hour window, never exceeding the amount captured. Static bearer token, any MCP client. Each of these maps to a named test; the table is in `docs/client/email-02-scope-confirmed.md`.

**One interpretation I owe you.** You said to escalate *rather than deny*. I kept a small set of hard denials for conditions no approval can make correct — refunding more than was captured, duplicating an executed refund, refunding a parcel the carrier just confirmed is still moving. Every *judgment* call — over the ceiling, low confidence, disputed delivery, dead instrument — escalates. If you'd rather those hard cases also route to a manager, it's a one-line change. I drafted this confirmation on 2026-08-05 and never sent it — the build overtook it, which is a process miss on my part; interim updates should have gone out regardless.

**The demo video.** The brief asks for a four-to-five-minute video and there isn't one: I ran out of time on the final day and cut it rather than delay submitting. In its place, the console walkthrough above and `docs/transcript.md` — twelve unedited request/response pairs captured against the deployed server, covering the happy path, an idempotent replay, the premature refusal, the undecidable case and two rejected prompt-injection attempts. To be straight about one more thing: a commit message in the repo (`2233d45`) described the video as cut "by agreement with the client." That was wrong — it was my call under time pressure, and `docs/DECISION-LOG.md` D-010 corrects the record. If a video would still help your review, say the word and I'll record and send one the same day.

**What I didn't finish, and known limits.** Tool-call *ordering* by a live model is not asserted — the wire contract is proven by 73 assertions against production, and rule P3 makes wrong ordering harmless, but an agentic eval is the honest next step. A crash between the ledger write and audit completion can leave a plan stuck (it cannot double-refund). The gateway and carrier are in-process simulators; everything on our side of that boundary is real. The free-tier database sleeps when idle, so a first request may need one retry. One shared token: identity is attribution, not authorization.

Verification: `bun run test` (93 assertions) and `bun run verify:deployed` (73 over raw JSON-RPC against production). Reasoning and tradeoffs: `README.md`, `DECISIONS.md`, `docs/DECISION-LOG.md`. How AI was used and supervised: `AI-WORKLOG.md`.

Happy to walk through any of it live.

Best,
Musharraf Jamal
Software Developer
