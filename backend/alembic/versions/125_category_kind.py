"""give every category a kind (its nature for the plan)

Revision ID: 125
Revises: 124

`categories.kind` says what a category means for the plan: income,
investment, fixed, variable, occasional or transfer. `treat_as_transfer`
stays, and from now on the app keeps it equal to "kind is investment or
transfer"; this migration fills `kind` so existing rows already agree with it.

Backfill, first match wins:

1. a transfer-like category named like the default Investments category
   (any language, or a former name) -> investment;
2. any other `treat_as_transfer` category -> transfer;
3. a category in a group named like the default Income group -> income;
4. everything else -> variable.

Rules 1 and 2 only look at rows that are already transfer-like, and rules 3
and 4 only at rows that are not, so `treat_as_transfer` is never changed. An
Investments category the user un-flagged stays non-transfer-like and falls to
rule 3 or 4.

The names are copied from app/data/default_categories.json as it is today, so
the migration does not change meaning when that file grows later.
"""

import sqlalchemy as sa
from alembic import op

revision = "125"
down_revision = "124"
branch_labels = None
depends_on = None

INVESTMENTS_NAMES = (
    "Befektetések", "Inversiones", "Investeringen", "Investice", "Investimenti",
    "Investimentos", "Investissements", "Investitionen", "Investments", "Investície",
    "Inwestycje", "Επενδύσεις", "Інвестиції", "Инвестиции", "השקעות", "निवेश", "投資",
)

INCOME_GROUP_NAMES = (
    "Bevételek", "Einkommen", "Entrate", "Income", "Ingresos", "Inkomen", "Przychody",
    "Príjmy", "Příjmy", "Renda", "Rendimentos", "Revenus", "Εισόδημα", "Доходи",
    "Доходы", "הכנסות", "आय", "収入",
)


def upgrade() -> None:
    op.add_column(
        "categories",
        sa.Column("kind", sa.String(length=20), nullable=False, server_default="variable"),
    )
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE categories SET kind = 'investment' "
            "WHERE treat_as_transfer IS TRUE AND name IN :names"
        ).bindparams(sa.bindparam("names", expanding=True)),
        {"names": list(INVESTMENTS_NAMES)},
    )
    bind.execute(
        sa.text(
            "UPDATE categories SET kind = 'transfer' "
            "WHERE treat_as_transfer IS TRUE AND kind <> 'investment'"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE categories SET kind = 'income' "
            "WHERE treat_as_transfer IS NOT TRUE AND group_id IN ("
            "  SELECT id FROM category_groups WHERE name IN :names"
            ")"
        ).bindparams(sa.bindparam("names", expanding=True)),
        {"names": list(INCOME_GROUP_NAMES)},
    )


def downgrade() -> None:
    op.drop_column("categories", "kind")
