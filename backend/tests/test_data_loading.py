"""Dataset loading & referential-integrity tests.

Expected counts come from the profiling recorded in docs/architecture.md §A.
"""


def test_row_counts(repo):
    assert len(repo.persons) == 500
    assert len(repo.calls) == 2000
    assert len(repo.transactions) == 1500
    assert len(repo.locations) == 200
    assert len(repo.firs) == 300


def test_person_ids_unique_and_contiguous(repo):
    v = repo.validation["persons"]
    assert v["unique_ids"] == 500
    assert v["id_min"] == 1
    assert v["id_max"] == 500
    assert v["missing_ids_count"] == 0


def test_identifiers_unique(repo):
    v = repo.validation["persons"]
    assert v["duplicate_phones"] == 0
    assert v["duplicate_aadhaar"] == 0
    assert v["duplicate_names"] == 0


def test_referential_integrity_clean(repo):
    ri = repo.validation["referential_integrity"]
    assert ri["calls_bad_caller"] == 0
    assert ri["calls_bad_callee"] == 0
    assert ri["txns_bad_sender"] == 0
    assert ri["txns_bad_receiver"] == 0
    assert ri["firs_bad_complainant"] == 0
    assert ri["firs_bad_accused"] == 0
    assert ri["firs_bad_location"] == 0
    assert ri["persons_bad_location_fk"] == 0
    assert repo.validation["is_valid"] is True


def test_self_references_reported_not_errors(repo):
    # These exist in the data (2 self-calls, 1 self-FIR) but are not integrity errors.
    ri = repo.validation["referential_integrity"]
    assert ri["calls_self"] == 2
    assert ri["txns_self"] == 0
    assert ri["firs_self"] == 1


def test_multiline_addresses_parsed(repo):
    # 256 addresses contain embedded newlines; a quote-aware parser must keep
    # the record count at 500 (not overcount).
    assert any("\n" in p["address"] for p in repo.persons)


def test_native_python_types(repo):
    p = repo.persons[0]
    assert isinstance(p["person_id"], int)
    assert isinstance(p["aadhar"], str)  # identifier kept as string, not float
    t = repo.transactions[0]
    assert isinstance(t["amount_inr"], float)


def test_ring_id_nullable(repo):
    # Some persons have a ring, most (358) do not (ring_id is None).
    assert any(p["ring_id"] is None for p in repo.persons)
    assert any(isinstance(p["ring_id"], int) for p in repo.persons)


def test_canonical_coords_in_india_bounds(repo):
    for loc in repo.locations:
        assert 6.0 <= loc["canonical_lat"] <= 37.5
        assert 68.0 <= loc["canonical_lng"] <= 98.0


def test_canonical_coords_deterministic(repo):
    from app.services.geo import canonical_coords

    loc = repo.locations[0]
    again = canonical_coords(loc["city"], loc["location_id"], repo.settings.geo_jitter_degrees)
    assert (loc["canonical_lat"], loc["canonical_lng"]) == again
