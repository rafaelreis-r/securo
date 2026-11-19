"""Plan (metas): planned vs actual in four blocks, by month and by year.

Planned values are the existing Budget rows (per category, month override >
latest recurring default). Actuals come from posted transactions, signed per
category kind by `KIND_RULES`. The fold is pure so the hard cases (a
category with flows both ways, investment counting only what was applied,
transfers out of every block) are unit-tested without a database.

Totals must reconcile: for any month, FIXED_SPENDING + VARIABLE_SPENDING
actual equals the expense total the dashboard shows for that month.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Iterable, Mapping, Optional, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import CategoryKind
from app.schemas.plan import MonthPlan, YearGrid


@dataclass(frozen=True)
class Movement:
    """Posted money of one category in one month, already filtered to what counts."""

    month: date
    category_id: Optional[uuid.UUID]  # None: uncategorized
    debit: Decimal
    credit: Decimal


@dataclass(frozen=True)
class BudgetRow:
    category_id: uuid.UUID
    month: date
    amount: Decimal
    is_recurring: bool


@dataclass(frozen=True)
class CategoryInfo:
    id: uuid.UUID
    name: str
    icon: Optional[str]
    color: Optional[str]
    group_id: Optional[uuid.UUID]
    group_name: Optional[str]
    kind: CategoryKind


def resolve_planned(budgets: Sequence[BudgetRow], month: date) -> dict[uuid.UUID, Decimal]:
    """Month override > most recent recurring default with month <= M.

    The one resolver: budget_service's map is built from it too.
    """
    raise NotImplementedError


def fold_month(
    month: date,
    cats: Mapping[uuid.UUID, CategoryInfo],
    planned: Mapping[uuid.UUID, Decimal],
    moves: Iterable[Movement],
) -> MonthPlan:
    """Sign each category by KIND_RULES[kind].actual, keep negative nets,
    record counter_flow, put uncategorized debits on a synthetic line in
    VARIABLE_SPENDING, drop TRANSFER kinds, compute shares of income.
    Lines with neither planned nor movement are omitted; blocks always present.
    """
    raise NotImplementedError


async def get_month_plan(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, month: date
) -> MonthPlan:
    raise NotImplementedError


async def get_year_grid(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, year: int
) -> YearGrid:
    """One grouped movements query for the year, one Budget query; each
    month column equals get_month_plan of that month."""
    raise NotImplementedError
