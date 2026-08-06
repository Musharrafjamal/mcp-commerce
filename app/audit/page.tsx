import Link from 'next/link'
import { Empty, Shell, Verdict } from '@/components/shell'
import { listAudit } from '@/src/services/approvals'
import { formatMoney } from '@/src/domain/types'

export const dynamic = 'force-dynamic'

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

export default async function AuditPage() {
  const entries = await listAudit(100)

  return (
    <Shell>
      <h1 className="font-heading text-xl font-semibold">Audit log</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Append-only. One record per attempted remediation — <strong>including the ones policy refused</strong>,
        which is what makes this credible to a real operations team. A denied action is exactly as
        traceable as a successful one.
      </p>

      {entries.length === 0 ? (
        <div className="mt-6">
          <Empty>Nothing yet. Drive the MCP server and every attempt will land here.</Empty>
        </div>
      ) : (
        <ul className="mt-6 divide-y rounded border text-sm">
          {entries.map(a => (
            <li key={a._id} id={a._id} className="flex flex-wrap items-start gap-x-4 gap-y-1 p-3">
              <span className="w-32 shrink-0 font-mono text-xs text-muted-foreground">
                {stamp(a.createdAt)}
              </span>
              <Verdict value={a.status} />
              <span className="font-mono text-xs">{a.action}</span>
              <Link href={`/approvals/${a._id}`} className="font-medium hover:underline">
                {a.orderId}
              </Link>
              {a.computed && <span className="font-mono text-xs">{formatMoney(a.computed.amount)}</span>}
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {a.policy
                  ? a.policy.rules
                      .filter(r => r.verdict !== 'allow')
                      .map(r => r.id)
                      .join(', ') || 'all rules passed'
                  : ''}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{a.actor?.label}</span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  )
}
