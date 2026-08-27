"""Dataset summary endpoint tests."""


def test_summary_counts(client):
    response = client.get("/api/v1/data/summary")
    assert response.status_code == 200
    body = response.json()
    assert body["counts"] == {
        "persons": 500,
        "calls": 2000,
        "transactions": 1500,
        "locations": 200,
        "firs": 300,
    }


def test_summary_validation_valid(client):
    body = client.get("/api/v1/data/summary").json()
    assert body["validation"]["is_valid"] is True


def test_summary_financial_modes(client):
    body = client.get("/api/v1/data/summary").json()
    modes = set(body["financial"]["modes"].keys())
    assert modes <= {"UPI", "NEFT", "IMPS", "CASH", "CARD"}
    assert body["financial"]["amount_min"] <= body["financial"]["amount_median"]
    assert body["financial"]["amount_median"] <= body["financial"]["amount_max"]


def test_summary_ring_distribution(client):
    body = client.get("/api/v1/data/summary").json()
    persons = body["persons"]
    assert persons["in_ring"] + persons["not_in_ring"] == 500
    # Ground-truth rings 0-4 plus the 'none' bucket.
    assert "none" in persons["ring_distribution"]


def test_summary_has_honesty_notes(client):
    body = client.get("/api/v1/data/summary").json()
    joined = " ".join(body["notes"]).lower()
    assert "read-only" in joined
    assert "no detection" in joined or "descriptive" in joined
