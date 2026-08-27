"""Application startup / factory tests."""


def test_app_factory_builds(app):
    assert app.title
    assert app.version == "0.1.0"


def test_lifespan_loads_dataset(repo):
    # Lifespan ran via the client fixture; dataset must be present and timestamped.
    assert repo is not None
    assert repo.loaded_at is not None


def test_root_endpoint(client):
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["api_base"] == "/api/v1"
    assert body["health"] == "/health"


def test_openapi_available(client):
    response = client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    for expected in [
        "/health",
        "/api/v1/data/summary",
        "/api/v1/persons",
        "/api/v1/calls",
        "/api/v1/transactions",
        "/api/v1/locations",
        "/api/v1/firs",
    ]:
        assert expected in paths, f"missing route: {expected}"
