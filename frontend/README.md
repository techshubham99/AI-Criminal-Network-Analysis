# Cyber Investigation Command Center — Phase 3.5 frontend

A thin but complete investigator frontend over the Phase 1–3 FastAPI backend of the
**AI-Powered Criminal Network Analysis System** (SIH 2026, Problem Statement 26189).

Its purpose is narrow and deliberate: prove that the graph engine, the narrative NLP
layer and the provenance chain are all reachable and legible from a real UI, using
**only** data the backend actually returns. There is no mock data anywhere in the
application code, no hardcoded statistic, and no screen that is not backed by a
verified endpoint.

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

Copy `.env.example` to `.env.local` only if your backend is not on
`http://127.0.0.1:8000`.

- `VITE_API_PROXY_TARGET` — where the dev/preview proxy forwards. **The only place the
  backend address is configured.**
- `VITE_API_BASE_URL` — leave **unset** for development. Unset means the API layer
  issues *relative* `/api/v1/...` requests that the proxy forwards, so the browser is
  always same-origin and **no CORS configuration is needed on the backend**. Set it to
  an absolute base only when serving `dist/` from somewhere with no proxy in front.
- `VITE_LIVE_API_URL` / `CNA_LIVE_API_URL` — base URL for `npm run test:live`.

There are **no API keys, no external services and no third-party endpoints** in this
application. It runs fully offline.

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

**Every request is a `GET`.** The client has no POST/PUT/PATCH/DELETE path at all — the
backend is read-only and the frontend is physically unable to mutate it.

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

## 3. What the four screens are

| Route | Screen | Backed by |
|---|---|---|
| `/` | **Command Center** | `data/summary`, `graph/summary`, `nlp/summary`, `analytics/demo`, `analytics/persons/top`, `analytics/communities` |
| `/network`, `/network/:personId` | **Network Investigation** — the Cytoscape graph, 1-hop / 2-hop, relationship filters, node & edge panels | `graph/search`, `graph/persons/{id}`, `graph/persons/{id}/network`, `analytics/persons/{id}`, `graph/relationships/{id}` |
| `/fir`, `/fir/:firId` | **FIR Intelligence** — narrative with in-place extraction spans, entities, relationships, graph impact | `firs`, `firs/{id}`, `nlp/firs/{id}/…`, `nlp/search` |
| `/evidence` | **Evidence & Provenance** — connection evidence chains and narrative search | `graph/path`, `graph/relationships/{id}`, `nlp/search` |

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

**`npm test` — component suite against recorded fixtures.** The 25 JSON files in
`src/test/fixtures/` are **recordings**: each is the verbatim body the real backend
returned for the URL named in its key. Tests install a `fetch` that routes by URL shape
to the matching recording, so a component exercises its real request path — query
params included — against real response bytes. Nothing about backend behaviour is
invented. The fetch spy also records which URLs were requested, which is how the
"consume only verified endpoints" rule is actually enforced rather than asserted.

**`npm run test:live` — contract suite against a running backend.** 22 tests over real
HTTP that check every bound endpoint still exists and still returns the fields the UI
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
  api/          client.ts (the ONLY fetch site) · endpoints.ts (one fn per verified endpoint)
  components/
    ui/         the shared vocabulary: Panel Badge Button ProvenanceTag ConfidenceMeter
                StatTile KeyValueList Skeleton ErrorState EmptyState Tooltip …
    graph/      graphStyle · NetworkGraph · GraphToolbar · GraphLegend
                NodeDetailsPanel · EdgeEvidencePanel
    search/     GlobalSearch · SearchResultList
    nlp/        NarrativeViewer · EntityTable · RelationshipList · GraphImpactPanel
  hooks/        useAsync · useDebouncedValue · useInvestigation
  layouts/      AppShell · TopBar · Sidebar
  pages/        CommandCenter · NetworkInvestigation · FirIntelligence · EvidencePage
  styles/       index.css — the @theme design tokens, the only colours in use
  test/         fixtures/ (recorded responses) · helpers.tsx · setup.ts · live/contract.test.ts
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
- **The audit ledger is a verdict, not a dashboard.** Phase 5 shipped a tamper-evident
  audit ledger (a local hash chain — not a blockchain), and the UI surfaces exactly one
  compact read-out on Evidence & Provenance: `VERIFIED` / `INTEGRITY COMPROMISED`, a
  truncated head hash, one `[Verify]`. No block explorer, and no chain browsing.
