"""Phase 4.6 live ingestion: validate, resolve, decide, then update.

Nothing in this package writes to the read-only synthetic dataset, and nothing
appends caller input to the graph without passing the decision gate in
:mod:`app.ingest.pipeline`.
"""
