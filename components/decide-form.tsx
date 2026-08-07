'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button } from '@/components/ui/button'
import { decideAction, type DecideState } from '@/app/approvals/actions'

/** Shows busy text only on the button that was actually pressed; both lock while pending. */
function DecideButton({
  verdict,
  variant,
  idle,
  busy,
}: {
  verdict: 'approve' | 'reject'
  variant?: 'outline'
  idle: string
  busy: string
}) {
  const { pending, data } = useFormStatus()
  const active = pending && data?.get('verdict') === verdict
  return (
    <Button type="submit" name="verdict" value={verdict} variant={variant} disabled={pending}>
      {active ? busy : idle}
    </Button>
  )
}

export function DecideForm({ actionId }: { actionId: string }) {
  const [state, action] = useActionState<DecideState, FormData>(decideAction, null)

  return (
    <form action={action} className="mt-8 space-y-3 rounded border p-4">
      <input type="hidden" name="action_id" value={actionId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Your name or email</span>
          <input
            name="decided_by"
            defaultValue="demo-manager"
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-muted-foreground">
          Decision note (required, for approvals and rejections alike)
        </span>
        <textarea
          name="note"
          required
          rows={3}
          placeholder="Why is this the right call?"
          className="w-full rounded border bg-background px-3 py-2 text-sm"
        />
      </label>
      <div className="flex gap-2">
        <DecideButton verdict="approve" idle="Approve refund" busy="Approving…" />
        <DecideButton verdict="reject" variant="outline" idle="Reject" busy="Rejecting…" />
      </div>
      <p aria-live="polite" className="text-xs">
        {state?.error ? (
          <span className="text-red-600 dark:text-red-400">{state.error}</span>
        ) : (
          <span className="text-muted-foreground">
            Approving re-runs the full policy engine against live data. A signature overrides the approval
            requirement and nothing else — if the order was refunded elsewhere in the meantime, this still
            will not pay.
          </span>
        )}
      </p>
    </form>
  )
}
