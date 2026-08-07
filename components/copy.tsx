'use client'

import { useState } from 'react'

/**
 * The one piece of client state in the app.
 *
 * It earns its place: the whole page exists to be copied out of, and asking a reviewer
 * to hand-select a multi-line command is friction on the first thing they do.
 */
export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1600)
      }}
      className="shrink-0 rounded border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

/** A prompt the visitor is meant to paste into their MCP client. */
export function Prompt({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
      <p className="min-w-0 flex-1 font-mono text-[13px] leading-relaxed">&ldquo;{children}&rdquo;</p>
      <Copy text={children} label="Copy" />
    </div>
  )
}

/**
 * A shell command or config block.
 *
 * The copy button sits in the label row rather than floating over the code: a long
 * single-line command scrolls horizontally underneath an overlaid button, which looks
 * broken on exactly the snippet people need most.
 */
export function Snippet({ children, label }: { children: string; label?: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-3">
        {label && <p className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</p>}
        <div className={label ? '' : 'ml-auto'}>
          <Copy text={children} />
        </div>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {children}
      </pre>
    </div>
  )
}
