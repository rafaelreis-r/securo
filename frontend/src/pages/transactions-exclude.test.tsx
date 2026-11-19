/**
 * "Exclude from totals" from the transaction list: the bulk bar and the
 * row's context menu take rows out of income and expense totals or bring
 * them back, and the toast says how many changed and how many were skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import TransactionsPage from '@/pages/transactions'
import { renderWithProviders } from '@/test/utils'
import type { Transaction } from '@/types'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

const api = vi.hoisted(() => ({
  transactions: { list: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn(), bulkFlag: vi.fn(), bulkExclude: vi.fn() },
  categories: { list: vi.fn(), listIncludingHidden: vi.fn() },
  categoryGroups: { list: vi.fn() },
  accounts: {
    get: vi.fn(), list: vi.fn(), bills: vi.fn(), summary: vi.fn(),
    update: vi.fn(), runningBalance: vi.fn(),
  },
  recurring: { list: vi.fn() },
  payees: { list: vi.fn() },
  admin: { accountingMode: vi.fn() },
  groups: { get: vi.fn(), list: vi.fn() },
  rules: { create: vi.fn() },
  reconciliation: { suggestions: vi.fn() },
  currencies: { list: vi.fn() },
  settings: { attachments: vi.fn() },
}))

vi.mock('@/lib/api', () => ({
  transactions: api.transactions,
  categories: api.categories,
  categoryGroups: api.categoryGroups,
  accounts: api.accounts,
  recurring: api.recurring,
  payees: api.payees,
  admin: api.admin,
  groups: api.groups,
  rules: api.rules,
  reconciliation: api.reconciliation,
  currencies: api.currencies,
  settings: api.settings,
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en-US',
  useDateLocale: () => 'en-US',
}))
vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '***' }),
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-1', preferences: { currency_display: 'BRL' } } }),
}))
vi.mock('@/contexts/workspace-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/workspace-context')>()
  return { ...actual, useWorkspace: () => ({ canWrite: true, hasModule: () => true }) }
})
vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({
    collections: [], activeCollectionId: null, activeCollection: null,
    setActiveCollectionId: () => {}, activeAccountIds: null, activeWalletIds: null,
  }),
}))

function row(id: string, description: string, excluded: boolean): Transaction {
  return {
    id, user_id: 'user-1', account_id: 'acc-1', description,
    category_id: null, category: null,
    external_id: null, original_description: null, amount: 42, currency: 'BRL',
    date: '2026-10-08', type: 'debit', source: 'manual', status: 'posted',
    payee: null, payee_id: null, payee_name: null, notes: null,
    transfer_pair_id: null, transfer_counterpart: null,
    amount_primary: null, fx_rate_used: null, fx_fallback: false,
    installment_number: null, total_installments: null, installment_total_amount: null,
    installment_purchase_date: null, installment_series_id: null,
    bill_id: null, effective_bill_date: null, reporting_date_override: null,
    splits: [], is_ignored: false, exclude_from_pnl: excluded, is_flagged: false,
  } as Transaction
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(new Date('2026-10-20T12:00:00'))
  api.transactions.list.mockResolvedValue({
    items: [row('tx-out', 'Refund paid for a friend', true), row('tx-in', 'Bakery', false)],
    total: 2, page: 1, limit: 50,
  })
  api.categories.list.mockResolvedValue([])
  api.categories.listIncludingHidden.mockResolvedValue([])
  api.categoryGroups.list.mockResolvedValue([])
  api.accounts.list.mockResolvedValue([])
  api.recurring.list.mockResolvedValue([])
  api.payees.list.mockResolvedValue([])
  api.admin.accountingMode.mockResolvedValue(false)
  api.groups.list.mockResolvedValue([])
  api.reconciliation.suggestions.mockResolvedValue([])
  api.currencies.list.mockResolvedValue([])
  api.settings.attachments.mockResolvedValue(false)
})

async function selectRow(user: ReturnType<typeof renderWithProviders>['user'], description: string) {
  const cell = await screen.findByText(description)
  await user.click(cell.closest('tr')!.querySelector('input[type="checkbox"]')!)
}

describe('exclude from totals', () => {
  it('takes the selected rows out of the totals and reports the skipped ones', async () => {
    api.transactions.bulkExclude.mockResolvedValue({ updated: 1, skipped_principal: 1, skipped_paired: 2 })
    const { user } = renderWithProviders(<TransactionsPage />, { route: '/transactions', path: '/transactions' })

    await selectRow(user, 'Bakery')
    await user.click(await screen.findByRole('button', { name: 'Exclude from totals' }))

    expect(api.transactions.bulkExclude).toHaveBeenCalledWith(['tx-in'], true)
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Excluded from income and expenses: 1',
      { description: 'Transfers left unchanged: 2 · Loan principal entries left unchanged: 1' },
    ))
  })

  it('counts the selection again when every selected row is already out', async () => {
    api.transactions.bulkExclude.mockResolvedValue({ updated: 1, skipped_principal: 0, skipped_paired: 0 })
    const { user } = renderWithProviders(<TransactionsPage />, { route: '/transactions', path: '/transactions' })

    await selectRow(user, 'Refund paid for a friend')
    await user.click(await screen.findByRole('button', { name: 'Count again' }))

    expect(api.transactions.bulkExclude).toHaveBeenCalledWith(['tx-out'], false)
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Counted again: 1', { description: undefined },
    ))
  })

  it('offers both actions on a row\'s context menu', async () => {
    api.transactions.bulkExclude.mockResolvedValue({ updated: 1, skipped_principal: 0, skipped_paired: 0 })
    const { user } = renderWithProviders(<TransactionsPage />, { route: '/transactions', path: '/transactions' })

    const cell = await screen.findByText('Refund paid for a friend')
    fireEvent.contextMenu(cell.closest('tr')!)
    expect(await screen.findByRole('menuitem', { name: 'Exclude from totals' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Count again' }))

    expect(api.transactions.bulkExclude).toHaveBeenCalledWith(['tx-out'], false)
  })
})
