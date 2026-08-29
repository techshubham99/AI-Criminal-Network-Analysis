"""The live channel (spec §12): Server-Sent Events, and nothing else.

SSE is used deliberately in place of a WebSocket: the traffic is one-directional
(the server tells the UI something changed), it survives an ordinary HTTP proxy,
it reconnects on its own, and it needs no protocol upgrade or extra dependency.

Event payloads are **notifications, not data**. They carry ids, counts, statuses
and band changes so the frontend knows *what to refetch*; they never carry
narrative text, phone numbers, Aadhaar numbers, amounts or raw submissions. The
authenticated REST endpoints remain the only way to read record content.

Each subscriber gets a bounded queue. A client that cannot keep up loses frames
(and is told so, via a dropped-frame counter) rather than growing the server's
memory: a stalled browser tab must not become a memory leak.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from app.config import Settings

logger = logging.getLogger(__name__)


class EventType(str, Enum):
    """The event types this channel publishes (spec §12).

    ``BULK_PREVIEW`` is Phase 6.2's progress channel: one frame per real
    checkpoint of a CSV preview, carrying an import id and a stage name. It
    reports work that has already happened, so no frame is ever emitted on a
    timer or ahead of the step it names.
    """

    NEW_INTELLIGENCE = "new_intelligence"
    ENTITY_UPDATED = "entity_updated"
    RELATIONSHIP_ADDED = "relationship_added"
    PATTERN_DETECTED = "pattern_detected"
    PRIORITY_CHANGED = "priority_changed"
    BULK_PREVIEW = "bulk_preview"


@dataclass(frozen=True)
class LiveEvent:
    event_id: int
    event_type: EventType
    at: str
    data: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type.value,
            "at": self.at,
            "data": self.data,
        }


class _Subscriber:
    __slots__ = ("queue", "loop", "dropped")

    def __init__(self, queue: "asyncio.Queue[LiveEvent]", loop: asyncio.AbstractEventLoop):
        self.queue = queue
        self.loop = loop
        self.dropped = 0

    def offer(self, event: LiveEvent) -> None:
        """Hand an event to this subscriber's loop from any thread."""

        def _put() -> None:
            try:
                self.queue.put_nowait(event)
            except asyncio.QueueFull:
                self.dropped += 1

        try:
            self.loop.call_soon_threadsafe(_put)
        except RuntimeError:  # loop already closed: the client is gone
            self.dropped += 1


class EventBus:
    """Fan-out of live events to attached SSE clients.

    ``publish`` is safe to call from a worker thread (ingestion runs off the
    event loop so a full analytics recomputation cannot stall the server), which
    is why delivery is marshalled onto each subscriber's own loop.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._subscribers: list[_Subscriber] = []
        self._recent: deque[LiveEvent] = deque(maxlen=max(1, settings.ingest_event_buffer))
        self._next_id = 1
        self._published = 0

    # -- publish -----------------------------------------------------------
    def publish(self, event_type: EventType, data: dict[str, Any]) -> LiveEvent:
        event = LiveEvent(
            event_id=self._next_id,
            event_type=event_type,
            at=datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            data=data,
        )
        self._next_id += 1
        self._published += 1
        self._recent.append(event)
        for subscriber in list(self._subscribers):
            subscriber.offer(event)
        return event

    # -- subscribe ---------------------------------------------------------
    def subscribe(self) -> "asyncio.Queue[LiveEvent]":
        queue: "asyncio.Queue[LiveEvent]" = asyncio.Queue(
            maxsize=max(1, self.settings.ingest_sse_queue_size)
        )
        self._subscribers.append(_Subscriber(queue, asyncio.get_running_loop()))
        return queue

    def unsubscribe(self, queue: "asyncio.Queue[LiveEvent]") -> None:
        self._subscribers = [s for s in self._subscribers if s.queue is not queue]

    # -- introspection -----------------------------------------------------
    def recent(self, limit: Optional[int] = None) -> list[LiveEvent]:
        events = list(self._recent)
        if limit is not None:
            events = events[-limit:]
        return events

    def stats(self) -> dict[str, Any]:
        return {
            "subscribers": len(self._subscribers),
            "published": self._published,
            "buffered": len(self._recent),
            "dropped_frames": sum(s.dropped for s in self._subscribers),
            "transport": "sse",
        }


def format_sse(event: LiveEvent) -> str:
    """Render one event as an SSE frame."""
    import json

    payload = json.dumps(event.as_dict(), ensure_ascii=False)
    return f"id: {event.event_id}\nevent: {event.event_type.value}\ndata: {payload}\n\n"


def keepalive_frame() -> str:
    """A comment frame: keeps an idle stream (and its proxies) alive."""
    return ": keepalive\n\n"
