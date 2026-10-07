import pytest

from calc_check.fixtures import load_fixtures, run_fixture

FIXTURES = load_fixtures()


def test_minimum_fixture_count() -> None:
    assert len(FIXTURES) >= 16


@pytest.mark.parametrize("fx", FIXTURES, ids=[f["id"] for f in FIXTURES])
def test_fixture(fx: dict[str, object]) -> None:
    run_fixture(fx)
