/**
 * The two channels, and why they are two.
 *
 *   toolError()    a MECHANICAL fault the agent can fix by itself: a stale plan, an
 *                  expired plan, an order that does not exist. isError: true, one
 *                  unambiguous recovery call, never a menu.
 *
 *   normal result  a POLICY DECISION. deny and require_approval are the system
 *                  working, not failing, and they come back as ordinary results.
 *
 * Getting this backwards is the single most damaging mistake available here. An error
 * invites a retry. If "refund denied" arrived as an error, a capable agent would
 * dutifully reshape the request - fewer lines, a smaller scope - and try again until
 * something slipped through. Returning it as a result with do_not_retry removes the
 * incentive entirely.
 *
 * Raw exceptions never cross the wire. A stack trace is pure token cost with zero
 * recovery signal.
 */

export type McpToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export function toolError(code: string, message: string, recovery: string, retryAfterMs?: number): McpToolResult {
  const lines = [`**${code}** — ${message}`, '', `**Do this next:** ${recovery}`]
  if (retryAfterMs) lines.push('', `Wait about ${Math.ceil(retryAfterMs / 1000)}s before retrying.`)
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
  }
}

export function ok(markdown: string, structuredContent: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: markdown }], structuredContent, isError: false }
}

/** Turn an unexpected throw into something an agent can act on rather than a stack trace. */
export function unexpected(e: unknown, recovery: string): McpToolResult {
  const message = e instanceof Error ? e.message : String(e)
  return toolError('INTERNAL_ERROR', message, recovery)
}
