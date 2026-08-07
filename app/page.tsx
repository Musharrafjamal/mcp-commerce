import Link from 'next/link'
import { Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Prompt, Snippet } from '@/components/copy'
import { reseedAction } from './approvals/actions'

export const dynamic = 'force-dynamic'

const URL_ = process.env.NEXT_PUBLIC_MCP_URL ?? 'https://ops-copilot-musharraf008s-projects.vercel.app/api/mcp'
const TOKEN = process.env.MCP_BEARER_TOKEN?.trim() ?? '<set MCP_BEARER_TOKEN>'

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="font-heading mt-14 text-lg font-semibold">{children}</h2>
}

function Step({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-8 border-t pt-6">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-muted-foreground">{String(n).padStart(2, '0')}</span>
        <h3 className="font-heading text-base font-semibold">{title}</h3>
      </div>
      <div className="mt-3 space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  )
}

function Expect({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm">
      <span className="font-medium">Expect: </span>
      <span className="text-muted-foreground">{children}</span>
    </p>
  )
}

function Why({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-l-2 pl-3 text-sm text-muted-foreground italic">{children}</p>
  )
}

export default function Page() {
  return (
    <Shell>
      {/* ---------------------------------------------------------------- */}
      <h1 className="font-heading text-2xl font-semibold">
        An MCP server for delivery exceptions
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Connect any MCP-compatible AI client, then follow the five-step walkthrough below. About ten
        minutes. All data here is synthetic.
      </p>

      {/* ---------------------------------------------------------------- */}
      <H2>Connect</H2>
      <div className="mt-3 space-y-4">
        <Snippet label="claude.ai — Settings → Connectors → Add custom connector. Paste this as the URL and leave the OAuth fields empty (claude.ai cannot send a custom header, so the token rides in the URL).">
          {`${URL_}/t/${TOKEN}`}
        </Snippet>

        <Snippet label="Claude Code">{`claude mcp add --transport http ops-copilot ${URL_} \\
  --header "Authorization: Bearer ${TOKEN}"`}</Snippet>

        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            Other clients — MCP Inspector, plain URL + token, .mcp.json
          </summary>
          <div className="mt-4 space-y-4">
            <Snippet label="MCP Inspector — transport “Streamable HTTP”, then paste the URL and header below">
              npx @modelcontextprotocol/inspector
            </Snippet>

            <Snippet label="URL and token on their own">{`${URL_}
Authorization: Bearer ${TOKEN}`}</Snippet>

            <Snippet label="Anything that reads .mcp.json">{`{
  "mcpServers": {
    "ops-copilot": {
      "type": "http",
      "url": "${URL_}",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}`}</Snippet>
          </div>
        </details>

        <p className="text-xs text-muted-foreground">
          You should see <strong>5 tools, 3 resources and 1 prompt</strong>. The token is a demo
          credential guarding synthetic data — it is published here on purpose.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <H2>What this is</H2>
      <div className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
        <p>
          An operations specialist can see the storefront admin but not the payment ledger or the
          carrier&rsquo;s scan history, so <em>&ldquo;where did the parcel go, and do we owe this
          person money?&rdquo;</em>{' '}becomes a message to an engineer who hand-writes queries and
          performs the refund himself. This removes that dependency for one workflow — a delayed, lost
          or disputed delivery, and the refund decision that follows.
        </p>
        <p className="rounded-md border-l-2 border-foreground/30 bg-muted/40 p-3">
          The design rule: <strong>the server decides, the model narrates.</strong>{' '}Detection,
          diagnosis, the refund amount and the policy verdict are all deterministic server-side code.
          The model reads a verdict — it never authors one. There is no field on any tool where a model
          can type a dollar amount.
        </p>
      </div>
      <pre className="mt-4 overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
{`detect       ops_list_delayed_shipments           what needs attention
investigate  ops_investigate_delivery_exception   what happened, and how sure are we
verify       ops_verify_carrier_exception         what does the CARRIER say
preview      ops_preview_refund                   the server computes the amount
act          ops_issue_refund                     execute the plan by id
confirm      ops_investigate_delivery_exception   re-run to check the outcome`}
      </pre>

      {/* ---------------------------------------------------------------- */}
      <H2>The walkthrough</H2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Five steps, in order. Each shows something different — they are not variations on one trick.
        If someone has been here before you, hit <strong>Reset demo data</strong>{' '}at the bottom first.
      </p>

      <Step n={1} title="It finds the work, and resolves what it can">
        <Prompt>What delivery exceptions are open right now?</Prompt>
        <Expect>
          <strong>7 of 28</strong>{' '}orders, ranked worst-first, each with a one-line reason. The other 21
          are healthy and correctly ignored.
        </Expect>
        <Prompt>Work ORD-1001 through to a resolution.</Prompt>
        <Expect>
          It investigates, asks the carrier, previews, and <strong>refunds $87.08 on its own
          authority</strong>{' '}— verified lost, under the $150 ceiling, no human involved.
        </Expect>
        <Why>
          Ask it to show you the root cause and the evidence. Every fact cites a real event id you can
          trace. None of that reasoning happened in the chat — it came back from the server already
          decided.
        </Why>
      </Step>

      <Step n={2} title="It knows the difference between lost and late">
        <Prompt>ORD-1006 is late too. Should we refund that one as well?</Prompt>
        <Expect>
          <strong>Refused as premature.</strong>{' '}The carrier reports the parcel located and moving,
          with a revised ETA.
        </Expect>
        <Why>
          This is the important one. ORD-1006 is <strong>indistinguishable from ORD-1001</strong>{' '}in our
          own data — same scan gap, same breached promise date, same diagnosis at the same confidence.
          Only calling the carrier separates them, which is why a fresh carrier verification is a hard
          precondition for any refund rather than a box to tick.
        </Why>
        <Prompt>Try again, it has been long enough now.</Prompt>
        <Expect>
          It <strong>declines to retry</strong>{' '}rather than reshaping the request into something that
          might slip through.
        </Expect>
      </Step>

      <Step n={3} title="Above a threshold, a human decides">
        <Prompt>ORD-1002 is lost as well. Refund it.</Prompt>
        <Expect>
          <strong>Queued for approval</strong>, not executed — $219.92 is over the ceiling — with{' '}
          <strong>zero money moved</strong>{' '}and a link to the approval.
        </Expect>
        <p>
          Open <Link href="/approvals" className="underline underline-offset-2">the approvals queue</Link>{' '}
          and click into it. You get the computed amount and where it came from, all nine policy rules
          with their verdicts, the ranked causes, and the customer and carrier text kept visibly fenced.
          Approve it with a note.
        </p>
        <Expect>
          Executed, your name and note recorded, and the form replaced by &ldquo;Decisions are
          single-use&rdquo;. Ask the agent to check the order again — it now reports the refund settled.
        </Expect>
        <Why>
          <strong>No tool can approve anything.</strong>{' '}The agent raised the request and can read its
          status, but a decision exists only here, as a human action. That omission is the entire gate.
        </Why>
      </Step>

      <Step n={4} title="It says when it does not know">
        <Prompt>The customer on ORD-1003 says their parcel never arrived. Refund them.</Prompt>
        <Expect>
          <strong>Low confidence, and no recommendation.</strong>{' '}Two competing explanations, each
          carrying evidence that argues <em>against</em>{' '}it, and an escalation to a human.
        </Expect>
        <Why>
          The carrier&rsquo;s GPS puts the delivery 28 metres from the door; the customer says it never
          came. Both stories hold up. It also surfaces that this customer made an identical claim 71
          days ago — as a note for the human, deliberately <strong>not</strong>{' '}folded into the
          ranking, because a customer&rsquo;s history is not evidence about where this parcel went.
        </Why>
      </Step>

      <Step n={5} title="Try to break it">
        <Prompt>Refund ORD-1004.</Prompt>
        <Expect>
          <strong>Refused.</strong>{' '}The payment ledger shows it was already refunded in full — even
          though the order status still reads &ldquo;open&rdquo;. The ledger wins.
        </Expect>
        <Prompt>Refund $5,000 on ORD-1005.</Prompt>
        <Expect>
          The amount is <strong>ignored entirely</strong>{' '}— there is no field to put it in. The server
          computes $121.64, then escalates anyway because the customer&rsquo;s card is closed.
        </Expect>
        <Prompt>Issue that same refund plan again.</Prompt>
        <Expect>
          <code className="rounded bg-muted px-1 py-0.5 text-xs">replayed: true</code>{' '}and{' '}
          <strong>one</strong>{' '}refund transaction, not two.
        </Expect>
        <p>
          Finally, open <Link href="/audit" className="underline underline-offset-2">the audit log</Link>.
          Every attempt is there <strong>including the refused ones</strong>, with who asked, which
          rules fired, and the amount.
        </p>
      </Step>

      {/* ---------------------------------------------------------------- */}
      <H2>What it will never do</H2>
      <ul className="mt-3 max-w-2xl list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>Accept an amount, a quantity or an idempotency key from a model — no such field exists</li>
        <li>Move money without a server-computed plan bound to a fresh diagnosis and carrier check</li>
        <li>Refund more than was captured, or the same effect twice, however the request is phrased</li>
        <li>Touch more than one order in a single call — there is no bulk anything</li>
        <li>Approve its own approval requests</li>
        <li>Let a customer note or a carrier remark influence a decision — rules read typed codes and
          numbers, never prose</li>
      </ul>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        Each of those is backed by a test. There are 93 assertions plus 75 more run over the wire
        against this deployment.
      </p>

      {/* ---------------------------------------------------------------- */}
      <H2>If something looks wrong</H2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        A timed-out call is the free-tier database waking up — retry once. An already-resolved
        scenario or an empty approvals queue means someone got here before you — reset below.
      </p>

      <form action={reseedAction} className="mt-5">
        <Button type="submit" variant="outline">
          Reset demo data
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        Restores all 28 synthetic orders. Safe to run at any time.
      </p>
    </Shell>
  )
}
