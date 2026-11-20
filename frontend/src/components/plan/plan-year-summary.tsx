import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { summarizeYear, type PlanFigure, type PlanSummaryRow } from '@/lib/plan-utils'
import type { YearGrid } from '@/types'

const COLUMNS = ['income', 'investment', 'fixed', 'variable'] as const

/** Where a month's targets are edited. */
const budgetsMonthHref = (month: string) => `/budgets?month=${month.slice(0, 7)}`

/**
 * The advisor's year view: one line per month with income, investment, fixed
 * and variable spending and the result, the year total at the bottom.
 * A month's line opens that month in Budgets, where its targets are adjusted.
 */
export function PlanYearSummary({ grid, figure, money, locale, currentMonth }: {
  grid: YearGrid
  figure: PlanFigure
  money: (value: number) => string
  locale: string
  /** `YYYY-MM`; later months have nothing realized yet. */
  currentMonth: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { months, total } = summarizeYear(grid, figure)
  const monthName = (month: string) => {
    const name = new Date(`${month}T12:00:00`).toLocaleDateString(locale, { month: 'long' })
    return name.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase(locale))
  }
  const amount = (value: number | null) => (value === null ? '—' : money(value))
  const resultClass = (value: number | null) =>
    value === null ? 'text-muted-foreground' : value < 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-400'

  const cells = (row: PlanSummaryRow, future: boolean) => (
    <>
      {COLUMNS.map((column) => (
        <td key={column} className="px-3 py-2.5 text-end text-sm tabular-nums text-foreground whitespace-nowrap">
          {future ? '—' : amount(row[column])}
        </td>
      ))}
      <td className={cn('px-4 sm:px-5 py-2.5 text-end text-sm font-semibold tabular-nums whitespace-nowrap', future ? 'text-muted-foreground' : resultClass(row.result))}>
        {future ? '—' : amount(row.result)}
      </td>
    </>
  )

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr className="text-[11px] text-muted-foreground border-b border-border">
            <th scope="col" className="px-4 sm:px-5 py-2 text-start font-medium">{t('plan.summary.month')}</th>
            <th scope="col" className="px-3 py-2 text-end font-medium">{t('plan.summary.income')}</th>
            <th scope="col" className="px-3 py-2 text-end font-medium">{t('plan.summary.investment')}</th>
            <th scope="col" className="px-3 py-2 text-end font-medium">{t('plan.summary.fixed')}</th>
            <th scope="col" className="px-3 py-2 text-end font-medium">{t('plan.summary.variable')}</th>
            <th scope="col" className="px-4 sm:px-5 py-2 text-end font-medium">{t('plan.summary.result')}</th>
          </tr>
        </thead>
        <tbody>
          {months.map((row) => {
            const future = figure === 'actual' && row.month.slice(0, 7) > currentMonth
            const name = monthName(row.month)
            return (
              <tr
                key={row.month}
                onClick={() => navigate(budgetsMonthHref(row.month))}
                className={cn(
                  'group border-b border-border cursor-pointer hover:bg-muted/40 transition-colors',
                  row.month.slice(0, 7) === currentMonth && 'bg-primary/5',
                )}
              >
                <th scope="row" className="px-4 sm:px-5 py-2.5 text-start text-sm font-medium text-foreground">
                  <Link
                    to={budgetsMonthHref(row.month)}
                    aria-label={t('plan.summary.adjustMonth', { month: name })}
                    onClick={(event) => event.stopPropagation()}
                    className="inline-flex items-center gap-1 hover:text-primary"
                  >
                    {name}
                    <ChevronRight size={13} aria-hidden className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity rtl:-scale-x-100" />
                  </Link>
                </th>
                {cells(row, future)}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="bg-muted/50 border-t-2 border-border font-semibold">
            <th scope="row" className="px-4 sm:px-5 py-3 text-start text-sm text-foreground">{t('plan.summary.yearTotal', { year: grid.year })}</th>
            {COLUMNS.map((column) => (
              <td key={column} className="px-3 py-3 text-end text-sm tabular-nums text-foreground whitespace-nowrap">{amount(total[column])}</td>
            ))}
            <td className={cn('px-4 sm:px-5 py-3 text-end text-sm tabular-nums whitespace-nowrap', resultClass(total.result))}>{amount(total.result)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
