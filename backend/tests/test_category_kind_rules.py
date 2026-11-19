from app.models.category import CategoryKind
from app.services.category_kind_rules import KIND_RULES, PlanBlock


def test_every_kind_has_a_rule():
    assert set(KIND_RULES) == set(CategoryKind)


def test_transfer_never_reaches_the_plan_and_is_transfer_like():
    assert KIND_RULES[CategoryKind.TRANSFER].block is None
    assert KIND_RULES[CategoryKind.TRANSFER].transfer_like


def test_occasional_lands_in_variable_spending():
    assert KIND_RULES[CategoryKind.OCCASIONAL].block is PlanBlock.VARIABLE_SPENDING
