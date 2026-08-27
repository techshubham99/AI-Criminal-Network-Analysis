/**
 * Architecture tests — the Phase 3.5 constraints, enforced mechanically.
 *
 * Several of this project's rules are the kind that a reviewer can only check by
 * reading every file: "no mock data when a real endpoint exists", "only consume
 * verified endpoints", "one fetch site", "no Phase 4 risk scoring", "never
 * request the ground-truth overlay". Prose in a README does not enforce any of
 * them. These tests read the actual source tree and do.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as endpoints from '@/api/endpoints';

const SRC = join(process.cwd(), 'src');

interface SourceFile {
  /** Posix-style path relative to `src/`, e.g. `components/graph/NetworkGraph.tsx`. */
  path: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const ALL: SourceFile[] = walk(SRC)
  .filter((full) => /\.(ts|tsx|css)$/.test(full))
  .map((full) => ({
    path: relative(SRC, full).split(sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));

const isTest = (file: SourceFile) =>
  file.path.startsWith('test/') || /\.test\.tsx?$/.test(file.path);

/** Application code only — the tests themselves are allowed to stub and record. */
const APP = ALL.filter((file) => !isTest(file));
const CODE = APP.filter((file) => file.path.endsWith('.ts') || file.path.endsWith('.tsx'));

/** Strips line and block comments so prose cannot trip a code-level assertion. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the source tree was actually found', () => {
  it('walked a plausible number of files', () => {
    expect(ALL.length).toBeGreaterThan(20);
    expect(APP.length).toBeGreaterThan(15);
    expect(APP.some((f) => f.path === 'api/client.ts')).toBe(true);
  });
});

describe('there is exactly one fetch site', () => {
  it('only src/api/client.ts calls fetch', () => {
    const offenders = CODE.filter((file) => /\bfetch\s*\(/.test(file.text)).map((f) => f.path);
    expect(offenders).toEqual(['api/client.ts']);
  });

  it('no other transport is used anywhere', () => {
    for (const file of CODE) {
      expect(file.text, file.path).not.toMatch(/\bXMLHttpRequest\b/);
      expect(file.text, file.path).not.toMatch(/\bEventSource\b/);
      expect(file.text, file.path).not.toMatch(/\bnew WebSocket\b/);
      expect(file.text, file.path).not.toMatch(/\baxios\b/);
    }
  });

  it('the client issues GET and nothing else', () => {
    const client = APP.find((f) => f.path === 'api/client.ts')!;
    const methods = [...client.text.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods).toEqual(['GET']);
  });
});

describe('no mock data in application code', () => {
  it('nothing outside the test tree imports a fixture', () => {
    const offenders = CODE.filter(
      (file) => /from\s+['"][^'"]*fixtures\//.test(file.text) || /@\/test\b/.test(file.text),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no module fabricates data with a random or seeded generator', () => {
    for (const file of CODE) {
      expect(stripComments(file.text), file.path).not.toMatch(/Math\.random\s*\(/);
      expect(stripComments(file.text), file.path).not.toMatch(/\bfaker\b/);
    }
  });
});

describe('only verified endpoints are consumed', () => {
  it('every api.* call resolves to an exported binding', () => {
    const called = new Set<string>();
    for (const file of CODE) {
      for (const match of file.text.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)) {
        called.add(match[1]);
      }
    }
    // If the app calls nothing, this test is not doing its job.
    expect(called.size).toBeGreaterThan(0);
    const unknown = [...called].filter((name) => !(name in endpoints));
    expect(unknown).toEqual([]);
  });

  it('no component builds an /api/ URL of its own', () => {
    const offenders = CODE.filter(
      (file) => file.path !== 'api/client.ts' && /['"`]\/api\/v1\//.test(stripComments(file.text)),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('there is no binding for an endpoint the backend does not expose', () => {
    // Endpoints deliberately absent in Phase 3.5. If one of these ever appears,
    // it is either invented or Phase 4 arriving early.
    const forbidden = ['risk', 'score', 'audit', 'ledger', 'blockchain', 'vehicles', 'events'];
    for (const name of Object.keys(endpoints)) {
      for (const word of forbidden) {
        expect(name.toLowerCase(), name).not.toContain(word);
      }
    }
  });
});

describe('the ground-truth overlay is never requested', () => {
  it('include_overlay is never set true in application code', () => {
    for (const file of CODE) {
      expect(stripComments(file.text), file.path).not.toMatch(/include_overlay\s*[:=]\s*true/);
      expect(stripComments(file.text), file.path).not.toMatch(/include_overlay=true/);
    }
  });
});

describe('Phase 4 has not begun', () => {
  it('no risk-score or threat-score field exists', () => {
    // The prose "not a risk score" is allowed and expected; an identifier is not.
    for (const file of CODE) {
      const code = stripComments(file.text);
      expect(code, file.path).not.toMatch(/risk_score|riskScore|threat_score|threatScore/);
      expect(code, file.path).not.toMatch(/riskLevel|risk_level|threatLevel|threat_level/);
    }
  });

  it('no audit ledger or chain-of-custody hashing is wired up', () => {
    for (const file of CODE) {
      const code = stripComments(file.text);
      expect(code, file.path).not.toMatch(/\bBlockchain\b|\bledgerEntry\b|\bmerkle/i);
      expect(code, file.path).not.toMatch(/crypto\.subtle|createHash\s*\(/);
    }
  });
});

describe('Tailwind class names are never assembled at runtime', () => {
  it('no utility prefix is followed by an interpolation', () => {
    // Tailwind v4 scans source TEXT, so `bg-${colour}` produces no CSS at all —
    // the element silently renders unstyled. Full class strings only.
    const pattern =
      /(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|divide|accent|caret|placeholder)-\$\{/;
    const offenders = CODE.filter((file) => pattern.test(stripComments(file.text))).map(
      (f) => f.path,
    );
    expect(offenders).toEqual([]);
  });

  it('no utility prefix is concatenated with a variable', () => {
    const pattern = /['"](?:bg|text|border|ring|fill|stroke)-['"]\s*\+/;
    const offenders = CODE.filter((file) => pattern.test(stripComments(file.text))).map(
      (f) => f.path,
    );
    expect(offenders).toEqual([]);
  });
});

describe('everything stays local', () => {
  it('no external host appears in application code', () => {
    // Allowed: the SVG/XHTML namespace URIs, and localhost/127.0.0.1 which only
    // ever appear in comments describing the dev proxy.
    const allowed = /^https?:\/\/(?:www\.w3\.org|localhost|127\.0\.0\.1)/;
    for (const file of CODE) {
      const urls = [...stripComments(file.text).matchAll(/https?:\/\/[^\s'"`)]+/g)].map(
        (m) => m[0],
      );
      const external = urls.filter((url) => !allowed.test(url));
      expect(external, file.path).toEqual([]);
    }
  });

  it('no API key or token is read from the environment', () => {
    for (const file of CODE) {
      const code = stripComments(file.text);
      expect(code, file.path).not.toMatch(/API_KEY|ACCESS_TOKEN|SECRET|Bearer\s/i);
    }
  });
});

describe('routes only exist where a backend does', () => {
  it('App.tsx declares exactly the four supported screens plus a fallback', () => {
    const app = APP.find((f) => f.path === 'App.tsx')!;
    const paths = [...app.text.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(paths)).toEqual(
      new Set([
        '/',
        '/network',
        '/network/:personId',
        '/fir',
        '/fir/:firId',
        '/evidence',
        // A redirect alias, not a fifth screen.
        '/firs',
        '*',
      ]),
    );
  });

  it('the only extra path is a redirect, not a screen with no backend', () => {
    const app = APP.find((f) => f.path === 'App.tsx')!;
    expect(app.text).toMatch(/path="\/firs"\s+element=\{<Navigate to="\/fir"/);
  });

  it('route parameters are the numeric ids the backend path segments parse', () => {
    const app = APP.find((f) => f.path === 'App.tsx')!;
    // `:entityId` would mean a prefixed `person:445` in a path — HTTP 422.
    expect(app.text).not.toMatch(/path="\/network\/:entityId"/);
    expect(app.text).toContain(':personId');
    expect(app.text).toContain(':firId');
  });
});
