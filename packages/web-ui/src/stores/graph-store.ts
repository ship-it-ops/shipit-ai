import { create } from 'zustand';
import type { Core } from 'cytoscape';

export interface GraphFilters {
  nodeLabels: string[];
  environments: string[];
  tiers: string[];
  owners: string[];
}

type LayoutType = 'dagre' | 'cose' | 'concentric';

interface GraphState {
  selectedNode: string | null;
  filters: GraphFilters;
  layout: LayoutType;
  viewport: { zoom: number; pan: { x: number; y: number } };
  /** Live Cytoscape instance, published by GraphCanvas after mount. */
  cyInstance: Core | null;
  /**
   * True while a modal dialog (claims, blast radius) is open over the graph.
   * The explore page reads this to hide the floating legend, which otherwise
   * paints above the dialog's backdrop overlay.
   */
  dialogOpen: boolean;
  setSelectedNode: (nodeId: string | null) => void;
  setDialogOpen: (open: boolean) => void;
  setFilters: (filters: Partial<GraphFilters>) => void;
  resetFilters: () => void;
  setLayout: (layout: LayoutType) => void;
  setViewport: (viewport: { zoom: number; pan: { x: number; y: number } }) => void;
  setCyInstance: (cy: Core | null) => void;
}

const defaultFilters: GraphFilters = {
  nodeLabels: [],
  environments: [],
  tiers: [],
  owners: [],
};

export const useGraphStore = create<GraphState>((set) => ({
  selectedNode: null,
  filters: defaultFilters,
  layout: 'dagre',
  viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  cyInstance: null,
  dialogOpen: false,
  setSelectedNode: (nodeId) => set({ selectedNode: nodeId }),
  setDialogOpen: (open) => set({ dialogOpen: open }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  resetFilters: () => set({ filters: defaultFilters }),
  setLayout: (layout) => set({ layout }),
  setViewport: (viewport) => set({ viewport }),
  setCyInstance: (cy) => set({ cyInstance: cy }),
}));
