# TRACEX
### Trace Every Connection

**AI-Powered Criminal Network Analysis System**
Smart India Hackathon 2026 · Problem Statement ID **26189**
Ministry of Home Affairs · National Crime Records Bureau (NCRB), Women Safety Division
Theme: Blockchain & Cybersecurity · Category: Software
Team **LAZER**

---

## Overview

TRACEX is an AI-powered investigation platform that unifies fragmented crime-related
data — FIRs, call detail records (CDRs), financial transactions, and location
records — into a single explainable knowledge graph. It automatically extracts
entities from FIR narratives, resolves them against structured records, detects
suspicious patterns and key influencers, and gives investigators an evidence-first,
auditable view of a criminal network — without ever making a guilt determination.

Every relationship, score, and pattern shown by the system traces back to a real
source record. Nothing is a black-box output.

> Built and tested entirely on a **synthetic** dataset. No real FIR, CDR, financial,
> or personal data is used anywhere in this project.

---

## Core Capabilities

- **Multi-source data ingestion** — structured CSVs (persons, calls, transactions,
  locations) and FIR narrative text
- **Rule-based NLP extraction** — entities (people, phones, Aadhaar, locations,
  dates) pulled from FIR text with confidence tiers, no external LLM/API dependency
- **Explainable knowledge graph** — typed nodes and edges (Person, Phone, Aadhaar,
  Location, FIR, Cell Tower), every edge carrying its source dataset, source record
  ID, and confidence
- **Network analytics** — degree/betweenness/PageRank centrality, community
  detection, shortest-path search, all evidence-backed
- **Investigation Intelligence Engine** — multi-channel relationship detection,
  communication anomalies, transaction pattern detection, bridge-entity
  identification, and a transparent, explainable priority score (never framed as
  guilt or criminality)
- **Live ingestion** — submit new FIRs/calls/transactions/locations at runtime;
  every record passes validation → entity resolution → deduplication → graph
  update → intelligence recalculation before being accepted
- **Bulk CSV upload with preview-before-commit** — upload a CSV, see exactly what
  would change (new entities, relationships, suspicious patterns, network impact)
  in a temporary read-only overlay, then explicitly **Add to System** or **Reject**
  — nothing is committed silently, and duplicates are detected automatically
- **Tamper-evident audit ledger** — a local SHA-256 hash chain records every
  significant action (ingestion decisions, new relationships, priority-band
  changes); any modification to an audited record is detectable and reported as
  `INTEGRITY_COMPROMISED`
- **Real-time updates** — Server-Sent Events push graph/intelligence changes to
  the dashboard without a page reload
- **Investigation dashboard** — Command Center, Network graph, Communication,
  Financial, Locations, FIR Intelligence, Timeline, Evidence, and Alerts views,
  all backed by real data with honest empty states (never fabricated results)

---

## Why This Approach

- **Evidence over inference** — every flagged pattern, score, or relationship
  links back to the exact call/transaction/FIR record that produced it
- **Honest by design** — if a pattern category finds nothing in the data, the
  system says so; thresholds are never lowered to manufacture a result
- **Local and offline** — the entire pipeline (NLP, graph, intelligence, audit)
  runs without any external API key, keeping sensitive investigative data on
  infrastructure the investigating agency controls
- **Detection, not black-box prevention** — the audit ledger makes tampering
  *detectable*; it does not claim to be an immutable public blockchain, and the
  documentation says so explicitly

---

## Architecture

```
Data Sources (CSV + Live API)
        │
        ▼
Entity Extraction & Resolution (rule-based NLP)
        │
        ▼
Knowledge Graph Construction (typed nodes/edges, full evidence trail)
        │
        ▼
Network Analytics (centrality, community detection)
        │
        ▼
Investigation Intelligence (patterns, anomalies, explainable priority scoring)
        │
        ▼
Tamper-Evident Audit Ledger (hash-chain, append-only)
        │
        ▼
Live Updates (SSE) ──► Investigator Dashboard
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI |
| Graph engine | NetworkX (abstracted behind a `GraphStore` interface — Neo4j-ready) |
| NLP | Rule-based extraction (regex + entity resolution), no external LLM/API |
| Real-time | Server-Sent Events (SSE) |
| Audit | Local SHA-256 hash-chain ledger |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Graph visualization | Cytoscape.js |
| Data store | In-memory / SQLite-ready writable store (original dataset remains read-only) |

---

## Project Structure

```
.
├── backend/
│   └── app/
│       ├── api/            # versioned REST endpoints (/api/v1)
│       ├── graph/          # GraphStore, builder, analytics
│       ├── nlp/            # FIR narrative extraction, resolution
│       ├── risk/           # intelligence engine, pattern detection, scoring
│       ├── ingest/         # live + bulk CSV ingestion pipeline
│       ├── audit/          # hash-chain audit ledger
│       ├── schemas/        # Pydantic request/response models
│       └── config.py
├── frontend/
│   └── src/
│       ├── pages/          # Command Center, Network, FIR, Evidence, Alerts...
│       ├── components/     # graph view, CSV upload/preview, live indicators
│       └── api/            # typed API client
├── dataset/
│   └── AI-Powered-Criminal-Network-Analysis/synthetic_dataset/
│       ├── persons.csv
│       ├── calls.csv
│       ├── transactions.csv
│       ├── locations.csv
│       ├── fir_text.csv
│       └── generate_synthetic.py
└── docs/
    └── architecture.md     # full as-built architecture, appended per phase
```

The original synthetic dataset is **never modified** by the application — all
live and bulk-uploaded data flows into a separate writable store, verified by
SHA-256 checksum after every operation.

---

## Getting Started

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate        # or source .venv/bin/activate on Linux/macOS
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Backend runs at `http://127.0.0.1:8000`. Interactive API docs at `/docs`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`.

---

## Key API Groups

| Group | Purpose |
|---|---|
| `/api/v1/persons`, `/calls`, `/transactions`, `/locations`, `/firs` | Base dataset access |
| `/api/v1/graph/*` | Network queries, 1-hop/2-hop expansion, path finding |
| `/api/v1/analytics/*` | Centrality, community detection |
| `/api/v1/nlp/*` | FIR entity/relationship extraction results |
| `/api/v1/intelligence/*` | Patterns, priority scores, explanations |
| `/api/v1/ingest/*` | Live single-record ingestion |
| `/api/v1/ingest/bulk/*` | CSV bulk upload — preview, confirm, reject |
| `/api/v1/audit/*` | Audit event log and integrity verification |

Full endpoint-level detail is in `docs/architecture.md`.

---

## Testing

```bash
# Backend
cd backend && pytest

# Frontend
cd frontend && npm run verify   # typecheck + tests + build
```

The backend regression suite covers dataset loading, graph construction, NLP
extraction, intelligence scoring, live/bulk ingestion, and audit-chain integrity.

---

## Known Limitations

- Rule-based NLP is tuned to this dataset's FIR templates; real-world free-form
  narratives would need a statistical NER layer as a fallback
- The audit ledger provides **tamper detection**, not tamper **prevention** —
  it is a local hash chain, not a distributed/permissioned blockchain
- Live-ingested data is held in memory unless persistence is explicitly enabled;
  a restart clears it (by design, for a repeatable demo)
- No production authentication/RBAC system is implemented yet — the design
  supports it, but it is out of scope for this prototype
- Pattern detectors report honestly when a category finds nothing in the
  synthetic corpus rather than lowering thresholds to force a result

---

## Disclaimer

This system is built and demonstrated entirely on **synthetic data**. All
outputs — priority scores, flagged patterns, and detected relationships — are
intended strictly as **investigative leads for human review**, not automated
determinations of guilt or criminality. No individual is ever labeled a
"criminal" or "suspect" by the system.

---

## Team

**Team LAZER** — Smart India Hackathon 2026
Problem Statement 26189 · Ministry of Home Affairs · NCRB, Women Safety Division
