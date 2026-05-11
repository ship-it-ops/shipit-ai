import { create } from 'zustand';

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
  setSelectedNode: (nodeId: string | null) => void;
  setFilters: (filters: Partial<GraphFilters>) => void;
  resetFilters: () => void;
  setLayout: (layout: LayoutType) => void;
  setViewport: (viewport: { zoom: number; pan: { x: number; y: number } }) => void;
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
  setSelectedNode: (nodeId) => set({ selectedNode: nodeId }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  resetFilters: () => set({ filters: defaultFilters }),
  setLayout: (layout) => set({ layout }),
  setViewport: (viewport) => set({ viewport }),
}));
