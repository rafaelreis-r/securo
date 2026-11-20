// Relative, not aliased: this file is pulled into the node test project,
// which compiles without the `@/*` path mapping (see tsconfig.node.json).
import type { MonthPlan, PlanBlock, PlanBlockSummary, PlanGridCell, PlanGridRow, PlanLine, YearGrid, YearSources } from '../types'

type Decimal = number | string
type Raw<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] extends number ? Decimal : Decimal | null }

type RawLine = Raw<PlanLine, 'planned' | 'actual' | 'counter_flow'>
type RawBlock = Omit<Raw<PlanBlockSummary, 'planned' | 'actual'>, 'lines'> & { lines: RawLine[] }
type RawMonthPlan = Omit<Raw<MonthPlan, 'income_planned'>, 'blocks'> & { blocks: RawBlock[] }
type RawCell = Raw<PlanGridCell, 'planned' | 'actual'>
type RawGridRow = Omit<PlanGridRow, 'cells' | 'total'> & { cells: RawCell[]; total: RawCell }
type RawYearGrid = Omit<YearGrid, 'rows' | 'committed'> & { rows: RawGridRow[]; committed?: Decimal[] }

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
    committed: (raw.committed ?? []).map(amount),
  }
}

type RawYearSources = Omit<YearSources, 'sources'> & { sources: { name: string | null; cells: Decimal[]; total: Decimal }[] }

export function normalizeYearSources(raw: RawYearSources): YearSources {
  return { ...raw, sources: raw.sources.map((row) => ({ ...row, cells: row.cells.map(amount), total: amount(row.total) })) }
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

/** Which figure the year summary shows: the targets or what happened. */
export type PlanFigure = 'planned' | 'actual'

/** One line of the year summary: the four blocks and what is left. */
export interface PlanSummaryRow {
  /** `YYYY-MM-01`; Jan 1st for the year total. */
  month: string
  income: number | null
  investment: number | null
  fixed: number | null
  variable: number | null
  /** Income minus investment, fixed and variable. Negative: the month does not close. */
  result: number | null
  /** Installments already on the books still to count that month; null when none. */
  committed: number | null
}

const cents = (value: number) => Math.round(value * 100) / 100
const sumKnown = (values: (number | null)[]) =>
  values.some((value) => value !== null) ? cents(values.reduce<number>((total, value) => total + (value ?? 0), 0)) : null

function summaryRow(month: string, income: number | null, investment: number | null, fixed: number | null, variable: number | null, committed: number | null): PlanSummaryRow {
  const known = [income, investment, fixed, variable].some((value) => value !== null)
  const result = known ? cents((income ?? 0) - (investment ?? 0) - (fixed ?? 0) - (variable ?? 0)) : null
  return { month, income, investment, fixed, variable, result, committed }
}

/**
 * The year grid folded to one line per month (the advisor's summary):
 * income, investment, fixed and variable spending, and the result, plus the
 * year total of each column. `planned` leaves a block null when it has no
 * target that month; a month with no target at all has a null result.
 * `committed` (installments still to come) is the same in both figures and
 * stays out of the result: the targets already cover that spending.
 */
export function summarizeYear(grid: YearGrid, figure: PlanFigure): { months: PlanSummaryRow[]; total: PlanSummaryRow } {
  const blockCells = (block: PlanBlock) => grid.rows.find((row) => row.level === 'block' && row.block === block)?.cells ?? []
  const pick = (cell: PlanGridCell | undefined) => (cell === undefined ? null : figure === 'planned' ? cell.planned : cell.actual)
  const income = blockCells('income')
  const investment = blockCells('investment')
  const fixed = blockCells('fixed_spending')
  const variable = blockCells('variable_spending')
  const months = Array.from({ length: 12 }, (_, index) => summaryRow(
    `${grid.year}-${String(index + 1).padStart(2, '0')}-01`,
    pick(income[index]), pick(investment[index]), pick(fixed[index]), pick(variable[index]),
    grid.committed[index] ? grid.committed[index] : null,
  ))
  const total: PlanSummaryRow = {
    month: `${grid.year}-01-01`,
    income: sumKnown(months.map((row) => row.income)),
    investment: sumKnown(months.map((row) => row.investment)),
    fixed: sumKnown(months.map((row) => row.fixed)),
    variable: sumKnown(months.map((row) => row.variable)),
    result: sumKnown(months.map((row) => row.result)),
    committed: sumKnown(months.map((row) => row.committed)),
  }
  return { months, total }
}
