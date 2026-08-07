'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { decide } from '@/src/services/approvals'
import { reseedDemoData } from '@/src/services/reseed'

/**
 * The ONLY way an approval decision can be made.
 *
 * There is deliberately no MCP tool that reaches `decide()`. The agent can create
 * approval requests and read their status; it can never resolve one. That single
 * omission is what makes the human gate real rather than theatrical.
 */
export type DecideState = { error: string } | null

export async function decideAction(_prev: DecideState, formData: FormData): Promise<DecideState> {
  const actionId = String(formData.get('action_id') ?? '')
  const verdict = String(formData.get('verdict') ?? '')
  const note = String(formData.get('note') ?? '')
  const decidedBy = String(formData.get('decided_by') ?? '').trim() || 'demo-manager'

  if (verdict !== 'approve' && verdict !== 'reject') return { error: 'Invalid decision.' }
  // Enforced here AND in the service. An audit trail that records what was decided but
  // not why is only half a trail.
  if (!note.trim()) return { error: 'A decision note is required.' }

  try {
    await decide(actionId, verdict, decidedBy, note)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The decision could not be recorded. Try once more.' }
  }

  revalidatePath('/approvals')
  revalidatePath('/audit')
  // Re-renders this same page in its decided state — that is the success feedback.
  redirect(`/approvals/${actionId}`)
}

export type ReseedState = { ok: boolean; orders?: number; error?: string } | null

/** Stays on the page and reports back — the button renders the outcome inline. */
export async function reseedAction(_prev: ReseedState, _formData: FormData): Promise<ReseedState> {
  try {
    const { orders } = await reseedDemoData()
    revalidatePath('/')
    revalidatePath('/approvals')
    revalidatePath('/audit')
    return { ok: true, orders }
  } catch {
    return { ok: false, error: 'Reset failed — the free-tier database may be waking up. Try once more.' }
  }
}
