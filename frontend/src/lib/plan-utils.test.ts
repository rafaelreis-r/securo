import { describe, expect, it } from 'vitest'
import { amountFromIncomePercent, groupPlanLines, normalizeMonthPlan, planDifference, planStatus, summarizeYear } from './plan-utils'
import type { PlanBlock, PlanLine, YearGrid } from '../types'

describe('planStatus', () => {
  it('flags spending above its target and income or investment below it', () => {
    expect(planStatus(100, 120, true)).toBe('over')
    expect(planStatus(100, 100, true)).toBe('ok')
    expect(planStatus(100, 80, false)).toBe('short')
    expect(planStatus(100, 120, false)).toBe('ok')
    expect(planStatus(null, 120, true)).toBe('none')
  })
})

describe('planDifference', () => {
  it('is actual minus planned, null without a target', () => {
    expect(planDifference(20000, 22000)).toBe(2000)
    expect(planDifference(null, 5)).toBeNull()
  })
})

describe('amountFromIncomePercent', () => {
  it('takes the percentage of the planned income, to the cent', () => {
    expect(amountFromIncomePercent(10, 50000)).toBe(5000)
    expect(amountFromIncomePercent(12.5, 1234.56)).toBe(154.32)
  })

  it('needs a planned income and a valid percentage', () => {
    expect(amountFromIncomePercent(10, null)).toBeNull()
    expect(amountFromIncomePercent(10, 0)).toBeNull()
    expect(amountFromIncomePercent(-1, 50000)).toBeNull()
    expect(amountFromIncomePercent(Number.NaN, 50000)).toBeNull()
  })
})

describe('normalizeMonthPlan', () => {
  it('turns decimal strings into numbers and keeps missing targets null', () => {
    const plan = normalizeMonthPlan({
      month: '2026-10-01', income_planned: '50000.00',
      blocks: [{
        block: 'fixed_spending', planned: null, actual: '-12.50', over_is_bad: true, share_of_income: null,
        lines: [{ category_id: null, name: 'x', icon: null, color: null, group_id: null, group_name: null, kind: null, planned: '1.10', actual: '2', counter_flow: '0.00', share_of_income: null }],
      }],
    })
    expect(plan.income_planned).toBe(50000)
    expect(plan.blocks[0].planned).toBeNull()
    expect(plan.blocks[0].actual).toBe(-12.5)
    expect(plan.blocks[0].lines[0]).toMatchObject({ planned: 1.1, actual: 2, counter_flow: 0 })
  })
})

describe('groupPlanLines', () => {
  it('groups lines by group in arrival order', () => {
    const line = (name: string, group_id: string | null, group_name: string | null) =>
      ({ name, group_id, group_name }) as PlanLine
    const groups = groupPlanLines([line('a', 'g1', 'One'), line('b', 'g2', 'Two'), line('c', 'g1', 'One'), line('d', null, null)])
    expect(groups.map((group) => [group.name, group.lines.map((item) => item.name)])).toEqual([
      ['One', ['a', 'c']], ['Two', ['b']], [null, ['d']],
    ])
  })
})

describe('summarizeYear', () => {
  const cells = (values: [number | null, number][]) =>
    values.map(([planned, actual], index) => ({ month: `2026-${String(index + 1).padStart(2, '0')}-01`, planned, actual }))
  const block = (name: PlanBlock, values: [number | null, number][]) => ({
    level: 'block' as const, block: name, group_id: null, group_name: null, category_id: null, name, kind: null,
    cells: cells(values), total: { month: '2026-01-01', planned: null, actual: 0 },
  })
  const months = (first: [number | null, number], second: [number | null, number]) =>
    [first, second, ...Array.from({ length: 10 }, (): [number | null, number] => [null, 0])]
  const grid: YearGrid = {
    year: 2026,
    committed: [0, 0, 1200.5, 800, 0, 0, 0, 0, 0, 0, 0, 0],
    rows: [
      block('income', months([30000, 31000.1], [30000, 29000])),
      block('investment', months([3000, 2500], [null, 0])),
      block('fixed_spending', months([20000, 21000], [20000, 20500.2])),
      block('variable_spending', months([10000, 9000], [15000, 12000])),
    ],
  }

  it('gives one line per month with income minus investment, fixed and variable as the result', () => {
    const { months: rows } = summarizeYear(grid, 'actual')
    expect(rows).toHaveLength(12)
    expect(rows[0]).toEqual({ month: '2026-01-01', income: 31000.1, investment: 2500, fixed: 21000, variable: 9000, result: -1499.9, committed: null })
    expect(rows[1].result).toBe(-3500.2)
  })

  it('takes investment as net, so a month that redeemed more than it applied adds to the result', () => {
    const redeemedMore: YearGrid = { ...grid, rows: grid.rows.map((row) => (row.block === 'investment' ? block('investment', months([3000, -4000], [null, 0])) : row)) }
    const { months: rows } = summarizeYear(redeemedMore, 'actual')
    expect(rows[0]).toMatchObject({ investment: -4000, result: 5000.1 })
  })

  it('totals each column over the year, the negative months included', () => {
    const { total } = summarizeYear(grid, 'actual')
    expect(total).toEqual({ month: '2026-01-01', income: 60000.1, investment: 2500, fixed: 41500.2, variable: 21000, result: -5000.1, committed: 2000.5 })
  })

  it('leaves a block without target empty and a month without any target without result', () => {
    const { months: rows, total } = summarizeYear(grid, 'planned')
    expect(rows[0].result).toBe(-3000)
    expect(rows[1]).toMatchObject({ investment: null, result: -5000 })
    expect(rows[2]).toMatchObject({ income: null, investment: null, fixed: null, variable: null, result: null, committed: 1200.5 })
    expect(total).toMatchObject({ income: 60000, investment: 3000, result: -8000 })
  })
})
