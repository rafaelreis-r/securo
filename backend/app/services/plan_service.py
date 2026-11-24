"""Plan (metas): planned vs actual in four blocks, by month and by year.

Planned values are the existing Budget rows (per category, month override >
latest recurring default). Actuals come from posted transactions, signed per
category kind by `KIND_RULES`. The fold is pure so the hard cases (a
category with flows both ways, investment netting applications and
redemptions, transfers out of every block) are unit-tested without a database.

Totals must reconcile with the dashboard. The dashboard's monthly expense is
every debit that counts toward the user's P/L, so for any month:

    FIXED_SPENDING + VARIABLE_SPENDING actual
      + their categories' counter_flow (credits inside spending categories)
      + the INCOME block's counter_flow (debits inside income categories)
    == dashboard expense

(The uncategorized line's counter_flow is uncategorized credits, which the
dashboard books as income, so it stays out of the sum.)

When no category mixes flows, the two counter-flow terms are zero and fixed
plus variable equals the dashboard expense exactly.

Investment sits outside that identity: its categories are transfer-like, so
the dashboard never books them. Its actual is net, applied (debits) minus
redeemed (credits, see `counts_as_investment`), and can be negative in a
month that took out more than it put in. Its counter_flow is what was
redeemed, so applied = actual + counter_flow. With a net investment, income
minus investment minus fixed and variable spending is the month's cash left.
"""

from __future__ import annotations

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Iterable, Mapping, Optional, Protocol, Sequence, TypeVar

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.core.config import get_settings
from app.models.budget import Budget
from app.models.category import Category, CategoryKind
from app.models.category_group import CategoryGroup
from app.models.payee import Payee
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.plan import (
    BlockSummary,
    GridCell,
    GridRow,
    MonthPlan,
    PlanLine,
    SourceRow,
    YearGrid,
    YearSources,
)
from app.services._query_filters import (
    counts_as_investment,
    counts_as_user_pnl,
    line_category_id,
    line_primary_or_amount,
    owner_split_offset_by_category,
    reporting_date_col,
    viewer_shared_spending_by_category,
    with_category_lines,
)
from app.services.admin_service import get_credit_card_accounting_mode
from app.services.category_kind_rules import KIND_RULES, ActualRule, PlanBlock

UNCATEGORIZED_NAME = "Uncategorized"
_CENT = Decimal("0.01")
_ZERO = Decimal("0")


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


class _BudgetLike(Protocol):
    @property
    def category_id(self) -> uuid.UUID: ...
    @property
    def month(self) -> date: ...
    @property
    def is_recurring(self) -> bool: ...


B = TypeVar("B", bound=_BudgetLike)


def resolve_effective_budgets(budgets: Iterable[B], month: date) -> dict[uuid.UUID, list[B]]:
    """The budget rows in effect for each category in `month` (first day).

    Month override (`is_recurring=False`, month == M) > the most recent
    recurring default with month <= M. A slot can hold one row per author
    (the unique key includes `user_id`), so each category maps to every row
    of its winning slot. Works on `BudgetRow` and on `Budget` models alike,
    so `budget_service` resolves through it too.
    """
    recurring: dict[uuid.UUID, list[B]] = {}
    overrides: dict[uuid.UUID, list[B]] = {}
    for b in budgets:
        if b.is_recurring:
            if b.month > month:
                continue
            current = recurring.get(b.category_id)
            if current is None or b.month > current[0].month:
                recurring[b.category_id] = [b]
            elif b.month == current[0].month:
                current.append(b)
        elif b.month == month:
            overrides.setdefault(b.category_id, []).append(b)
    return {**recurring, **overrides}


def resolve_planned(budgets: Sequence[BudgetRow], month: date) -> dict[uuid.UUID, Decimal]:
    """Month override > most recent recurring default with month <= M.

    The one resolver: budget_service's map is built from it too
    (through `resolve_effective_budgets`, which keeps the winning rows).
    Rows of the same slot by different authors add up.
    """
    return {
        cat_id: sum((row.amount for row in rows), _ZERO)
        for cat_id, rows in resolve_effective_budgets(budgets, month).items()
    }


def _share(actual: Decimal, income_actual: Decimal) -> Optional[float]:
    if income_actual == 0:
        return None
    return float(actual / income_actual)


def _sum_planned(values: Iterable[Optional[Decimal]]) -> Optional[Decimal]:
    present = [v for v in values if v is not None]
    return sum(present, _ZERO) if present else None


def _line_order(line: PlanLine) -> tuple:
    """Grouped categories by group name, then ungrouped ones, the
    uncategorized line last; by name inside each."""
    return (
        line.category_id is None,
        line.group_name is None,
        (line.group_name or "").casefold(),
        str(line.group_id or ""),
        line.name.casefold(),
        str(line.category_id or ""),
    )


def _block_over_is_bad() -> dict[PlanBlock, bool]:
    out: dict[PlanBlock, bool] = {}
    for rule in KIND_RULES.values():
        if rule.block is not None:
            out.setdefault(rule.block, rule.over_is_bad)
    return out


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

    Movements of other months are ignored. A movement whose category is not
    in `cats` (a share of a category from another workspace) lands on the
    uncategorized line, so the expense total still reconciles.
    """
    debit: dict[Optional[uuid.UUID], Decimal] = defaultdict(lambda: _ZERO)
    credit: dict[Optional[uuid.UUID], Decimal] = defaultdict(lambda: _ZERO)
    for m in moves:
        if m.month != month:
            continue
        key = m.category_id if m.category_id in cats else None
        debit[key] += m.debit
        credit[key] += m.credit

    lines_by_block: dict[PlanBlock, list[PlanLine]] = {b: [] for b in PlanBlock}
    for cat in cats.values():
        rule = KIND_RULES[cat.kind]
        if rule.block is None:
            continue
        line_planned = planned.get(cat.id)
        d, c = debit.get(cat.id, _ZERO), credit.get(cat.id, _ZERO)
        if line_planned is None and d == 0 and c == 0:
            continue
        if rule.actual is ActualRule.CREDITS_MINUS_DEBITS:
            actual, counter = c - d, d
        else:  # DEBITS_MINUS_CREDITS: refunds lower spending, redemptions lower investment
            actual, counter = d - c, c
        lines_by_block[rule.block].append(
            PlanLine(
                category_id=cat.id,
                name=cat.name,
                icon=cat.icon,
                color=cat.color,
                group_id=cat.group_id,
                group_name=cat.group_name,
                kind=cat.kind,
                planned=line_planned,
                actual=actual,
                counter_flow=counter,
            )
        )

    d, c = debit.get(None, _ZERO), credit.get(None, _ZERO)
    if d != 0 or c != 0:
        lines_by_block[PlanBlock.VARIABLE_SPENDING].append(
            PlanLine(category_id=None, name=UNCATEGORIZED_NAME, actual=d, counter_flow=c)
        )

    income_actual = sum((line.actual for line in lines_by_block[PlanBlock.INCOME]), _ZERO)
    over_is_bad = _block_over_is_bad()
    blocks: list[BlockSummary] = []
    for block in PlanBlock:
        lines = sorted(lines_by_block[block], key=_line_order)
        for line in lines:
            line.share_of_income = _share(line.actual, income_actual)
        block_actual = sum((line.actual for line in lines), _ZERO)
        blocks.append(
            BlockSummary(
                block=block,
                planned=_sum_planned(line.planned for line in lines),
                actual=block_actual,
                over_is_bad=over_is_bad[block],
                share_of_income=_share(block_actual, income_actual),
                lines=lines,
            )
        )

    return MonthPlan(
        month=month,
        income_planned=_sum_planned(line.planned for line in lines_by_block[PlanBlock.INCOME]),
        blocks=blocks,
    )


# ---------------------------------------------------------------------------
# Database shell
# ---------------------------------------------------------------------------


def _add_months(d: date, n: int) -> date:
    index = d.year * 12 + d.month - 1 + n
    return date(index // 12, index % 12 + 1, 1)


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(_CENT)


async def _load_categories(
    session: AsyncSession, workspace_id: uuid.UUID
) -> dict[uuid.UUID, CategoryInfo]:
    result = await session.execute(
        select(Category, CategoryGroup)
        .outerjoin(CategoryGroup, Category.group_id == CategoryGroup.id)
        .where(Category.workspace_id == workspace_id)
    )
    return {
        category.id: CategoryInfo(
            id=category.id,
            name=category.name,
            icon=category.icon,
            color=category.color,
            group_id=group.id if group else None,
            group_name=group.name if group else None,
            kind=CategoryKind(category.kind or CategoryKind.VARIABLE.value),
        )
        for category, group in result.all()
    }


async def _load_budgets(
    session: AsyncSession, workspace_id: uuid.UUID, before: date
) -> list[BudgetRow]:
    result = await session.execute(
        select(Budget.category_id, Budget.month, Budget.amount, Budget.is_recurring).where(
            Budget.workspace_id == workspace_id,
            Budget.month < before,
        )
    )
    return [BudgetRow(*row) for row in result.all()]


async def _load_movements(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    start: date,
    end: date,
) -> list[Movement]:
    """Movements of [start, end), one per month and category.

    Same base as `budget_service.get_budget_vs_actual` (posted, not future,
    reporting date of the accounting mode, category lines, primary currency,
    owner split offsets, the viewer's shares of other workspaces), plus
    investment rows through `counts_as_investment`, and without opening
    balances, which the dashboard leaves out of its totals too.
    """
    user = await session.get(User, user_id)
    primary_currency = user.primary_currency if user else get_settings().default_currency
    accounting_mode = await get_credit_card_accounting_mode(session)
    report_date = reporting_date_col(accounting_mode)
    category = line_category_id()

    result = await session.execute(
        with_category_lines(
            select(
                report_date,
                category,
                Transaction.type,
                func.sum(line_primary_or_amount()),
            ).select_from(Transaction)
        )
        .where(
            Transaction.workspace_id == workspace_id,
            report_date >= start,
            report_date < end,
            report_date <= app_today(),
            Transaction.status == "posted",
            Transaction.source != "opening_balance",
            or_(counts_as_user_pnl(category), counts_as_investment(category)),
        )
        .group_by(report_date, category, Transaction.type)
    )
    debit: dict[tuple[date, Optional[uuid.UUID]], Decimal] = defaultdict(lambda: _ZERO)
    credit: dict[tuple[date, Optional[uuid.UUID]], Decimal] = defaultdict(lambda: _ZERO)
    for day, cat_id, tx_type, total in result.all():
        key = (day.replace(day=1), cat_id)
        if tx_type == "debit":
            debit[key] += Decimal(str(total or 0))
        elif tx_type == "credit":
            credit[key] += Decimal(str(total or 0))

    # The split offsets and shared shares are per period; walk the months so
    # each lands in its own (a handful of small queries per month).
    use_effective_date = accounting_mode == "accrual"
    month = start
    while month < end:
        month_end = _add_months(month, 1)
        for tx_type, bucket in (("debit", debit), ("credit", credit)):
            offsets = await owner_split_offset_by_category(
                session, user_id, month, month_end,
                use_effective_date=use_effective_date,
                primary_currency=primary_currency,
                workspace_id=workspace_id,
                tx_type=tx_type,
            )
            for cat_id, total in offsets.items():
                bucket[(month, cat_id)] -= Decimal(str(total))
        shared = await viewer_shared_spending_by_category(
            session, user_id, month, month_end,
            use_effective_date=use_effective_date,
            primary_currency=primary_currency,
            exclude_workspace_id=workspace_id,
        )
        for cat_id, total in shared.items():
            debit[(month, cat_id)] += Decimal(str(total))
        month = month_end

    keys = set(debit) | set(credit)
    return [
        Movement(
            month=m,
            category_id=cat_id,
            debit=_money(debit.get((m, cat_id))),
            credit=_money(credit.get((m, cat_id))),
        )
        for m, cat_id in keys
    ]


async def _load_committed_installments(
    session: AsyncSession, workspace_id: uuid.UUID, start: date, end: date
) -> dict[date, Decimal]:
    """Installments that will count but have not yet, per month of [start, end).

    The rows `_load_movements` leaves out for being pending or dated after
    today, narrowed to installments (`total_installments` set) in spending
    categories, on the same reporting date. Debits minus credits.
    """
    accounting_mode = await get_credit_card_accounting_mode(session)
    report_date = reporting_date_col(accounting_mode)
    category = line_category_id()
    spending_kinds = [
        kind.value
        for kind, rule in KIND_RULES.items()
        if rule.block in (PlanBlock.FIXED_SPENDING, PlanBlock.VARIABLE_SPENDING)
    ]
    spending_category = or_(
        category.is_(None),
        category.in_(
            select(Category.id).where(
                Category.workspace_id == workspace_id, Category.kind.in_(spending_kinds)
            )
        ),
    )
    result = await session.execute(
        with_category_lines(
            select(report_date, Transaction.type, func.sum(line_primary_or_amount())).select_from(
                Transaction
            )
        )
        .where(
            Transaction.workspace_id == workspace_id,
            report_date >= start,
            report_date < end,
            or_(Transaction.status != "posted", report_date > app_today()),
            Transaction.total_installments.is_not(None),
            Transaction.source != "opening_balance",
            counts_as_user_pnl(category),
            spending_category,
        )
        .group_by(report_date, Transaction.type)
    )
    committed: dict[date, Decimal] = defaultdict(lambda: _ZERO)
    for day, tx_type, total in result.all():
        sign = 1 if tx_type == "debit" else -1
        committed[day.replace(day=1)] += sign * Decimal(str(total or 0))
    return committed


async def _month_plans(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    months: list[date],
) -> list[MonthPlan]:
    end = _add_months(months[-1], 1)
    cats = await _load_categories(session, workspace_id)
    budgets = await _load_budgets(session, workspace_id, end)
    moves = await _load_movements(session, workspace_id, user_id, months[0], end)
    by_month: dict[date, list[Movement]] = defaultdict(list)
    for m in moves:
        by_month[m.month].append(m)
    return [
        fold_month(month, cats, resolve_planned(budgets, month), by_month.get(month, []))
        for month in months
    ]


async def get_month_plan(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, month: date
) -> MonthPlan:
    (plan,) = await _month_plans(session, workspace_id, user_id, [month.replace(day=1)])
    return plan


def _cell(month: date, planned: Iterable[Optional[Decimal]], actual: Iterable[Decimal]) -> GridCell:
    return GridCell(month=month, planned=_sum_planned(planned), actual=sum(actual, _ZERO))


def _total(year: int, cells: list[GridCell]) -> GridCell:
    return _cell(date(year, 1, 1), (c.planned for c in cells), (c.actual for c in cells))


async def get_year_grid(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, year: int
) -> YearGrid:
    """One grouped movements query for the year, one Budget query; each
    month column equals get_month_plan of that month."""
    months = [date(year, m, 1) for m in range(1, 13)]
    plans = await _month_plans(session, workspace_id, user_id, months)

    rows: list[GridRow] = []
    for block_index, block in enumerate(PlanBlock):
        summaries = [plan.blocks[block_index] for plan in plans]
        block_cells = [
            GridCell(month=month, planned=s.planned, actual=s.actual)
            for month, s in zip(months, summaries)
        ]
        rows.append(
            GridRow(
                level="block",
                block=block,
                name=block.value,
                cells=block_cells,
                total=_total(year, block_cells),
            )
        )

        # Every line that shows up in some month, in the fold's order.
        cells_by_line: dict[Optional[uuid.UUID], dict[date, PlanLine]] = defaultdict(dict)
        meta: dict[Optional[uuid.UUID], PlanLine] = {}
        for month, summary in zip(months, summaries):
            for line in summary.lines:
                cells_by_line[line.category_id][month] = line
                meta.setdefault(line.category_id, line)
        ordered = sorted(meta.values(), key=_line_order)

        def line_cells(cat_id: Optional[uuid.UUID]) -> list[GridCell]:
            out = []
            for month in months:
                line = cells_by_line[cat_id].get(month)
                out.append(
                    GridCell(month=month, planned=line.planned, actual=line.actual)
                    if line
                    else GridCell(month=month)
                )
            return out

        def category_row(line: PlanLine) -> GridRow:
            cells = line_cells(line.category_id)
            return GridRow(
                level="category",
                block=block,
                group_id=line.group_id,
                group_name=line.group_name,
                category_id=line.category_id,
                name=line.name,
                kind=line.kind,
                cells=cells,
                total=_total(year, cells),
            )

        def flow_rows(line: PlanLine) -> list[GridRow]:
            """An investment category's net, opened into what was applied and
            what was redeemed (negative); the two add up to the category row."""
            if block is not PlanBlock.INVESTMENT or line.category_id is None:
                return []
            out = []
            for flow in ("applied", "redeemed"):
                cells = []
                for month in months:
                    part = cells_by_line[line.category_id].get(month)
                    if part is None:
                        value = _ZERO
                    elif flow == "applied":
                        value = part.actual + part.counter_flow
                    else:
                        value = -part.counter_flow
                    cells.append(GridCell(month=month, actual=value))
                out.append(
                    GridRow(
                        level="flow",
                        block=block,
                        group_id=line.group_id,
                        group_name=line.group_name,
                        category_id=line.category_id,
                        name=flow,
                        kind=line.kind,
                        flow=flow,
                        cells=cells,
                        total=_total(year, cells),
                    )
                )
            return out

        seen_groups: set[uuid.UUID] = set()
        for line in ordered:
            if line.group_id is None:
                rows.append(category_row(line))
                rows.extend(flow_rows(line))
                continue
            if line.group_id in seen_groups:
                continue
            seen_groups.add(line.group_id)
            members = [m for m in ordered if m.group_id == line.group_id]
            member_rows = [category_row(m) for m in members]
            group_cells = [
                _cell(
                    month,
                    (r.cells[i].planned for r in member_rows),
                    (r.cells[i].actual for r in member_rows),
                )
                for i, month in enumerate(months)
            ]
            rows.append(
                GridRow(
                    level="group",
                    block=block,
                    group_id=line.group_id,
                    group_name=line.group_name,
                    name=line.group_name or "",
                    cells=group_cells,
                    total=_total(year, group_cells),
                )
            )
            for member, member_row in zip(members, member_rows):
                rows.append(member_row)
                rows.extend(flow_rows(member))

    committed = await _load_committed_installments(
        session, workspace_id, months[0], _add_months(months[-1], 1)
    )
    return YearGrid(
        year=year,
        rows=rows,
        committed=[_money(committed.get(month, _ZERO)) for month in months],
    )


SOURCES_SHOWN = 12
_SOURCE_NOISE = re.compile(r"\d+(?:[/.,-]\d+)*")


def _source_name(payee: Optional[str], description: Optional[str]) -> str:
    """The payee when there is one; else the description without the numbers
    banks add (dates, installments, ids), so one source is one row."""
    if payee:
        return payee.strip()
    text = _SOURCE_NOISE.sub(" ", description or "")
    return " ".join(text.split())[:60] or (description or "").strip()


async def get_year_sources(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    year: int,
    category_id: Optional[uuid.UUID],
) -> YearSources:
    """One category's actual over the year, broken down by payee.

    Same rows as `_load_movements` (posted, not future, reporting date,
    category lines, primary currency), signed by the category's
    `KIND_RULES` rule; `category_id` None is the uncategorized line (its
    debits). The owner split offsets and other workspaces' shares that
    `_load_movements` folds in per category are not spread over payees, so
    with split bills the sources can sum to a bit more than the category row.
    The largest `SOURCES_SHOWN` sources are listed; the rest fold into one.
    """
    start, end = date(year, 1, 1), date(year + 1, 1, 1)
    months = [date(year, m, 1) for m in range(1, 13)]
    sign = {"debit": 1}  # the uncategorized line counts its debits
    if category_id is not None:
        cats = await _load_categories(session, workspace_id)
        info = cats.get(category_id)
        if info is None or KIND_RULES[info.kind].block is None:
            return YearSources(year=year, category_id=category_id, sources=[])
        sign = {
            ActualRule.CREDITS_MINUS_DEBITS: {"credit": 1, "debit": -1},
            ActualRule.DEBITS_MINUS_CREDITS: {"debit": 1, "credit": -1},
        }[KIND_RULES[info.kind].actual]

    accounting_mode = await get_credit_card_accounting_mode(session)
    report_date = reporting_date_col(accounting_mode)
    category = line_category_id()
    result = await session.execute(
        with_category_lines(
            select(
                report_date,
                Payee.name,
                Transaction.description,
                Transaction.type,
                func.sum(line_primary_or_amount()),
            )
            .select_from(Transaction)
        )
        .outerjoin(Payee, Payee.id == Transaction.payee_id)
        .where(
            Transaction.workspace_id == workspace_id,
            report_date >= start,
            report_date < end,
            report_date <= app_today(),
            Transaction.status == "posted",
            Transaction.source != "opening_balance",
            or_(counts_as_user_pnl(category), counts_as_investment(category)),
            category.is_(None) if category_id is None else category == category_id,
        )
        .group_by(report_date, Payee.name, Transaction.description, Transaction.type)
    )

    by_source: dict[str, dict[date, Decimal]] = defaultdict(lambda: defaultdict(lambda: _ZERO))
    for day, payee, description, tx_type, total in result.all():
        factor = sign.get(tx_type)
        if factor is None:
            continue
        by_source[_source_name(payee, description)][day.replace(day=1)] += factor * Decimal(
            str(total or 0)
        )

    def row(name: Optional[str], per_month: Mapping[date, Decimal]) -> SourceRow:
        cells = [_money(per_month.get(month, _ZERO)) for month in months]
        return SourceRow(name=name, cells=cells, total=_money(sum(cells, _ZERO)))

    rows = sorted(
        (row(name, per_month) for name, per_month in by_source.items()),
        key=lambda r: (-abs(r.total), r.name or ""),
    )
    rows = [r for r in rows if any(c != 0 for c in r.cells)]
    if len(rows) > SOURCES_SHOWN + 1:
        rest: dict[date, Decimal] = defaultdict(lambda: _ZERO)
        for r in rows[SOURCES_SHOWN:]:
            for month, cell in zip(months, r.cells):
                rest[month] += cell
        rows = rows[:SOURCES_SHOWN] + [row(None, rest)]
    return YearSources(year=year, category_id=category_id, sources=rows)
