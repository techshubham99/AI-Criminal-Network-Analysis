"""Application configuration.

Centralizes all settings (including the awkward, deeply-nested dataset path noted
in docs/architecture.md §DQ-9) so nothing is hard-coded across the codebase.
All values can be overridden via environment variables prefixed with ``CNA_``.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# --- Path anchors -----------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent          # .../backend/app
BACKEND_DIR = APP_DIR.parent                        # .../backend
REPO_ROOT = BACKEND_DIR.parent                      # .../AI-Criminal-Network-Analysis

# The provided dataset lives under a doubly-nested folder whose leaf name
# contains a space. Keep this in exactly one place.
DEFAULT_DATASET_DIR = (
    REPO_ROOT
    / "dataset"
    / "AI-Powered-Criminal-Network-Analysis-System-main"
    / "AI-Powered-Criminal-Network-Analysis-System-main"
    / "synthetic dataset"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CNA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Application metadata
    app_name: str = "AI-Powered Criminal Network Analysis API"
    app_version: str = "0.1.0"
    phase: str = "1 - Backend Foundation"
    environment: str = "development"

    # API
    api_v1_prefix: str = "/api/v1"

    # Data (read-only source)
    dataset_dir: Path = DEFAULT_DATASET_DIR
    # Optional enrichment (Phase 9) lives in a SEPARATE directory; originals untouched.
    enrichment_dir: Path = BACKEND_DIR / "data" / "enrichment"

    # CORS for local frontend development (Vite: 5173, CRA: 3000)
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # Logging
    log_level: str = "INFO"

    # Pagination
    default_page_size: int = 50
    max_page_size: int = 200

    # Geo normalization (canonical city centroid + deterministic jitter, §DQ-1)
    geo_jitter_degrees: float = 0.05

    # --- Phase 2: graph engine --------------------------------------------
    # Multiplex edge-weight coefficients for the UNDIRECTED person analytic
    # graph (centrality / community). These are transparent, tunable analytic
    # weights (edge strength) — NOT confidence values (see phase2_preflight §3).
    graph_weight_called: float = 1.0
    graph_weight_transacted: float = 1.0
    graph_weight_co_located: float = 0.5
    graph_weight_reported_against: float = 1.0
    # Coefficients for the DIRECTED person projection (PageRank / flow).
    graph_dir_weight_called: float = 1.0
    graph_dir_weight_transacted: float = 1.0
    graph_dir_weight_reported_against: float = 1.0
    # CO_LOCATED clique guard (§preflight watch-item 4): skip locations shared
    # by more than this many persons to avoid O(n^2) edge explosion.
    co_located_max_group: int = 30
    # Network expansion safety limits (§8: prevent unbounded expansion).
    graph_max_depth: int = 2
    graph_max_network_nodes: int = 300
    graph_max_path_length: int = 6
    graph_max_paths: int = 5
    graph_search_limit: int = 50
    # Analytics determinism / interpretation.
    louvain_seed: int = 42
    pagerank_damping: float = 0.85
    pagerank_tolerance: float = 1.0e-10
    pagerank_max_iter: int = 200
    analytics_top_percentile: float = 90.0
    analytics_default_top: int = 20
    analytics_max_top: int = 100

    # --- Phase 3: FIR narrative NLP ---------------------------------------
    # Result caps for the NLP endpoints (mirrors the Phase 2 limits pattern).
    nlp_search_limit: int = 50
    nlp_search_max_limit: int = 200
    # Entity resolution acceptance threshold: a candidate resolution below this
    # deterministic score is left UNRESOLVED (never silently merged).
    nlp_resolution_min_confidence: float = 0.5
    # Narrative relationships below this confidence are extracted and reported
    # but NOT integrated into the narrative graph (spec §7).
    nlp_relationship_min_confidence: float = 0.5
    # Bounded hop check used to report whether an accepted narrative edge merely
    # short-circuits an existing structured path (honest "adds no new
    # connectivity" accounting, spec §9).
    nlp_derivability_max_hops: int = 2

    # --- Phase 4: Investigation Intelligence Engine -----------------------
    # Feature weight caps for the 0-100 Investigation Priority Score. These are
    # the MAXIMUM contribution each feature may make; a feature routinely
    # contributes less. They sum to exactly 100 (validated at build time).
    intel_weight_network_importance: float = 20.0
    intel_weight_multi_channel: float = 20.0
    intel_weight_transaction: float = 20.0
    intel_weight_communication: float = 15.0
    intel_weight_location: float = 15.0
    intel_weight_bridge: float = 10.0

    # Band boundaries (inclusive upper bounds). LOW 0-39, MEDIUM 40-69,
    # HIGH 70-100. Configuration-driven, but NOT to be moved to force demo
    # results (spec §8).
    intel_band_low_max: int = 39
    intel_band_medium_max: int = 69

    # §2 communication anomaly. A person's baseline is built from their own
    # daily call totals; z > intel_anomaly_z_threshold marks unusually HIGH
    # activity. Fewer than intel_anomaly_min_observations distinct observed days
    # yields "insufficient baseline data" rather than an invented baseline.
    intel_anomaly_z_threshold: float = 2.0
    intel_anomaly_min_observations: int = 5
    # A z-score can be large while the absolute excess is trivial (a 2-call day
    # against a 1-call baseline). Statistical flagging is unchanged; this is the
    # threshold above which the excess is additionally reported as materially
    # significant, and it gates the FULL communication contribution.
    intel_anomaly_material_excess: float = 2.0

    # §1 multi-channel: minimum number of INDEPENDENT observed channels linking
    # a pair before the pair is reported.
    intel_multi_channel_min_channels: int = 2

    # §3 transaction structure thresholds.
    intel_txn_cycle_max_length: int = 4
    intel_txn_fan_in_min: int = 5
    intel_txn_fan_out_min: int = 5
    intel_txn_concentration_min_txns: int = 4
    # Share of a person's total transacted value flowing through one
    # counterparty before the relationship is reported as concentrated.
    intel_txn_concentration_min_share: float = 0.6

    # §4 location patterns. A cohort is a canonical location shared by at least
    # this many persons; the max guard mirrors the Phase 2 clique guard.
    intel_location_min_group: int = 5
    intel_location_max_group: int = 30

    # §5 bridge entities: percentile of the betweenness distribution above which
    # an entity is reported as a bridge (reuses the Phase 2 analytics values).
    intel_bridge_percentile: float = 90.0

    # Endpoint result caps (mirrors the Phase 2/3 limit pattern).
    intel_default_top: int = 20
    intel_max_top: int = 100
    intel_patterns_limit: int = 50
    intel_patterns_max_limit: int = 200

    # --- Phase 4.6: live ingestion -----------------------------------------
    # Accepted live records are persisted in their OWN writable directory. The
    # read-only synthetic dataset under `dataset_dir` is never written to.
    ingest_dir: Path = BACKEND_DIR / "data" / "ingest"
    # Off by default so tests and the demo start from a clean, deterministic
    # store; the running app turns it on so accepted records survive a restart.
    ingest_persist: bool = False

    # A narrative long enough to be a FIR statement, short enough to bound the
    # rule-based extractor's work. Both ends are validation, not truncation.
    ingest_min_narrative_chars: int = 20
    ingest_max_narrative_chars: int = 4000
    # Guards against a mistyped duration/amount being accepted as fact.
    ingest_max_call_duration_sec: int = 86_400
    ingest_max_amount_inr: float = 1.0e10

    # SSE: how often a comment frame is written when no event has occurred, so
    # proxies and the browser do not treat an idle stream as a dead one.
    ingest_sse_keepalive_sec: float = 15.0
    # Bounded per-client queue. A client that cannot keep up drops frames rather
    # than growing the server's memory without limit.
    ingest_sse_queue_size: int = 64
    # How many recent events /ingest/events replays to a newly attached client.
    ingest_event_buffer: int = 50

    # §13 external sources: no external integration is configured or claimed.
    # An adapter interface exists; nothing is enabled unless named here.
    ingest_external_sources: list[str] = []

    @field_validator("ingest_external_sources", mode="before")
    @classmethod
    def _split_sources(cls, v):
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    # --- Phase 5: tamper-evident audit ledger ------------------------------
    # A local append-only SHA-256 hash chain. Not a blockchain, and no
    # permissioned network is configured (see docs/phase5_audit.md).
    audit_enabled: bool = True
    audit_dir: Path = BACKEND_DIR / "data" / "audit"
    # Off by default for the same reason as ingest_persist: the records the
    # ledger audits do not outlive a restart unless ingestion persists too, so a
    # self-persisting ledger would describe a graph that no longer exists.
    # CNA_AUDIT_PERSIST=true turns it on and the chain survives a restart.
    audit_persist: bool = False
    # Upper bound on the canonical serialization of content submitted for
    # hashing. The audit layer never stores content, but it should not be asked
    # to canonicalize something unbounded either.
    audit_max_content_bytes: int = 65_536
    audit_max_page_size: int = 200

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors(cls, v):
        # Allow comma-separated string via env var (CNA_CORS_ORIGINS=a,b,c)
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
