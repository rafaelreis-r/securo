"""How each category kind behaves in the plan (metas).

One table, one entry per `CategoryKind`. Everything that needs to know what
a kind means — which plan block it feeds, how its actual is signed, whether
it is money that moves rather than money earned or spent — reads it here.
`test_category_kind_rules` fails if a kind is missing.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Optional

from app.models.category import CategoryKind


class PlanBlock(str, enum.Enum):
    """The four blocks the plan shows, in display order."""

    INCOME = "income"
    INVESTMENT = "investment"
    FIXED_SPENDING = "fixed_spending"
    VARIABLE_SPENDING = "variable_spending"


class ActualRule(str, enum.Enum):
    """How a category's actual is computed from its posted movements."""

    CREDITS_MINUS_DEBITS = "credits_minus_debits"  # income: refunds of income lower it
    DEBITS_MINUS_CREDITS = "debits_minus_credits"  # spending: refunds lower it; investment: redemptions do


@dataclass(frozen=True)
class KindRule:
    block: Optional[PlanBlock]  # None: never on the plan
    actual: ActualRule
    over_is_bad: bool  # spending: passing the target is bad; income/investment: falling short is bad
    transfer_like: bool  # mirrors Category.treat_as_transfer


KIND_RULES: Mapping[CategoryKind, KindRule] = MappingProxyType(
    {
        CategoryKind.INCOME: KindRule(PlanBlock.INCOME, ActualRule.CREDITS_MINUS_DEBITS, False, False),
        CategoryKind.INVESTMENT: KindRule(PlanBlock.INVESTMENT, ActualRule.DEBITS_MINUS_CREDITS, False, True),
        CategoryKind.FIXED: KindRule(PlanBlock.FIXED_SPENDING, ActualRule.DEBITS_MINUS_CREDITS, True, False),
        CategoryKind.VARIABLE: KindRule(PlanBlock.VARIABLE_SPENDING, ActualRule.DEBITS_MINUS_CREDITS, True, False),
        CategoryKind.OCCASIONAL: KindRule(PlanBlock.VARIABLE_SPENDING, ActualRule.DEBITS_MINUS_CREDITS, True, False),
        CategoryKind.TRANSFER: KindRule(None, ActualRule.DEBITS_MINUS_CREDITS, True, True),
    }
)
