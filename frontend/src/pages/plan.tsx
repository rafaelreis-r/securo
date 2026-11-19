import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'
import { budgets as budgetsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { monthLabel, shiftMonth } from '@/lib/month-utils'
import { formatCompactCurrency, formatCurrency } from '@/lib/format'
import { todayInTimezone } from '@/lib/date-utils'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { useEffectiveTimezone } from '@/hooks/use-timezone'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MonthPicker } from '@/components/ui/monthpicker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/page-header'
import { PlanEmptyHint, PlanMonthView, type PlanFormatters } from '@/components/plan/plan-month-view'
import { PlanYearGrid } from '@/components/plan/plan-year-grid'

const STEP_BUTTON = 'h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground transition-all text-base'
const PICKER_BUTTON = 'inline-flex items-center justify-center gap-2 border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground hover:bg-muted/50 transition-all cursor-pointer'

type View = 'month' | 'year'

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 sm:px-5 py-4 text-sm text-rose-700 dark:text-rose-300">
      <span className="flex items-center gap-2"><AlertCircle size={16} />{extractApiError(error, t('common.error'))}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

function Loading() {
  return <div className="space-y-3">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 w-full" />)}</div>
}

/**
 * Planejamento: the advisor's four blocks (income, investment, fixed and
 * variable spending), target against actual, for a month or a whole year.
 * Targets themselves are edited in Budgets.
 */
export default function PlanPage() {
  const { t, i18n } = useTranslation()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const locale = useDisplayLocale()
  const timeZone = useEffectiveTimezone()
  const today = todayInTimezone(timeZone)
  const [searchParams, setSearchParams] = useSearchParams()
  const uiLocale = i18n.resolvedLanguage ?? i18n.language
  const currency = user?.preferences?.currency_display ?? 'USD'

  const requestedView = searchParams.get('view')
  const view: View = requestedView === 'year' ? 'year' : 'month'
  const requestedMonth = searchParams.get('month')
  const month = requestedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7)
  const requestedYear = Number(searchParams.get('year'))
  const year = Number.isInteger(requestedYear) && requestedYear >= 1900 && requestedYear <= 2999 ? requestedYear : Number(today.slice(0, 4))
  const [monthCalOpen, setMonthCalOpen] = useState(false)

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(key, value)
    setSearchParams(next, { replace: true })
  }
  const monthTitle = monthLabel(month, uiLocale).replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase(uiLocale))

  const monthQuery = useQuery({
    queryKey: ['budgets', 'plan', 'month', month],
    queryFn: () => budgetsApi.planMonth(`${month}-01`),
    enabled: view === 'month',
  })
  const yearQuery = useQuery({
    queryKey: ['budgets', 'plan', 'year', year],
    queryFn: () => budgetsApi.planYear(year),
    enabled: view === 'year',
  })

  const percentFormatter = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  const formatters: PlanFormatters = {
    money: (value) => mask(formatCurrency(value, currency, locale)),
    percent: (ratio) => (ratio === null ? '—' : percentFormatter.format(ratio)),
  }
  const compactMoney = (value: number) => mask(formatCompactCurrency(value, currency, locale))

  const picker = view === 'month' ? (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className={STEP_BUTTON} aria-label={t('plan.previousMonth')} onClick={() => setParam('month', shiftMonth(month, -1))}>‹</button>
      <Popover open={monthCalOpen} onOpenChange={setMonthCalOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={`${PICKER_BUTTON} min-w-[180px]`}>
            <CalendarIcon className="size-3.5 text-muted-foreground" />
            {monthTitle}
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-auto p-0">
          <MonthPicker
            locale={resolveDateFnsLocale(uiLocale)}
            selectedMonth={new Date(`${month}-01T00:00:00`)}
            onMonthSelect={(date) => {
              if (!date) return
              setParam('month', format(date, 'yyyy-MM'))
              setMonthCalOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      <button type="button" className={STEP_BUTTON} aria-label={t('plan.nextMonth')} onClick={() => setParam('month', shiftMonth(month, 1))}>›</button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className={STEP_BUTTON} aria-label={t('plan.previousYear')} onClick={() => setParam('year', String(year - 1))}>‹</button>
      <span className={`${PICKER_BUTTON} min-w-[100px] cursor-default tabular-nums`}>{year}</span>
      <button type="button" className={STEP_BUTTON} aria-label={t('plan.nextYear')} onClick={() => setParam('year', String(year + 1))}>›</button>
    </div>
  )

  const yearHasTargets = yearQuery.data?.rows.some((row) => row.level === 'block' && row.total.planned !== null)

  return (
    <div>
      <PageHeader section={t('nav.groupSetup')} title={t('plan.title')} action={picker} />
      <Tabs value={view} onValueChange={(value) => setParam('view', value)}>
        <TabsList>
          <TabsTrigger value="month">{t('plan.tabMonth')}</TabsTrigger>
          <TabsTrigger value="year">{t('plan.tabYear')}</TabsTrigger>
        </TabsList>
        <TabsContent value="month" className="mt-2">
          {monthQuery.isError ? (
            <LoadError error={monthQuery.error} onRetry={() => { void monthQuery.refetch() }} />
          ) : !monthQuery.data ? (
            <Loading />
          ) : (
            <PlanMonthView plan={monthQuery.data} format={formatters} />
          )}
        </TabsContent>
        <TabsContent value="year" className="mt-2 space-y-4">
          {yearQuery.isError ? (
            <LoadError error={yearQuery.error} onRetry={() => { void yearQuery.refetch() }} />
          ) : !yearQuery.data ? (
            <Loading />
          ) : (
            <>
              {!yearHasTargets && <PlanEmptyHint />}
              <p className="text-xs text-muted-foreground">{t('plan.cellLegend')}</p>
              <PlanYearGrid grid={yearQuery.data} money={compactMoney} locale={uiLocale} />
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
