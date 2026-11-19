"""A category's kind (its nature for the plan) and `treat_as_transfer` stay in step.

`kind` is the source of truth and `treat_as_transfer == KIND_RULES[kind].transfer_like`
after every write: the API, default seeding, rule packs, backup restore and the
MCP proposal tool. Plugin sync is covered in test_data_plugins.
"""

import io
import json
import uuid
import zipfile

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import mcp_server.tools  # noqa: F401
from app.models.category import Category, CategoryKind
from app.services import backup_service
from app.services.category_defaults import DEFAULT_CATEGORIES, localized_name
from app.services.category_kind_rules import KIND_RULES
from app.services.category_service import create_default_categories, kind_from_legacy_flag
from app.services.rule_service import ensure_default_categories
from mcp_server.auth import CallContext
from mcp_server.registry import REGISTRY

K = CategoryKind


async def _categories(session: AsyncSession, workspace_id) -> list[Category]:
    result = await session.execute(
        select(Category)
        .where(Category.workspace_id == workspace_id)
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


def _assert_in_step(categories) -> None:
    for c in categories:
        assert c.treat_as_transfer == KIND_RULES[K(c.kind)].transfer_like, (c.name, c.kind)


@pytest.mark.parametrize(
    ("current", "flag", "expected"),
    [
        (K.VARIABLE, True, K.TRANSFER),
        (K.FIXED, True, K.TRANSFER),
        (K.INCOME, True, K.TRANSFER),
        (K.INVESTMENT, True, K.INVESTMENT),
        (K.TRANSFER, True, K.TRANSFER),
        (K.INVESTMENT, False, K.VARIABLE),
        (K.TRANSFER, False, K.VARIABLE),
        (K.FIXED, False, K.FIXED),
        (K.OCCASIONAL, False, K.OCCASIONAL),
        (K.INCOME, False, K.INCOME),
    ],
)
def test_a_legacy_flag_becomes_a_kind(current, flag, expected):
    assert kind_from_legacy_flag(current, flag) is expected


# --- API ------------------------------------------------------------------


async def _create(client: AsyncClient, headers, **body) -> dict:
    resp = await client.post("/api/categories", headers=headers, json={"name": "Cat", **body})
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.parametrize(
    ("body", "kind", "flag"),
    [
        ({}, "variable", False),
        ({"kind": "fixed"}, "fixed", False),
        ({"kind": "investment"}, "investment", True),
        ({"kind": "transfer", "treat_as_transfer": True}, "transfer", True),
        ({"treat_as_transfer": True}, "transfer", True),
        ({"treat_as_transfer": False}, "variable", False),
    ],
)
async def test_create_stores_the_kind_and_its_flag(client, auth_headers, body, kind, flag):
    created = await _create(client, auth_headers, **body)
    assert (created["kind"], created["treat_as_transfer"]) == (kind, flag)

    listed = (await client.get("/api/categories", headers=auth_headers)).json()
    row = next(c for c in listed if c["id"] == created["id"])
    assert (row["kind"], row["treat_as_transfer"]) == (kind, flag)


async def test_a_kind_and_flag_that_disagree_are_refused(client, auth_headers):
    resp = await client.post(
        "/api/categories", headers=auth_headers,
        json={"name": "Bad", "kind": "income", "treat_as_transfer": True},
    )
    assert resp.status_code == 422

    created = await _create(client, auth_headers, kind="fixed")
    resp = await client.patch(
        f"/api/categories/{created['id']}", headers=auth_headers,
        json={"kind": "investment", "treat_as_transfer": False},
    )
    assert resp.status_code == 422
    row = (await client.get("/api/categories", headers=auth_headers)).json()
    assert next(c for c in row if c["id"] == created["id"])["kind"] == "fixed"


async def test_an_unknown_kind_is_refused(client, auth_headers):
    resp = await client.post(
        "/api/categories", headers=auth_headers, json={"name": "Bad", "kind": "savings"}
    )
    assert resp.status_code == 422


@pytest.mark.parametrize(
    ("start", "patch", "kind", "flag"),
    [
        ("variable", {"kind": "fixed"}, "fixed", False),
        ("variable", {"kind": "investment"}, "investment", True),
        ("investment", {"kind": "occasional"}, "occasional", False),
        ("fixed", {"treat_as_transfer": True}, "transfer", True),
        ("investment", {"treat_as_transfer": True}, "investment", True),
        ("investment", {"treat_as_transfer": False}, "variable", False),
        ("transfer", {"treat_as_transfer": False}, "variable", False),
        ("income", {"treat_as_transfer": False}, "income", False),
        ("income", {"name": "Renamed"}, "income", False),
        ("transfer", {"kind": None}, "transfer", True),
    ],
)
async def test_update_round_trip(client, auth_headers, start, patch, kind, flag):
    created = await _create(client, auth_headers, kind=start)
    resp = await client.patch(
        f"/api/categories/{created['id']}", headers=auth_headers, json=patch
    )
    assert resp.status_code == 200, resp.text
    assert (resp.json()["kind"], resp.json()["treat_as_transfer"]) == (kind, flag)

    listed = (await client.get("/api/categories", headers=auth_headers)).json()
    row = next(c for c in listed if c["id"] == created["id"])
    assert (row["kind"], row["treat_as_transfer"]) == (kind, flag)


# --- Seeding --------------------------------------------------------------

EXPECTED_DEFAULT_KINDS = {
    "salary": "income",
    "investments": "investment",
    "transfers": "transfer",
}


async def test_seeded_defaults_get_their_kind(session: AsyncSession, test_user, test_workspace):
    await create_default_categories(session, test_user.id, "pt-BR", workspace_id=test_workspace.id)
    by_name = {c.name: c for c in await _categories(session, test_workspace.id)}

    assert len(by_name) == len(DEFAULT_CATEGORIES)
    for key, data in DEFAULT_CATEGORIES.items():
        category = by_name[localized_name(data, "pt-BR")]
        assert category.kind == EXPECTED_DEFAULT_KINDS.get(key, "variable"), key
    assert by_name["Investimentos"].treat_as_transfer is True
    assert by_name["Transferências"].treat_as_transfer is True
    _assert_in_step(by_name.values())


async def test_rule_packs_create_missing_defaults_with_their_kind(
    session: AsyncSession, test_user, test_workspace
):
    created = await ensure_default_categories(
        session, test_workspace.id, test_user.id, {"investments", "salary", "groceries"}, "en"
    )
    await session.commit()

    assert created == 3
    kinds = {c.name: c.kind for c in await _categories(session, test_workspace.id)}
    assert kinds == {"Investments": "investment", "Salary & Income": "income", "Groceries": "variable"}
    _assert_in_step(await _categories(session, test_workspace.id))


# --- Backup restore -------------------------------------------------------


async def _restore_with_categories(session, test_user, test_workspace, edit) -> list[Category]:
    data = await backup_service.build_backup_zip(
        session, test_workspace, content=backup_service.BackupContent.configuration
    )
    edited = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(data)) as source,
        zipfile.ZipFile(edited, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        for info in source.infolist():
            payload = source.read(info.filename)
            if info.filename == "categories.json":
                rows = json.loads(payload)
                edit(rows)
                payload = json.dumps(rows).encode()
            target.writestr(info, payload)
    await backup_service.restore_backup_bytes(
        session,
        data=edited.getvalue(),
        target_user_id=test_user.id,
        current_workspace=test_workspace,
        content=backup_service.BackupContent.configuration,
        mode=backup_service.BackupRestoreMode.current_workspace,
        confirmation="RESTORE",
    )
    return await _categories(session, test_workspace.id)


async def test_restore_keeps_kinds(client, auth_headers, session, test_user, test_workspace):
    for kind in ("fixed", "investment", "occasional", "income"):
        await _create(client, auth_headers, name=f"C {kind}", kind=kind)

    restored = await _restore_with_categories(session, test_user, test_workspace, lambda rows: None)

    assert {c.name: c.kind for c in restored} == {
        "C fixed": "fixed", "C investment": "investment",
        "C occasional": "occasional", "C income": "income",
    }
    _assert_in_step(restored)


async def test_restoring_a_backup_from_before_kinds(
    client, auth_headers, session, test_user, test_workspace
):
    """An old backup has no kind: it is read from the flag and the name."""
    flags = {"Investimentos": True, "Pix entre contas": True, "Mercado": False}
    for name, flag in flags.items():
        await _create(client, auth_headers, name=name, treat_as_transfer=flag)

    def drop_kind(rows):
        for row in rows:
            row.pop("kind")

    restored = await _restore_with_categories(session, test_user, test_workspace, drop_kind)

    assert {c.name: c.kind for c in restored} == {
        "Investimentos": "investment", "Pix entre contas": "transfer", "Mercado": "variable",
    }
    assert {c.name: c.treat_as_transfer for c in restored} == flags


async def test_restore_trusts_the_kind_over_a_flag_that_disagrees(
    client, auth_headers, session, test_user, test_workspace
):
    await _create(client, auth_headers, name="Aluguel", kind="fixed")

    def contradict(rows):
        rows[0]["treat_as_transfer"] = True

    restored = await _restore_with_categories(session, test_user, test_workspace, contradict)

    assert [(c.kind, c.treat_as_transfer) for c in restored] == [("fixed", False)]


# --- MCP ------------------------------------------------------------------


@pytest_asyncio.fixture
async def ext_ctx(test_user) -> CallContext:
    return CallContext(user_id=test_user.id, conversation_id=uuid.uuid4(), external=True)


async def test_mcp_creates_and_lists_a_kind(session: AsyncSession, ext_ctx, test_workspace):
    result = await REGISTRY["propose_create_category"].handler(
        session=session, ctx=ext_ctx, name="Aportes", kind="investment", apply=True
    )
    assert result.get("applied") is True, result
    assert result["proposed"]["kind"] == "investment"

    listed = await REGISTRY["list_categories"].handler(session=session, ctx=ext_ctx)
    row = next(item for item in listed["items"] if item["name"] == "Aportes")
    assert (row["kind"], row["treat_as_transfer"]) == ("investment", True)

    plain = await REGISTRY["propose_create_category"].handler(
        session=session, ctx=ext_ctx, name="Padaria", apply=True
    )
    category = await session.get(Category, uuid.UUID(plain["id"]))
    assert (category.kind, category.treat_as_transfer) == ("variable", False)
