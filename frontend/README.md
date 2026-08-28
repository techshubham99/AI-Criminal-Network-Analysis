# TRACEX — Trace Every Connection

The investigator frontend of the **AI-Powered Criminal Network Analysis System**
(SIH 2026, Problem Statement 26189), over this repository's FastAPI backend.

Its purpose is narrow and deliberate: prove that the graph engine, the narrative NLP
layer, the intelligence layer and the provenance chain are all reachable and legible
from a real UI, using **only** data the backend actually returns. There is no mock data
anywhere in the application code, no hardcoded statistic, and no screen that is not
backed by a verified endpoint.

```
React 19  ·  TypeScript 5.9 (strict)  ·  Vite 8  ·  Tailwind CSS v4  ·  Cytoscape.js 3.34 + fCoSE
```

---

## 1. Running it

The frontend is useless without the backend, so start that first. **Two terminals:**

**Terminal 1 — backend** (from the repository root):

```bash
cd backend && ./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — frontend** (from the repository root):

```bash
cd frontend && npm install && npm run dev
```

Then open <http://localhost:5173>. The Command Center's system-status indicator turns
green once `GET /health` answers; if it shows "Backend unreachable", terminal 1 is not
up.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `:5173`, proxying `/api` and `/health` to the backend |
| `npm run typecheck` | `tsc -b` — strict, `noUnusedLocals`, `verbatimModuleSyntax` |
| `npm test` | Component/unit suite against **recorded** backend responses (no server needed) |
| `npm run test:live` | Contract suite against a **running** backend; self-skips if it is down |
| `npm run build` | Typecheck then production bundle into `dist/` |
| `npm run preview` | Serve `dist/` on `:4173` with the same proxy |
| `npm run verify` | `typecheck` → `test` → `build`, i.e. the whole gate |

### Configuration

The API address is **configuration, not code**. Nothing in the shipped bundle assumes
localhost: `src/api/client.ts` reads `VITE_API_BASE_URL` and falls back to a
same-origin relative path, so one build runs against a dev proxy or a deployed API
depending only on the environment. Copy `.env.example` to `.env.local` to change it.

- `VITE_API_BASE_URL` — the deployed API base, version prefix included
  (`https://your-api-domain.example/api/v1`). Set this for any build served from an
  origin with no proxy in front of it; the backend must allow that origin in CORS.
  Leave it **unset** in development: the API layer then issues relative `/api/v1/...`
  requests that the dev proxy forwards, so the browser stays same-origin and needs no
  CORS at all. The SSE stream and `/health` follow the same base.
- `VITE_API_PROXY_TARGET` — where the **dev/preview** proxy forwards. Development only;
  not part of a production build.
- `VITE_LIVE_API_URL` / `CNA_LIVE_API_URL` — base URL for `npm run test:live`.

There are **no API keys and no third-party services** in this application. Core
intelligence — NLP extraction, graph analytics, pattern detection, priority scoring —
runs entirely in this project's own backend; there is no external AI dependency, and no
provider adapter is implemented here.

**Not integrated:** there is no connection to NCRB, CCTNS/ICJS, telecom CDR systems or
any banking network. The corpus is synthetic. Any such integration would need its own
authorised adapter, and none is present.

---

## 2. Verified endpoint inventory

Every binding lives in [`src/api/endpoints.ts`](src/api/endpoints.ts) — one exported
function per endpoint, and `src/api/client.ts` is the **only** module in the codebase
that calls `fetch`. Each row below was verified against the running backend's
`GET /openapi.json` and exercised by the live contract suite.

| Function | Method & path | Consumed by |
|---|---|---|
| `getHealth` | `GET /health` | top-bar system status |
| `getDataSummary` | `GET /api/v1/data/summary` | Command Center |
| `getGraphSummary` | `GET /api/v1/graph/summary` | Command Center |
| `searchGraph` | `GET /api/v1/graph/search?q=&limit=` | global search, subject pickers |
| `getPersonDetail` | `GET /api/v1/graph/persons/{person_id}` | Network Investigation header |
| `getPersonNetwork` | `GET /api/v1/graph/persons/{person_id}/network?depth=&persons_only=&include_overlay=&max_nodes=` | the graph |
| `getRelationship` | `GET /api/v1/graph/relationships/{relationship_id}` | edge evidence panel |
| `getPath` | `GET /api/v1/graph/path?source=&target=&max_length=&max_paths=` | Evidence & Provenance |
| `getTopPersons` | `GET /api/v1/analytics/persons/top?metric=&limit=` | Command Center |
| `getPersonAnalytics` | `GET /api/v1/analytics/persons/{person_id}` | node details panel |
| `getCommunities` | `GET /api/v1/analytics/communities?min_size=` | Command Center |
| `getDemoInvestigation` | `GET /api/v1/analytics/demo` | the deterministic demo entry point |
| `listFirs` | `GET /api/v1/firs?page=&page_size=` | FIR Intelligence list |
| `getFir` | `GET /api/v1/firs/{fir_id}` | FIR record (structured) |
| `getNlpSummary` | `GET /api/v1/nlp/summary` | Command Center |
| `getFirEntities` | `GET /api/v1/nlp/firs/{fir_id}/entities` | narrative viewer, entity table |
| `getFirRelationships` | `GET /api/v1/nlp/firs/{fir_id}/relationships` | narrative relationships |
| `getFirGraphImpact` | `GET /api/v1/nlp/firs/{fir_id}/graph-impact` | graph-impact panel |
| `searchNlp` | `GET /api/v1/nlp/search?q=&page=&page_size=` | narrative evidence search |
| `getPersonRecord` | `GET /api/v1/persons/{person_id}` | raw record lookup |
| `getLocationRecord` | `GET /api/v1/locations/{location_id}` | raw record lookup |

The table above is the read core. The intelligence, records, ingestion and audit
families were added later and are bound the same way — one exported function per
verified route, all of them in `endpoints.ts`:

| Family | Routes |
|---|---|
| Intelligence | `intelligence/summary`, `intelligence/persons/top`, `intelligence/persons/{id}`, `intelligence/persons/{id}/explain`, `intelligence/patterns`, `intelligence/patterns/{id}` |
| Records | `persons`, `calls`, `transactions`, `locations` — paged list plus `/{id}` detail |
| Ingestion | `POST ingest/fir`, `POST ingest/call`, `POST ingest/transaction`, `POST ingest/location`, and the SSE stream `ingest/stream` |
| Audit | `audit/verify` |

**Two verbs exist, and no more.** `GET` everywhere, plus `POST` for the four ingestion
routes — the app's only writes. `HttpMethod` is a closed union of exactly those two, so
a mutating verb cannot be introduced by passing a string, and an architecture test
asserts no `PUT`/`PATCH`/`DELETE` literal appears anywhere in `src/`.

### Deliberately not bound

Vehicle / organisation / event entities. The backend declares them as *future* node types;
this UI never renders them as present, and there is no nav entry for a screen that has no
backend behind it. Of the Phase 5 audit routes, only `GET /api/v1/audit/verify` is bound
(`verifyAuditChain`) — the event list, per-resource verification and the integrity-record
write exist on the backend but the UI shows a verdict, not a ledger browser.

### The two id forms — the single easiest thing to get wrong

Responses always speak the **prefixed entity id** (`person:445`, `phone:+91-…`,
`fir:210`). But:

- **Path parameters take the numeric row id.** `/graph/persons/445`,
  `/analytics/persons/445`, `/firs/79`, `/nlp/firs/79/entities`. Passing `person:445`
  returns **HTTP 422 `int_parsing`**. Those params are therefore typed `number` in
  `endpoints.ts`, so the mistake cannot compile, and the app's routes are plain
  integers (`/network/445`, `/fir/79`).
- **Query parameters and relationship ids take the prefixed form.**
  `/graph/path?source=person:445&target=person:114` (a bare `445` returns 404), and
  `/graph/relationships/CALLED~person:141~person:189`.

Bridge the two with `personIdFromEntityId()` / `firIdFromEntityId()` from
`src/utils/entity.ts`.

### One more asymmetry worth knowing

`source_record_id` is a **node** field (`persons:445`). An **edge** has no such scalar —
its provenance is the `evidence` array of `dataset:record_id` citations (e.g.
`["calls:213"]`), whose length equals `evidence_count`.

---

## 3. The screens

Communication, Financial, Locations and Evidence are **independent product areas**, not
aliases of the network view. Each browses the whole corpus with no subject selected, and
narrows to a subject when one is.

| Route | Screen | Backed by |
|---|---|---|
| `/` | **Command Center** | `data/summary`, `graph/summary`, `nlp/summary`, `analytics/demo`, `analytics/persons/top`, `intelligence/patterns` |
| `/investigations` | **Investigations** — the priority queue as an entry point | `intelligence/persons/top`, `intelligence/summary` |
| `/network`, `/network/:personId` | **Investigation workspace** — full page: subject header, tab bar, and the graph as main content | `graph/search`, `graph/persons/{id}`, `graph/persons/{id}/network`, `analytics/persons/{id}`, `graph/relationships/{id}`, `intelligence/persons/{id}` |
| `/fir`, `/fir/:firId` | **FIR Intelligence** — the FIR list, then one record with narrative, extraction spans, entities, relationships, graph impact | `firs`, `firs/{id}`, `nlp/firs/{id}/…`, `nlp/search` |
| `/communication` | **Communication** — calls, contacts, communication patterns | `calls`, `intelligence/patterns`, `intelligence/persons/{id}` |
| `/financial` | **Financial** — transactions, counterparties, fan-in / fan-out / cycle / concentration patterns | `transactions`, `intelligence/patterns`, `intelligence/persons/{id}` |
| `/locations` | **Location Intelligence** — locations, linked persons, shared-location and cohort patterns, map | `locations`, `intelligence/patterns` |
| `/evidence` | **Evidence & Provenance** — evidence chains, provenance, ledger verdict | `graph/path`, `graph/relationships/{id}`, `nlp/search`, `audit/verify` |
| `/alerts` | **Alerts** — priority queue and detected patterns | `intelligence/persons/top`, `intelligence/patterns` |

`[+ Add Intelligence]` sits once, in the header. It posts to one `ingest/*` route and
shows the pipeline's verdict — `ACCEPTED` / `DUPLICATE` / `REVIEW REQUIRED` /
`REJECTED` — with the backend's own reason, and distinguishes `AMBIGUOUS_MATCH` from
`NO_MATCH_NEW_ENTITY` because they are different findings. A record that resolves to no
validated relationship says **"No validated connection found"** rather than being forced
into an existing network.

---

## 4. Honesty rules the UI enforces

These are not decoration; they are the reason this prototype can be shown to someone who
knows the domain.

1. **Structured vs narrative-derived is always visible.** `<ProvenanceTag>` marks every
   fact as `STRUCTURED` (a column observed in a dataset table) or `NARRATIVE-DERIVED`
   (asserted only by FIR free text, extracted by a deterministic rule, and held in a
   **separate** narrative graph that is never merged into the structured one).
2. **The ground-truth overlay is excluded.** The generator's `ring_id` / `SAME_RING`
   labels are the answer key, not evidence. `include_overlay` is `false` on every
   request in this frontend, there is no control to turn it on, and wherever `ring_id`
   does surface it is tagged `GROUND-TRUTH OVERLAY` and explicitly described as present
   only because the data is synthetic.
3. **Centrality is not a risk score.** PageRank, betweenness and degree describe
   structural position in the observed network. Every place they appear carries that
   caveat. Nobody and no subgraph is labelled criminal; the language is "investigation
   lead" and "structurally connected".
4. **Confidence is a tier, not a probability.** Extraction confidences are fixed
   constants set by the rule that fired. They are rendered as `HIGH`/`MEDIUM`/`LOW`,
   never as a percentage, because "70%" would imply a calibration this system has never
   measured.
5. **A zero is an answer.** On this corpus, narrative extraction adds **no new
   connectivity** — every proposed edge duplicates a structured one. The UI says exactly
   that instead of dressing it up as a discovery. Absent-but-declared entity types are
   shown as "not present in this corpus" rather than hidden.
6. **Absent ≠ zero.** A stat tile shows an em dash when the backend did not report a
   value, because "0 relationships" and "not reported" are different claims.

---

## 5. Testing, and why there are no mocks

Two suites, and the distinction matters:

**`npm test` — component suite against recorded fixtures.** The JSON files in
`src/test/fixtures/` are **recordings**: each is the verbatim body the real backend
returned for the URL named in its key. Tests install a `fetch` that routes by URL shape
to the matching recording, so a component exercises its real request path — query
params included — against real response bytes. Nothing about backend behaviour is
invented. The fetch spy also records which URLs were requested, which is how the
"consume only verified endpoints" rule is actually enforced rather than asserted.

**`npm run test:live` — contract suite against a running backend.** Real HTTP,
checking that every bound endpoint still exists and still returns the fields the UI
reads. It also pins the properties that would silently corrupt the product if they
drifted:

- extraction spans index correctly into the narrative the same response returns
  (`narrative.slice(character_start, character_end) === raw_text`);
- no `is_overlay` edge ever appears in a network response;
- `/analytics/demo` returns the same person twice in a row, so "deterministic demo
  entry point" is a fact rather than a hope;
- `graph-impact` reports `structured_graph_mutated === false`;
- `DELETE` on a read endpoint is refused — the API really is read-only.

When the backend is unreachable the live suite **skips** rather than fails, so a
developer without a server running is never blocked. Run it against a non-default port
with:

```bash
CNA_LIVE_API_URL=http://127.0.0.1:8000 npm run test:live
```

---

## 6. Layout

```
src/
  api/          client.ts (the ONLY fetch site) · endpoints.ts (one fn per verified
                endpoint) · live.ts (the ONLY EventSource site)
  components/
    ui/         the shared vocabulary: Panel Badge Button ProvenanceTag ConfidenceMeter
                StatTile KeyValueList Skeleton ErrorState EmptyState Tooltip ThemeToggle
    graph/      graphStyle · NetworkGraph · GraphToolbar · GraphLegend
                NodeDetailsPanel · EdgeEvidencePanel
    search/     GlobalSearch · SearchResultList
    nlp/        NarrativeViewer · EntityTable · RelationshipList · GraphImpactPanel
    intelligence/ PriorityPanel · PriorityExplain · PatternList · PatternDetails
                EvidenceList · ActivityTimeline · FactorBreakdown
    records/    DataTable · Pager · PersonRef · SubjectScope
    live/       LiveIndicator · AddIntelligenceButton · IntakeForm · IngestVerdict
    audit/      the integrity verdict read-out
  hooks/        useAsync · useDebouncedValue · useInvestigation · useLive · useTheme
                usePersonNames · usePersonScope
  layouts/      AppShell · TopBar · Sidebar
  pages/        CommandCenter · InvestigationsPage · NetworkInvestigation · FirIntelligence
                CommunicationPage · FinancialPage · LocationsPage · EvidencePage · AlertsPage
  styles/       index.css — the @theme design tokens, the only colours in use
  test/         fixtures/ (recorded responses) · helpers.tsx · setup.ts · live/contract.test.ts
                architecture.test.ts — the standing constraints, enforced mechanically
  types/        api.ts — every response interface, transcribed from the live OpenAPI doc
  utils/        entity · format · records · cn
```

**A Tailwind v4 note that will bite you:** never assemble a class name at runtime.
Tailwind scans source *text*, so `'bg-' + colour` is never generated. Full class strings
go in lookup maps; runtime palette colours (from `entityColor()` /
`relationshipStyle().color`) go in a `style={{ }}` prop.

---

## 7. Known limitations of this slice

- **Network views are person-rooted.** The backend's only neighbourhood endpoint is
  `/graph/persons/{id}/network`, so a phone, tower or location cannot be the root of a
  graph view. Non-person search results therefore open in Evidence & Provenance instead,
  and the UI says so rather than hiding it.
- **Traversal stops at 2 hops** and **300 nodes** — backend caps. The 2-hop view of a
  hub person *is* truncated, and the toolbar shows a warning badge saying so instead of
  presenting a subset as the whole picture.
- **Graph impact is per-FIR**, not corpus-wide, because that is the shape the backend
  exposes.
- **No `TRANSACTION` node type exists.** Money movement is a `TRANSACTED` *edge* between
  two persons; there is no transaction entity to click.
- **The audit ledger is a verdict, not a dashboard.** The backend keeps a
  tamper-evident audit ledger — a local hash chain, **not** a blockchain. The UI surfaces
  exactly one compact read-out on Evidence & Provenance: `VERIFIED` /
  `INTEGRITY COMPROMISED`, a truncated head hash, one `[Verify]`. No block explorer, no
  chain browsing.
- **The corpus is synthetic, and the deployment is a prototype deployment.** The API base
  URL is configurable and the app is CORS-compatible, but there is no auth layer, no
  multi-tenancy and no rate limiting in front of it. Nothing here is cleared for real
  case data.
