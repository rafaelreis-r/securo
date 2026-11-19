import { describe, expect, it } from 'vitest'
import { amountFromIncomePercent, groupPlanLines, normalizeMonthPlan, planDifference, planStatus } from './plan-utils'
import type { PlanLine } from '../types'

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
