"""Endpoint tests: pagination, filtering, invalid ids, error envelope."""

import pytest

LIST_ENDPOINTS = [
    ("persons", 500),
    ("calls", 2000),
    ("transactions", 1500),
    ("locations", 200),
    ("firs", 300),
]

DETAIL_OK = [
    ("persons", 1, "person_id"),
    ("calls", 1, "call_id"),
    ("transactions", 1, "txn_id"),
    ("locations", 1, "location_id"),
    ("firs", 1, "fir_id"),
]


@pytest.mark.parametrize("resource,total", LIST_ENDPOINTS)
def test_list_pagination_meta(client, resource, total):
    response = client.get(f"/api/v1/{resource}?page=1&page_size=10")
    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 10
    meta = body["meta"]
    assert meta["total"] == total
    assert meta["page"] == 1
    assert meta["page_size"] == 10
    assert meta["total_pages"] == (total + 9) // 10
    assert meta["has_prev"] is False
    assert meta["has_next"] is True


def test_second_page_has_prev(client):
    body = client.get("/api/v1/persons?page=2&page_size=10").json()
    assert body["meta"]["page"] == 2
    assert body["meta"]["has_prev"] is True
    # Page 1 and page 2 must not overlap.
    first = client.get("/api/v1/persons?page=1&page_size=10").json()
    first_ids = {p["person_id"] for p in first["items"]}
    second_ids = {p["person_id"] for p in body["items"]}
    assert first_ids.isdisjoint(second_ids)


def test_last_page_partial(client):
    # 500 persons, page_size 200 -> page 3 has 100 items and no next page.
    body = client.get("/api/v1/persons?page=3&page_size=200").json()
    assert len(body["items"]) == 100
    assert body["meta"]["has_next"] is False


def test_page_out_of_range_returns_empty(client):
    body = client.get("/api/v1/persons?page=9999&page_size=50").json()
    assert body["items"] == []
    assert body["meta"]["total"] == 500
    assert body["meta"]["has_next"] is False


@pytest.mark.parametrize("resource,_", LIST_ENDPOINTS)
def test_page_zero_rejected(client, resource, _):
    assert client.get(f"/api/v1/{resource}?page=0").status_code == 422


@pytest.mark.parametrize("resource,_", LIST_ENDPOINTS)
def test_page_size_over_max_rejected(client, resource, _):
    assert client.get(f"/api/v1/{resource}?page_size=100000").status_code == 422


@pytest.mark.parametrize("resource,ident,key", DETAIL_OK)
def test_detail_ok(client, resource, ident, key):
    response = client.get(f"/api/v1/{resource}/{ident}")
    assert response.status_code == 200
    assert response.json()[key] == ident


@pytest.mark.parametrize("resource,_", LIST_ENDPOINTS)
def test_detail_not_found(client, resource, _):
    response = client.get(f"/api/v1/{resource}/999999")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"


@pytest.mark.parametrize("resource,_", LIST_ENDPOINTS)
def test_detail_invalid_type_rejected(client, resource, _):
    # Non-integer id -> 422 validation error.
    assert client.get(f"/api/v1/{resource}/not-an-int").status_code == 422


def test_person_filter_by_ring(client):
    body = client.get("/api/v1/persons?ring_id=3&page_size=200").json()
    assert body["meta"]["total"] > 0
    assert all(p["ring_id"] == 3 for p in body["items"])


def test_calls_filter_by_caller(client):
    body = client.get("/api/v1/calls?caller_id=1&page_size=200").json()
    assert all(c["caller_id"] == 1 for c in body["items"])


def test_transactions_filter_by_mode(client):
    body = client.get("/api/v1/transactions?mode=UPI&page_size=200").json()
    assert all(t["mode"] == "UPI" for t in body["items"])


def test_firs_filter_by_accused(client):
    body = client.get("/api/v1/firs?accused_id=21&page_size=200").json()
    assert all(f["accused_id"] == 21 for f in body["items"])
