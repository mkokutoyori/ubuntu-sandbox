import type { CommandSpec } from '@/cli/CommandTable';

export interface RoutedPortHost {
  setSelectedPortsRouted(routed: boolean): string;
}

const MODES = ['config-if'] as const;

export function routedPortSpecs(ctx: () => RoutedPortHost): CommandSpec[] {
  return [{
    id: 'config-if-switchport',
    path: ['switchport'],
    description: 'Set switching mode characteristics',
    undoDescription: 'Set the interface to be a routed (layer 3) port',
    modes: MODES, minPrivilege: 15,
    run: () => ctx().setSelectedPortsRouted(false),
    undo: () => ctx().setSelectedPortsRouted(true),
  }];
}
