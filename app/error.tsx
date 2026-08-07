'use client'

import { useTransition } from 'react'

/**
 * A free-tier Atlas cluster auto-pauses, and the client is configured to fail fast
 * (serverSelectionTimeoutMS: 5000) rather than hang inside a caller. Failing fast is
 * right — but a blank 500 reads as "this project is broken", so the one failure mode a
 * reviewer is actually likely to hit gets an honest explanation and a reload button.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [reloading, startReload] = useTransition()
  const likelyColdCluster = /server selection|timed out|ECONNREFUSED|topology/i.test(error.message)

  return (
    <div className="mx-auto flex min-h-svh max-w-xl flex-col justify-center px-6">
      <h1 className="font-heading text-xl font-semibold">This page could not load</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {likelyColdCluster
          ? 'The demo database is on a free tier that pauses when idle, and the first request after a pause can time out. Reloading almost always fixes it.'
          : 'Something went wrong reading the demo data. Reloading usually fixes it; if not, the MCP server itself is unaffected.'}
      </p>
      <button
        onClick={() => startReload(reset)}
        disabled={reloading}
        className="mt-5 w-fit rounded border px-4 py-2 text-sm hover:bg-muted disabled:opacity-60"
        type="button"
      >
        {reloading ? 'Reloading…' : 'Reload'}
      </button>
      {error.digest && <p className="mt-4 font-mono text-xs text-muted-foreground">digest: {error.digest}</p>}
    </div>
  )
}
