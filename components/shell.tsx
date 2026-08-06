import Link from 'next/link'

/**
 * The whole design system.
 *
 * This UI is the approval boundary, not a product surface — the brief explicitly says
 * not to build a frontend, and every minute spent here is a minute not spent on the
 * MCP. Unmodified shadcn tokens, server components, zero client state.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-svh max-w-4xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b pb-4">
        <Link href="/" className="font-heading text-lg font-semibold">
          ops-copilot
        </Link>
        <nav className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            Start here
          </Link>
          <Link href="/approvals" className="hover:text-foreground">
            Approvals
          </Link>
          <Link href="/audit" className="hover:text-foreground">
            Audit log
          </Link>
        </nav>
      </header>
      {children}
    </div>
  )
}

export function Verdict({ value }: { value: string }) {
  const tone =
    value === 'executed' || value === 'allow'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : value === 'denied' || value === 'deny' || value === 'rejected' || value === 'failed'
        ? 'bg-red-500/10 text-red-600 dark:text-red-400'
        : value === 'requires_approval' || value === 'require_approval'
          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground'
  return <span className={`rounded px-2 py-0.5 font-mono text-xs ${tone}`}>{value}</span>
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</p>
}
