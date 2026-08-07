# AI worklog

## Tools and models

| Phase | Tool / model | Why |
|---|---|---|
| Research | **Claude Opus 5** via Claude Code, 4 parallel agents | Four independent unknowns — MCP-on-Next.js hosting, MCP tool-design practice, Atlas-on-serverless, reviewer access — with no dependencies between them. Parallel agents each verifying against live documentation, rather than one context accumulating four topics' worth of noise. |
| Design | **Claude Opus 5**, 3 agents with different briefs | Three deliberately conflicting lenses: maximise MCP depth, ruthlessly minimise scope, design backwards from the threat model. Independent proposals surface the real trade-offs; one agent asked to "consider trade-offs" just produces a hedged menu. |
| Synthesis | **Claude Opus 5**, high reasoning effort | Ruling on the conflicts between those three, with reasons. |
| Implementation, debugging, tests, review | **Claude Opus 5** via Claude Code | Long-horizon work across ~30 files where a mistake in the policy engine is a money bug. Not a place to trade capability for speed. |

Everything ran through Claude Code with filesystem, shell, MongoDB and browser access, so the model could
execute what it wrote rather than hand me code to run.

## How the work was planned

I did not start with code. The first action was an eight-agent research and design pass whose brief was
the assignment itself, and whose output was a single ruled architecture — tool set, data model, policy
rules, test list, build order and a committed drop list.

That output became `TASKS.md`: eleven sections, roughly seventy nested checkboxes, timeboxes on the parts
known to overrun, and a **drop order written down in advance** so that cuts under time pressure were
decided while calm. `TASKS.md` was updated as work landed, including with the defects found — it is a
record, not a plan I wrote once.

This front-loading paid for itself twice. The research flagged that Vercel Deployment Protection would
silently break a hosted MCP server, which is why the very first task was a 20-minute spike to production
before a single domain file existed. It fired exactly as predicted.

## Division of responsibility

**Mine.** The product decisions, all of them. Which workflow to bound to. Whether write tools should
mutate for real. Whether to ship an in-app chat playground. How much to build. Whether to take the
client's narrowing. Every policy threshold and the reading of "escalate rather than deny". I also chose
to put the questions to the client rather than assume, which changed the shape of the build twice.

**Delegated.** Implementation, test authoring, and the research legwork of verifying which package
versions and APIs are current.

**Neither.** The interesting cases. The confidence formula, the deny-versus-escalate boundary and the
untrusted-text design were argued back and forth — the model proposed, I rejected or amended, it
implemented the amendment.

## Instructions and context that mattered

- **The whole assignment brief, verbatim, in every research prompt.** Cheap, and it stopped agents
  optimising for the wrong thing.
- **"Verify against live documentation; flag anything you could not verify."** The MCP specification and
  `mcp-handler` were days old and Vercel's own MCP docs were stale. Every version and API in this repo
  was checked against the npm registry or the installed `.d.ts`, never recalled from memory.
- **A hard constraint that research agents create no files and run no installs.** Research contaminating
  the working tree is a real failure mode.
- **"Commit to decisions. No menus of options."** Design agents default to enumerating alternatives,
  which pushes the decision back to me unimproved.
- **"Descriptions before handler bodies, and budget a third of the MCP hour on prose alone."** The tool
  descriptions are the highest-weighted artefact in the submission; writing them last would have made
  them documentation of whatever got built.
- **"A refusal is not an error."** Repeated at every layer, because it is the one design rule that is
  counter-intuitive to a model trained to be helpful.

## Suggestions I rejected or changed

**Caller-supplied idempotency keys — rejected outright.** The first design gave every write tool an
`idempotency_key` argument. It is the standard REST/PSP pattern and it is wrong here: an LLM is not a
well-behaved API client. It reuses one key across different operations in a turn, and mints a *fresh* one
when retrying after an error — exactly backwards, defeating the mechanism at the moment it matters.
Replaced with a server-minted, single-use, state-bound `plan_id` that **is** the idempotency key. Write
tools accept nothing else. This changed the whole architecture: it is why no tool has an amount field.

**`mongodb@7.5.0` — my error, corrected.** Research recommended `^6`; I installed latest anyway. It
cannot load under Bun at all (`bson` calls `v8.startupSnapshot.isBuildingSnapshot()`, unimplemented).
Node was fine, so production was never at risk, but `bun test` needs the driver. Reverted to `^6`. The
lesson was mine, not the model's.

**The confidence formula — caught by its own test.** As written it divided by *all* supporting facts, so
an order scored `medium` purely because nobody had yet called the carrier. Absent evidence was reading as
a failed check. Changed so optional evidence adds a bonus but never divides.

**"No root cause matched" treated as low confidence — a real bug.** Empty and ambiguous are opposite
conditions, and conflating them would have escalated every healthy order to a manager as *unresolvable*.

**A test of mine that passed for the wrong reason — twice.** The auth matrix was green while Deployment
Protection was answering *every* request with 401, so "wrong token rejected" meant nothing. I added an
assertion that fails if any platform wall sits in front of the server. Separately, the "no tool accepts
an amount" check grepped the serialised schema and was matching the words "high-**value**" inside a
description; it now inspects actual field names. Both were my tests, and both would have shipped green.

**The approval queue — reversed on client feedback.** I argued against it: an ops specialist waiting on
an approver is barely better off than one waiting on an engineer. The client overruled me and was right
for a reason I had underweighted — without a queue, every hard case simply dead-ends.

## How the work was verified

Nothing here is verified by reading the code and finding it plausible.

- **93 assertions.** 78 pure functions with no database and no MCP client, 15 integration tests against a
  separate `opscopilot_test` database so a run can never touch demo data.
- **75 assertions over raw JSON-RPC against the deployed URL**, deliberately without the MCP client SDK,
  so what is asserted is the wire contract a reviewer's client will actually hit. This walks the whole
  workflow: refused before verification, carrier confirms, same order allowed, executes, re-issue
  replays, refund visible on re-investigation.
- **Tests written to prove named claims**, not for coverage. Three orders exist only to be *not*
  detected. One is deliberately undiagnosable, and the passing condition is that the engine refuses to
  conclude.
- **The approval flow driven by hand in a browser against production**, not just unit-tested — because a
  server action's form wiring is exactly the sort of thing tests miss. That check is what caught the
  cold-start 500 on `/audit`.
- **Every claim in the README that says "impossible" is backed by a test**, and where something is only
  *caught* rather than prevented, the table says so.

## Remaining risks and unfinished work

- **Tool-call *ordering* by a live model is not asserted.** The tests prove each step and the wire
  contract; they do not prove a model will always verify before previewing. The prompt, the descriptions
  and rule P3 all push that way, and P3 makes the wrong order harmless — but an agentic eval asserting
  "no refund fired without a preceding verification in-trace" is the honest next step, and it is missing.
- **A crash between the ledger write and the audit completion** leaves a plan `claimed` and returning
  `IN_FLIGHT` forever. It cannot double-refund; it is stuck. A claim reaper is the fix.
- **The dataset is synthetic and I wrote both the fixtures and the rules.** Mitigations are set out in
  `DECISIONS.md`; they narrow the objection rather than remove it.
- **A cold free-tier database can time out the first request.** It fails fast rather than hanging, and
  the console explains it, but a reviewer may still meet one slow page.
- **Identity is attribution, not authorization.** One shared token, and the policy engine is identical
  for every caller. That is the correct posture for this scope and would not survive real deployment.
