import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface StpInterfaceAgent {
  setPortCost(iface: string, cost: number | null, vlan?: number): void;
  setPortPriority(iface: string, priority: number | null, vlan?: number): void;
  setPortFast(iface: string, on: boolean): void;
  setPortBpduGuard(iface: string, on: boolean): void;
  setPortBpduFilter(iface: string, on: boolean): void;
  setPortRootGuard(iface: string, on: boolean): void;
  setPortLoopGuard(iface: string, on: boolean): void;
}

export interface StpInterfaceHost {
  targetInterfaces(): string[];
  stpAgent(): StpInterfaceAgent;
  recordStpLine(iface: string, line: string): void;
  forgetStpLine(iface: string, head: string, knob: string): void;
}

const MODES = ['config-if'] as const;

export const STP_MAX_COST = 200_000_000;
export const STP_MAX_PORT_PRIORITY = 240;

const COUT: ArgumentSpec = {
  name: 'cout', type: 'INT', description: 'Port path cost',
  range: [1, STP_MAX_COST],
};

const PRIORITE: ArgumentSpec = {
  name: 'priorite', type: 'INT', description: 'Port priority',
  range: [0, STP_MAX_PORT_PRIORITY],
};

const VLAN: ArgumentSpec = {
  name: 'vlan', type: 'VLAN_ID', description: 'VLAN identifier',
};

const ACTIF: ArgumentSpec = {
  name: 'etat', type: 'ENUM', description: 'Enable or disable',
  values: [
    { keyword: 'enable', description: 'Enable on this interface' },
    { keyword: 'disable', description: 'Disable on this interface' },
  ],
};

const GARDE: ArgumentSpec = {
  name: 'garde', type: 'ENUM', description: 'Guard mode',
  values: [
    { keyword: 'loop', description: 'Enable loop guard' },
    { keyword: 'none', description: 'Disable guard on this interface' },
    { keyword: 'root', description: 'Enable root guard' },
  ],
};

const LIEN: ArgumentSpec = {
  name: 'lien', type: 'ENUM', description: 'Link type',
  values: [
    { keyword: 'point-to-point', description: 'Consider the interface as point-to-point' },
    { keyword: 'shared', description: 'Consider the interface as shared' },
  ],
};

const PORTFAST: ArgumentSpec = {
  name: 'portee', type: 'ENUM', optional: true, description: 'PortFast scope',
  values: [
    { keyword: 'disable', description: 'Disable PortFast on this interface' },
    { keyword: 'trunk', description: 'Enable PortFast on a trunk port' },
  ],
};

export function stpInterfaceSpecs(ctx: () => StpInterfaceHost): CommandSpec[] {
  const surChaque = (
    ligne: (args: Record<string, string | undefined>) => string,
    appliquer: (
      agent: StpInterfaceAgent, iface: string,
      args: Record<string, string | undefined>) => void,
  ) => (_session: unknown, args: Record<string, string | undefined>): string => {
    const host = ctx();
    const agent = host.stpAgent();
    for (const iface of host.targetInterfaces()) {
      appliquer(agent, iface, args);
      host.recordStpLine(iface, `spanning-tree ${ligne(args)}`);
    }
    return '';
  };

  const defaire = (
    tete: string, knob: string,
    appliquer: (
      agent: StpInterfaceAgent, iface: string,
      args: Record<string, string | undefined>) => void,
  ) => (_session: unknown, args: Record<string, string | undefined>): string => {
    const host = ctx();
    const agent = host.stpAgent();
    for (const iface of host.targetInterfaces()) {
      appliquer(agent, iface, args);
      host.forgetStpLine(iface, tete, knob);
    }
    return '';
  };

  const vlanDe = (args: Record<string, string | undefined>): number | undefined =>
    args.vlan === undefined ? undefined : Number(args.vlan);

  const negationNue = (
    id: string, chemin: readonly (string | ArgumentSpec)[],
    description: string, undoDescription: string, tete: string, knob: string,
    appliquer: (
      agent: StpInterfaceAgent, iface: string,
      args: Record<string, string | undefined>) => void,
  ): CommandSpec => ({
    id, path: chemin, description, undoDescription,
    existsOnlyNegated: true,
    modes: MODES, minPrivilege: 15,
    run: () => '% Incomplete command.',
    undo: defaire(tete, knob, appliquer),
  });

  return [
    {
      id: 'config-if-stp-portfast',
      path: ['spanning-tree', 'portfast', PORTFAST],
      description: 'Enable an interface to move directly to forwarding on link up',
      undoDescription: 'Disable PortFast on this interface',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `portfast${args.portee ? ` ${args.portee}` : ''}`,
        (agent, iface, args) => agent.setPortFast(iface, args.portee !== 'disable')),
      undo: defaire('portfast', 'portfast',
        (agent, iface) => agent.setPortFast(iface, false)),
    },
    {
      id: 'config-if-stp-bpduguard',
      path: ['spanning-tree', 'bpduguard', ACTIF],
      description: 'Don\'t accept BPDUs on this interface',
      undoDescription: 'Return BPDU guard to the global setting',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `bpduguard ${args.etat}`,
        (agent, iface, args) => agent.setPortBpduGuard(iface, args.etat === 'enable')),
      undo: defaire('bpduguard', 'bpduguard',
        (agent, iface) => agent.setPortBpduGuard(iface, false)),
    },
    {
      id: 'config-if-stp-bpdufilter',
      path: ['spanning-tree', 'bpdufilter', ACTIF],
      description: 'Don\'t send or receive BPDUs on this interface',
      undoDescription: 'Return BPDU filter to the global setting',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `bpdufilter ${args.etat}`,
        (agent, iface, args) => agent.setPortBpduFilter(iface, args.etat === 'enable')),
      undo: defaire('bpdufilter', 'bpdufilter',
        (agent, iface) => agent.setPortBpduFilter(iface, false)),
    },
    {
      id: 'config-if-stp-guard',
      path: ['spanning-tree', 'guard', GARDE],
      description: 'Guard mode for this interface',
      undoDescription: 'Remove the guard mode from this interface',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `guard ${args.garde}`,
        (agent, iface, args) => {
          agent.setPortRootGuard(iface, args.garde === 'root');
          agent.setPortLoopGuard(iface, args.garde === 'loop');
        }),
      undo: defaire('guard', 'guard', (agent, iface) => {
        agent.setPortRootGuard(iface, false);
        agent.setPortLoopGuard(iface, false);
      }),
    },
    {
      id: 'config-if-stp-link-type',
      path: ['spanning-tree', 'link-type', LIEN],
      description: 'Specify a link type for this interface',
      undoDescription: 'Return the link type to its default',
      modes: MODES, minPrivilege: 15,
      run: surChaque((args) => `link-type ${args.lien}`, () => undefined),
      undo: defaire('link-type', 'link-type', () => undefined),
    },
    {
      id: 'config-if-stp-cost',
      path: ['spanning-tree', 'cost', COUT],
      description: 'Change an interface\'s spanning tree port path cost',
      undoDescription: 'Return the port path cost to its default',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `cost ${args.cout}`,
        (agent, iface, args) => agent.setPortCost(iface, Number(args.cout))),
      undo: defaire('cost', 'cost',
        (agent, iface) => agent.setPortCost(iface, null)),
    },
    {
      id: 'config-if-stp-port-priority',
      path: ['spanning-tree', 'port-priority', PRIORITE],
      description: 'Change an interface\'s spanning tree port priority',
      undoDescription: 'Return the port priority to its default',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `port-priority ${args.priorite}`,
        (agent, iface, args) => agent.setPortPriority(iface, Number(args.priorite))),
      undo: defaire('port-priority', 'port-priority',
        (agent, iface) => agent.setPortPriority(iface, null)),
    },
    {
      id: 'config-if-stp-vlan-cost',
      path: ['spanning-tree', 'vlan', VLAN, 'cost', COUT],
      description: 'Change an interface\'s spanning tree port path cost',
      undoDescription: 'Return the port path cost to its default',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `vlan ${args.vlan} cost ${args.cout}`,
        (agent, iface, args) =>
          agent.setPortCost(iface, Number(args.cout), vlanDe(args))),
      undo: defaire('vlan', 'cost',
        (agent, iface, args) => agent.setPortCost(iface, null, vlanDe(args))),
    },
    {
      id: 'config-if-stp-vlan-port-priority',
      path: ['spanning-tree', 'vlan', VLAN, 'port-priority', PRIORITE],
      description: 'Change an interface\'s spanning tree port priority',
      undoDescription: 'Return the port priority to its default',
      modes: MODES, minPrivilege: 15,
      run: surChaque(
        (args) => `vlan ${args.vlan} port-priority ${args.priorite}`,
        (agent, iface, args) =>
          agent.setPortPriority(iface, Number(args.priorite), vlanDe(args))),
      undo: defaire('vlan', 'port-priority',
        (agent, iface, args) => agent.setPortPriority(iface, null, vlanDe(args))),
    },
    negationNue('config-if-stp-cost-nu', ['spanning-tree', 'cost'],
      'Change an interface\'s spanning tree port path cost',
      'Return the port path cost to its default', 'cost', 'cost',
      (agent, iface) => agent.setPortCost(iface, null)),
    negationNue('config-if-stp-port-priority-nu', ['spanning-tree', 'port-priority'],
      'Change an interface\'s spanning tree port priority',
      'Return the port priority to its default', 'port-priority', 'port-priority',
      (agent, iface) => agent.setPortPriority(iface, null)),
    negationNue('config-if-stp-bpduguard-nu', ['spanning-tree', 'bpduguard'],
      'Don\'t accept BPDUs on this interface',
      'Return BPDU guard to the global setting', 'bpduguard', 'bpduguard',
      (agent, iface) => agent.setPortBpduGuard(iface, false)),
    negationNue('config-if-stp-bpdufilter-nu', ['spanning-tree', 'bpdufilter'],
      'Don\'t send or receive BPDUs on this interface',
      'Return BPDU filter to the global setting', 'bpdufilter', 'bpdufilter',
      (agent, iface) => agent.setPortBpduFilter(iface, false)),
    negationNue('config-if-stp-guard-nu', ['spanning-tree', 'guard'],
      'Guard mode for this interface',
      'Remove the guard mode from this interface', 'guard', 'guard',
      (agent, iface) => {
        agent.setPortRootGuard(iface, false);
        agent.setPortLoopGuard(iface, false);
      }),
    negationNue('config-if-stp-link-type-nu', ['spanning-tree', 'link-type'],
      'Specify a link type for this interface',
      'Return the link type to its default', 'link-type', 'link-type',
      () => undefined),
    negationNue('config-if-stp-vlan-cost-nu', ['spanning-tree', 'vlan', VLAN, 'cost'],
      'Change an interface\'s spanning tree port path cost',
      'Return the port path cost to its default', 'vlan', 'cost',
      (agent, iface, args) => agent.setPortCost(iface, null, vlanDe(args))),
    negationNue('config-if-stp-vlan-port-priority-nu',
      ['spanning-tree', 'vlan', VLAN, 'port-priority'],
      'Change an interface\'s spanning tree port priority',
      'Return the port priority to its default', 'vlan', 'port-priority',
      (agent, iface, args) => agent.setPortPriority(iface, null, vlanDe(args))),
  ];
}
