/**
 * `cytoscape-fcose` ships no TypeScript declarations, so we declare the one
 * thing we use: the extension registration function.
 *
 * fCoSE (fast Compound Spring Embedder) is used because a force-directed layout
 * is the honest way to draw an investigation network — cluster structure that
 * exists in the data becomes visible, and nothing is implied by an arbitrary
 * arrangement. Options are documented at the package's README; the subset the
 * app passes is typed loosely on purpose since Cytoscape validates them.
 */
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const fcose: Ext;
  export default fcose;
}

/** Vite resolves a CSS import to a side-effect module; it has no runtime value. */
declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_API_PROXY_TARGET?: string;
  readonly VITE_LIVE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
