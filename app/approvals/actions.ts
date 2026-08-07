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
export async function decideAction(formData: FormData) {
  const actionId = String(formData.get('action_id') ?? '')
  const verdict = String(formData.get('verdict') ?? '')
  const note = String(formData.get('note') ?? '')
  const decidedBy = String(formData.get('decided_by') ?? '').trim() || 'demo-manager'

  if (verdict !== 'approve' && verdict !== 'reject') throw new Error('Invalid decision.')
  // Enforced here AND in the service. An audit trail that records what was decided but
  // not why is only half a trail.
  if (!note.trim()) throw new Error('A decision note is required.')

  await decide(actionId, verdict, decidedBy, note)

  revalidatePath('/approvals')
  revalidatePath('/audit')
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
