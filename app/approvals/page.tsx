import Link from 'next/link'
import { Empty, Shell, Verdict } from '@/components/shell'
import { listPending } from '@/src/services/approvals'
import { formatMoney } from '@/src/domain/types'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const pending = await listPending()

  return (
    <Shell>
      <h1 className="font-heading text-xl font-semibold">Awaiting approval</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Refunds the engine declined to authorise on its own. Each carries the full evidence bundle: the
        computed amount and where it came from, the rules that fired, and the competing explanations with
        what argues against them.
      </p>

      {pending.length === 0 ? (
        <div className="mt-6">
          <Empty>
            Nothing is waiting. Drive the MCP server to a refund over the $150 ceiling — ORD-1002 or
            ORD-1003 — and it will appear here.
          </Empty>
        </div>
      ) : (
        <ul className="mt-6 divide-y rounded border">
          {pending.map(a => (
            <li key={a._id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <div className="min-w-0 flex-1">
                <Link href={`/approvals/${a._id}`} className="font-medium hover:underline">
                  {a.orderId}
                </Link>
                <span className="ml-2 font-mono text-sm">
                  {a.computed ? formatMoney(a.computed.amount) : '—'}
                </span>
                <p className="mt-1 text-xs text-muted-foreground">{a.approval?.reason}</p>
              </div>
              <div className="flex items-center gap-2">
                {a.policy?.rules
                  .filter(r => r.verdict === 'require_approval')
                  .map(r => (
                    <span key={r.id} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                      {r.id}
                    </span>
                  ))}
                <Verdict value={a.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  )
}
