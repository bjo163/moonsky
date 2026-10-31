import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../../lib/utils.js'

const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-zinc-700 bg-zinc-900 text-zinc-100',
      destructive: 'border-red-800 bg-red-950/50 text-red-200',
    },
  },
  defaultVariants: { variant: 'default' },
})

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

export function Alert({ className, variant, ...props }: AlertProps) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}
