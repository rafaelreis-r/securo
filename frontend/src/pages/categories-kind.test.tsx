/**
 * A category's nature ("kind") on the categories page.
 *
 * One select decides it; there is no separate "treat as transfer" switch that
 * could disagree with it, because the server derives that flag from the kind.
 */
import { createContext } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import CategoriesPage from '@/pages/categories'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  categories: {
    listIncludingHidden: vi.fn(),
    usage: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ruleUsage: vi.fn(),
  },
  categoryGroups: {
    listIncludingHidden: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/lib/api', () => ({
  categories: api.categories,
  categoryGroups: api.categoryGroups,
}))

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ canWrite: true }),
  WorkspaceContext: createContext<{ canWrite: boolean } | undefined>({ canWrite: true }),
}))

function category(id: string, name: string, kind: string, treatAsTransfer = false) {
  return {
    id,
    user_id: 'user-1',
    name,
    icon: 'circle-help',
    color: '#6366f1',
    group_id: null,
    is_system: false,
    is_hidden: false,
    kind,
    treat_as_transfer: treatAsTransfer,
    is_ignored: false,
  }
}

const RENT = category('rent', 'Rent', 'fixed')
const BROKER = category('broker', 'Broker', 'investment', true)

beforeEach(() => {
  vi.clearAllMocks()
  api.categories.listIncludingHidden.mockResolvedValue([RENT, BROKER])
  api.categoryGroups.listIncludingHidden.mockResolvedValue([])
  api.categories.update.mockResolvedValue(RENT)
  api.categories.create.mockResolvedValue(RENT)
})

function rowOf(name: string) {
  return screen.getByText(name).closest('div')!.parentElement!
}

describe('category nature', () => {
  it('labels each category with its nature', async () => {
    renderWithProviders(<CategoriesPage />)

    await screen.findByText('Rent')
    expect(within(rowOf('Rent')).getByText('Fixed')).toBeInTheDocument()
    expect(within(rowOf('Broker')).getByText('Investment')).toBeInTheDocument()
  })

  it('edits the nature with one select and sends only the kind', async () => {
    const { user } = renderWithProviders(<CategoriesPage />)

    await screen.findByText('Broker')
    await user.click(within(rowOf('Broker')).getByTitle('Edit'))

    const select = await screen.findByLabelText('Nature')
    expect(select).toHaveValue('investment')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Income', 'Investment', 'Fixed', 'Variable', 'Occasional', 'Transfer',
    ])
    expect(screen.queryByText('Treat as transfer')).not.toBeInTheDocument()
    expect(screen.getByText(/won't count as income or expense/)).toBeInTheDocument()

    await user.selectOptions(select, 'occasional')
    expect(screen.getByText('What this category means in your plan.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.categories.update).toHaveBeenCalled())
    const [id, payload] = api.categories.update.mock.calls[0]
    expect(id).toBe('broker')
    expect(payload.kind).toBe('occasional')
    expect(payload).not.toHaveProperty('treat_as_transfer')
  })

  it('creates a category as variable unless another nature is picked', async () => {
    const { user } = renderWithProviders(<CategoriesPage />)

    await screen.findByText('Rent')
    await user.click(screen.getByRole('button', { name: /Add Category/ }))
    const select = await screen.findByLabelText('Nature')
    expect(select).toHaveValue('variable')

    const nameInput = screen.getByRole('dialog').querySelector<HTMLInputElement>('input[name="name"]')!
    await user.type(nameInput, 'Pix to myself')
    await user.selectOptions(select, 'transfer')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.categories.create).toHaveBeenCalled())
    const [payload] = api.categories.create.mock.calls[0]
    expect(payload).toMatchObject({ name: 'Pix to myself', kind: 'transfer' })
    expect(payload).not.toHaveProperty('treat_as_transfer')
  })
})
