"""Shared pytest fixtures.

The ``client`` fixture is used as a context manager so FastAPI's lifespan runs —
this is what loads the read-only dataset into ``app.state.dataset``.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture(scope="session")
def app():
    return create_app()


@pytest.fixture(scope="session")
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def repo(app, client):
    # `client` ensures lifespan has run and app.state.dataset is populated.
    return app.state.dataset


@pytest.fixture(scope="session")
def settings(app, client):
    return app.state.settings


@pytest.fixture(scope="session")
def graph_service(app, client):
    # Built once during lifespan startup (Phase 2).
    return app.state.graph


@pytest.fixture(scope="session")
def store(graph_service):
    return graph_service.store


@pytest.fixture(scope="session")
def analytics(graph_service):
    return graph_service.analytics


@pytest.fixture(scope="session")
def nlp_service(app, client):
    # Built once during lifespan startup (Phase 3), after the graph.
    return app.state.nlp


@pytest.fixture(scope="session")
def narrative_store(nlp_service):
    """The SEPARATE narrative graph. Never the Phase 2 structured store."""
    return nlp_service.integrator.store


@pytest.fixture(scope="session")
def intelligence(app, client):
    # Built once during lifespan startup (Phase 4), after the graph and NLP.
    return app.state.intelligence
