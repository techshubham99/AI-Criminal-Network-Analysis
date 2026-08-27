import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

import type { EdgeOut, NodeOut } from '@/types/api';
import { entityColor, relationshipStyle } from '@/utils/entity';
import { cn } from '@/utils/cn';
import { formatCount } from '@/utils/format';
import { GRAPH_BACKGROUND, buildGraphStylesheet, graphLayoutOptions } from './graphStyle';

/**
 * The investigation network canvas.
 *
 * This component owns the Cytoscape instance and nothing else: no fetching, no
 * filtering, no interpretation. It renders exactly the nodes and edges it is
 * given — which is how the page above can guarantee that the synthetic overlay
 * (`SAME_RING`) never reaches the canvas.
 *
 * Selection is a *controlled* concern. A tap reports the ORIGINAL API object
 * back to the caller, and the `selectedNodeId` / `selectedEdgeId` props push a
 * selection made elsewhere (a search result, an evidence row) back into the
 * graph. That two-way sync is what makes the graph and the side panels feel like
 * one instrument rather than two widgets.
 */

/* fCoSE must be registered on the cytoscape singleton before any instance asks
   for the layout by name. Module scope runs once per module instance, and the
   boolean plus the try/catch make a second registration (HMR, a duplicated
   bundle copy) a no-op instead of a thrown error. */
let fcoseRegistered = false;
if (!fcoseRegistered) {
  fcoseRegistered = true;
  try {
    cytoscape.use(fcose);
  } catch {
    // Already registered by another copy of this module — nothing to do.
  }
}

/**
 * jsdom implements no canvas, so Cytoscape's canvas renderer would paint into a
 * null 2D context and throw inside an animation frame. When no context is
 * available we build a headless instance instead: the graph model, styles,
 * classes and selection logic all still work, only painting is skipped. Tests
 * can therefore render this component without stubbing anything.
 */
function canPaintCanvas(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const probe = document.createElement('canvas');
    return typeof probe.getContext === 'function' && probe.getContext('2d') != null;
  } catch {
    return false;
  }
}

export interface NetworkGraphHandle {
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  relayout(): void;
  focusEntity(entityId: string): void;
}

export interface NetworkGraphProps {
  nodes: NodeOut[];
  edges: EdgeOut[];
  focusEntityId?: string | null;
  /** Matches `NodeOut.entity_id`. */
  selectedNodeId?: string | null;
  /** Matches `EdgeOut.relationship_id`. */
  selectedEdgeId?: string | null;
  onSelectNode?: (node: NodeOut | null) => void;
  onSelectEdge?: (edge: EdgeOut | null) => void;
  className?: string;
}

const ZOOM_STEP = 1.35;
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 3.2;
const FIT_PADDING = 28;

interface BuiltElements {
  elements: cytoscape.ElementDefinition[];
  nodeMap: Map<string, NodeOut>;
  edgeMap: Map<string, EdgeOut>;
  renderedEdgeCount: number;
}

/**
 * Translate API objects into Cytoscape elements.
 *
 * Element ids are the backend's own ids verbatim (`person:445`,
 * `CALLED~person:141~person:189`) so a lookup never needs a translation table
 * and `getElementById` works directly from a prop.
 */
function buildElements(nodes: NodeOut[], edges: EdgeOut[]): BuiltElements {
  const nodeMap = new Map<string, NodeOut>();
  for (const node of nodes) nodeMap.set(node.entity_id, node);

  const edgeMap = new Map<string, EdgeOut>();
  // Degree is computed from the edges actually returned, not from any backend
  // metric: it describes THIS view, so the node sizing never claims more
  // structure than the canvas is showing.
  const degree = new Map<string, number>();
  const usableEdges: EdgeOut[] = [];

  for (const edge of edges) {
    // A truncated network, or a relationship-type filter applied upstream, can
    // leave an edge pointing at an entity that is not in the node list.
    // Cytoscape throws on such an edge, so it is dropped rather than faked.
    if (!nodeMap.has(edge.source_entity_id) || !nodeMap.has(edge.target_entity_id)) continue;
    if (edgeMap.has(edge.relationship_id)) continue; // defensive: ids are unique
    edgeMap.set(edge.relationship_id, edge);
    usableEdges.push(edge);
    degree.set(edge.source_entity_id, (degree.get(edge.source_entity_id) ?? 0) + 1);
    if (edge.target_entity_id !== edge.source_entity_id) {
      degree.set(edge.target_entity_id, (degree.get(edge.target_entity_id) ?? 0) + 1);
    }
  }

  const elements: cytoscape.ElementDefinition[] = [];

  for (const node of nodes) {
    elements.push({
      group: 'nodes',
      data: {
        id: node.entity_id,
        // snake_case keys: the stylesheet's selectors read these names, and they
        // match the API field names so there is no second vocabulary to learn.
        entity_type: node.entity_type,
        label: node.label,
        degree: degree.get(node.entity_id) ?? 0,
        color: entityColor(node.entity_type),
      },
    });
  }

  for (const edge of usableEdges) {
    const style = relationshipStyle(edge.relationship_type);
    elements.push({
      group: 'edges',
      data: {
        id: edge.relationship_id,
        source: edge.source_entity_id,
        target: edge.target_entity_id,
        relationship_type: edge.relationship_type,
        weight: Number.isFinite(edge.weight) ? edge.weight : 1,
        directed: edge.directed,
        dashed: style.dashed,
        color: style.color,
      },
    });
  }

  return { elements, nodeMap, edgeMap, renderedEdgeCount: usableEdges.length };
}

export const NetworkGraph = forwardRef<NetworkGraphHandle, NetworkGraphProps>(
  function NetworkGraph(
    {
      nodes,
      edges,
      focusEntityId,
      selectedNodeId,
      selectedEdgeId,
      onSelectNode,
      onSelectEdge,
      className,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const cyRef = useRef<cytoscape.Core | null>(null);
    const layoutRef = useRef<cytoscape.Layouts | null>(null);
    const paintsRef = useRef(false);

    const { elements, nodeMap, edgeMap, renderedEdgeCount } = useMemo(
      () => buildElements(nodes, edges),
      [nodes, edges],
    );

    /* Tap handlers are registered once, so they read the current maps and
       callbacks through refs instead of being torn down on every render. */
    const lookupRef = useRef({ nodeMap, edgeMap });
    const callbacksRef = useRef({ onSelectNode, onSelectEdge });
    const highlightRef = useRef({ focusEntityId, selectedNodeId, selectedEdgeId });
    useEffect(() => {
      lookupRef.current = { nodeMap, edgeMap };
      callbacksRef.current = { onSelectNode, onSelectEdge };
      highlightRef.current = { focusEntityId, selectedNodeId, selectedEdgeId };
    });

    /**
     * Apply the focus ring and the selection highlight.
     *
     * Selecting an element dims everything outside its closed neighbourhood so
     * the local structure reads immediately. The network's anchor keeps its
     * focus ring and is never dimmed — losing the anchor would make the view
     * unreadable.
     */
    const applyHighlight = useCallback(
      (
        cy: cytoscape.Core,
        state: {
          focusEntityId?: string | null;
          selectedNodeId?: string | null;
          selectedEdgeId?: string | null;
        },
      ) => {
        cy.batch(() => {
          cy.elements().removeClass('dimmed selected focus');

          const focus = state.focusEntityId
            ? cy.getElementById(state.focusEntityId)
            : cy.collection();
          if (focus.nonempty()) focus.addClass('focus');

          let keep: cytoscape.CollectionReturnValue | null = null;

          if (state.selectedNodeId) {
            const node = cy.getElementById(state.selectedNodeId);
            if (node.nonempty()) {
              node.addClass('selected');
              keep = node.closedNeighborhood();
            }
          } else if (state.selectedEdgeId) {
            const edge = cy.getElementById(state.selectedEdgeId);
            if (edge.nonempty()) {
              edge.addClass('selected');
              keep = edge.union(edge.connectedNodes());
            }
          }

          if (keep) {
            const visible = focus.nonempty() ? keep.union(focus) : keep;
            cy.elements().difference(visible).addClass('dimmed');
          }
        });
      },
      [],
    );

    const runLayout = useCallback((cy: cytoscape.Core) => {
      // Headless instances (jsdom) have no viewport geometry, so a force layout
      // there would compute positions against a 0x0 box for no benefit.
      if (!paintsRef.current || cy.elements().empty()) return;
      layoutRef.current?.stop();
      const layout = cy.layout(graphLayoutOptions(cy.elements().length));
      layoutRef.current = layout;
      layout.run();
    }, []);

    /* Viewport helpers shared by the imperative handle and the keyboard map, so
       a toolbar button and a keypress can never drift apart. */
    const zoomBy = useCallback((factor: number) => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.zoom({
        level: cy.zoom() * factor,
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      });
    }, []);

    const fitAll = useCallback(() => {
      const cy = cyRef.current;
      if (!cy || cy.elements().empty()) return;
      cy.fit(cy.elements(), FIT_PADDING);
    }, []);

    const panBy = useCallback((dx: number, dy: number) => {
      cyRef.current?.panBy({ x: dx, y: dy });
    }, []);

    /* ------------------------------------------------------------------ mount */
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const paints = canPaintCanvas();
      paintsRef.current = paints;

      const cy = cytoscape({
        container,
        // No canvas => headless model-only instance. `styleEnabled` has to be
        // forced on because it otherwise follows the renderer.
        headless: !paints,
        styleEnabled: true,
        style: buildGraphStylesheet(),
        // Layout is run explicitly once elements are in place.
        layout: { name: 'null' },
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        // Wheel zoom and drag pan stay on; nothing is locked, so an analyst can
        // drag a node out of a cluster to read it.
        zoomingEnabled: true,
        userZoomingEnabled: true,
        panningEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        selectionType: 'single',
        autolock: false,
        autoungrabify: false,
        autounselectify: false,
        textureOnViewport: false,
        pixelRatio: 'auto',
      });
      cyRef.current = cy;

      cy.on('tap', 'node', (event) => {
        const node = lookupRef.current.nodeMap.get(event.target.id()) ?? null;
        callbacksRef.current.onSelectEdge?.(null);
        callbacksRef.current.onSelectNode?.(node);
      });

      cy.on('tap', 'edge', (event) => {
        const edge = lookupRef.current.edgeMap.get(event.target.id()) ?? null;
        callbacksRef.current.onSelectNode?.(null);
        callbacksRef.current.onSelectEdge?.(edge);
      });

      cy.on('tap', (event) => {
        // Background tap clears the selection.
        if (event.target !== cy) return;
        callbacksRef.current.onSelectNode?.(null);
        callbacksRef.current.onSelectEdge?.(null);
      });

      cy.on('mouseover', 'node, edge', (event) => {
        event.target.addClass('hovered');
      });
      cy.on('mouseout', 'node, edge', (event) => {
        event.target.removeClass('hovered');
      });

      // The canvas lives in a flex layout, so it can change size without the
      // window doing so (a side panel opening). Cytoscape only listens to window
      // resize, hence the observer.
      let observer: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          if (cyRef.current) cyRef.current.resize();
        });
        observer.observe(container);
      }

      return () => {
        observer?.disconnect();
        layoutRef.current?.stop();
        layoutRef.current = null;
        cyRef.current = null;
        cy.destroy();
      };
    }, []);

    /* --------------------------------------------------- elements + layout */
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) return;

      cy.batch(() => {
        cy.elements().remove();
        cy.add(elements);
      });

      runLayout(cy);
      applyHighlight(cy, highlightRef.current);
    }, [elements, runLayout, applyHighlight]);

    /* ------------------------------- selection pushed in from outside the graph */
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) return;
      applyHighlight(cy, { focusEntityId, selectedNodeId, selectedEdgeId });
    }, [focusEntityId, selectedNodeId, selectedEdgeId, applyHighlight]);

    /* ------------------------------------------------------ imperative handle */
    useImperativeHandle(
      ref,
      (): NetworkGraphHandle => ({
        fit: fitAll,
        zoomIn() {
          zoomBy(ZOOM_STEP);
        },
        zoomOut() {
          zoomBy(1 / ZOOM_STEP);
        },
        resetView() {
          const cy = cyRef.current;
          if (!cy) return;
          cy.reset();
          fitAll();
        },
        relayout() {
          const cy = cyRef.current;
          if (!cy) return;
          runLayout(cy);
        },
        focusEntity(entityId: string) {
          const cy = cyRef.current;
          if (!cy) return;
          const target = cy.getElementById(entityId);
          if (target.empty()) return;
          // Centre without animation, and only raise the zoom if the node would
          // otherwise be too small to identify.
          if (cy.zoom() < 0.75) cy.zoom({ level: 0.75, position: target.position() });
          cy.center(target);
        },
      }),
      [fitAll, zoomBy, runLayout],
    );

    /**
     * Keyboard operation of the canvas, for an analyst who tabs into it: +/- to
     * zoom, 0 to fit, arrows to pan. Only these keys are intercepted, so Tab
     * still moves focus out of the graph.
     */
    const onKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 160 : 60;
        switch (event.key) {
          case '+':
          case '=':
            zoomBy(ZOOM_STEP);
            break;
          case '-':
          case '_':
            zoomBy(1 / ZOOM_STEP);
            break;
          case '0':
            fitAll();
            break;
          case 'ArrowLeft':
            panBy(step, 0);
            break;
          case 'ArrowRight':
            panBy(-step, 0);
            break;
          case 'ArrowUp':
            panBy(0, step);
            break;
          case 'ArrowDown':
            panBy(0, -step);
            break;
          default:
            return;
        }
        event.preventDefault();
      },
      [fitAll, panBy, zoomBy],
    );

    const focusLabel = focusEntityId ? nodeMap.get(focusEntityId)?.label : undefined;

    return (
      <div
        className={cn(
          'tactical-grid border-line relative overflow-hidden rounded-lg border',
          className,
        )}
        // Token-matched ground, stated inline so the canvas area is never a
        // bright rectangle if the utility layer has not painted yet.
        style={{ backgroundColor: GRAPH_BACKGROUND }}
      >
        <div
          ref={containerRef}
          data-testid="network-graph"
          role="application"
          aria-label={
            focusLabel
              ? `Investigation network graph for ${focusLabel}: ${nodes.length} entities, ${renderedEdgeCount} relationships. Click an entity or a relationship for its record. Zoom with plus and minus, fit with zero, pan with the arrow keys.`
              : `Investigation network graph: ${nodes.length} entities, ${renderedEdgeCount} relationships. Click an entity or a relationship for its record. Zoom with plus and minus, fit with zero, pan with the arrow keys.`
          }
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="h-full min-h-[420px] w-full"
        />

        {/* Rendered-element readout. Reflects what is on the canvas right now —
            after any upstream filter — so it can disagree with the backend's
            own count, which is the point. */}
        <div
          className="border-line/80 bg-abyss/85 text-ink-4 pointer-events-none absolute bottom-2 left-2 rounded-xs border px-1.5 py-0.5 font-mono text-2xs tracking-wide"
          aria-hidden
        >
          {formatCount(nodes.length)} nodes · {formatCount(renderedEdgeCount)} edges
        </div>
      </div>
    );
  },
);
