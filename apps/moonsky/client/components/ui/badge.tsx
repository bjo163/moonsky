import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'border-zinc-700 bg-zinc-800 text-zinc-200',
        secondary: 'border-transparent bg-zinc-700 text-zinc-100',
        outline: 'border-zinc-600 text-zinc-300',
        success: 'border-emerald-700 bg-emerald-900/40 text-emerald-300',
        destructive: 'border-red-700 bg-red-900/40 text-red-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
