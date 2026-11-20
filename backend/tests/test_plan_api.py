"""Plan (metas) endpoints: month plan and year grid over real rows.

The key check is reconciliation: the plan's fixed + variable spending for a
month equals the expense the dashboard summary reports for that month.
"""

import uuid
from datetime import date
from decimal import Decimal

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.budget import Budget
from app.models.category import Category, CategoryKind
from app.models.category_group import CategoryGroup
from app.models.group import Group, GroupMember
from app.models.transaction import Transaction
from app.models.transaction_category_line import TransactionCategoryLine
from app.models.transaction_split import TransactionSplit
from app.services.category_kind_rules import KIND_RULES

D = Decimal
MARCH = date(2025, 3, 1)


class Seed:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID, workspace_id: uuid.UUID):
        self.session = session
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.account: Account | None = None
        self.broker: Account | None = None

    async def accounts(self):
        self.account = Account(
            user_id=self.user_id, workspace_id=self.workspace_id, name="Checking",
            type="checking", balance=D("0"), currency="BRL",
        )
        self.broker = Account(
            user_id=self.user_id, workspace_id=self.workspace_id, name="Broker",
            type="investment", balance=D("0"), currency="BRL",
        )
        self.session.add_all([self.account, self.broker])
        await self.session.flush()

    def group(self, name: str) -> CategoryGroup:
        group = CategoryGroup(user_id=self.user_id, workspace_id=self.workspace_id, name=name)
        self.session.add(group)
        return group

    def category(self, name: str, kind: CategoryKind, group: CategoryGroup | None = None, **kw) -> Category:
        cat = Category(
            user_id=self.user_id, workspace_id=self.workspace_id, name=name, kind=kind.value,
            # The kind's transfer flag, as category_service keeps them in step.
            treat_as_transfer=KIND_RULES[kind].transfer_like,
            group=group, **kw,
        )
        self.session.add(cat)
        return cat

    def tx(self, amount: str, type_: str, day: date, category: Category | None = None,
           account: Account | None = None, source: str = "manual", **kw) -> Transaction:
        tx = Transaction(
            id=uuid.uuid4(), user_id=self.user_id, workspace_id=self.workspace_id,
            account_id=(account or self.account).id, category_id=category.id if category else None,
            description=f"{type_} {amount}", amount=D(amount), amount_primary=D(amount),
            currency="BRL", date=day, effective_date=day, type=type_, source=source, **kw,
        )
        self.session.add(tx)
        return tx

    def budget(self, category: Category, amount: str, month: date, recurring: bool = True):
        self.session.add(Budget(
            user_id=self.user_id, workspace_id=self.workspace_id, category_id=category.id,
            amount=D(amount), month=month, is_recurring=recurring,
        ))


@pytest_asyncio.fixture
async def plan_world(session: AsyncSession, test_user, test_workspace):
    s = Seed(session, test_user.id, test_workspace.id)
    await s.accounts()
    income_group, home, food = s.group("Income"), s.group("Home"), s.group("Food")
    c = {
        "salary": s.category("Salary", CategoryKind.INCOME, income_group),
        "rent": s.category("Rent", CategoryKind.FIXED, home),
        "groceries": s.category("Groceries", CategoryKind.VARIABLE, food),
        "restaurant": s.category("Restaurant", CategoryKind.VARIABLE, food),
        "pharmacy": s.category("Pharmacy", CategoryKind.VARIABLE),
        "trip": s.category("Trip", CategoryKind.OCCASIONAL),
        "invest": s.category("Investments", CategoryKind.INVESTMENT),
        "moves": s.category("Own transfers", CategoryKind.TRANSFER),
        "ignored_cat": s.category("Ignored", CategoryKind.VARIABLE, is_ignored=True),
    }
    await session.flush()

    # February, for the year grid.
    s.tx("9000", "credit", date(2025, 2, 5), c["salary"])
    s.tx("3000", "debit", date(2025, 2, 10), c["rent"])
    s.tx("650", "debit", date(2025, 2, 15), c["groceries"])

    # March.
    s.tx("10000", "credit", date(2025, 3, 5), c["salary"])
    s.tx("3000", "debit", date(2025, 3, 10), c["rent"])
    s.tx("800", "debit", date(2025, 3, 12), c["groceries"])
    s.tx("1500", "debit", date(2025, 3, 20), c["trip"])
    s.tx("50", "debit", date(2025, 3, 21))  # uncategorized
    # A row split across two categories counts part by part.
    split = s.tx("300", "debit", date(2025, 3, 14), has_category_lines=True)
    await session.flush()
    for position, (cat, amount) in enumerate(((c["groceries"], "100"), (c["pharmacy"], "200"))):
        session.add(TransactionCategoryLine(
            workspace_id=test_workspace.id, transaction_id=split.id, category_id=cat.id,
            amount=D(amount), position=position,
        ))
    # Dinner for two split with a friend: only the user's half is spending.
    dinner = s.tx("200", "debit", date(2025, 3, 15), c["restaurant"])
    friends = Group(user_id=test_user.id, workspace_id=test_workspace.id, name="Friends")
    session.add(friends)
    await session.flush()
    me = GroupMember(group_id=friends.id, workspace_id=test_workspace.id, name="Me", is_self=True)
    friend = GroupMember(group_id=friends.id, workspace_id=test_workspace.id, name="Ana")
    session.add_all([me, friend])
    await session.flush()
    for member in (me, friend):
        session.add(TransactionSplit(
            transaction_id=dinner.id, workspace_id=test_workspace.id,
            group_member_id=member.id, share_amount=D("100"),
        ))
    # Application from checking to the broker, both legs paired: the debit
    # counts once, the broker's credit leg is not a redemption.
    pair = uuid.uuid4()
    s.tx("2000", "debit", date(2025, 3, 6), c["invest"], transfer_pair_id=pair)
    s.tx("2000", "credit", date(2025, 3, 6), c["invest"], account=s.broker, transfer_pair_id=pair)
    s.tx("500", "credit", date(2025, 3, 25), c["invest"])  # redemption
    # Transfer between own accounts: out of every block.
    moved = uuid.uuid4()
    s.tx("700", "debit", date(2025, 3, 8), c["moves"], transfer_pair_id=moved)
    s.tx("700", "credit", date(2025, 3, 8), c["moves"], account=s.broker, transfer_pair_id=moved)
    # Excluded and ignored rows count nowhere.
    s.tx("999", "debit", date(2025, 3, 11), c["groceries"], exclude_from_pnl=True)
    s.tx("888", "debit", date(2025, 3, 11), c["invest"], exclude_from_pnl=True)
    s.tx("444", "debit", date(2025, 3, 11), c["groceries"], is_ignored=True)
    s.tx("777", "debit", date(2025, 3, 11), c["invest"], is_ignored=True)
    s.tx("333", "debit", date(2025, 3, 11), c["ignored_cat"])
    # Not posted, or an opening balance: not part of the month's actual.
    s.tx("123", "debit", date(2025, 3, 11), c["groceries"], status="pending")
    s.tx("5000", "debit", date(2025, 3, 1), source="opening_balance")

    s.budget(c["salary"], "9500", date(2025, 1, 1))
    s.budget(c["rent"], "3000", date(2025, 1, 1))
    s.budget(c["groceries"], "1000", date(2025, 1, 1))
    s.budget(c["groceries"], "900", MARCH, recurring=False)
    s.budget(c["invest"], "2000", date(2025, 1, 1))
    s.budget(c["moves"], "100", date(2025, 1, 1))
    await session.commit()
    return c


def _block(plan: dict, block: str) -> dict:
    (b,) = [b for b in plan["blocks"] if b["block"] == block]
    return b


def _lines(plan: dict) -> dict:
    return {line["name"]: line for b in plan["blocks"] for line in b["lines"]}


async def _month(client: AsyncClient, headers: dict, month: date) -> dict:
    resp = await client.get("/api/budgets/plan/month", params={"month": month.isoformat()}, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_month_plan_folds_blocks(client: AsyncClient, auth_headers, plan_world):
    plan = await _month(client, auth_headers, MARCH)

    assert plan["month"] == "2025-03-01"
    assert [b["block"] for b in plan["blocks"]] == [
        "income", "investment", "fixed_spending", "variable_spending",
    ]
    lines = _lines(plan)
    assert D(lines["Salary"]["actual"]) == D("10000")
    assert D(lines["Salary"]["planned"]) == D("9500")
    assert D(plan["income_planned"]) == D("9500")

    invest = lines["Investments"]
    assert (D(invest["actual"]), D(invest["counter_flow"]), D(invest["planned"])) == (
        D("2000"), D("500"), D("2000"),
    )
    assert D(lines["Rent"]["actual"]) == D("3000")
    assert D(lines["Groceries"]["actual"]) == D("900")  # 800 + its 100 part of the split row
    assert D(lines["Groceries"]["planned"]) == D("900")  # the March override
    assert D(lines["Pharmacy"]["actual"]) == D("200")
    assert D(lines["Restaurant"]["actual"]) == D("100")  # the user's half
    assert D(lines["Trip"]["actual"]) == D("1500")
    assert lines["Trip"] in _block(plan, "variable_spending")["lines"]
    assert lines["Uncategorized"]["category_id"] is None
    assert D(lines["Uncategorized"]["actual"]) == D("50")
    assert "Own transfers" not in lines
    assert "Ignored" not in lines
    assert lines["Rent"]["share_of_income"] == 0.3


@pytest.mark.asyncio
async def test_spending_reconciles_with_dashboard_expense(client: AsyncClient, auth_headers, plan_world):
    plan = await _month(client, auth_headers, MARCH)
    resp = await client.get(
        "/api/dashboard/summary", params={"month": MARCH.isoformat()}, headers=auth_headers
    )
    assert resp.status_code == 200, resp.text
    summary = resp.json()

    spending = D(_block(plan, "fixed_spending")["actual"]) + D(_block(plan, "variable_spending")["actual"])
    assert spending == D("5750.00")
    assert spending == D(str(summary["monthly_expenses_primary"]))
    assert D(_block(plan, "income")["actual"]) == D(str(summary["monthly_income_primary"]))


@pytest.mark.asyncio
async def test_reconciliation_with_counter_flows(
    client: AsyncClient, auth_headers, session: AsyncSession, test_user, test_workspace, plan_world
):
    """A refund inside a spending category and a debit inside an income
    category: the dashboard books them as income and expense, the plan nets
    them in place and reports them as counter flow. The identity holds."""
    s = Seed(session, test_user.id, test_workspace.id)
    s.account = await session.get(Account, (await _account_id(session, test_workspace.id)))
    s.tx("120", "credit", date(2025, 3, 18), plan_world["groceries"])
    s.tx("40", "debit", date(2025, 3, 19), plan_world["salary"])
    s.tx("15", "credit", date(2025, 3, 19))  # uncategorized credit: dashboard income
    await session.commit()

    plan = await _month(client, auth_headers, MARCH)
    summary = (await client.get(
        "/api/dashboard/summary", params={"month": MARCH.isoformat()}, headers=auth_headers
    )).json()

    fixed, variable = _block(plan, "fixed_spending"), _block(plan, "variable_spending")
    spending = D(fixed["actual"]) + D(variable["actual"])
    counter = sum(
        (
            D(line["counter_flow"])
            for b in (fixed, variable, _block(plan, "income"))
            for line in b["lines"]
            if line["category_id"] is not None
        ),
        D("0"),
    )
    assert spending == D("5630.00")
    assert spending + counter == D(str(summary["monthly_expenses_primary"]))


async def _account_id(session: AsyncSession, workspace_id: uuid.UUID) -> uuid.UUID:
    from sqlalchemy import select

    return (await session.execute(
        select(Account.id).where(Account.workspace_id == workspace_id, Account.name == "Checking")
    )).scalar_one()


@pytest.mark.asyncio
async def test_year_grid_columns_equal_month_plans(client: AsyncClient, auth_headers, plan_world):
    resp = await client.get("/api/budgets/plan/year", params={"year": 2025}, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    grid = resp.json()
    assert grid["year"] == 2025

    rows = grid["rows"]
    assert all(len(r["cells"]) == 12 for r in rows)
    assert [r["block"] for r in rows if r["level"] == "block"] == [
        "income", "investment", "fixed_spending", "variable_spending",
    ]
    # Block row, then each group followed by its categories.
    variable_rows = [(r["level"], r["name"]) for r in rows if r["block"] == "variable_spending"]
    assert variable_rows == [
        ("block", "variable_spending"),
        ("group", "Food"),
        ("category", "Groceries"),
        ("category", "Restaurant"),
        ("category", "Pharmacy"),
        ("category", "Trip"),
        ("category", "Uncategorized"),
    ]

    for month_index in (1, 2, 3):  # Feb, Mar, Apr
        month = date(2025, month_index + 1, 1)
        plan = await _month(client, auth_headers, month)
        for b in plan["blocks"]:
            (block_row,) = [r for r in rows if r["level"] == "block" and r["block"] == b["block"]]
            cell = block_row["cells"][month_index]
            assert cell["month"] == month.isoformat()
            assert (cell["planned"], D(cell["actual"])) == (b["planned"], D(b["actual"]))
            for line in b["lines"]:
                (row,) = [
                    r for r in rows
                    if r["level"] == "category" and r["block"] == b["block"]
                    and r["category_id"] == line["category_id"]
                ]
                cell = row["cells"][month_index]
                assert (cell["planned"], D(cell["actual"])) == (line["planned"], D(line["actual"]))

    (groceries,) = [r for r in rows if r["name"] == "Groceries"]
    assert D(groceries["total"]["actual"]) == D("650") + D("900")
    # Recurring 1000 every month but March, where the override is 900.
    assert D(groceries["total"]["planned"]) == D("1000") * 11 + D("900")
    (food,) = [r for r in rows if r["level"] == "group" and r["name"] == "Food"]
    assert D(food["cells"][2]["actual"]) == D("1000")  # groceries 900 + restaurant 100


@pytest.mark.asyncio
async def test_plan_routes_default_to_today_and_need_auth(client: AsyncClient, auth_headers, plan_world):
    from app.core.app_clock import app_today

    month = await client.get("/api/budgets/plan/month", headers=auth_headers)
    year = await client.get("/api/budgets/plan/year", headers=auth_headers)
    assert month.status_code == 200 and year.status_code == 200
    assert month.json()["month"] == app_today().replace(day=1).isoformat()
    assert year.json()["year"] == app_today().year

    assert (await client.get("/api/budgets/plan/month")).status_code == 401


@pytest.mark.asyncio
async def test_year_grid_lists_installments_still_to_come(
    client: AsyncClient, session: AsyncSession, auth_headers, plan_world, test_user, test_workspace
):
    s = Seed(session, test_user.id, test_workspace.id)
    s.account = (await session.get(Account, (await _first_account_id(session, test_workspace.id))))
    c = plan_world
    installment = {"total_installments": 3}
    # Pending installments of a card purchase: they count in May and June.
    s.tx("400", "debit", date(2025, 5, 10), c["groceries"], status="pending", installment_number=2, **installment)
    s.tx("400", "debit", date(2025, 6, 10), c["groceries"], status="pending", installment_number=3, **installment)
    s.tx("250", "debit", date(2025, 6, 12), c["rent"], status="pending", installment_number=2, total_installments=6)
    s.tx("50", "credit", date(2025, 6, 13), c["groceries"], status="pending", installment_number=2, **installment)
    # Not committed: already posted, not an installment, or out of spending.
    s.tx("400", "debit", date(2025, 4, 10), c["groceries"], installment_number=1, **installment)
    s.tx("90", "debit", date(2025, 5, 11), c["groceries"], status="pending")
    s.tx("300", "debit", date(2025, 5, 12), c["moves"], status="pending", installment_number=1, **installment)
    s.tx("300", "debit", date(2025, 5, 12), c["invest"], status="pending", installment_number=1, **installment)
    await session.commit()

    resp = await client.get("/api/budgets/plan/year", params={"year": 2025}, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    committed = [D(value) for value in resp.json()["committed"]]
    assert len(committed) == 12
    assert committed[4] == D("400")
    assert committed[5] == D("400") + D("250") - D("50")
    assert committed[3] == D("0")
    # They are still to come, so no block's actual moved.
    rows = resp.json()["rows"]
    (variable,) = [r for r in rows if r["level"] == "block" and r["block"] == "variable_spending"]
    assert D(variable["cells"][4]["actual"]) == D("0")


async def _first_account_id(session: AsyncSession, workspace_id: uuid.UUID) -> uuid.UUID:
    from sqlalchemy import select

    return (await session.execute(
        select(Account.id).where(Account.workspace_id == workspace_id, Account.type == "checking")
    )).scalars().first()


async def _sources(client: AsyncClient, headers: dict, **params) -> dict:
    resp = await client.get("/api/budgets/plan/year/sources", params={"year": 2025, **params}, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_year_sources_break_a_category_down_by_payee(
    client: AsyncClient, session: AsyncSession, auth_headers, plan_world, test_user, test_workspace
):
    from app.models.payee import Payee

    c = plan_world
    s = Seed(session, test_user.id, test_workspace.id)
    s.account = await session.get(Account, await _first_account_id(session, test_workspace.id))
    acme = Payee(user_id=test_user.id, workspace_id=test_workspace.id, name="ACME Corp")
    session.add(acme)
    await session.flush()
    s.tx("4000", "credit", date(2025, 4, 5), c["salary"], payee_id=acme.id)
    s.tx("100", "debit", date(2025, 4, 6), c["salary"], payee_id=acme.id)  # an income refund
    await session.commit()

    grid = (await client.get("/api/budgets/plan/year", params={"year": 2025}, headers=auth_headers)).json()

    def category_total(category_id: str | None, block: str) -> D:
        (row,) = [
            r for r in grid["rows"]
            if r["level"] == "category" and r["block"] == block and r["category_id"] == category_id
        ]
        return D(row["total"]["actual"])

    salary = await _sources(client, auth_headers, category_id=str(c["salary"].id))
    by_name = {row["name"]: row for row in salary["sources"]}
    # The payee names its rows; without one, the description minus its numbers.
    assert set(by_name) == {"ACME Corp", "credit"}
    assert D(by_name["ACME Corp"]["cells"][3]) == D("3900")
    assert [D(v) for v in by_name["credit"]["cells"][1:3]] == [D("9000"), D("10000")]
    assert salary["sources"][0]["name"] == "credit"  # largest first
    assert sum(D(row["total"]) for row in salary["sources"]) == category_total(str(c["salary"].id), "income")

    # A split row counts its own part only, as the category row does.
    groceries = await _sources(client, auth_headers, category_id=str(c["groceries"].id))
    assert sum(D(row["total"]) for row in groceries["sources"]) == category_total(str(c["groceries"].id), "variable_spending")

    uncategorized = await _sources(client, auth_headers)
    assert uncategorized["category_id"] is None
    assert sum(D(row["total"]) for row in uncategorized["sources"]) == category_total(None, "variable_spending")

    transfers = await _sources(client, auth_headers, category_id=str(c["moves"].id))
    assert transfers["sources"] == []
