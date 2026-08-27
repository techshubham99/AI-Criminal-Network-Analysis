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
  canonical_lat: number;
  canonical_lng: number;
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
