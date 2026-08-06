import { Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { reseedAction } from './approvals/actions'

export const dynamic = 'force-dynamic'

const URL_ = process.env.NEXT_PUBLIC_MCP_URL ?? 'https://ops-copilot-musharraf008s-projects.vercel.app/api/mcp'
const TOKEN = process.env.MCP_BEARER_TOKEN?.trim() ?? '<set MCP_BEARER_TOKEN>'

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  )
}

export default function Page() {
  return (
    <Shell>
      <h1 className="font-heading text-2xl font-semibold">Delivery-exception triage, driven by an MCP server</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        An operations specialist can see the storefront admin but not the payment gateway ledger or the
        carrier scan history. This server closes that gap for one workflow: a delayed, lost or disputed
        delivery, and the refund decision that follows. All data is synthetic.
      </p>

      <section className="mt-8">
        <h2 className="font-heading text-sm font-semibold tracking-wide uppercase">Connect</h2>
        <Code>{`${URL_}\nAuthorization: Bearer ${TOKEN}`}</Code>
        <p className="mt-2 text-xs text-muted-foreground">
          Any MCP-compatible client works. The token is a demo credential guarding synthetic data.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-1 text-xs font-medium">Claude Code</p>
            <Code>{`claude mcp add --transport http ops-copilot ${URL_} \\\n  --header "Authorization: Bearer ${TOKEN}"`}</Code>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">MCP Inspector</p>
            <Code>npx @modelcontextprotocol/inspector</Code>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Any client reading .mcp.json</p>
            <Code>{`{
  "mcpServers": {
    "ops-copilot": {
      "type": "http",
      "url": "${URL_}",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}`}</Code>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-heading text-sm font-semibold tracking-wide uppercase">Three prompts worth trying</h2>
        <ol className="mt-3 space-y-4 text-sm">
          <li>
            <strong>The engine acts on its own authority.</strong>
            <br />
            <span className="text-muted-foreground">
              &ldquo;What delivery exceptions are open? Work ORD-1001 through to a resolution.&rdquo;
            </span>
            <br />
            <span className="text-xs text-muted-foreground">
              Verified lost, under the $150 ceiling — it refunds without asking anyone.
            </span>
          </li>
          <li>
            <strong>Verification is load-bearing, not a label.</strong>
            <br />
            <span className="text-muted-foreground">&ldquo;ORD-1006 is late. Should we refund it?&rdquo;</span>
            <br />
            <span className="text-xs text-muted-foreground">
              Identical to ORD-1001 in our own data. Only the carrier can tell them apart — and it says the
              parcel is still moving, so the refund is refused as premature.
            </span>
          </li>
          <li>
            <strong>It knows when it cannot decide.</strong>
            <br />
            <span className="text-muted-foreground">
              &ldquo;The customer on ORD-1003 says their parcel never arrived. Refund them.&rdquo;
            </span>
            <br />
            <span className="text-xs text-muted-foreground">
              Competing hypotheses it cannot separate. It refuses to recommend, and escalates with the
              evidence instead.
            </span>
          </li>
        </ol>
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="font-heading text-sm font-semibold tracking-wide uppercase">Reset</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Restores all 28 synthetic orders. Use it if someone has already resolved the scenario you wanted
          to see.
        </p>
        <form action={reseedAction} className="mt-3">
          <Button type="submit" variant="outline">
            Reset demo data
          </Button>
        </form>
      </section>
    </Shell>
  )
}
