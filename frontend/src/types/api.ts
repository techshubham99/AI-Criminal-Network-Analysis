/**
 * Backend response types.
 * ---------------------------------------------------------------------------
 * Every interface here is transcribed from the LIVE OpenAPI document of this
 * project's FastAPI backend (`GET /openapi.json`), not from guesswork. Names
 * match the backend's Pydantic schema names one-for-one so the two can be
 * diffed by eye.
 *
 * `src/test/live/contract.test.ts` re-checks these shapes against a running
 * backend, which is what protects them from silent drift.
 *
 * Anything typed `Record<string, unknown>` is genuinely open-ended on the
 * backend side (a plain dict, not a declared model). Those are narrowed at the
 * point of use with the small readers in `src/utils/records.ts` rather than by
 * asserting a shape the backend never promised.
 */

/* ======================================================================
   Error envelope — every non-2xx response from this backend uses it.
   e.g. {"error":{"code":"not_found","message":"Person '99999' not found",
                  "detail":{"resource":"Person","id":99999}}}
   ====================================================================== */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

/* ======================================================================
   Shared primitives
   ====================================================================== */

/** Node types actually materialised in the Phase 2 graph. */
export const NODE_TYPES = [
  'PERSON',
  'PHONE',
  'AADHAAR',
  'LOCATION',
  'FIR',
  'CELL_TOWER',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Structured edge types the Phase 2 graph is allowed to contain. */
export const EDGE_TYPES = [
  'CALLED',
  'TRANSACTED',
  'REPORTED_AGAINST',
  'NAMED_IN_FIR',
  'OWNS_PHONE',
  'OWNS_AADHAAR',
  'LOCATED_AT',
  'CO_LOCATED',
  'USED_TOWER',
  'SAME_RING',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Entity types the Phase 3 NLP layer can emit. */
export const NLP_ENTITY_TYPES = [
  'PERSON',
  'PHONE',
  'AADHAAR',
  'LOCATION',
  'DATE',
  'MONEY',
  'VEHICLE',
  'ORGANIZATION',
] as const;
export type NlpEntityType = (typeof NLP_ENTITY_TYPES)[number];

/** Relationship types the Phase 3 NLP layer can assert from narrative text. */
export const NLP_RELATIONSHIP_TYPES = [
  'REPORTED_AGAINST',
  'LOCATED_AT',
  'ASSOCIATED_WITH',
  'MET',
  'CALLED',
  'TRANSFERRED_TO',
] as const;
export type NlpRelationshipType = (typeof NLP_RELATIONSHIP_TYPES)[number];

export type ResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'not_applicable';

export type GraphAdditionStatus =
  | 'accepted_additive'
  | 'accepted_merged_provenance'
  | 'rejected_duplicate'
  | 'rejected_self_loop'
  | 'rejected_unresolved_endpoint'
  | 'rejected_low_confidence'
  | 'rejected_invalid';

export interface PageMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

/* ======================================================================
   Phase 1 — dataset foundation
   ====================================================================== */

export interface HealthResponse {
  status: string;
  app: string;
  version: string;
  phase: string;
  environment: string;
  dataset_loaded: boolean;
}

export interface TableCounts {
  persons: number;
  calls: number;
  transactions: number;
  locations: number;
  firs: number;
}

export interface TimeRange {
  min?: string | null;
  max?: string | null;
}

export interface TemporalProfile {
  calls: TimeRange;
  transactions: TimeRange;
  firs: TimeRange;
}

export interface PersonsProfile {
  unique_ids: number;
  id_min: number;
  id_max: number;
  missing_ids_count: number;
  duplicate_phones: number;
  duplicate_aadhaar: number;
  duplicate_names: number;
  in_ring: number;
  not_in_ring: number;
  ring_distribution: Record<string, number>;
}

export interface FinancialProfile {
  amount_min: number;
  amount_median: number;
  amount_p90: number;
  amount_max: number;
  amount_mean: number;
  modes: Record<string, number>;
}

export interface CallsProfile {
  duration_min: number;
  duration_max: number;
  duration_mean: number;
}

export interface ReferentialIntegrity {
  calls_bad_caller: number;
  calls_bad_callee: number;
  calls_self: number;
  txns_bad_sender: number;
  txns_bad_receiver: number;
  txns_self: number;
  firs_bad_complainant: number;
  firs_bad_accused: number;
  firs_bad_location: number;
  firs_self: number;
  persons_bad_location_fk: number;
}

export interface ValidationReport {
  is_valid: boolean;
  referential_integrity: ReferentialIntegrity;
}

export interface DataSummaryResponse {
  dataset_dir: string;
  loaded_at: string;
  counts: TableCounts;
  persons: PersonsProfile;
  temporal: TemporalProfile;
  financial: FinancialProfile;
  calls_profile: CallsProfile;
  validation: ValidationReport;
  notes: string[];
}

export interface FIR {
  fir_id: number;
  date: string;
  complainant_id: number;
  accused_id: number;
  location_id: number;
  narrative: string;
}

export interface Person {
  person_id: number;
  name: string;
  phone: string;
  aadhar: string;
  address: string;
  city: string;
  state: string;
  location_id: number;
  ring_id?: number | null;
}

export interface LocationRecord {
  location_id: number;
  state: string;
  city: string;
  latitude: number;
  longitude: number;
  /** City-centroid coordinate. The only pair this UI ever plots. */
  canonical_lat: number;
  canonical_lng: number;
}

/** One row of the `calls` table, as `GET /calls` returns it. */
export interface CallRecord {
  call_id: number;
  caller_id: number;
  callee_id: number;
  start_time: string;
  duration_sec: number;
  cell_tower_id: number;
}

/** One row of the `transactions` table, as `GET /transactions` returns it. */
export interface TransactionRecord {
  txn_id: number;
  sender_id: number;
  receiver_id: number;
  amount_inr: number;
  txn_time: string;
  mode: string;
  bank_ref: string;
}

/* ======================================================================
   Phase 2 — graph engine
   ====================================================================== */

export interface NodeOut {
  entity_id: string;
  /** Widened to `string`: the backend does not constrain this to an enum. */
  entity_type: string;
  label: string;
  source_dataset?: string | null;
  source_record_id?: string | null;
  attributes?: Record<string, unknown>;
}

export interface EdgeOut {
  relationship_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  directed: boolean;
  source_dataset: string;
  weight: number;
  weight_detail?: Record<string, unknown>;
  date_first?: string | null;
  date_last?: string | null;
  provenance_confidence: number;
  is_overlay: boolean;
  attributes?: Record<string, unknown>;
  evidence_count: number;
  evidence?: string[];
}

export interface NetworkResponse {
  anchor: NodeOut;
  depth: number;
  persons_only: boolean;
  nodes: NodeOut[];
  edges: EdgeOut[];
  /** Known keys: truncated, node_count, edge_count, depth, max_nodes. */
  meta: Record<string, unknown>;
}

export interface PersonDetailResponse {
  person: NodeOut;
  relationship_counts: Record<string, number>;
  neighbor_count: number;
  metrics?: Record<string, unknown> | null;
}

export interface SearchResponse {
  query: string;
  count: number;
  results: NodeOut[];
}

export interface PathHop {
  length: number;
  nodes: NodeOut[];
  edges: EdgeOut[];
}

export interface PathResponse {
  source: string;
  target: string;
  found: boolean;
  path_count: number;
  max_length: number;
  paths: PathHop[];
}

/** `GET /graph/summary` is an open dict on the backend; these keys are the
 *  ones it actually returns today (verified live). Optional throughout so a
 *  backend that stops emitting one degrades instead of crashing. */
export interface GraphSummaryResponse {
  phase?: string;
  graph?: {
    node_count?: number;
    edge_count?: number;
    observed_edge_count?: number;
    overlay_edge_count?: number;
    nodes_by_type?: Record<string, number>;
    edges_by_type?: Record<string, number>;
    overlay_edges_by_type?: Record<string, number>;
    self_loops?: number;
  };
  build?: Record<string, unknown>;
  analytics?: {
    persons?: number;
    undirected?: { edges?: number; metrics?: string[]; note?: string };
    directed?: { edges?: number; metrics?: string[] };
    excluded_from_analytics?: string[];
  };
  communities?: {
    count?: number;
    modularity?: number;
    adjusted_rand_index_vs_rings?: number;
    ari_persons?: number;
  };
  materialized_node_types?: string[];
  future_node_types?: string[];
  allowed_edge_types?: string[];
  limits?: {
    max_network_depth?: number;
    max_network_nodes?: number;
    max_path_length?: number;
    max_paths?: number;
    co_located_max_group?: number;
    search_limit?: number;
  };
  provenance_note?: string;
  [key: string]: unknown;
}

/* ======================================================================
   Phase 2 — analytics
   ====================================================================== */

export interface MetricInterpretation {
  label?: string;
  text?: string;
  is_investigation_lead?: boolean;
  basis?: Record<string, unknown>;
  disclaimer?: string;
  [key: string]: unknown;
}

export interface PersonAnalyticsOut {
  entity_id: string;
  degree: number;
  degree_centrality: number;
  weighted_degree: number;
  betweenness: number;
  pagerank: number;
  community_id?: number | null;
  component_id?: number | null;
  interpretation: MetricInterpretation;
}

export interface TopPersonsResponse {
  metric: string;
  projection: string;
  count: number;
  persons: PersonAnalyticsOut[];
  note: string;
}

export interface CommunitySummary {
  community_id?: number;
  size?: number;
  members_sample?: string[];
  [key: string]: unknown;
}

export interface CommunitiesResponse {
  algorithm: string;
  projection: string;
  weight: string;
  seed: number;
  deterministic: boolean;
  community_count: number;
  modularity: number;
  ground_truth_overlay: Record<string, unknown>;
  communities: CommunitySummary[];
}

/** `GET /analytics/demo` — the backend's own deterministic demo selection. */
export interface DemoInvestigationResponse {
  available: boolean;
  selection_method?: string;
  person_id?: string;
  label?: string;
  one_hop?: { node_count?: number; edge_count?: number; truncated?: boolean };
  two_hop?: { node_count?: number; edge_count?: number; truncated?: boolean };
  strongest_relationships?: Array<{
    relationship_id: string;
    relationship_type: string;
    with: string;
    with_label?: string;
    weight?: number;
    weight_detail?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  notable_metrics?: PersonAnalyticsOut;
  community?: {
    community_id?: number;
    community_size?: number;
    modularity?: number;
    ground_truth_overlay?: Record<string, unknown>;
  };
  ground_truth_ring_id?: number | null;
  description?: string;
  framing_note?: string;
  [key: string]: unknown;
}

/* ======================================================================
   Phase 3 — FIR narrative NLP
   ====================================================================== */

export interface EntityOut {
  entity_type: string;
  raw_text: string;
  normalized_value: string;
  confidence: number;
  fir_id: number;
  character_start: number;
  character_end: number;
  extraction_method: string;
  evidence_text: string;
  role?: string | null;
}

export interface ResolutionOut {
  status: string;
  matched_entity_id?: string | null;
  resolution_method?: string | null;
  confidence?: number | null;
  evidence?: string[];
  ambiguous?: boolean;
  candidates?: string[];
  reason?: string | null;
}

export interface ResolvedEntityOut {
  entity: EntityOut;
  resolution: ResolutionOut;
}

export interface RelationshipOut {
  relationship_type: string;
  fir_id: number;
  directed: boolean;
  source_entity_id?: string | null;
  target_entity_id?: string | null;
  source_mention: string;
  target_mention: string;
  source_resolved: boolean;
  target_resolved: boolean;
  confidence: number;
  evidence_text: string;
  character_start: number;
  character_end: number;
  extraction_method: string;
  source_dataset: string;
  source_record_id: string;
  attributes?: Record<string, unknown>;
}

export interface FirEntitiesResponse {
  fir_id: number;
  narrative: string;
  source_record_id: string;
  entity_count: number;
  counts_by_type: Record<string, number>;
  resolution_counts: Record<string, number>;
  entities: ResolvedEntityOut[];
  absent_entity_types: string[];
}

export interface FirRelationshipsResponse {
  fir_id: number;
  narrative: string;
  source_record_id: string;
  relationship_count: number;
  counts_by_type: Record<string, number>;
  relationships: RelationshipOut[];
  note: string;
}

export interface GraphAdditionOut {
  status: string;
  accepted: boolean;
  reason: string;
  relationship_id?: string | null;
  duplicate_of?: string | null;
  detail?: Record<string, unknown>;
  relationship: RelationshipOut;
}

export interface NarrativeEdgeOut {
  relationship_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  directed: boolean;
  source_dataset: string;
  is_narrative: boolean;
  is_overlay: boolean;
  provenance_confidence: number;
  weight: number;
  date_first?: string | null;
  date_last?: string | null;
  evidence?: string[];
  attributes?: Record<string, unknown>;
}

export interface GraphImpactSummary {
  extracted_entity_count?: number;
  resolved_entity_count?: number;
  unresolved_entity_count?: number;
  ambiguous_entity_count?: number;
  validated_relationship_count?: number;
  proposed_count?: number;
  accepted_count?: number;
  rejected_count?: number;
  by_status?: Record<string, number>;
  structured_graph_mutated?: boolean;
  [key: string]: unknown;
}

export interface GraphImpactResponse {
  fir_id: number;
  narrative: string;
  source_record_id: string;
  summary: GraphImpactSummary;
  extracted_entities: ResolvedEntityOut[];
  resolved_entities: ResolvedEntityOut[];
  unresolved_entities: ResolvedEntityOut[];
  not_applicable_entities: ResolvedEntityOut[];
  validated_relationships: RelationshipOut[];
  proposed_additions: GraphAdditionOut[];
  accepted_additions: GraphAdditionOut[];
  rejected_additions: GraphAdditionOut[];
  narrative_edges: NarrativeEdgeOut[];
  structured_graph_mutated: boolean;
}

export interface SearchHitOut {
  fir_id: number;
  source_record_id: string;
  matched_field: string;
  entity: EntityOut;
  resolution: ResolutionOut;
}

export interface NlpSearchResponse {
  query: string;
  counts_by_type: Record<string, number>;
  matched_fir_count: number;
  items: SearchHitOut[];
  meta: PageMeta;
  searched_fields?: string[];
}

/* ======================================================================
   Phase 4 — investigation intelligence

   Two shapes carry weight here and must survive into the UI unchanged:

   1. STRUCTURED AND NLP-DERIVED EVIDENCE ARE SEPARATE LISTS. The backend never
      emits a merged `evidence` field, and nothing in this frontend creates one.
      A structured item is an observed dataset row (confidence 1.0); an
      NLP-derived item is a rule-extraction claim about FIR free text carrying
      its own confidence, and it does not raise any score.

   2. `value` AND `contribution` ARE SEPARATE NUMBERS, so a reader can verify the
      arithmetic: contribution = round(value x max_contribution, 2), and the
      published score is the sum of contributions rounded half-up.

   Note one deliberate naming divergence from the backend: its Phase 4 ranking
   schema is also called `TopPersonsResponse`, which already means the Phase 2
   centrality ranking in this file. The Phase 4 one is `PriorityRankingResponse`
   here. The two rank different things and are never interchangeable.
   ====================================================================== */

export const SCORE_BANDS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

export const PATTERN_TYPES = [
  'MULTI_CHANNEL_RELATIONSHIP',
  'COMMUNICATION_ANOMALY',
  'TRANSACTION_CYCLE',
  'TRANSACTION_FAN_IN',
  'TRANSACTION_FAN_OUT',
  'TRANSACTION_CONCENTRATION',
  'LOCATION_COHORT',
  'SHARED_LOCATION_PAIR',
  'BRIDGE_ENTITY',
] as const;
export type PatternType = (typeof PATTERN_TYPES)[number];

/** The six scored features. Order here is the backend's weight order. */
export const SCORE_FEATURES = [
  'network_importance',
  'multi_channel_relationship',
  'transaction_patterns',
  'communication_anomaly',
  'location_patterns',
  'bridge_network_structure',
] as const;
export type ScoreFeature = (typeof SCORE_FEATURES)[number];

export interface EvidenceOut {
  evidence_id: string;
  /** `STRUCTURED` = observed record; `NLP_DERIVED` = claim about FIR text. */
  evidence_class: 'STRUCTURED' | 'NLP_DERIVED';
  source_dataset: string;
  source_record_id: string;
  confidence: number;
  confidence_basis: string;
  evidence_text?: string | null;
}

export interface PatternOut {
  /** Content-addressed: `<type>~<sha256 prefix>`, stable across restarts. */
  pattern_id: string;
  pattern_type: string;
  entity_ids: string[];
  relationship_types: string[];
  source_datasets: string[];
  severity: number;
  explanation: string;
  structured_evidence: EvidenceOut[];
  nlp_evidence: EvidenceOut[];
  detail?: Record<string, unknown>;
}

export interface PatternListResponse {
  total: number;
  count: number;
  offset: number;
  limit: number;
  patterns: PatternOut[];
  filters: {
    pattern_type?: string | null;
    entity_id?: string | null;
    /** `new_in_preview` on a bulk-import preview. */
    scope?: string | null;
  };
  note: string;
}

export interface ScoreFactorOut {
  feature: string;
  /** 0-1, before weighting. */
  value: number;
  max_contribution: number;
  contribution: number;
  pattern_ids: string[];
  evidence_ids: string[];
  explanation: string;
  detail?: Record<string, unknown>;
}

export interface PriorityScoreOut {
  person_id: number;
  entity_id: string;
  /** 0-100. Not a probability of anything. */
  score: number;
  band: ScoreBand;
  factors: ScoreFactorOut[];
  pattern_ids: string[];
  structured_evidence: EvidenceOut[];
  nlp_evidence: EvidenceOut[];
  explanation: string;
  disclaimer: string;
}

export interface RankedPersonOut {
  person_id: number;
  entity_id: string;
  name?: string | null;
  city?: string | null;
  state?: string | null;
  score: number;
  band: ScoreBand;
  /** At most three, all with a contribution above zero. */
  top_factors: ScoreFactorOut[];
  pattern_count: number;
  structured_evidence_count: number;
  nlp_evidence_count: number;
  explanation: string;
}

export interface PriorityRankingResponse {
  count: number;
  limit: number;
  band?: ScoreBand | null;
  persons: RankedPersonOut[];
  band_boundaries: Record<string, string>;
  note: string;
  disclaimer: string;
}

export interface CommunicationBaselineOut {
  person_id: number;
  anomaly_status: string;
  observed_count?: number | null;
  peak_date?: string | null;
  z_score?: number | null;
  excess_over_baseline?: number | null;
  materially_significant?: boolean;
  baseline?: {
    observation_days?: number | null;
    total_calls?: number | null;
    mean_calls_per_active_day?: number | null;
    stdev_calls_per_active_day?: number | null;
    min_calls_per_active_day?: number | null;
    max_calls_per_active_day?: number | null;
  };
  supporting_call_ids?: number[];
  [key: string]: unknown;
}

export interface PersonIntelligenceResponse {
  person: Person;
  priority: PriorityScoreOut;
  patterns: PatternOut[];
  communication_baseline?: CommunicationBaselineOut | null;
  /** Phase 2 centrality, reported alongside and never folded into the score. */
  network_position?: PersonAnalyticsOut | null;
  disclaimer: string;
}

export interface FactorWalkthroughOut extends ScoreFactorOut {
  label: string;
  feature_value: number;
  /** e.g. `"0.89 x 20.0 = 17.78"` — the arithmetic, spelled out. */
  arithmetic: string;
}

export interface ExplainResponse {
  person_id: number;
  entity_id: string;
  score: number;
  band: ScoreBand;
  sum_of_contributions: number;
  rounding: string;
  band_meaning: string;
  factor_walkthrough: FactorWalkthroughOut[];
  structured_evidence: EvidenceOut[];
  nlp_evidence: EvidenceOut[];
  evidence_separation_note: string;
  explanation: string;
  disclaimer: string;
}

export interface IntelligenceSummaryResponse {
  phase: string;
  persons_scored: number;
  patterns_detected: number;
  duplicate_pattern_ids_collapsed: number;
  patterns_by_type: Record<string, number>;
  zero_result_categories: Array<{ pattern_type: string; [key: string]: unknown }>;
  score_bands: {
    boundaries: Record<string, string>;
    distribution: Record<string, number>;
  };
  score_stats: { min: number; max: number; mean: number };
  feature_weights: Record<string, number>;
  feature_weight_total: number;
  detection_coverage: Record<string, unknown>;
  evidence_policy: Record<string, string>;
  self_reference_policy: string;
  overlay_policy: string;
  structured_graph_mutated: boolean;
  ranking_note: string;
  disclaimer: string;
}

/* ======================================================================
   Phase 3 (continued) — corpus-level NLP metrics
   ====================================================================== */

/** `GET /nlp/summary` is an open dict; these are the keys it returns today. */
export interface NlpSummaryResponse {
  phase?: string;
  firs_analyzed?: number;
  firs_with_narrative?: number;
  firs_without_narrative?: number;
  firs_without_entities?: number;
  entity_count?: number;
  entities_by_type?: Record<string, number>;
  entities_by_extraction_method?: Record<string, number>;
  entities_by_confidence?: Record<string, number>;
  resolution_by_status?: Record<string, number>;
  resolution_by_method?: Record<string, number>;
  unresolved_entities?: number;
  ambiguous_resolutions?: number;
  relationship_count?: number;
  relationships_by_type?: Record<string, number>;
  relationships_by_confidence?: Record<string, number>;
  graph_additions_by_status?: Record<string, number>;
  graph_additions_accepted?: number;
  graph_additions_rejected?: number;
  narrative_graph?: {
    node_count?: number;
    edge_count?: number;
    nodes_by_type?: Record<string, number>;
    edges_by_type?: Record<string, number>;
    confidence_by_type?: Record<string, number[]>;
    contributing_source_records?: number;
    all_edges_are_narrative?: boolean;
  };
  capabilities?: {
    extraction_methods?: string[];
    optional_spacy_model_available?: boolean;
    external_model_apis_used?: boolean;
    supported_entity_types?: string[];
    supported_relationship_types?: string[];
  };
  confidence_semantics?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  [key: string]: unknown;
}

/* ======================================================================
   Phase 4.6 — live ingestion (`POST /ingest/*`) and the SSE channel
   Transcribed from `backend/app/schemas/ingest.py` and
   `backend/app/ingest/events.py`.
   ====================================================================== */

/** An identifier may be sent as a number or a string; normalization decides. */
export type IngestScalar = string | number;

/** How a submission points at a person. At least one field must be usable. */
export interface PersonRef {
  person_id?: IngestScalar;
  phone?: IngestScalar;
  aadhaar?: IngestScalar;
  name?: string;
}

/**
 * Where the submitter says the record came from. Stored and echoed verbatim; it
 * is never interpreted as an integration with any external system.
 */
export interface ProvenanceIn {
  source_name: string;
  submitted_by?: string;
  reference?: string;
  note?: string;
}

export interface FirIn {
  provenance: ProvenanceIn;
  date: IngestScalar;
  complainant: PersonRef;
  /** Omit when no accused is named yet — that is a valid FIR. */
  accused?: PersonRef;
  narrative: string;
  location_id?: IngestScalar;
  city?: string;
  state?: string;
}

export interface CallIn {
  provenance: ProvenanceIn;
  caller: PersonRef;
  callee: PersonRef;
  start_time: IngestScalar;
  duration_sec: IngestScalar;
  cell_tower_id?: IngestScalar;
}

export interface TransactionIn {
  provenance: ProvenanceIn;
  sender: PersonRef;
  receiver: PersonRef;
  amount_inr: IngestScalar;
  txn_time: IngestScalar;
  mode: string;
  bank_ref?: string;
}

export interface LocationIn {
  provenance: ProvenanceIn;
  person: PersonRef;
  observed_at?: IngestScalar;
  location_id?: IngestScalar;
  city?: string;
  state?: string;
}

/** The four decisions the pipeline can reach. */
export const INGEST_STATUSES = [
  'ACCEPTED',
  'DUPLICATE',
  'REVIEW_REQUIRED',
  'REJECTED',
] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** The two review reasons, which are deliberately NOT interchangeable. */
export type ReviewReason = 'AMBIGUOUS_MATCH' | 'NO_MATCH_NEW_ENTITY' | string;

export interface CandidateOut {
  entity_id: string;
  label: string;
  detail?: Record<string, unknown>;
}

export interface MatchOut {
  field: string;
  /** MATCHED | AMBIGUOUS | NO_MATCH */
  status: string;
  /** trusted_identifier | normalized_exact | deterministic_context | none */
  method: string;
  entity_id?: string | null;
  label?: string | null;
  confidence?: number | null;
  candidates: CandidateOut[];
  explanation: string;
  is_new_entity: boolean;
}

/**
 * The backend calls this `RelationshipOut` too, but Phase 3's NLP relationship
 * already owns that name above; the prefix keeps the two apart.
 */
export interface IngestRelationshipOut {
  relationship_type: string;
  source_entity_id?: string | null;
  target_entity_id?: string | null;
  accepted: boolean;
  reason: string;
  relationship_id?: string | null;
  is_new_edge: boolean;
  is_self_reference: boolean;
  excluded_from_intelligence: boolean;
  is_narrative: boolean;
}

export interface ProvenanceOut {
  source_type: string;
  source_name: string;
  submitted_by?: string | null;
  reference?: string | null;
  note?: string | null;
}

/**
 * One submitted record and its verdict.
 *
 * `impact` is an open dict on the backend; the keys the UI reads are narrowed
 * where they are used, not asserted here.
 */
export interface IngestRecordOut {
  record_id: string;
  source_type: string;
  status: IngestStatus | string;
  validation_status: string;
  resolution_status: string;
  review_reason?: ReviewReason | null;
  reject_reason?: string | null;
  reason: string;
  raw_payload: Record<string, unknown>;
  normalized_payload: Record<string, unknown>;
  provenance: ProvenanceOut;
  ingested_at: string;
  matches: MatchOut[];
  relationships: IngestRelationshipOut[];
  evidence: string[];
  entity_ids: string[];
  duplicate_of?: string | null;
  impact: Record<string, unknown>;
  disclaimer: string;
}

/** Every event type the live channel publishes. */
export const LIVE_EVENT_TYPES = [
  'new_intelligence',
  'entity_updated',
  'relationship_added',
  'pattern_detected',
  'priority_changed',
  'bulk_preview',
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/**
 * One frame off the SSE stream.
 *
 * Events are notifications, not data: they carry ids, counts and statuses so the
 * UI knows what to refetch, never narrative text or identifiers. `data` is
 * therefore left open and is not rendered.
 */
export interface LiveEvent {
  event_id: number;
  event_type: LiveEventType | string;
  at: string;
  data: Record<string, unknown>;
}

/* ------------------------------------- Phase 6.2 — CSV bulk import ------ */

/** The four record types a CSV may carry, lowercase as the route expects. */
export const BULK_SOURCE_TYPES = ['call', 'transaction', 'fir', 'location'] as const;
export type BulkSourceType = (typeof BULK_SOURCE_TYPES)[number];

/** The six checkpoints a preview reports, in the order the backend reaches them. */
export const BULK_STAGES = [
  'received',
  'validating',
  'checking_duplicates',
  'building_preview',
  'analyzing_preview',
  'preview_ready',
] as const;
export type BulkStage = (typeof BULK_STAGES)[number];

export interface BulkUploadIn {
  filename: string;
  content: string;
}

export interface BulkRowOut {
  /** 1-based data row, header excluded. */
  row: number;
  verdict: 'NEW_VALID' | 'DUPLICATE' | 'REVIEW_REQUIRED' | 'REJECTED' | string;
  reason: string;
  /** Which entities the row points at, identifiers masked to their last four. */
  summary: string;
  record_id?: string | null;
  /** Which file the row came from in a combined import; null in a single one. */
  source_type?: string | null;
}

export interface BulkCountsOut {
  total: number;
  new_valid: number;
  duplicate: number;
  review_required: number;
  rejected: number;
}

/**
 * What the graph and analytics would look like after committing.
 *
 * The same three shapes `GET /graph/summary` returns, because the preview runs
 * the same functions over an in-memory overlay. `note` replaces `analytics` when
 * no row is new: nothing was recomputed, so there is nothing to report.
 */
export interface BulkMetricsPreview {
  graph?: GraphSummaryResponse['graph'];
  analytics?: GraphSummaryResponse['analytics'];
  communities?: GraphSummaryResponse['communities'] & {
    /** Each detected community, with a sample of its members and their labels. */
    detected?: BulkCommunityOut[];
  };
  /** The overlay's most central persons, ranked by the existing centrality pass. */
  key_players?: BulkKeyPlayerOut[];
  live_rows?: Record<string, number>;
  recompute_cost_ms?: Record<string, number>;
  priority_changes?: Record<string, unknown>[];
  note?: string;
}

/** One row of the preview's Key Players table — `GraphAnalytics.person_metrics`. */
export interface BulkKeyPlayerOut {
  entity_id: string;
  name?: string | null;
  degree?: number;
  degree_centrality?: number;
  weighted_degree?: number;
  betweenness?: number;
  pagerank?: number;
  community_id?: number | null;
  component_id?: number | null;
  /** True when this import touched the person, so the ranking can be read. */
  in_import?: boolean;
}

/** One row of the preview's Detected Communities table. */
export interface BulkCommunityOut {
  community_id: number;
  size: number;
  members_sample: string[];
  member_names?: (string | null)[];
}

/** The affected nodes and their immediate neighbours, in the graph shape. */
export interface BulkNetworkOut {
  nodes: NodeOut[];
  edges: EdgeOut[];
  meta: Record<string, unknown>;
}

export interface BulkPreviewOut {
  import_id: string;
  source_type: string;
  counts: BulkCountsOut;
  /** False when no row is new: there is nothing to commit. */
  commit_applicable: boolean;
  metrics_preview: BulkMetricsPreview;
  network_preview: BulkNetworkOut;
  suspicious_patterns_preview: PatternListResponse;
  duplicate_rows: BulkRowOut[];
  review_required_rows: BulkRowOut[];
  rejected_rows: BulkRowOut[];
  disclaimer: string;
}

export interface BulkConfirmOut {
  import_id: string;
  source_type: string;
  counts: Record<string, number>;
  record_ids: string[];
  /** Rows that stopped being committable between preview and confirm. */
  skipped: Record<string, unknown>[];
  graph_totals: Record<string, number>;
  live_rows: Record<string, number>;
  new_pattern_ids: string[];
  priority_changes: Record<string, unknown>[];
  recompute_cost_ms: Record<string, number>;
  recompute_error?: string | null;
  manifest_hash?: string | null;
  audit_event_id?: string | null;
  audit_error?: string | null;
  disclaimer: string;
  /** Combined imports only: what each selected file committed. */
  files?: BulkFileOut[] | null;
  import_ids?: string[];
  graph_before?: Record<string, number> | null;
}

export interface BulkRejectOut {
  import_id: string;
  discarded: boolean;
  note: string;
}

/* --------------------------- Phase 6.2b — several files, one import ----- */

/** One file of an All Types selection, sent with the type it carries. */
export interface BulkBatchFileIn extends BulkUploadIn {
  source_type: BulkSourceType;
}

export interface BulkBatchIn {
  files: BulkBatchFileIn[];
}

/**
 * One selected file's own contribution.
 *
 * `status` says what became of the file, and the three ways of contributing
 * nothing are kept apart because they are different news: `skipped` (its rows are
 * already in the system), `rejected` (no row was usable) and `review` (no row
 * could be added without a decision). `ok` has new rows and becomes `committed`
 * after a commit; `error` means the file itself could not be read, and `error`
 * says why. `reason` carries the row's own explanation for the first three.
 */
export interface BulkFileOut {
  index: number;
  source_type: string;
  filename: string;
  status: 'ok' | 'skipped' | 'rejected' | 'review' | 'error' | 'committed' | string;
  counts: BulkCountsOut;
  import_id?: string | null;
  error?: string | null;
  /** Why the file contributed nothing new. Null when it did. */
  reason?: string | null;
  /** Present on a confirm response only. */
  imported?: number;
}

/**
 * A combined preview: one import over one to four files.
 *
 * `counts`, `metrics_preview`, `network_preview` and `suspicious_patterns_preview`
 * describe the whole selection analysed **together** on one overlay — not per-file
 * previews added up, which is what makes a relationship spanning two files
 * visible before either file is committed.
 */
export interface BulkBatchPreviewOut extends BulkPreviewOut {
  files: BulkFileOut[];
  /** The batch id, then each file's own id. Any of them ends the import. */
  import_ids: string[];
  /** Live graph totals the preview was computed against. */
  graph_before: Record<string, number>;
}

/* ------------------------------- Phase 5 — tamper-evident audit ledger -- */

/** The only two verdicts the ledger returns. There is no "probably fine". */
export const VERIFICATION_STATUSES = ['VERIFIED', 'INTEGRITY_COMPROMISED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Why a verification failed, with the two hashes side by side.
 *
 * Present only when `status` is `INTEGRITY_COMPROMISED`, and never carries the
 * content itself — a failure names the event and the digests, nothing more.
 */
export interface AuditFailureOut {
  audit_event_id?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  reason: string;
  expected_hash?: string | null;
  actual_hash?: string | null;
  message: string;
}

/** `GET /api/v1/audit/verify` — one recomputation of the whole hash chain. */
export interface ChainVerificationOut {
  status: VerificationStatus | string;
  events_checked: number;
  chain_length: number;
  genesis_previous_hash: string;
  head_hash: string;
  backend: string;
  persisted: boolean;
  failure?: AuditFailureOut | null;
}
