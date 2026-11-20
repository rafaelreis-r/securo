import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { budgets as budgetsApi } from '@/lib/api'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PLAN_STATUS_TEXT, blockOverIsBad, planStatus } from '@/lib/plan-utils'
import type { PlanBlock, PlanGridCell, PlanGridRow, YearGrid } from '@/types'

function Cell({ cell, overIsBad, money, emphasis }: { cell: PlanGridCell; overIsBad: boolean; money: (value: number) => string; emphasis?: boolean }) {
  const status = planStatus(cell.planned, cell.actual, overIsBad)
  return (
    <td className={cn('px-2 py-1.5 text-end text-xs tabular-nums whitespace-nowrap', emphasis && 'font-semibold')}>
      <span className="text-muted-foreground">{cell.planned === null ? '—' : money(cell.planned)}</span>
      <span className="text-muted-foreground/60"> / </span>
      <span className={cn(status === 'none' ? 'text-foreground' : PLAN_STATUS_TEXT[status])}>{money(cell.actual)}</span>
    </td>
  )
}

/** Where one category's money came from or went to, by payee: loaded when opened. */
function SourceRows({ year, categoryId, money }: { year: number; categoryId: string | null; money: (value: number) => string }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['budgets', 'plan', 'sources', year, categoryId],
    queryFn: () => budgetsApi.planYearSources(year, categoryId),
  })
  const note = (text: string) => (
    <tr className="border-b border-border">
      <td colSpan={14} className="sticky start-0 bg-card ps-20 pe-4 py-1.5 text-start text-[11px] text-muted-foreground">{text}</td>
    </tr>
  )
  if (query.isError) return note(t('plan.sources.error'))
  if (!query.data) return note(t('plan.sources.loading'))
  if (query.data.sources.length === 0) return note(t('plan.sources.empty'))
  return (
    <>
      {query.data.sources.map((source, index) => (
        <tr key={`${source.name ?? ''}-${index}`} className="border-b border-border bg-muted/5">
          <th scope="row" className="sticky start-0 z-10 bg-card ps-20 pe-4 py-1 text-start text-[11px] font-normal text-muted-foreground max-w-[16rem] truncate" title={source.name ?? undefined}>
            {source.name ?? t('plan.sources.rest')}
          </th>
          {source.cells.map((value, month) => (
            <td key={month} className="px-2 py-1 text-end text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">{value === 0 ? '' : money(value)}</td>
          ))}
          <td className="px-2 py-1 text-end text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">{money(source.total)}</td>
        </tr>
      ))}
    </>
  )
}

/**
 * Block → group → category rows against twelve month columns plus the year.
 * Each cell reads "previsto / realizado"; block rows fold their groups away.
 * A category opens on its payees (closed by default).
 */
export function PlanYearGrid({ grid, money, locale }: { grid: YearGrid; money: (value: number) => string; locale: string }) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<PlanBlock>>(() => new Set())
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => new Set())
  const toggleCategory = (key: string) => setOpenCategories((previous) => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const monthNames = Array.from({ length: 12 }, (_, index) =>
    new Date(grid.year, index, 2).toLocaleDateString(locale, { month: 'short' }).replace(/\.$/, ''))
  const toggle = (block: PlanBlock) => setCollapsed((previous) => {
    const next = new Set(previous)
    if (next.has(block)) next.delete(block)
    else next.add(block)
    return next
  })

  const label = (row: PlanGridRow) => {
    if (row.level === 'block') return t(`plan.blocks.${row.block}`)
    if (row.level === 'group') return row.group_name ?? t('plan.noGroup')
    return row.category_id === null ? t('plan.uncategorized') : row.name
  }

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-x-auto">
      <table className="w-full min-w-[1100px] border-collapse">
        <thead>
          <tr className="text-[11px] text-muted-foreground border-b border-border">
            <th scope="col" className="sticky start-0 z-10 bg-card px-4 py-2 text-start font-medium min-w-[12rem]">{t('plan.category')}</th>
            {monthNames.map((name) => <th key={name} scope="col" className="px-2 py-2 text-end font-medium capitalize">{name}</th>)}
            <th scope="col" className="px-2 py-2 text-end font-medium">{t('plan.total')}</th>
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row, index) => {
            if (row.level !== 'block' && collapsed.has(row.block)) return null
            const overIsBad = blockOverIsBad(row.block)
            const isBlock = row.level === 'block'
            const name = label(row)
            const categoryKey = `${row.block}:${row.category_id ?? 'none'}`
            const categoryOpen = row.level === 'category' && openCategories.has(categoryKey)
            return (
              <Fragment key={`${row.level}-${row.block}-${row.group_id ?? ''}-${row.category_id ?? ''}-${index}`}>
              <tr
                className={cn('border-b border-border last:border-0', isBlock && 'bg-muted/40', row.level === 'group' && 'bg-muted/10')}
              >
                <th
                  scope="row"
                  className={cn(
                    'sticky start-0 z-10 px-4 py-1.5 text-start text-xs',
                    isBlock ? 'bg-muted font-semibold text-foreground' : 'bg-card font-normal text-foreground',
                    row.level === 'group' && 'ps-8 font-medium',
                    row.level === 'category' && 'ps-12',
                  )}
                >
                  {isBlock ? (
                    <button
                      type="button"
                      aria-expanded={!collapsed.has(row.block)}
                      onClick={() => toggle(row.block)}
                      className="inline-flex items-center gap-1 hover:text-primary"
                    >
                      <ChevronRight size={13} aria-hidden className={cn('transition-transform rtl:-scale-x-100', !collapsed.has(row.block) && 'rotate-90 rtl:scale-x-100')} />
                      {name}
                    </button>
                  ) : row.level === 'category' ? (
                    <button
                      type="button"
                      aria-expanded={categoryOpen}
                      title={t('plan.sources.toggle', { name })}
                      onClick={() => toggleCategory(categoryKey)}
                      className="-ms-4 inline-flex items-center gap-1 hover:text-primary text-start"
                    >
                      <ChevronRight size={12} aria-hidden className={cn('text-muted-foreground transition-transform rtl:-scale-x-100', categoryOpen && 'rotate-90 rtl:scale-x-100')} />
                      {name}
                    </button>
                  ) : name}
                </th>
                {row.cells.map((cell) => <Cell key={cell.month} cell={cell} overIsBad={overIsBad} money={money} emphasis={isBlock} />)}
                <Cell cell={row.total} overIsBad={overIsBad} money={money} emphasis />
              </tr>
              {categoryOpen && <SourceRows year={grid.year} categoryId={row.category_id} money={money} />}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
