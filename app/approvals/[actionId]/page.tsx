import { notFound } from 'next/navigation'
import { Shell, Verdict } from '@/components/shell'
import { DecideForm } from '@/components/decide-form'
import { getAction } from '@/src/services/approvals'
import { formatMoney } from '@/src/domain/types'

export const dynamic = 'force-dynamic'

export default async function ApprovalDetail({ params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params
  const a = await getAction(actionId)
  if (!a) notFound()

  const open = a.status === 'requires_approval'

  return (
    <Shell>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-heading text-xl font-semibold">{a.orderId}</h1>
        <Verdict value={a.status} />
        <span className="font-mono text-sm text-muted-foreground">{a._id}</span>
      </div>

      {a.computed && (
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 rounded border p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Proposed refund</dt>
            <dd className="font-mono font-medium">{formatMoney(a.computed.amount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Captured</dt>
            <dd className="font-mono">{formatMoney(a.computed.capturedTotal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Already refunded</dt>
            <dd className="font-mono">{formatMoney(a.computed.alreadyRefunded)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Target transaction</dt>
            <dd className="font-mono text-xs">{a.computed.targetTxnId}</dd>
          </div>
        </dl>
      )}

      {/* The evidence the client asked for, verbatim from the engine. */}
      {a.result != null && typeof a.result === 'object' && 'approval' in (a.result as object) ? (
        <pre className="mt-6 overflow-x-auto rounded border bg-muted/40 p-4 text-xs leading-relaxed whitespace-pre-wrap">
          {String((a.result as { approval?: { summaryMd?: string } }).approval?.summaryMd ?? '')}
        </pre>
      ) : null}

      <h2 className="mt-8 font-heading text-sm font-semibold tracking-wide uppercase">Policy rules</h2>
      <ul className="mt-3 divide-y rounded border text-sm">
        {(a.policy?.rules ?? []).map(r => (
          <li key={r.id} className="flex flex-wrap items-start gap-3 p-3">
            <Verdict value={r.verdict} />
            <span className="font-mono text-xs">{r.id}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">{r.detail}</span>
          </li>
        ))}
      </ul>

      {a.approval?.decidedBy && (
        <p className="mt-6 rounded border p-4 text-sm">
          Decided by <strong>{a.approval.decidedBy}</strong> at{' '}
          {a.approval.decidedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC
          <br />
          <span className="text-muted-foreground">{a.approval.decisionNote}</span>
        </p>
      )}

      {open ? (
        <DecideForm actionId={a._id} />
      ) : (
        <p className="mt-8 rounded border border-dashed p-4 text-sm text-muted-foreground">
          This action is <span className="font-mono">{a.status}</span>. Decisions are single-use.
        </p>
      )}
    </Shell>
  )
}
