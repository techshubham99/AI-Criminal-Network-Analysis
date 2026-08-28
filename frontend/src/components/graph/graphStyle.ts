import type { BaseLayoutOptions, LayoutOptions, StylesheetJsonBlock } from 'cytoscape';

import {
  ENTITY_TYPE_STYLES,
  RELATIONSHIP_STYLES,
  UNKNOWN_ENTITY_STYLE,
  UNKNOWN_RELATIONSHIP_STYLE,
} from '@/utils/entity';

/**
 * Cytoscape presentation layer for the investigation network.
 *
 * Everything visual lives here so `NetworkGraph.tsx` stays a lifecycle wrapper.
 * Two rules shape the design:
 *
 *  1. Colour is never the only channel. Every entity type gets a distinct SHAPE
 *     as well as a distinct hue, so the graph still reads for a colour-blind
 *     viewer and on a washed-out projector.
 *  2. Nothing decorative. No glow, no gradients, no animation — a hairline dark
 *     border separates overlapping nodes, and that is the whole treatment.
 *
 * ---------------------------------------------------------------------------
 * ELEMENT DATA CONTRACT — the selectors below depend on these `data` keys, which
 * `NetworkGraph` populates from the API objects (snake_case, matching the API):
 *
 *   node: { entity_type, label, degree, color }
 *   edge: { relationship_type, weight, dashed, directed, color }
 *
 * `color` is resolved once per element with `entityColor()` /
 * `relationshipStyle().color` so the palette has exactly one source of truth;
 * the per-type selector blocks generated here handle shape (nodes) and arrow
 * colour (edges), and act as the fallback if a `color` were ever missing.
 * ---------------------------------------------------------------------------
 */

/**
 * Canvas chrome, per theme.
 *
 * Cytoscape paints to a canvas, so it cannot read CSS custom properties — the
 * one place in the app that needs literal hex values. Each field mirrors a design
 * token by name so the two themes cannot drift apart: change a token in
 * `styles/index.css` and change its twin here.
 *
 * ENTITY AND RELATIONSHIP COLOURS ARE NOT HERE. Those come from the shared
 * vocabulary in `@/utils/entity` and are identical in both themes, because a
 * PERSON node that changes hue with the theme would break every legend, badge and
 * screenshot that refers to it.
 */
export interface GraphChrome {
  /** `--color-abyss`. Canvas ground, and the label halo. */
  background: string;
  /** A hairline this close to the ground separates two touching nodes. */
  nodeBorder: string;
  /** `--color-ink-2`. Node labels: readable, never maximum contrast. */
  label: string;
  /** `--color-ink`. Used for the label of a selected or focused node. */
  ink: string;
  /** `--color-cyan-400` / `--color-cyan-300` — the only accent the graph uses. */
  accent: string;
  accentBright: string;
  /** `--color-ink`. Hover reads as neutral, never as a semantic state. */
  hoverBorder: string;
}

const CHROME: Record<GraphTheme, GraphChrome> = {
  dark: {
    background: '#0b111c',
    nodeBorder: '#070b12',
    label: '#a7b6c9',
    ink: '#e8eff8',
    accent: '#22d3ee',
    accentBright: '#67e8f9',
    hoverBorder: '#e8eff8',
  },
  light: {
    background: '#f4f7fb',
    nodeBorder: '#ffffff',
    label: '#33506b',
    ink: '#0f2032',
    accent: '#0891b2',
    accentBright: '#0e7490',
    hoverBorder: '#0f2032',
  },
};

/** Narrower than `Theme` from the theme hook on purpose: this module has no React. */
export type GraphTheme = 'dark' | 'light';

export function graphChrome(theme: GraphTheme): GraphChrome {
  return CHROME[theme];
}

/**
 * The app's `--font-sans` stack, flattened for the canvas text renderer.
 *
 * Deliberately unquoted: Cytoscape validates `font-family` against
 * `^([\w- "]+(?:\s*,\s*[\w- "]+)*)$`, so a stack containing single quotes is
 * rejected outright and the label silently falls back to Helvetica. Multi-word
 * family names are legal unquoted in CSS, which is why the library's own default
 * (`Helvetica Neue, Helvetica, sans-serif`) is written the same way.
 */
const SANS = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

/**
 * One shape per entity type. PERSON is the subject of every investigation, so it
 * keeps the plain circle; attribute nodes take angular shapes that stay
 * distinguishable at 16px on a projector.
 */
const NODE_SHAPES: Record<string, 'ellipse' | 'round-rectangle' | 'diamond' | 'triangle' | 'rectangle' | 'hexagon'> =
  {
    PERSON: 'ellipse',
    PHONE: 'round-rectangle',
    AADHAAR: 'diamond',
    LOCATION: 'triangle',
    FIR: 'rectangle',
    CELL_TOWER: 'hexagon',
  };

export function buildGraphStylesheet(theme: GraphTheme = 'dark'): StylesheetJsonBlock[] {
  const {
    background: GRAPH_BACKGROUND,
    nodeBorder: NODE_BORDER,
    label: LABEL_COLOR,
    ink: INK,
    accent: ACCENT,
    accentBright: ACCENT_BRIGHT,
    hoverBorder: HOVER_BORDER,
  } = graphChrome(theme);

  const sheet: StylesheetJsonBlock[] = [
    /* ---------------------------------------------------------------- nodes */
    {
      selector: 'node',
      style: {
        // Palette comes from the shared entity vocabulary via a data mapping,
        // so a badge in a side panel and a node here can never disagree.
        'background-color': 'data(color)',
        'background-opacity': 1,
        'border-width': 1,
        'border-color': NODE_BORDER,
        'border-opacity': 0.85,
        shape: 'ellipse',
        width: 18,
        height: 18,
        label: 'data(label)',
        color: LABEL_COLOR,
        'font-family': SANS,
        'font-size': 9.5,
        'font-weight': 500,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'text-wrap': 'ellipsis',
        'text-max-width': '96px',
        // A 300-node view would otherwise be a wall of text: labels are
        // suppressed until the rendered glyphs are actually legible.
        'min-zoomed-font-size': 9,
        // A halo in the canvas colour keeps a label readable where it crosses
        // an edge, without drawing a filled box behind every node.
        'text-outline-color': GRAPH_BACKGROUND,
        'text-outline-width': 2,
        'text-outline-opacity': 0.9,
        'z-index': 10,
      },
    },
    {
      // Attribute nodes (phone / Aadhaar / location / FIR / tower): sized gently
      // by degree. `mapData` clamps its percentage, so a hub cannot balloon.
      selector: 'node[degree]',
      style: {
        width: 'mapData(degree, 0, 8, 14, 26)',
        height: 'mapData(degree, 0, 8, 14, 26)',
      },
    },
    {
      // Persons are the subject of analysis, so they sit a step larger than the
      // attribute nodes they own. Size is degree — a structural count of
      // observed links — and nothing more; it is not a ranking of a person.
      selector: 'node[entity_type = "PERSON"][degree]',
      style: {
        width: 'mapData(degree, 0, 12, 22, 44)',
        height: 'mapData(degree, 0, 12, 22, 44)',
        'font-size': 10,
      },
    },

    /* ---------------------------------------------------------------- edges */
    {
      selector: 'edge',
      style: {
        // `bezier` (never `haystack`): the backend can return several distinct
        // relationships between the same pair of entities, and the control-point
        // step is what keeps those parallel edges individually selectable.
        'curve-style': 'bezier',
        'control-point-step-size': 26,
        'line-color': 'data(color)',
        'line-cap': 'round',
        width: 1.2,
        opacity: 0.8,
        'target-arrow-shape': 'none',
        'source-arrow-shape': 'none',
        'arrow-scale': 0.7,
        'target-arrow-color': 'data(color)',
        'z-index': 1,
      },
    },
    {
      // Width tracks weight but is clamped hard at both ends: one 40-call edge
      // must not visually erase the single-call edge next to it.
      selector: 'edge[weight]',
      style: {
        width: 'mapData(weight, 1, 10, 1.2, 4)',
      },
    },
    {
      // Only genuinely directed relationships (CALLED, TRANSACTED, ...) get an
      // arrowhead; symmetric ones such as CO_LOCATED must not imply a direction.
      selector: 'edge[?directed]',
      style: {
        'target-arrow-shape': 'triangle',
        'target-arrow-fill': 'filled',
      },
    },
    {
      // Dashed == derived or asserted, not directly observed (CO_LOCATED and the
      // narrative types). The legend states this in words.
      selector: 'edge[?dashed]',
      style: {
        'line-style': 'dashed',
        'line-dash-pattern': [6, 3],
        opacity: 0.7,
      },
    },
    {
      // Self-loops exist in this corpus (a person transacting with themselves via
      // a shared account row), and the default loop is drawn on top of the node.
      selector: 'edge:loop',
      style: {
        'control-point-step-size': 42,
        'loop-direction': '-45deg',
        'loop-sweep': '-32deg',
      },
    },
  ];

  /* Per-entity-type shape. Colour already arrives via data(color); the shape
     mapping has to be declarative because Cytoscape has no shape mapper. */
  for (const entityType of Object.keys(ENTITY_TYPE_STYLES)) {
    const shape = NODE_SHAPES[entityType];
    if (!shape) continue; // types the graph never materialises (DATE, MONEY, ...)
    sheet.push({
      selector: `node[entity_type = "${entityType}"]`,
      style: { shape },
    });
  }

  /* Fallback for an entity type this build has no styling for: grey circle. */
  sheet.push({
    selector: 'node[!color]',
    style: { 'background-color': UNKNOWN_ENTITY_STYLE.color },
  });

  /* Per-relationship-type arrow colour, so an arrowhead never drifts from its
     line colour if a future edge arrives without a resolved `color`. */
  for (const [relationshipType, style] of Object.entries(RELATIONSHIP_STYLES)) {
    sheet.push({
      selector: `edge[relationship_type = "${relationshipType}"]`,
      style: {
        'line-color': style.color,
        'target-arrow-color': style.color,
        'source-arrow-color': style.color,
      },
    });
  }
  sheet.push({
    selector: 'edge[!color]',
    style: {
      'line-color': UNKNOWN_RELATIONSHIP_STYLE.color,
      'target-arrow-color': UNKNOWN_RELATIONSHIP_STYLE.color,
    },
  });

  /* --------------------------------------------------- interaction states
     Order matters: these come last so they win over the type blocks above.
     `dimmed` is applied to everything outside a selection's neighbourhood; the
     focus node is never dimmed (enforced in NetworkGraph, not here). */
  sheet.push(
    {
      selector: '.dimmed',
      style: {
        opacity: 0.12,
        'text-opacity': 0,
      },
    },
    {
      selector: 'node.hovered',
      style: {
        'border-width': 2,
        'border-color': HOVER_BORDER,
        'border-opacity': 0.7,
        'z-index': 20,
      },
    },
    {
      selector: 'edge.hovered',
      style: {
        opacity: 1,
        'z-index': 20,
      },
    },
    {
      selector: 'node.selected',
      style: {
        'border-width': 2.5,
        'border-color': ACCENT_BRIGHT,
        'border-opacity': 1,
        color: INK,
        'z-index': 30,
      },
    },
    {
      selector: 'edge.selected',
      style: {
        opacity: 1,
        // An underlay keeps the relationship's own colour legible while still
        // marking the selection — recolouring the line would hide its type.
        'underlay-color': ACCENT,
        'underlay-opacity': 0.35,
        'underlay-padding': 3,
        'z-index': 30,
      },
    },
    {
      // The anchor of the network. Always visible, always ringed.
      selector: 'node.focus',
      style: {
        'border-width': 3,
        'border-color': ACCENT,
        'border-opacity': 1,
        color: INK,
        'font-weight': 700,
        'z-index': 40,
      },
    },
    {
      // Cytoscape's own :selected pseudo-class stays visually quiet — selection
      // is driven by React props, and the `.selected` class above is the signal.
      selector: ':selected',
      style: {
        'overlay-opacity': 0,
      },
    },
  );

  return sheet;
}

/**
 * fCoSE options, interpolated between a "small network" and a "backend cap"
 * profile so a 25-node 1-hop view and a 300-node 2-hop view both read well.
 *
 * `animate` is false on purpose: an animated force layout settling over 300
 * nodes looks like a rendering fault on a projector, and the brief forbids
 * animation beyond the existing skeleton pulse.
 */
interface FcoseLayoutOptions extends BaseLayoutOptions {
  name: 'fcose';
  quality: 'draft' | 'default' | 'proof';
  randomize: boolean;
  animate: boolean;
  fit: boolean;
  padding: number;
  nodeDimensionsIncludeLabels: boolean;
  uniformNodeDimensions: boolean;
  packComponents: boolean;
  samplingType: boolean;
  nodeSeparation: number;
  nodeRepulsion: number;
  idealEdgeLength: number;
  edgeElasticity: number;
  gravity: number;
  gravityRange: number;
  numIter: number;
  tile: boolean;
  tilingPaddingVertical: number;
  tilingPaddingHorizontal: number;
  initialEnergyOnIncremental: number;
}

function lerp(small: number, large: number, t: number): number {
  return Math.round(small + (large - small) * t);
}

export function graphLayoutOptions(elementCount: number): LayoutOptions {
  // 30 elements => the "small" profile, 300 (the backend's node cap) => "large".
  const t = Math.min(1, Math.max(0, (elementCount - 30) / (300 - 30)));

  const options: FcoseLayoutOptions = {
    name: 'fcose',
    // 'default' adds a CoSE refinement pass over the spectral placement: good
    // separation without the cost of 'proof' on a 300-node graph.
    quality: 'default',
    randomize: true,
    animate: false,
    fit: true,
    padding: lerp(34, 18, t),
    // Labels sit below the nodes, so they must be counted or dense clusters
    // overlap their own text.
    nodeDimensionsIncludeLabels: true,
    uniformNodeDimensions: false,
    // The 2-hop view frequently contains small detached pieces (a tower or an
    // FIR whose only bridge fell outside the cap). Packing lays them out beside
    // the main component instead of flinging them to the far corners.
    packComponents: true,
    samplingType: true,
    nodeSeparation: lerp(110, 65, t),
    nodeRepulsion: lerp(7000, 4000, t),
    idealEdgeLength: lerp(100, 52, t),
    edgeElasticity: 0.45,
    gravity: 0.24,
    gravityRange: 3.8,
    numIter: lerp(2500, 1600, t),
    tile: true,
    tilingPaddingVertical: 12,
    tilingPaddingHorizontal: 12,
    initialEnergyOnIncremental: 0.3,
  };

  return options;
}
