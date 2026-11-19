"""Taking rows out of income and expense totals from the transaction list,
and bringing them back, without moving the account balance."""
import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.account import Account
from app.models.mortgage_payment_allocation import MORTGAGE_PRINCIPAL_SOURCE
from app.models.transaction import Transaction
from app.models.user import User
from app.models.workspace import Workspace


def _month_day(day: int) -> str:
    return app_today().replace(day=day).isoformat()


async def _manual_account(client: AsyncClient, auth_headers) -> str:
    response = await client.post(
        "/api/accounts",
        headers=auth_headers,
        json={"name": "Carteira", "type": "checking", "currency": "BRL"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _expense(client: AsyncClient, auth_headers, account_id: str, desc: str, amount: str) -> str:
    response = await client.post(
        "/api/transactions",
        headers=auth_headers,
        json={
            "account_id": account_id,
            "description": desc,
            "amount": amount,
            "date": _month_day(1),
            "type": "debit",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _monthly_expenses(client: AsyncClient, auth_headers) -> Decimal:
    response = await client.get(
        "/api/dashboard/summary",
        headers=auth_headers,
        params={"month": app_today().replace(day=1).isoformat()},
    )
    assert response.status_code == 200
    return Decimal(str(response.json()["monthly_expenses"])).quantize(Decimal("0.01"))


async def _balance(client: AsyncClient, auth_headers, account_id: str) -> Decimal:
    response = await client.get(f"/api/accounts/{account_id}", headers=auth_headers)
    assert response.status_code == 200
    return Decimal(str(response.json()["current_balance"])).quantize(Decimal("0.01"))


async def _bulk_exclude(client: AsyncClient, auth_headers, ids: list[str], excluded: bool) -> dict:
    response = await client.patch(
        "/api/transactions/bulk-exclude",
        headers=auth_headers,
        json={"transaction_ids": ids, "excluded": excluded},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _row(client: AsyncClient, auth_headers, tx_id: str) -> dict:
    response = await client.get(f"/api/transactions/{tx_id}", headers=auth_headers)
    assert response.status_code == 200
    return response.json()


@pytest.mark.asyncio
async def test_excluding_rows_lowers_expenses_by_their_sum_and_keeps_the_balance(
    client: AsyncClient, auth_headers, test_user: User
):
    account_id = await _manual_account(client, auth_headers)
    rent = await _expense(client, auth_headers, account_id, "Aluguel", "1200.00")
    refund = await _expense(client, auth_headers, account_id, "Reembolso a terceiro", "310.45")
    gift = await _expense(client, auth_headers, account_id, "Presente", "89.90")
    await _expense(client, auth_headers, account_id, "Mercado", "450.10")

    expenses_before = await _monthly_expenses(client, auth_headers)
    balance_before = await _balance(client, auth_headers, account_id)

    result = await _bulk_exclude(client, auth_headers, [refund, gift], True)

    assert result == {"updated": 2, "skipped_principal": 0, "skipped_paired": 0}
    assert await _monthly_expenses(client, auth_headers) == expenses_before - Decimal("400.35")
    assert await _balance(client, auth_headers, account_id) == balance_before
    refund_row = await _row(client, auth_headers, refund)
    assert refund_row["exclude_from_pnl"] is True
    assert refund_row["is_ignored"] is False
    assert (await _row(client, auth_headers, rent))["exclude_from_pnl"] is False

    # Setting the same value again changes nothing.
    repeat = await _bulk_exclude(client, auth_headers, [refund, gift], True)
    assert repeat == {"updated": 0, "skipped_principal": 0, "skipped_paired": 0}
    assert await _monthly_expenses(client, auth_headers) == expenses_before - Decimal("400.35")

    restored = await _bulk_exclude(client, auth_headers, [refund, gift], False)
    assert restored == {"updated": 2, "skipped_principal": 0, "skipped_paired": 0}
    assert await _monthly_expenses(client, auth_headers) == expenses_before
    assert await _balance(client, auth_headers, account_id) == balance_before


@pytest.mark.asyncio
async def test_principal_and_paired_rows_are_skipped_and_counted(
    client: AsyncClient,
    auth_headers,
    session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    account_id = await _manual_account(client, auth_headers)
    plain = await _expense(client, auth_headers, account_id, "Farmácia", "60.00")
    common = dict(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        account_id=uuid.UUID(account_id),
        currency="BRL",
        date=app_today(),
        type="debit",
        status="posted",
    )
    principal = Transaction(
        description="Amortização", amount=Decimal("700.00"),
        source=MORTGAGE_PRINCIPAL_SOURCE, exclude_from_pnl=True, **common,
    )
    paired = Transaction(
        description="Transferência para poupança", amount=Decimal("500.00"),
        source="manual", transfer_pair_id=uuid.uuid4(), **common,
    )
    session.add_all([principal, paired])
    await session.commit()
    ids = [plain, str(principal.id), str(paired.id)]

    excluded = await _bulk_exclude(client, auth_headers, ids, True)
    assert excluded == {"updated": 1, "skipped_principal": 1, "skipped_paired": 1}
    assert (await _row(client, auth_headers, str(paired.id)))["exclude_from_pnl"] is False

    # The principal entry stays out of P&L: the payment breakdown owns it.
    restored = await _bulk_exclude(client, auth_headers, ids, False)
    assert restored == {"updated": 1, "skipped_principal": 1, "skipped_paired": 1}
    assert (await _row(client, auth_headers, str(principal.id)))["exclude_from_pnl"] is True
    assert (await _row(client, auth_headers, plain))["exclude_from_pnl"] is False


@pytest.mark.asyncio
async def test_ids_from_another_workspace_are_left_alone(
    client: AsyncClient,
    auth_headers,
    session: AsyncSession,
    test_user: User,
):
    other = Workspace(name="Outro", kind="personal", created_by_user_id=test_user.id)
    session.add(other)
    await session.flush()
    account = Account(
        user_id=test_user.id, workspace_id=other.id, name="Conta alheia",
        type="checking", currency="BRL",
    )
    session.add(account)
    await session.flush()
    foreign = Transaction(
        user_id=test_user.id, workspace_id=other.id, account_id=account.id,
        description="Fora do escopo", amount=Decimal("99.00"), currency="BRL",
        date=date(2026, 1, 5), type="debit", source="manual", status="posted",
    )
    session.add(foreign)
    await session.commit()

    result = await _bulk_exclude(client, auth_headers, [str(foreign.id)], True)

    assert result == {"updated": 0, "skipped_principal": 0, "skipped_paired": 0}
    await session.refresh(foreign)
    assert foreign.exclude_from_pnl is False


@pytest.mark.asyncio
async def test_a_viewer_cannot_bulk_exclude(
    client: AsyncClient, viewer_auth_headers, test_transactions: list[Transaction]
):
    response = await client.patch(
        "/api/transactions/bulk-exclude",
        json={"transaction_ids": [str(test_transactions[0].id)], "excluded": True},
        headers=viewer_auth_headers,
    )
    assert response.status_code == 403
