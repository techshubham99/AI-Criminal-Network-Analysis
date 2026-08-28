/**
 * The live channel — the ONLY module that opens an `EventSource`.
 *
 * Server-Sent Events, not a WebSocket: the traffic is one-directional (the
 * backend says "something changed"), it needs no protocol upgrade, and the
 * browser reconnects on its own.
 *
 * Two things this module deliberately does NOT do:
 *
 *   - It does not read event payloads for display. Frames carry ids, counts and
 *     statuses so the UI knows *what to refetch*; the record content comes from
 *     the REST endpoints. Consumers get the event type and refetch.
 *   - It does not open a connection per component. One stream is shared by every
 *     subscriber and closed again when the last one leaves, so mounting the LIVE
 *     indicator and the ingestion panel together costs one connection, not two.
 *
 * `EventSource` is absent in jsdom. Rather than throw, `connect()` reports
 * `offline` — a test that does not stub the transport sees an honest "no live
 * connection", never a crash.
 */
import { apiPath } from './client';
import { LIVE_EVENT_TYPES, type LiveEvent } from '@/types/api';

/** `GET /api/v1/ingest/stream` — the SSE endpoint. */
export const LIVE_STREAM_PATH = 'ingest/stream';

/** The URL the stream is opened on. Exported for display, not for fetching. */
export function liveStreamUrl(): string {
  return apiPath(LIVE_STREAM_PATH);
}

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface LiveSubscriber {
  /** Called once per frame, in arrival order. */
  onEvent?: (event: LiveEvent) => void;
  /** Called on every transition, and immediately with the current status. */
  onStatus?: (status: LiveStatus) => void;
}

type EventListener = (event: LiveEvent) => void;
type StatusListener = (status: LiveStatus) => void;

const eventListeners = new Set<EventListener>();
const statusListeners = new Set<StatusListener>();

let source: EventSource | null = null;
let status: LiveStatus = 'offline';

/** `EventSource.CLOSED`, as a literal: a stubbed transport may omit the statics. */
const CLOSED = 2;

function setStatus(next: LiveStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of [...statusListeners]) listener(next);
}

function emit(raw: unknown): void {
  if (typeof raw !== 'string' || raw.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // a frame we cannot read is dropped, not guessed at
  }
  if (!parsed || typeof parsed !== 'object') return;
  const event = parsed as LiveEvent;
  if (typeof event.event_type !== 'string') return;
  setStatus('live');
  for (const listener of [...eventListeners]) listener(event);
}

function open(): void {
  if (source) return;
  if (typeof EventSource === 'undefined') {
    setStatus('offline');
    return;
  }

  setStatus('connecting');
  const stream = new EventSource(liveStreamUrl());
  source = stream;

  stream.onopen = () => setStatus('live');
  stream.onerror = () => {
    // readyState CONNECTING means the browser is retrying by itself; CLOSED
    // means it gave up. Only the latter is "offline".
    setStatus(stream.readyState === CLOSED ? 'offline' : 'connecting');
  };
  // The backend names every frame (`event: relationship_added`), so `onmessage`
  // — which only sees unnamed frames — is not enough on its own.
  const handler = (message: Event) => emit((message as MessageEvent).data);
  for (const type of LIVE_EVENT_TYPES) stream.addEventListener(type, handler);
  stream.onmessage = handler;
}

function close(): void {
  if (!source) return;
  source.close();
  source = null;
  setStatus('offline');
}

/**
 * Attach to the live stream. Returns the detach function.
 *
 * The connection is opened on the first subscriber and closed after the last
 * one detaches.
 */
export function subscribeLive(subscriber: LiveSubscriber): () => void {
  const { onEvent, onStatus } = subscriber;
  if (onEvent) eventListeners.add(onEvent);
  if (onStatus) statusListeners.add(onStatus);
  open();
  // Report the current state straight away: a second subscriber joining an
  // already-open stream would otherwise wait for the next transition.
  if (onStatus) onStatus(status);

  return () => {
    if (onEvent) eventListeners.delete(onEvent);
    if (onStatus) statusListeners.delete(onStatus);
    if (eventListeners.size === 0 && statusListeners.size === 0) close();
  };
}

/** The current connection state, for a consumer that cannot wait for a callback. */
export function liveStatus(): LiveStatus {
  return status;
}
