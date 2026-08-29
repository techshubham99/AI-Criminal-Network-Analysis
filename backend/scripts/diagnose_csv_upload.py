"""Explain, per file, why a CSV upload was rejected.

A count of rejected rows says nothing about the cause. This prints the cause: the
header the file actually carries, which of its columns the importer recognises,
which person references the source type requires and cannot find, and the first
real validation failure of the first rejected row — the same reason string the
import UI shows.

    python -m scripts.diagnose_csv_upload
    python -m scripts.diagnose_csv_upload --file CALL=path/to/calls.csv --rows 5

With no ``--file``, it diagnoses a short slice of each synthetic dataset file
exactly as exported — same header, same row text — which is what an investigator
uploading "the data we already have" would select. The dataset is only read.
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import get_settings
from app.core.errors import BadRequestError
from app.ingest import bulk
from app.ingest.models import IngestStatus, Provenance, SourceType
from app.main import create_app

REPO = Path(__file__).resolve().parents[2]
DATASET = (
    REPO
    / "dataset"
    / "AI-Powered-Criminal-Network-Analysis-System-main"
    / "AI-Powered-Criminal-Network-Analysis-System-main"
    / "synthetic dataset"
)
DEFAULTS = {
    SourceType.CALL: DATASET / "calls.csv",
    SourceType.TRANSACTION: DATASET / "transactions.csv",
    SourceType.FIR: DATASET / "fir_text.csv",
    SourceType.LOCATION: DATASET / "locations.csv",
}


def slice_csv(path: Path, rows: int) -> str:
    """The header plus the first ``rows`` data rows, re-emitted verbatim."""
    text = path.read_text(encoding="utf-8")
    reader = csv.reader(io.StringIO(text))
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    for index, row in enumerate(reader):
        if index > rows:
            break
        writer.writerow(row)
    return out.getvalue()


def diagnose(pipeline, source_type: SourceType, filename: str, content: str) -> None:
    print(f"\n=== {source_type.value}  {filename} ===")
    header = next(csv.reader(io.StringIO(content)), [])
    print(f"header in file : {header}")

    known = set(bulk.columns_for(source_type))
    present = [name for name in header if name.strip().lower() in known]
    unknown = [name for name in header if name.strip().lower() not in known]
    print(f"recognised     : {present}")
    print(f"not recognised : {unknown}")

    try:
        rows = bulk.parse_csv(source_type, content)
    except BadRequestError as exc:
        print(f"FILE REJECTED  : {exc.message}")
        print(f"                 detail={exc.detail}")
        return

    provenance = Provenance(
        source_type="CSV_UPLOAD", source_name="diagnostic", submitted_by="diagnostic"
    )
    counts = {"NEW_VALID": 0, "DUPLICATE": 0, "REVIEW_REQUIRED": 0, "REJECTED": 0}
    first_reason: str | None = None
    first_payload: dict | None = None
    for number, _raw, payload in rows:
        record = pipeline.classify(source_type, payload, provenance)
        verdict = bulk._VERDICTS[record.status]
        counts[verdict] += 1
        if record.status is IngestStatus.REJECTED and first_reason is None:
            first_reason = f"row {number}: {record.reason} [{record.reject_reason}]"
            first_payload = payload
    print(f"verdicts       : {counts}")
    if first_reason is None:
        print("no rejected row")
        return
    print(f"FIRST REJECTION: {first_reason}")
    print(f"payload built  : {first_payload}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--file",
        action="append",
        default=[],
        metavar="TYPE=PATH",
        help="a file to diagnose, e.g. CALL=uploads/test_calls.csv",
    )
    parser.add_argument("--rows", type=int, default=5)
    args = parser.parse_args()

    selection: list[tuple[SourceType, Path]] = []
    for item in args.file:
        name, _, path = item.partition("=")
        selection.append((SourceType(name.strip().upper()), Path(path)))
    if not selection:
        selection = list(DEFAULTS.items())

    app = create_app()
    settings = get_settings()
    with TestClient(app):
        pipeline = app.state.ingest
        if pipeline is None:
            print("live ingestion unavailable; cannot diagnose")
            return 1
        print(f"row cap        : {bulk.MAX_ROWS}   min narrative: "
              f"{settings.ingest_min_narrative_chars}")

        for source_type, path in selection:
            if not path.exists():
                print(f"\n=== {source_type.value} === missing file: {path}")
                continue
            diagnose(pipeline, source_type, path.name, slice_csv(path, args.rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
