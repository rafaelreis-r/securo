"""Pure tests of the plan fold and the budget resolver (no database)."""

import uuid
from datetime import date
from decimal import Decimal

import pytest

from app.models.category import CategoryKind
from app.services.category_kind_rules import PlanBlock
from app.services.plan_service import (
    UNCATEGORIZED_NAME,
    BudgetRow,
    CategoryInfo,
    Movement,
    fold_month,
    resolve_planned,
)

MARCH = date(2025, 3, 1)
D = Decimal


def _cat(name: str, kind: CategoryKind, group: str | None = None) -> CategoryInfo:
    return CategoryInfo(
        id=uuid.uuid5(uuid.NAMESPACE_DNS, name),
        name=name,
        icon=None,
        color=None,
        group_id=uuid.uuid5(uuid.NAMESPACE_DNS, f"group:{group}") if group else None,
        group_name=group,
        kind=kind,
    )


SALARY = _cat("Salary", CategoryKind.INCOME, "Income")
RENT_IN = _cat("Rent received", CategoryKind.INCOME, "Income")
BROKER = _cat("Broker", CategoryKind.INVESTMENT)
RENT = _cat("Rent", CategoryKind.FIXED, "Home")
GROCERIES = _cat("Groceries", CategoryKind.VARIABLE, "Food")
TRIP = _cat("Trip", CategoryKind.OCCASIONAL)
MOVES = _cat("Own transfers", CategoryKind.TRANSFER)
GYM = _cat("Gym", CategoryKind.FIXED, "Home")
CATS = {c.id: c for c in (SALARY, RENT_IN, BROKER, RENT, GROCERIES, TRIP, MOVES, GYM)}


def _mv(cat: CategoryInfo | None, debit: str = "0", credit: str = "0", month: date = MARCH) -> Movement:
    return Movement(month=month, category_id=cat.id if cat else None, debit=D(debit), credit=D(credit))


def _block(plan, block: PlanBlock):
    (summary,) = [b for b in plan.blocks if b.block is block]
    return summary


def _line(plan, cat: CategoryInfo | None):
    matches = [
        line for b in plan.blocks for line in b.lines
        if line.category_id == (cat.id if cat else None)
    ]
    return matches[0] if matches else None


# (case, movements, planned, category, expected block, expected actual, expected counter_flow)
LINE_CASES = [
    ("income is credits minus debits", [_mv(SALARY, debit="200", credit="10000")], {},
     SALARY, PlanBlock.INCOME, D("9800"), D("200")),
    ("mixed spending category reports the credits as counter flow",
     [_mv(RENT, debit="3000", credit="1200")], {}, RENT, PlanBlock.FIXED_SPENDING, D("1800"), D("1200")),
    ("investment counts debits only, a redemption does not lower it",
     [_mv(BROKER, debit="2000", credit="5000")], {}, BROKER, PlanBlock.INVESTMENT, D("2000"), D("5000")),
    ("occasional lands in variable spending", [_mv(TRIP, debit="1500")], {},
     TRIP, PlanBlock.VARIABLE_SPENDING, D("1500"), D("0")),
    ("a refund larger than the spending keeps the negative net",
     [_mv(GROCERIES, debit="100", credit="250")], {}, GROCERIES, PlanBlock.VARIABLE_SPENDING, D("-150"), D("250")),
    ("uncategorized debits go to a synthetic variable line",
     [_mv(None, debit="40"), _mv(None, debit="10", credit="5")], {}, None, PlanBlock.VARIABLE_SPENDING,
     D("50"), D("5")),
    ("a planned line without movement is shown at zero", [], {GYM.id: D("120")},
     GYM, PlanBlock.FIXED_SPENDING, D("0"), D("0")),
]


@pytest.mark.parametrize(
    ("case", "moves", "planned", "cat", "block", "actual", "counter"),
    LINE_CASES,
    ids=[c[0] for c in LINE_CASES],
)
def test_fold_line(case, moves, planned, cat, block, actual, counter):
    plan = fold_month(MARCH, CATS, planned, moves)

    line = _line(plan, cat)
    assert line is not None, case
    assert line in _block(plan, block).lines
    assert (line.actual, line.counter_flow) == (actual, counter)
    if cat is None:
        assert line.name == UNCATEGORIZED_NAME and line.kind is None


def test_transfer_kind_never_reaches_the_plan():
    plan = fold_month(MARCH, CATS, {MOVES.id: D("500")}, [_mv(MOVES, debit="700", credit="700")])

    assert _line(plan, MOVES) is None
    assert all(b.actual == 0 and b.planned is None for b in plan.blocks)


def test_blocks_always_present_in_order_and_idle_lines_omitted():
    plan = fold_month(MARCH, CATS, {}, [])

    assert [b.block for b in plan.blocks] == list(PlanBlock)
    assert [b.over_is_bad for b in plan.blocks] == [False, False, True, True]
    assert all(b.lines == [] and b.actual == 0 and b.planned is None for b in plan.blocks)
    assert plan.income_planned is None


def test_movements_of_other_months_are_ignored():
    plan = fold_month(MARCH, CATS, {}, [_mv(RENT, debit="3000", month=date(2025, 2, 1))])

    assert _line(plan, RENT) is None


def test_unknown_category_lands_on_the_uncategorized_line():
    stranger = _cat("Category of another workspace", CategoryKind.VARIABLE)

    plan = fold_month(MARCH, CATS, {}, [_mv(stranger, debit="30")])

    assert _line(plan, None).actual == D("30")


def test_shares_of_income_block_totals_and_income_planned():
    planned = {SALARY.id: D("9000"), RENT_IN.id: D("1000"), RENT.id: D("3000"), BROKER.id: D("2000")}
    moves = [
        _mv(SALARY, credit="9000"),
        _mv(RENT_IN, credit="1000"),
        _mv(BROKER, debit="2500"),
        _mv(RENT, debit="3000"),
        _mv(GROCERIES, debit="800"),
        _mv(TRIP, debit="200"),
    ]

    plan = fold_month(MARCH, CATS, planned, moves)

    assert plan.income_planned == D("10000")
    income, investment, fixed, variable = plan.blocks
    assert (income.planned, income.actual, income.share_of_income) == (D("10000"), D("10000"), 1.0)
    assert (investment.planned, investment.actual, investment.share_of_income) == (D("2000"), D("2500"), 0.25)
    assert (fixed.planned, fixed.actual, fixed.share_of_income) == (D("3000"), D("3000"), 0.3)
    # No line of the variable block has a target, so neither has the block.
    assert (variable.planned, variable.actual, variable.share_of_income) == (None, D("1000"), 0.1)
    assert _line(plan, GROCERIES).share_of_income == 0.08
    # Grouped lines first (by group name), then ungrouped ones.
    assert [line.name for line in variable.lines] == ["Groceries", "Trip"]


def test_share_of_income_is_none_without_income():
    plan = fold_month(MARCH, CATS, {}, [_mv(RENT, debit="3000")])

    assert _line(plan, RENT).share_of_income is None
    assert _block(plan, PlanBlock.FIXED_SPENDING).share_of_income is None


def _b(cat: CategoryInfo, month: date, amount: str, recurring: bool) -> BudgetRow:
    return BudgetRow(category_id=cat.id, month=month, amount=D(amount), is_recurring=recurring)


RESOLVE_CASES = [
    ("latest recurring default at or before the month wins",
     [_b(RENT, date(2025, 1, 1), "2800", True), _b(RENT, date(2025, 3, 1), "3000", True),
      _b(RENT, date(2025, 5, 1), "3200", True)], {RENT.id: D("3000")}),
    ("a month override beats the recurring default",
     [_b(RENT, date(2025, 1, 1), "2800", True), _b(RENT, MARCH, "3500", False)], {RENT.id: D("3500")}),
    ("an override of another month does not apply",
     [_b(RENT, date(2025, 2, 1), "3500", False)], {}),
    ("rows of the same slot by two authors add up",
     [_b(RENT, date(2025, 1, 1), "1000", True), _b(RENT, date(2025, 1, 1), "500", True)],
     {RENT.id: D("1500")}),
    ("a recurring default that starts later does not apply yet",
     [_b(RENT, date(2025, 4, 1), "3000", True)], {}),
]


@pytest.mark.parametrize(("case", "budgets", "expected"), RESOLVE_CASES, ids=[c[0] for c in RESOLVE_CASES])
def test_resolve_planned(case, budgets, expected):
    assert resolve_planned(budgets, MARCH) == expected
