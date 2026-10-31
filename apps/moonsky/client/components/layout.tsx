import * as React from 'react'
import { cn } from '../lib/utils.js'

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="grid gap-1">
      <h1 className="text-lg font-semibold tracking-wide text-zinc-100">{title}</h1>
      <p className="text-xs text-zinc-400">{subtitle}</p>
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-zinc-100">{value}</p>
      <p className="text-[11px] text-zinc-500">{hint}</p>
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid gap-1 rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center">
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      <p className="text-xs text-zinc-500">{hint}</p>
    </div>
  )
}

export function SplitView({ leftRatio = '34%', left, right }: { leftRatio?: string; left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="moonsky-split" style={{ '--moonsky-split-left': leftRatio } as React.CSSProperties}>
      <div>{left}</div>
      <div>{right}</div>
    </div>
  )
}

export function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className={cn('rounded-xl border border-zinc-800 bg-zinc-900/60')}>
      <header className="border-b border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-100">{title}</h2>
        {subtitle ? <p className="text-xs text-zinc-400">{subtitle}</p> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}
