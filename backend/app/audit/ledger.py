"""The ledger abstraction and its local hash-chain implementation (§4, §8, §9, §13).

:class:`AuditLedger` is the seam. Application code appends through it and knows
nothing about how the chain is stored, so replacing
:class:`LocalHashChainLedger` with a permissioned-blockchain implementation later
is a constructor change, not a rewrite. :class:`PermissionedBlockchainLedger`
exists in this file as a declared interface with no implementation — no network,
no Fabric, no dependency, and no claim that one is deployed.

The accurate name for what this file implements is a **Tamper-Evident Audit
Ledger**: an append-only local SHA-256 hash chain. It detects modification of a
recorded event, and it does not pretend to be a distributed consensus system.
:ref:`docs/phase5_audit.md <limitations>` states plainly what that does and does
not protect against.
"""
from __future__ import annotations

import json
import logging
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from app.audit.models import (
    GENESIS_PREVIOUS_HASH,
    AuditAction,
    AuditEvent,
    DEFAULT_ACTOR,
    FailureReason,
    ResourceType,
    VerificationStatus,
    assert_safe_metadata,
    audit_now,
    compute_event_hash,
    make_audit_event_id,
)

logger = logging.getLogger(__name__)


@dataclass
class ChainFailure:
    """The first broken link found, with both sides of the comparison (§8)."""

    audit_event_id: str
    reason: FailureReason
    expected_hash: str
    actual_hash: str
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "audit_event_id": self.audit_event_id,
            "reason": self.reason.value,
            "expected_hash": self.expected_hash,
            "actual_hash": self.actual_hash,
            "message": self.message,
        }


@dataclass
class ChainVerification:
    """The answer to "is the whole chain intact?" (§8)."""

    status: VerificationStatus
    events_checked: int
    genesis_previous_hash: str
    head_hash: str
    failure: Optional[ChainFailure] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "events_checked": self.events_checked,
            "genesis_previous_hash": self.genesis_previous_hash,
            "head_hash": self.head_hash,
            "failure": self.failure.as_dict() if self.failure else None,
        }


class AuditLedger(ABC):
    """Append-only audit ledger.

    The contract an implementation must honour:

    * ``append`` is atomic and single-writer: two concurrent callers produce two
      sequential links, never a fork and never an interleaved write.
    * Nothing is ever updated or deleted. There is no ``update``, no ``delete``
      and no ``truncate`` in this interface, by design.
    * ``verify`` re-derives every hash from stored fields, so it detects
      modification of anything the hash covers.
    """

    backend_name: str = "abstract"
    persisted: bool = False

    @abstractmethod
    def append(
        self,
        action: AuditAction,
        resource_type: ResourceType,
        resource_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
        metadata_hash: Optional[str] = None,
        actor: str = DEFAULT_ACTOR,
    ) -> AuditEvent:
        """Append one event and return it, with its links filled in."""

    @abstractmethod
    def all_events(self) -> list[AuditEvent]:
        """Every event, in chain order."""

    @abstractmethod
    def get(self, audit_event_id: str) -> Optional[AuditEvent]:
        """One event by id, or ``None``."""

    @abstractmethod
    def head(self) -> str:
        """The hash the next event will link to; genesis when empty."""

    @abstractmethod
    def verify(self) -> ChainVerification:
        """Walk the chain and report the first break, if any."""

    def __len__(self) -> int:  # pragma: no cover - trivial
        return len(self.all_events())


class LocalHashChainLedger(AuditLedger):
    """An in-process, append-only SHA-256 hash chain (§4, §9).

    §4 asks for the simplest appropriate synchronization mechanism. That is a
    single :class:`threading.Lock` held across "read the head, compute the hash,
    append, write the line". Any coarser scheme would be pointless and any finer
    one could interleave two appends and fork the chain. FastAPI runs sync
    handlers in a thread pool and the Phase 4.6 pipeline is itself lock-serialized,
    so threads — not processes — are the concurrency that actually exists here.

    Persistence is one append-only JSONL file, written inside the same lock so
    file order is chain order. On load, stored hashes are trusted for *nothing*:
    they are read verbatim so that :meth:`verify` can catch a file someone edited.
    """

    backend_name = "local_hash_chain"

    def __init__(self, path: Optional[Path] = None) -> None:
        self._path = path
        self.persisted = path is not None
        self._lock = threading.Lock()
        self._events: list[AuditEvent] = []
        self._by_id: dict[str, AuditEvent] = {}
        self.loaded = 0

    # ------------------------------------------------------------------
    # append
    # ------------------------------------------------------------------
    def append(
        self,
        action: AuditAction,
        resource_type: ResourceType,
        resource_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
        metadata_hash: Optional[str] = None,
        actor: str = DEFAULT_ACTOR,
    ) -> AuditEvent:
        meta = dict(metadata or {})
        # Validated before the lock is taken: a rejected event must not be able
        # to hold up an append, and it must not enter the chain at all.
        assert_safe_metadata(meta)

        with self._lock:
            sequence = len(self._events) + 1
            event = AuditEvent(
                audit_event_id=make_audit_event_id(sequence),
                timestamp=audit_now(),
                actor=actor,
                action=action,
                resource_type=resource_type,
                resource_id=str(resource_id),
                previous_hash=self._head_unlocked(),
                current_hash="",
                metadata=meta,
                metadata_hash=metadata_hash,
            )
            event.current_hash = compute_event_hash(event.content(), event.previous_hash)
            self._events.append(event)
            self._by_id[event.audit_event_id] = event
            if self._path is not None:
                self._persist(event)
            return event

    def _persist(self, event: AuditEvent) -> None:
        """Append one JSON line. Called with the lock held, so order is chain order."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event.as_dict(), ensure_ascii=False) + "\n")
        except OSError:  # pragma: no cover - defensive
            # The in-memory chain stays valid and the failure is loud, rather
            # than the append being silently rolled back.
            logger.exception("Failed to persist audit event %s", event.audit_event_id)

    # ------------------------------------------------------------------
    # read
    # ------------------------------------------------------------------
    def all_events(self) -> list[AuditEvent]:
        with self._lock:
            return list(self._events)

    def get(self, audit_event_id: str) -> Optional[AuditEvent]:
        with self._lock:
            return self._by_id.get(audit_event_id)

    def head(self) -> str:
        with self._lock:
            return self._head_unlocked()

    def _head_unlocked(self) -> str:
        if not self._events:
            return GENESIS_PREVIOUS_HASH
        return self._events[-1].current_hash

    def __len__(self) -> int:
        with self._lock:
            return len(self._events)

    # ------------------------------------------------------------------
    # verify
    # ------------------------------------------------------------------
    def verify(self) -> ChainVerification:
        """Re-derive every hash and every link (§8).

        Three independent checks per event: the id is at the position it claims,
        ``previous_hash`` equals the predecessor's ``current_hash`` (genesis for
        the first), and ``current_hash`` equals a fresh hash of the stored
        content. The first failure is reported and the walk stops — the earliest
        break is the one that matters.
        """
        events = self.all_events()
        expected_previous = GENESIS_PREVIOUS_HASH
        for index, event in enumerate(events, start=1):
            expected_id = make_audit_event_id(index)
            if event.audit_event_id != expected_id:
                return ChainVerification(
                    status=VerificationStatus.INTEGRITY_COMPROMISED,
                    events_checked=index,
                    genesis_previous_hash=GENESIS_PREVIOUS_HASH,
                    head_hash=self.head(),
                    failure=ChainFailure(
                        audit_event_id=event.audit_event_id,
                        reason=FailureReason.SEQUENCE_MISMATCH,
                        expected_hash=expected_id,
                        actual_hash=event.audit_event_id,
                        message=(
                            f"Event at chain position {index} is identified as "
                            f"'{event.audit_event_id}': an event was inserted, "
                            "removed or reordered."
                        ),
                    ),
                )
            if event.previous_hash != expected_previous:
                return ChainVerification(
                    status=VerificationStatus.INTEGRITY_COMPROMISED,
                    events_checked=index,
                    genesis_previous_hash=GENESIS_PREVIOUS_HASH,
                    head_hash=self.head(),
                    failure=ChainFailure(
                        audit_event_id=event.audit_event_id,
                        reason=FailureReason.BROKEN_LINK,
                        expected_hash=expected_previous,
                        actual_hash=event.previous_hash,
                        message=(
                            "previous_hash does not match the preceding event's "
                            "current_hash: the chain is broken at this event."
                        ),
                    ),
                )
            recomputed = event.recompute_hash()
            if recomputed != event.current_hash:
                return ChainVerification(
                    status=VerificationStatus.INTEGRITY_COMPROMISED,
                    events_checked=index,
                    genesis_previous_hash=GENESIS_PREVIOUS_HASH,
                    head_hash=self.head(),
                    failure=ChainFailure(
                        audit_event_id=event.audit_event_id,
                        reason=FailureReason.HASH_MISMATCH,
                        expected_hash=recomputed,
                        actual_hash=event.current_hash,
                        message=(
                            "Recomputing the hash of this event's stored fields "
                            "does not reproduce its current_hash: the event was "
                            "modified after it was recorded."
                        ),
                    ),
                )
            expected_previous = event.current_hash

        return ChainVerification(
            status=VerificationStatus.VERIFIED,
            events_checked=len(events),
            genesis_previous_hash=GENESIS_PREVIOUS_HASH,
            head_hash=expected_previous,
        )

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------
    def load(self) -> int:
        """Replay a persisted ledger (§9).

        Events are restored exactly as written, including their hashes, so a
        chain that survives a restart verifies for the right reason. A file that
        was edited while the process was down loads anyway and then fails
        ``verify`` — reporting the compromise is the product, so refusing to
        start would hide it.
        """
        if self._path is None or not self._path.exists():
            return 0
        restored: list[AuditEvent] = []
        with self._path.open("r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    restored.append(AuditEvent.from_dict(json.loads(line)))
                except (json.JSONDecodeError, KeyError, ValueError):
                    logger.error(
                        "Unreadable audit ledger line %d in %s; the chain will "
                        "not verify past this point",
                        line_no,
                        self._path,
                    )
                    break
        with self._lock:
            self._events = restored
            self._by_id = {e.audit_event_id: e for e in restored}
        self.loaded = len(restored)
        logger.info("Loaded %d persisted audit event(s)", self.loaded)
        return self.loaded


class PermissionedBlockchainLedger(AuditLedger):  # pragma: no cover - interface only
    """Declared, not implemented (§13).

    This is the extension point a permissioned deployment would fill in: the same
    four methods, backed by a chaincode/smart-contract transaction instead of a
    local file. Nothing here is installed, configured, connected or claimed —
    every method raises. It exists so the seam is visible in code rather than
    promised in a document.
    """

    backend_name = "permissioned_blockchain"

    def __init__(self, *_: Any, **__: Any) -> None:
        raise NotImplementedError(
            "No permissioned blockchain network is configured. Phase 5 ships a "
            "local tamper-evident audit ledger (LocalHashChainLedger); this "
            "class marks where a permissioned implementation would attach."
        )

    def append(self, *_: Any, **__: Any) -> AuditEvent:
        raise NotImplementedError

    def all_events(self) -> list[AuditEvent]:
        raise NotImplementedError

    def get(self, audit_event_id: str) -> Optional[AuditEvent]:
        raise NotImplementedError

    def head(self) -> str:
        raise NotImplementedError

    def verify(self) -> ChainVerification:
        raise NotImplementedError
