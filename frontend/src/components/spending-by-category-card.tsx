import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpDown } from 'lucide-react'
import { dashboard, budgets } from '@/lib/api'
import { monthLabel, monthRange } from '@/lib/month-utils'
import { formatCurrency } from '@/lib/format'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { Skeleton } from '@/components/ui/skeleton'
import { CategoryIcon } from '@/components/category-icon'
import { BudgetSpendingProgress } from '@/components/budget-spending-progress'
import type { DrillDownFilter } from '@/components/transaction-drill-down'
import { cn } from '@/lib/utils'

/**
 * The month's spending per category, with the budget bar and the change on
 * the previous month. Clicking a category hands the caller a drill-down
 * filter for that category and month; the caller owns the panel.
 *
 * Shared by the dashboard widget and the Spending by category page, so both
 * always show the same numbers.
 */
export function SpendingByCategoryCard({
  month,
  accountIds,
  enabled = true,
  onSelectCategory,
  className,
}: {
  /** YYYY-MM */
  month: string
  /** Accounts of the active collection; null means all accounts. */
  accountIds: string[] | null
  enabled?: boolean
  onSelectCategory: (filter: DrillDownFilter) => void
  /** Height and layout of the card; the dashboard caps it, the page doesn't. */
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const locale = useDisplayLocale()
  const uiLocale = i18n.resolvedLanguage ?? i18n.language
  const { from: monthStart, to: monthEnd } = monthRange(month)
  const monthLabelStr = monthLabel(month, uiLocale)
  // A collection with zero accounts has no account data: render empty instead
  // of silently falling back to "all accounts".
  const noAccounts = accountIds !== null && accountIds.length === 0
  const [catSortDesc, setCatSortDesc] = useState(true)

  const { data: spending, isLoading: spendingLoading } = useQuery({
    queryKey: ['dashboard', 'spending', month, accountIds],
    queryFn: () => dashboard.spendingByCategory(monthStart, accountIds ?? undefined),
    enabled: enabled && !noAccounts,
  })

  const { data: budgetComparison } = useQuery({
    queryKey: ['budgets', 'comparison', month],
    queryFn: () => budgets.comparison(monthStart),
    enabled,
  })

  const mergedCategories = useMemo(() => {
    if (!spending) return []
    const budgetMap = new Map<string, (typeof budgetComparison extends (infer T)[] | undefined ? T : never)>()
    if (budgetComparison) {
      for (const b of budgetComparison) {
        budgetMap.set(b.category_id, b)
      }
    }
    return spending
      .filter(s => s.category_id !== null)
      .map(s => {
        const budget = s.category_id ? budgetMap.get(s.category_id) : undefined
        // The category list must show the same spend set as its drill-down:
        // settled transactions plus pending/future rows and recurring
        // projections. The API keeps `total` as settled-only for callers that
        // need the actual/forecast split, while `projected_total` is the
        // user-visible all-in amount.
        const actual = s.projected_total
        const prevAmount = budget ? Number(budget.projected_prev_month_amount) : 0
        let momPct: number | null = null
        if (prevAmount > 0) {
          momPct = ((actual - prevAmount) / prevAmount) * 100
        } else if (actual > 0) {
          momPct = 100
        }
        return {
          category_id: s.category_id!,
          category_name: s.category_name,
          category_icon: s.category_icon,
          category_color: s.category_color,
          actual,
          budget_amount: budget ? Number(budget.budget_amount) : null,
          percentage_used: budget?.percentage_used ?? null,
          momPct,
        }
      })
      .sort((a, b) => catSortDesc ? b.actual - a.actual : a.actual - b.actual)
  }, [spending, budgetComparison, catSortDesc])

  return (
    <div className={cn('bg-card rounded-xl border border-border shadow-sm flex flex-col', className ?? 'max-h-[420px]')}>
      <div className="px-5 py-4 border-b border-border shrink-0 flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">{t('dashboard.spendingByCategory')}</p>
        <button
          onClick={() => setCatSortDesc(v => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <ArrowUpDown size={13} />
          {catSortDesc ? t('dashboard.sortHighest') : t('dashboard.sortLowest')}
        </button>
      </div>
      <div className="p-3 overflow-y-auto flex-1">
        {spendingLoading ? (
          <div className="space-y-3 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : mergedCategories.length > 0 ? (
          <div className="space-y-1.5">
            {mergedCategories.map((item) => {
              const hasBudget = item.budget_amount != null && item.budget_amount > 0
              const pct = item.percentage_used

              return (
                <div
                  key={item.category_id}
                  role="button"
                  tabIndex={0}
                  className="rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => onSelectCategory({
                    title: t('dashboard.drillDownCategory', { category: item.category_name, month: monthLabelStr }),
                    category_id: item.category_id,
                    type: 'debit',
                    from: monthStart,
                    to: monthEnd,
                  })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.currentTarget.click()
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    <CategoryIcon icon={item.category_icon} color={item.category_color} size="lg" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-semibold text-foreground truncate">{item.category_name}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-sm font-bold tabular-nums text-foreground">{mask(formatCurrency(item.actual, userCurrency, locale))}</span>
                          {item.momPct !== null && (
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${item.momPct > 0 ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400' : item.momPct < 0 ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
                              }`}>
                              {item.momPct > 0 ? '↑' : item.momPct < 0 ? '↓' : '='}{Math.abs(item.momPct).toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>
                      {hasBudget && (
                        <BudgetSpendingProgress categoryName={item.category_name} percentage={pct!} budgetAmount={item.budget_amount!} currency={userCurrency} />
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm text-center py-12">{t('dashboard.noData')}</p>
        )}
      </div>
    </div>
  )
}
