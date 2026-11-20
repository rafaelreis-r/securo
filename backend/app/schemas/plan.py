"""Wire shapes of the plan (metas) endpoints.

GET /api/budgets/plan/month?month=YYYY-MM-01  -> MonthPlan
GET /api/budgets/plan/year?year=YYYY          -> YearGrid

Amounts are in the user's primary currency. `planned` is None when no
budget (target) is set for the line. `actual` keeps its sign: a negative
actual is shown, never dropped.
"""

import uuid
from datetime import date
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel

from app.models.category import CategoryKind
from app.services.category_kind_rules import PlanBlock


class PlanLine(BaseModel):
    """One category (or the synthetic uncategorized line, category_id=None)."""

    category_id: Optional[uuid.UUID] = None
    name: str
    icon: Optional[str] = None
    color: Optional[str] = None
    group_id: Optional[uuid.UUID] = None
    group_name: Optional[str] = None
    kind: Optional[CategoryKind] = None  # None only for the uncategorized line
    planned: Optional[Decimal] = None
    actual: Decimal = Decimal("0")
    # Total of movements in the opposite direction of the kind, e.g. credits
    # inside a spending category. Non-zero means the category mixes flows.
    counter_flow: Decimal = Decimal("0")
    share_of_income: Optional[float] = None  # actual / income actual of the month


class BlockSummary(BaseModel):
    block: PlanBlock
    planned: Optional[Decimal] = None  # sum of the lines' planned; None when no line has one
    actual: Decimal = Decimal("0")
    over_is_bad: bool
    share_of_income: Optional[float] = None
    lines: list[PlanLine] = []


class MonthPlan(BaseModel):
    month: date  # first day
    income_planned: Optional[Decimal] = None  # base for "% da renda" targets
    blocks: list[BlockSummary]  # always 4, PlanBlock order


class GridCell(BaseModel):
    month: date
    planned: Optional[Decimal] = None
    actual: Decimal = Decimal("0")


class GridRow(BaseModel):
    level: Literal["block", "group", "category"]
    block: PlanBlock
    group_id: Optional[uuid.UUID] = None
    group_name: Optional[str] = None
    category_id: Optional[uuid.UUID] = None
    name: str
    kind: Optional[CategoryKind] = None
    cells: list[GridCell]  # always 12, Jan..Dec
    total: GridCell  # the year; month = Jan 1st


class YearGrid(BaseModel):
    year: int
    rows: list[GridRow]  # block row, then its groups, each followed by its categories
    # Installments already on the books that have not counted yet (pending, or
    # dated after today), per month Jan..Dec, spending categories only. They
    # land in the actual of their month once posted; never part of `rows`.
    committed: list[Decimal] = []
