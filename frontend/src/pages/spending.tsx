import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'
import {
  transactions,
  categories as categoriesApi,
  categoryGroups as categoryGroupsApi,
  accounts as accountsApi,
} from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { extractApiError } from '@/lib/api-errors'
import { getAccountName } from '@/lib/account-utils'
import { monthLabel, shiftMonth } from '@/lib/month-utils'
import { todayInTimezone } from '@/lib/date-utils'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import { useEffectiveTimezone } from '@/hooks/use-timezone'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { MonthPicker } from '@/components/ui/monthpicker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PageHeader } from '@/components/page-header'
import { SpendingByCategoryCard } from '@/components/spending-by-category-card'
import { TransactionDrillDown, type DrillDownFilter } from '@/components/transaction-drill-down'
import { TransactionDialog, type TransactionSavePayload } from '@/components/transaction-dialog'
import type { Transaction } from '@/types'

const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/
const STEP_BUTTON = 'h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground transition-all text-base'
const PICKER_BUTTON = 'inline-flex items-center justify-center gap-2 border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-foreground hover:bg-muted/50 transition-all cursor-pointer'

/**
 * Spending by category on a page of its own: the dashboard card, full height,
 * for one month. A category opens its transactions on the right, and a
 * transaction opens the editor, so a wrong category is fixed where it shows.
 * The month lives in the URL (?month=YYYY-MM) so a link opens the same view.
 */
export default function SpendingPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const timeZone = useEffectiveTimezone()
  const [searchParams, setSearchParams] = useSearchParams()
  const uiLocale = i18n.resolvedLanguage ?? i18n.language
  const requestedMonth = searchParams.get('month')
  const month = requestedMonth && MONTH_PARAM.test(requestedMonth)
    ? requestedMonth
    : todayInTimezone(timeZone).slice(0, 7)
  const { activeAccountIds } = useCollectionFilter()
  const [monthCalOpen, setMonthCalOpen] = useState(false)
  const [drillDown, setDrillDown] = useState<DrillDownFilter | null>(null)
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)

  const setMonth = (value: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('month', value)
    setSearchParams(next, { replace: true })
  }
  const monthTitle = monthLabel(month, uiLocale).replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase(uiLocale))

  const { data: categoriesList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list })
  const { data: categoryGroupsList } = useQuery({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list })
  const { data: accountsList } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() })

  const closeEditor = () => setEditingTx(null)
  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: TransactionSavePayload & { id: string }) => transactions.update(id, data),
    onSuccess: () => { invalidateFinancialQueries(queryClient); closeEditor() },
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactions.delete(id),
    onSuccess: () => { invalidateFinancialQueries(queryClient); closeEditor() },
  })
  const unlinkTransferMutation = useMutation({
    mutationFn: (pairId: string) => transactions.unlinkTransfer(pairId),
    onSuccess: () => { invalidateFinancialQueries(queryClient); closeEditor() },
  })

  const picker = (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className={STEP_BUTTON} aria-label={t('plan.previousMonth')} onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
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
              setMonth(format(date, 'yyyy-MM'))
              setMonthCalOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      <button type="button" className={STEP_BUTTON} aria-label={t('plan.nextMonth')} onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
    </div>
  )

  return (
    <div>
      <PageHeader section={t('nav.groupSetup')} title={t('nav.spending')} action={picker} />
      <p className="mb-3 text-xs text-muted-foreground">{t('spending.hint')}</p>
      <SpendingByCategoryCard
        month={month}
        accountIds={activeAccountIds}
        onSelectCategory={setDrillDown}
        className="min-h-[320px]"
      />

      <TransactionDrillDown
        filter={drillDown ? { ...drillDown, account_ids: drillDown.account_ids ?? activeAccountIds ?? undefined } : null}
        onClose={() => setDrillDown(null)}
        onTransactionClick={(tx) => setEditingTx(tx)}
      />

      <TransactionDialog
        open={editingTx !== null}
        onClose={closeEditor}
        transaction={editingTx}
        categories={categoriesList ?? []}
        categoryGroups={categoryGroupsList ?? []}
        accounts={(accountsList ?? []).map((a) => ({
          id: a.id,
          name: getAccountName(a),
          display_name: a.display_name,
          type: a.type,
          currency: a.currency,
          secured_asset_id: a.secured_asset_id,
        }))}
        onSave={(data) => {
          if (editingTx) updateMutation.mutate({ id: editingTx.id, ...data })
        }}
        onDelete={() => {
          if (editingTx) deleteMutation.mutate(editingTx.id)
        }}
        onUnlinkTransfer={(pairId) => unlinkTransferMutation.mutate(pairId)}
        loading={updateMutation.isPending || deleteMutation.isPending || unlinkTransferMutation.isPending}
        error={updateMutation.error ? extractApiError(updateMutation.error) : deleteMutation.error ? extractApiError(deleteMutation.error) : null}
        isSynced={editingTx?.source === 'sync'}
      />
    </div>
  )
}
