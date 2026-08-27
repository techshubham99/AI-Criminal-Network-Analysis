# Optional Enrichment (separate files — originals untouched)

This directory is reserved for the **optional demo enrichment pack** described in
`docs/architecture.md` §P (item 2).

The provided synthetic dataset contains **no vehicles, organizations, or weapons**
(measured: 0 license-plate patterns, 0 org keywords in FIR text). To demonstrate
vehicle/organization extraction convincingly in later phases, enrichment data will
be placed **here, in new files** — the original CSVs under
`dataset/.../synthetic dataset/` are never modified, moved, or regenerated.

Nothing in this directory is loaded in Phase 1. It is empty by design.
