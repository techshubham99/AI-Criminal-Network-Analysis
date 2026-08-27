import '@testing-library/jest-dom/vitest';
import { afterEach, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Test environment setup.
 *
 * Policy note: this project does NOT mock backend behaviour. Component tests are
 * served from `src/test/fixtures/`, which holds responses recorded verbatim from
 * the running FastAPI backend (see fixtures/README). `fetch` is stubbed only as
 * the transport; every byte it returns came off the real API.
 *
 * The contract suite in `src/test/live/` talks to the live backend directly and
 * self-skips when it is not running.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom has no ResizeObserver; Cytoscape's container sizing path touches it.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}

// jsdom does not implement layout, so every element reports a 0x0 box. Cytoscape
// refuses to lay out a zero-size container, so give it a deterministic viewport.
if (typeof Element !== 'undefined') {
  const rect: DOMRect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 600,
    right: 900,
    width: 900,
    height: 600,
    toJSON: () => ({}),
  };
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return rect;
  };
}

expect.extend({});
