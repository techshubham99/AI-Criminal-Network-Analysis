/**
 * The graph feature's public surface.
 *
 * A page imports the canvas, its controls and its two detail panels from here so
 * the network view can be assembled without reaching into individual files.
 */
export { NetworkGraph } from './NetworkGraph';
export type { NetworkGraphHandle, NetworkGraphProps } from './NetworkGraph';

export { GraphToolbar } from './GraphToolbar';
export type { GraphToolbarProps } from './GraphToolbar';

export { GraphLegend } from './GraphLegend';
export type { GraphLegendProps } from './GraphLegend';

export { buildGraphStylesheet, graphLayoutOptions, GRAPH_BACKGROUND } from './graphStyle';

export { NodeDetailsPanel } from './NodeDetailsPanel';
export type { NodeDetailsPanelProps } from './NodeDetailsPanel';

export { EdgeEvidencePanel } from './EdgeEvidencePanel';
export type { EdgeEvidencePanelProps } from './EdgeEvidencePanel';
