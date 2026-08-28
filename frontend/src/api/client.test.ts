/**
 * The API base URL — §9: environment-configurable, never compiled in.
 *
 * `API_BASE_URL` and `HEALTH_URL` are module-level constants, so each case here
 * stubs the variable, resets the module registry and re-imports the client. That
 * is the only way to observe what a differently-configured deployment would
 * actually build, rather than what this test process happened to start with.
 *
 * Unset, the base is a same-origin relative path the dev proxy forwards — which
 * is what keeps `localhost` out of the shipped bundle entirely.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Client = typeof import('./client');

const DEPLOYED = 'https://tracex-api.example.test/api/v1';

/** Re-imports the client with `VITE_API_BASE_URL` set to `base`. */
async function loadClient(base: string): Promise<Client> {
  vi.stubEnv('VITE_API_BASE_URL', base);
  vi.resetModules();
  return import('./client');
}

/** Records every URL the client requests, answering each with an empty object. */
function recordFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the API base URL is configured, not compiled in', () => {
  it('falls back to a same-origin relative path when nothing is configured', async () => {
    const client = await loadClient('');

    expect(client.API_BASE_URL).toBe('/api/v1');
    expect(client.apiPath('graph/summary')).toBe('/api/v1/graph/summary');
    // `/health` sits outside the versioned prefix.
    expect(client.HEALTH_URL).toBe('/health');
  });

  it('addresses a deployed backend when one is configured', async () => {
    const client = await loadClient(DEPLOYED);

    expect(client.API_BASE_URL).toBe(DEPLOYED);
    expect(client.apiPath('persons/445')).toBe(`${DEPLOYED}/persons/445`);
    expect(client.buildUrl(client.apiPath('persons'), { page: 2, page_size: 25 })).toBe(
      `${DEPLOYED}/persons?page=2&page_size=25`,
    );
    expect(client.HEALTH_URL).toBe('https://tracex-api.example.test/health');
  });

  it('tolerates a trailing slash on the configured value', async () => {
    const client = await loadClient(`${DEPLOYED}/`);

    expect(client.API_BASE_URL).toBe(DEPLOYED);
    expect(client.apiPath('/graph/summary')).toBe(`${DEPLOYED}/graph/summary`);
  });

  it('sends requests to the configured host', async () => {
    const client = await loadClient(DEPLOYED);
    const seen = recordFetch();

    await client.request('graph/summary');

    expect(seen).toEqual([`${DEPLOYED}/graph/summary`]);
  });

  it('sends requests to the same origin when nothing is configured', async () => {
    const client = await loadClient('');
    const seen = recordFetch();

    await client.request('calls', { params: { page: 1, page_size: 25 } });

    expect(seen).toEqual(['/api/v1/calls?page=1&page_size=25']);
  });
});
