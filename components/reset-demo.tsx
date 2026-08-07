'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { reseedAction, type ReseedState } from '@/app/approvals/actions'

/** The reset button with its outcome reported inline, so a click visibly did something. */
export function ResetDemo() {
  const [state, action, pending] = useActionState<ReseedState, FormData>(reseedAction, null)

  return (
    <form action={action} className="mt-5">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Resetting…' : 'Reset demo data'}
      </Button>
      <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
        {pending ? (
          'Reseeding the database…'
        ) : state?.ok ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            Done — {state.orders} orders restored to their starting state.
          </span>
        ) : state ? (
          <span className="text-red-600 dark:text-red-400">{state.error}</span>
        ) : (
          'Restores all 28 synthetic orders. Safe to run at any time.'
        )}
      </p>
    </form>
  )
}
