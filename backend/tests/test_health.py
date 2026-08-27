"""Health endpoint tests."""


def test_health_ok(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["dataset_loaded"] is True
    assert body["version"] == "0.1.0"
