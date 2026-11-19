import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Percent } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { amountFromIncomePercent } from '@/lib/plan-utils'
import { parseAmountInput } from '@/lib/format'

/**
 * "% da renda" calculator next to a budget amount: the user types a share of
 * the month's planned income and gets the amount. Only the amount is stored;
 * a later change to the income target does not move it.
 */
export function IncomePercentHelper({
  categoryName,
  incomePlanned,
  disabled,
  locale,
  money,
  onApply,
}: {
  categoryName: string
  incomePlanned: number | null
  disabled?: boolean
  locale: string
  money: (value: number) => string
  onApply: (amount: number) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const noIncome = incomePlanned === null || !(incomePlanned > 0)
  const percent = draft.trim() ? parseAmountInput(draft, locale) : null
  const amount = percent === null ? null : amountFromIncomePercent(percent, incomePlanned)

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setDraft('') }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('plan.percentOfIncomeFor', { category: categoryName })}
          title={noIncome ? t('plan.percentNeedsIncome') : t('plan.percentOfIncome')}
          disabled={disabled || noIncome}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Percent size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (amount === null) return
            onApply(amount)
            setOpen(false)
            setDraft('')
          }}
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">{t('plan.percentOfIncome')}</span>
            <div className="flex items-center rounded-lg border border-border bg-card px-2.5 focus-within:ring-2 focus-within:ring-primary">
              <input
                type="text"
                inputMode="decimal"
                aria-label={t('plan.percentInputFor', { category: categoryName })}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="0"
                className="h-8 w-full min-w-0 bg-transparent text-end text-sm tabular-nums text-foreground outline-none"
              />
              <span className="ms-1 text-xs text-muted-foreground">%</span>
            </div>
          </label>
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {incomePlanned !== null && t('plan.percentPreview', { income: money(incomePlanned), amount: amount === null ? '—' : money(amount) })}
          </p>
          <Button type="submit" size="sm" className="w-full" disabled={amount === null}>{t('plan.percentApply')}</Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
