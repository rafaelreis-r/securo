import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { CategoryIcon } from '@/components/category-icon'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { PLAN_STATUS_TEXT as STATUS_TEXT, groupPlanLines, planDifference, planStatus, type PlanStatus } from '@/lib/plan-utils'
import type { MonthPlan, PlanBlockSummary, PlanLine } from '@/types'

const STATUS_BORDER: Record<PlanStatus, string> = {
  none: 'border-s-border',
  ok: 'border-s-emerald-500',
  over: 'border-s-rose-500',
  short: 'border-s-amber-500',
}

export interface PlanFormatters {
  money: (value: number) => string
  percent: (ratio: number | null) => string
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn('text-sm font-semibold tabular-nums text-foreground break-words', className)}>{value}</dd>
    </div>
  )
}

function LineRow({ line, overIsBad, format }: { line: PlanLine; overIsBad: boolean; format: PlanFormatters }) {
  const { t } = useTranslation()
  const status = planStatus(line.planned, line.actual, overIsBad)
  const difference = planDifference(line.planned, line.actual)
  const name = line.category_id === null ? t('plan.uncategorized') : line.name
  return (
    <tr className="border-b border-border last:border-0">
      <th scope="row" className="px-4 sm:px-5 py-2 text-start font-normal">
        <div className="flex min-w-0 items-center gap-2.5">
          <CategoryIcon icon={line.icon} color={line.color} size="sm" />
          <div className="min-w-0">
            <span className="text-sm text-foreground break-words">{name}</span>
            {line.kind === 'occasional' && (
              <Badge variant="outline" className="ms-2 text-[10px] py-0">{t('plan.occasionalTag')}</Badge>
            )}
            {line.counter_flow !== 0 && (
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                <AlertTriangle size={11} aria-hidden />
                {t('plan.counterFlowHint')}
              </p>
            )}
          </div>
        </div>
      </th>
      <td className="px-2 py-2 text-end text-sm tabular-nums text-muted-foreground">{line.planned === null ? '—' : format.money(line.planned)}</td>
      <td className="px-2 py-2 text-end text-sm tabular-nums text-foreground">{format.money(line.actual)}</td>
      <td className={cn('px-2 py-2 text-end text-sm tabular-nums', STATUS_TEXT[status])}>{difference === null ? '—' : format.money(difference)}</td>
      <td className="px-4 sm:px-5 py-2 text-end text-sm tabular-nums text-muted-foreground">{format.percent(line.share_of_income)}</td>
    </tr>
  )
}

function BlockCard({ block, format }: { block: PlanBlockSummary; format: PlanFormatters }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const status = planStatus(block.planned, block.actual, block.over_is_bad)
  const difference = planDifference(block.planned, block.actual)
  const title = t(`plan.blocks.${block.block}`)
  const titleId = `plan-block-${block.block}`
  const linesId = `plan-block-lines-${block.block}`
  return (
    <section
      aria-labelledby={titleId}
      data-status={status}
      className={cn('bg-card rounded-xl border border-border border-s-4 shadow-sm overflow-hidden', STATUS_BORDER[status])}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 sm:px-5 py-4">
        <div className="min-w-0 space-y-3 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
            <span className={cn('text-xs font-medium', STATUS_TEXT[status])}>{t(`plan.status.${status}`)}</span>
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label={t('plan.planned')} value={block.planned === null ? '—' : format.money(block.planned)} />
            <Metric label={t('plan.actual')} value={format.money(block.actual)} />
            <Metric label={t('plan.difference')} value={difference === null ? '—' : format.money(difference)} className={STATUS_TEXT[status]} />
            <Metric label={t('plan.shareOfIncome')} value={format.percent(block.share_of_income)} />
          </dl>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={linesId}
          aria-label={t('plan.toggleLines', { block: title })}
          disabled={block.lines.length === 0}
          onClick={() => setOpen((value) => !value)}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
        >
          <ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div id={linesId} className="border-t border-border overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr className="text-[11px] text-muted-foreground">
                <th scope="col" className="px-4 sm:px-5 py-2 text-start font-medium">{t('plan.category')}</th>
                <th scope="col" className="px-2 py-2 text-end font-medium">{t('plan.planned')}</th>
                <th scope="col" className="px-2 py-2 text-end font-medium">{t('plan.actual')}</th>
                <th scope="col" className="px-2 py-2 text-end font-medium">{t('plan.difference')}</th>
                <th scope="col" className="px-4 sm:px-5 py-2 text-end font-medium">{t('plan.shareOfIncome')}</th>
              </tr>
            </thead>
            {groupPlanLines(block.lines).map((group) => (
              <tbody key={group.key}>
                <tr>
                  <th colSpan={5} scope="colgroup" className="bg-muted/30 px-4 sm:px-5 py-1.5 text-start text-xs font-medium text-muted-foreground border-y border-border">
                    {group.name ?? t('plan.noGroup')}
                  </th>
                </tr>
                {group.lines.map((line) => (
                  <LineRow key={line.category_id ?? 'uncategorized'} line={line} overIsBad={block.over_is_bad} format={format} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  )
}

export function PlanMonthView({ plan, format }: { plan: MonthPlan; format: PlanFormatters }) {
  const { t } = useTranslation()
  const nothingPlanned = plan.income_planned === null && plan.blocks.every((block) => block.planned === null)
  return (
    <div className="space-y-4">
      {nothingPlanned && <PlanEmptyHint />}
      {plan.blocks.map((block) => <BlockCard key={block.block} block={block} format={format} />)}
      {plan.income_planned !== null && (
        <p className="text-xs text-muted-foreground">{t('plan.incomePlannedNote', { amount: format.money(plan.income_planned) })}</p>
      )}
    </div>
  )
}

export function PlanEmptyHint() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 sm:px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{t('plan.emptyTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('plan.emptyDescription')}</p>
      </div>
      <Link to="/budgets" className="text-sm font-medium text-primary hover:underline">{t('plan.emptyAction')}</Link>
    </div>
  )
}
