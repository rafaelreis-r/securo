import type { CategoryKind } from '@/types'

/** Every category kind, in the order the picker lists them. */
export const CATEGORY_KINDS: readonly CategoryKind[] = [
  'income',
  'investment',
  'fixed',
  'variable',
  'occasional',
  'transfer',
]

/**
 * Kinds whose transactions stay out of income and expense. The server decides
 * this (KIND_RULES in the backend); the page only uses it to explain the choice.
 */
export function isTransferLikeKind(kind: CategoryKind): boolean {
  return kind === 'investment' || kind === 'transfer'
}
