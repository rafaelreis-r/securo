// Relative, not aliased: this file is pulled into the node test project,
// which compiles without the `@/*` path mapping (see tsconfig.node.json).
import type { MonthPlan, PlanBlock, PlanBlockSummary, PlanGridCell, PlanGridRow, PlanLine, YearGrid } from '../types'

type Decimal = number | string
type Raw<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] extends number ? Decimal : Decimal | null }

type RawLine = Raw<PlanLine, 'planned' | 'actual' | 'counter_flow'>
type RawBlock = Omit<Raw<PlanBlockSummary, 'planned' | 'actual'>, 'lines'> & { lines: RawLine[] }
type RawMonthPlan = Omit<Raw<MonthPlan, 'income_planned'>, 'blocks'> & { blocks: RawBlock[] }
type RawCell = Raw<PlanGridCell, 'planned' | 'actual'>
type RawGridRow = Omit<PlanGridRow, 'cells' | 'total'> & { cells: RawCell[]; total: RawCell }
type RawYearGrid = Omit<YearGrid, 'rows'> & { rows: RawGridRow[] }

const amount = (value: Decimal) => Number(value)
const optionalAmount = (value: Decimal | null | undefined) => (value === null || value === undefined ? null : Number(value))

/** The API sends decimals as strings; the plan screens compute with numbers. */
export function normalizeMonthPlan(raw: RawMonthPlan): MonthPlan {
  return {
    ...raw,
    income_planned: optionalAmount(raw.income_planned),
    blocks: raw.blocks.map((block) => ({
      ...block,
      planned: optionalAmount(block.planned),
      actual: amount(block.actual),
      lines: block.lines.map((line) => ({
        ...line,
        planned: optionalAmount(line.planned),
        actual: amount(line.actual),
        counter_flow: amount(line.counter_flow),
      })),
    })),
  }
}

function normalizeCell(cell: RawCell): PlanGridCell {
  return { ...cell, planned: optionalAmount(cell.planned), actual: amount(cell.actual) }
}

export function normalizeYearGrid(raw: RawYearGrid): YearGrid {
  return {
    ...raw,
    rows: raw.rows.map((row) => ({ ...row, cells: row.cells.map(normalizeCell), total: normalizeCell(row.total) })),
  }
}

/**
 * How a block or line stands against its target.
 * `over`: spending above the target. `short`: income or investment below it.
 * `none`: no target to compare with.
 */
export type PlanStatus = 'none' | 'ok' | 'over' | 'short'

/** Whether passing the target is bad, for a block of the year grid. */
export function blockOverIsBad(block: PlanBlock): boolean {
  return block === 'fixed_spending' || block === 'variable_spending'
}

export function planStatus(planned: number | null, actual: number, overIsBad: boolean): PlanStatus {
  if (planned === null) return 'none'
  if (overIsBad) return actual > planned ? 'over' : 'ok'
  return actual < planned ? 'short' : 'ok'
}

/** Text colour per status: red for overspending, amber for falling short. */
export const PLAN_STATUS_TEXT: Record<PlanStatus, string> = {
  none: 'text-muted-foreground',
  ok: 'text-emerald-700 dark:text-emerald-400',
  over: 'text-rose-700 dark:text-rose-300',
  short: 'text-amber-700 dark:text-amber-300',
}

/** Realizado minus previsto; null without a target. */
export function planDifference(planned: number | null, actual: number): number | null {
  return planned === null ? null : Math.round((actual - planned) * 100) / 100
}

/**
 * The amount that is `percent`% of the planned income, rounded to cents.
 * Null when there is no planned income to take a share of, or the percent is
 * not a non-negative number.
 */
export function amountFromIncomePercent(percent: number, incomePlanned: number | null): number | null {
  if (incomePlanned === null || !(incomePlanned > 0)) return null
  if (!Number.isFinite(percent) || percent < 0) return null
  return Math.round(incomePlanned * percent) / 100
}

/** Lines grouped by their category group, in the order the API sent them. */
export function groupPlanLines(lines: PlanLine[]): { key: string; name: string | null; lines: PlanLine[] }[] {
  const groups: { key: string; name: string | null; lines: PlanLine[] }[] = []
  for (const line of lines) {
    const key = line.group_id ?? line.group_name ?? ''
    const existing = groups.find((group) => group.key === key)
    if (existing) existing.lines.push(line)
    else groups.push({ key, name: line.group_name, lines: [line] })
  }
  return groups
}
