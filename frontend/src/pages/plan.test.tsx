import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import PlanPage from '@/pages/plan'
import { normalizeMonthPlan, normalizeYearGrid } from '@/lib/plan-utils'
import { renderWithProviders, t } from '@/test/utils'

const api = vi.hoisted(() => ({
  budgets: { planMonth: vi.fn(), planYear: vi.fn() },
}))

vi.mock('@/lib/api', () => ({ budgets: api.budgets }))
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-timezone', () => ({ useEffectiveTimezone: () => 'UTC' }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { preferences: { currency_display: 'USD' } } }) }))
vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '••••' }),
}))

const line = (overrides: Record<string, unknown>) => ({
  category_id: 'c', name: 'Line', icon: 'circle-help', color: '#000', group_id: 'g', group_name: 'Group',
  kind: 'variable', planned: null, actual: '0.00', counter_flow: '0.00', share_of_income: null, ...overrides,
})

// Decimals arrive as strings, as the API sends them.
const monthPayload = {
  month: '2026-10-01',
  income_planned: '50000.00',
  blocks: [
    {
      block: 'income', planned: '50000.00', actual: '48000.00', over_is_bad: false, share_of_income: 1,
      lines: [line({ category_id: 'salary', name: 'Salary', kind: 'income', group_id: 'g-inc', group_name: 'Earnings', planned: '50000.00', actual: '48000.00' })],
    },
    {
      block: 'investment', planned: '10000.00', actual: '12000.00', over_is_bad: false, share_of_income: 0.25,
      lines: [line({ category_id: 'broker', name: 'Broker', kind: 'investment', group_id: 'g-inv', group_name: 'Investments', planned: '10000.00', actual: '12000.00' })],
    },
    {
      block: 'fixed_spending', planned: '20000.00', actual: '22000.00', over_is_bad: true, share_of_income: 0.4583,
      lines: [line({ category_id: 'rent', name: 'Rent paid', kind: 'fixed', group_id: 'g-home', group_name: 'Housing', planned: '20000.00', actual: '22000.00', counter_flow: '300.00' })],
    },
    {
      block: 'variable_spending', planned: null, actual: '5000.00', over_is_bad: true, share_of_income: 0.1042,
      lines: [
        line({ category_id: 'trip', name: 'Trip', kind: 'occasional', group_id: 'g-fun', group_name: 'Leisure', actual: '4000.00' }),
        line({ category_id: null, name: 'Uncategorized', kind: null, group_id: null, group_name: null, actual: '1000.00' }),
      ],
    },
  ],
}

const cells = (planned: string | null, actual: string) =>
  Array.from({ length: 12 }, (_, index) => ({ month: `2026-${String(index + 1).padStart(2, '0')}-01`, planned, actual }))

const gridRow = (level: string, block: string, name: string, planned: string | null, actual: string, extra: Record<string, unknown> = {}) => ({
  level, block, name, group_id: null, group_name: null, category_id: null, kind: null,
  cells: cells(planned, actual), total: { month: '2026-01-01', planned: planned === null ? null : String(Number(planned) * 12), actual: String(Number(actual) * 12) },
  ...extra,
})

const yearPayload = {
  year: 2026,
  rows: [
    gridRow('block', 'income', 'income', '50000.00', '48000.00'),
    gridRow('group', 'income', 'Earnings', '50000.00', '48000.00', { group_id: 'g-inc', group_name: 'Earnings' }),
    gridRow('category', 'income', 'Salary', '50000.00', '48000.00', { group_id: 'g-inc', group_name: 'Earnings', category_id: 'salary', kind: 'income' }),
    gridRow('block', 'fixed_spending', 'fixed_spending', '20000.00', '22000.00'),
    gridRow('group', 'fixed_spending', 'Housing', '20000.00', '22000.00', { group_id: 'g-home', group_name: 'Housing' }),
    gridRow('category', 'fixed_spending', 'Rent paid', '20000.00', '22000.00', { group_id: 'g-home', group_name: 'Housing', category_id: 'rent', kind: 'fixed' }),
  ],
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 10, 12)))
  vi.clearAllMocks()
  // Same normalization as the real client, so the page gets numbers.
  api.budgets.planMonth.mockImplementation(async () => normalizeMonthPlan(structuredClone(monthPayload) as never))
  api.budgets.planYear.mockImplementation(async () => normalizeYearGrid(structuredClone(yearPayload) as never))
})

const block = (key: string) => screen.getByRole('region', { name: t(`plan.blocks.${key}`) })

describe('Plan page, month', () => {
  it('shows the four blocks in order with planned, actual, difference and share of income', async () => {
    renderWithProviders(<PlanPage />)

    expect(await screen.findByRole('region', { name: t('plan.blocks.income') })).toBeInTheDocument()
    expect(api.budgets.planMonth).toHaveBeenCalledWith('2026-10-01')
    expect(screen.getAllByRole('region').map((region) => within(region).getByRole('heading').textContent)).toEqual([
      t('plan.blocks.income'), t('plan.blocks.investment'), t('plan.blocks.fixed_spending'), t('plan.blocks.variable_spending'),
    ])

    const income = block('income')
    expect(within(income).getByText('$50,000.00')).toBeInTheDocument()
    expect(within(income).getByText('$48,000.00')).toBeInTheDocument()
    expect(within(income).getByText('-$2,000.00')).toBeInTheDocument()
    expect(within(income).getByText('100%')).toBeInTheDocument()

    // Income below target warns; investment above it is fine.
    expect(income).toHaveAttribute('data-status', 'short')
    expect(within(income).getByText(t('plan.status.short'))).toBeInTheDocument()
    expect(block('investment')).toHaveAttribute('data-status', 'ok')
    // Spending above target is bad; no target is neutral.
    expect(block('fixed_spending')).toHaveAttribute('data-status', 'over')
    expect(within(block('fixed_spending')).getByText(t('plan.status.over'))).toBeInTheDocument()
    expect(within(block('fixed_spending')).getByText('$2,000.00')).toBeInTheDocument()
    expect(within(block('fixed_spending')).getByText('45.8%')).toBeInTheDocument()
    expect(block('variable_spending')).toHaveAttribute('data-status', 'none')
    expect(within(block('variable_spending')).getByText(t('plan.status.none'))).toBeInTheDocument()

    expect(screen.queryByText(t('plan.emptyTitle'))).not.toBeInTheDocument()
  })

  it('expands a block into grouped lines and flags mixed flows, occasional and uncategorized lines', async () => {
    const { user } = renderWithProviders(<PlanPage />)
    await screen.findByRole('region', { name: t('plan.blocks.fixed_spending') })

    expect(screen.queryByText(t('plan.counterFlowHint'))).not.toBeInTheDocument()
    const toggleFixed = within(block('fixed_spending')).getByRole('button', { name: t('plan.toggleLines', { block: t('plan.blocks.fixed_spending') }) })
    await user.click(toggleFixed)
    expect(toggleFixed).toHaveAttribute('aria-expanded', 'true')
    const fixed = block('fixed_spending')
    expect(within(fixed).getByText('Housing')).toBeInTheDocument()
    expect(within(fixed).getByRole('rowheader', { name: /Rent paid/ })).toHaveTextContent(t('plan.counterFlowHint'))

    await user.click(within(block('variable_spending')).getByRole('button', { name: t('plan.toggleLines', { block: t('plan.blocks.variable_spending') }) }))
    const variable = block('variable_spending')
    expect(within(variable).getByRole('rowheader', { name: /Trip/ })).toHaveTextContent(t('plan.occasionalTag'))
    expect(within(variable).getByText(t('plan.uncategorized'))).toBeInTheDocument()
    expect(within(variable).getByText(t('plan.noGroup'))).toBeInTheDocument()
    // Only the mixed category carries the warning.
    expect(screen.getAllByText(t('plan.counterFlowHint'))).toHaveLength(1)
  })

  it('points to Budgets when nothing is planned', async () => {
    api.budgets.planMonth.mockImplementation(async () => normalizeMonthPlan({
      ...structuredClone(monthPayload),
      income_planned: null,
      blocks: monthPayload.blocks.map((item) => ({ ...item, planned: null, lines: [] })),
    } as never))
    renderWithProviders(<PlanPage />)

    expect(await screen.findByText(t('plan.emptyTitle'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: t('plan.emptyAction') })).toHaveAttribute('href', '/budgets')
    expect(screen.getAllByRole('region')).toHaveLength(4)
  })
})

describe('Plan page, year', () => {
  it('summarizes the year by month: income, investment, fixed, variable and result, with the year total', async () => {
    const { user } = renderWithProviders(<PlanPage />)
    await screen.findByRole('region', { name: t('plan.blocks.income') })
    await user.click(screen.getByRole('tab', { name: t('plan.tabYear') }))

    const table = await screen.findByRole('table')
    expect(api.budgets.planYear).toHaveBeenCalledWith(2026)
    const headers = within(table).getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toEqual([
      t('plan.summary.month'), t('plan.summary.income'), t('plan.summary.investment'),
      t('plan.summary.fixed'), t('plan.summary.variable'), t('plan.summary.result'),
    ])
    // The year has targets, so the targets show first.
    expect(screen.getByRole('button', { name: t('plan.planned') })).toHaveAttribute('aria-pressed', 'true')

    const march = within(table).getByRole('row', { name: /March/ })
    expect(within(march).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['$50,000.00', '—', '$20,000.00', '—', '$30,000.00'])
    const year = within(table).getByRole('row', { name: /2026/ })
    expect(within(year).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['$600,000.00', '—', '$240,000.00', '—', '$360,000.00'])

    await user.click(screen.getByRole('button', { name: t('plan.actual') }))
    expect(within(march).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['$48,000.00', '—', '$22,000.00', '—', '$26,000.00'])
    // November has not happened yet.
    const november = within(table).getByRole('row', { name: /November/ })
    expect(within(november).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['—', '—', '—', '—', '—'])
  })

  it('links each month to its targets in Budgets', async () => {
    renderWithProviders(<PlanPage />, { route: '/?view=year' })
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('link', { name: t('plan.summary.adjustMonth', { month: 'October' }) }))
      .toHaveAttribute('href', '/budgets?month=2026-10')
  })

  it('still offers the grid by category, each cell planned / actual', async () => {
    const { user } = renderWithProviders(<PlanPage />, { route: '/?view=year' })
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: t('plan.summary.byCategory') }))

    const table = await screen.findByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers).toHaveLength(14)
    const rent = within(table).getByRole('row', { name: /Rent paid/ })
    const rentCells = within(rent).getAllByRole('cell')
    expect(rentCells[0]).toHaveTextContent('$20K / $22K')
    expect(rentCells[12]).toHaveTextContent('$240K / $264K')
  })

  it('collapses and expands a block row of the grid by category', async () => {
    const { user } = renderWithProviders(<PlanPage />, { route: '/?view=year&detail=categories' })
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('rowheader', { name: 'Rent paid' })).toBeInTheDocument()

    const fixedToggle = within(table).getByRole('button', { name: t('plan.blocks.fixed_spending') })
    expect(fixedToggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(fixedToggle)

    expect(fixedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(table).queryByRole('rowheader', { name: 'Rent paid' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('rowheader', { name: 'Housing' })).not.toBeInTheDocument()
    // The other block is untouched.
    expect(within(table).getByRole('rowheader', { name: 'Salary' })).toBeInTheDocument()

    await user.click(fixedToggle)
    expect(within(table).getByRole('rowheader', { name: 'Rent paid' })).toBeInTheDocument()
  })
})
