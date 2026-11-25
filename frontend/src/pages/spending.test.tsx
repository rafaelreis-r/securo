import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router-dom'

import SpendingPage from '@/pages/spending'
import { renderWithProviders, t } from '@/test/utils'

const api = vi.hoisted(() => ({
  dashboard: { spendingByCategory: vi.fn() },
  budgets: { comparison: vi.fn() },
  transactions: { update: vi.fn(), delete: vi.fn(), unlinkTransfer: vi.fn() },
  categories: { list: vi.fn() },
  categoryGroups: { list: vi.fn() },
  accounts: { list: vi.fn() },
}))
const drillDown = vi.hoisted(() => ({ props: [] as Array<{ filter: unknown; onTransactionClick?: (tx: unknown) => void }> }))
const dialog = vi.hoisted(() => ({ props: [] as Array<{ open: boolean; transaction: unknown }> }))

vi.mock('@/lib/api', () => api)
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-timezone', () => ({ useEffectiveTimezone: () => 'UTC' }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { preferences: { currency_display: 'USD' } } }) }))
vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null, activeWalletIds: null }),
}))
vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '••••' }),
}))
// The panel and the editor have their own tests; here we only check what the
// page hands them.
vi.mock('@/components/transaction-drill-down', () => ({
  TransactionDrillDown: (props: { filter: unknown; onTransactionClick?: (tx: unknown) => void }) => {
    drillDown.props.push(props)
    return props.filter ? (
      <button type="button" onClick={() => props.onTransactionClick?.({ id: 'tx-1', source: 'sync' })}>open tx</button>
    ) : null
  },
}))
vi.mock('@/components/transaction-dialog', () => ({
  TransactionDialog: (props: { open: boolean; transaction: unknown }) => {
    dialog.props.push(props)
    return props.open ? <div role="dialog">editor</div> : null
  },
}))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

const row = (id: string, name: string, total: number) => ({
  category_id: id, category_name: name, category_icon: 'circle-help', category_color: '#000',
  total, projected_total: total, percentage: 0,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 24, 12)))
  vi.clearAllMocks()
  drillDown.props = []
  dialog.props = []
  api.dashboard.spendingByCategory.mockResolvedValue([row('food', 'Food', 6550.09), row('market', 'Market', 6592.1), row('none', 'Uncategorized', 10)].map((r, i) => (i === 2 ? { ...r, category_id: null } : r)))
  api.budgets.comparison.mockResolvedValue([])
  api.categories.list.mockResolvedValue([])
  api.categoryGroups.list.mockResolvedValue([])
  api.accounts.list.mockResolvedValue([])
})

const render = (route = '/spending') => renderWithProviders(<><SpendingPage /><LocationProbe /></>, { route })

describe('SpendingPage', () => {
  it('lists the month spending per category, highest first, from the URL month', async () => {
    render('/spending?month=2026-10')

    expect(screen.getByRole('heading', { name: t('nav.spending') })).toBeInTheDocument()
    const market = await screen.findByText('Market')
    const food = screen.getByText('Food')
    expect(market.compareDocumentPosition(food) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument()
    expect(screen.getByText('$6,592.10')).toBeInTheDocument()
    expect(api.dashboard.spendingByCategory).toHaveBeenCalledWith('2026-10-01', undefined)
  })

  it('defaults to the current month and keeps the chosen month in the URL', async () => {
    render()
    await screen.findByText('Food')
    expect(api.dashboard.spendingByCategory).toHaveBeenCalledWith('2026-11-01', undefined)

    fireEvent.click(screen.getByRole('button', { name: t('plan.previousMonth') }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?month=2026-10'))
    await waitFor(() => expect(api.dashboard.spendingByCategory).toHaveBeenCalledWith('2026-10-01', undefined))
  })

  it('opens the category transactions for the month, then the editor for a transaction', async () => {
    render('/spending?month=2026-10')
    fireEvent.click(await screen.findByText('Food'))

    const last = drillDown.props[drillDown.props.length - 1]
    expect(last.filter).toMatchObject({ category_id: 'food', type: 'debit', from: '2026-10-01', to: '2026-10-31' })

    fireEvent.click(screen.getByRole('button', { name: 'open tx' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('editor')
    expect(dialog.props[dialog.props.length - 1]).toMatchObject({ open: true, transaction: { id: 'tx-1' } })
  })
})
