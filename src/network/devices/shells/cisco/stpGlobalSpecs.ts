import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import { MST_INSTANCE_BOUNDS, parseVlanList } from '../cli/vlanList';
import { UPLINKFAST_RATE_RANGE } from '../../../stp/types';

export interface StpGlobalAgent {
  setBridgePriority(priority: number): void;
  setVlanPriority(vlan: number, priority: number): void;
  setVlanHelloSec(vlan: number, seconds: number): void;
  setVlanMaxAgeSec(vlan: number, seconds: number): void;
  setVlanForwardDelaySec(vlan: number, seconds: number): void;
  setVlanStpEnabled(vlan: number, on: boolean): void;
  setPortfastDefault(on: boolean): void;
  setBpduGuardGlobal(on: boolean): void;
  setBpduFilterGlobal(on: boolean): void;
  setLoopGuardGlobal(on: boolean): void;
  setUplinkFast(on: boolean, rate?: number): void;
  setBackboneFast(on: boolean): void;
  setPathcostMethod(method: 'long' | 'short'): void;
  setMstInstancePriority(instance: number, priority: number): void;
}

export interface StpGlobalHost {
  stpAgent(): StpGlobalAgent;
  applyStpMode(mode: string): void;
  enterMstConfiguration(): void;
}

export const STP_BRIDGE_PRIORITY_RANGE: readonly [number, number] = [0, 61440];
export const STP_BRIDGE_PRIORITY_STEP = 4096;
export const PRIORITY_MUST_STEP_BY_4096 =
  '% Bridge Priority must be in increments of 4096.';

export const STP_TIMER_RANGES: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({
    'hello-time': [1, 10],
    'forward-time': [4, 30],
    'max-age': [6, 40],
  });

const MODES = ['config'] as const;

const MODE: ArgumentSpec = {
  name: 'mode', type: 'ENUM', description: 'Spanning tree operating mode',
  values: [
    { keyword: 'mst', description: 'Multiple spanning tree mode' },
    { keyword: 'pvst', description: 'Per-VLAN spanning tree mode' },
    { keyword: 'rapid-pvst', description: 'Per-VLAN rapid spanning tree mode' },
  ],
};

const PRIORITY: ArgumentSpec = {
  name: 'priority', type: 'INT', range: STP_BRIDGE_PRIORITY_RANGE,
  description: 'Bridge priority in increments of 4096',
};

const VLAN_RANGE: ArgumentSpec = {
  name: 'vlans', type: 'WORD',
  description: 'vlan range, example: 1,3-5,7,9-11',
};

const MST_RANGE: ArgumentSpec = {
  name: 'instances', type: 'WORD',
  description: 'MST instance range, example: 0-3,5,7-9',
};

const ROOT_ROLE: ArgumentSpec = {
  name: 'role', type: 'ENUM', description: 'Bridge role',
  values: [
    { keyword: 'primary', description: 'Configure this switch as primary root' },
    { keyword: 'secondary', description: 'Configure this switch as secondary root' },
  ],
};

const PATHCOST_METHOD: ArgumentSpec = {
  name: 'method', type: 'ENUM', description: 'Method to calculate the default path cost',
  values: [
    { keyword: 'long', description: '32 bit based values for default path cost' },
    { keyword: 'short', description: '16 bit based values for default path cost' },
  ],
};

const UPDATE_RATE: ArgumentSpec = {
  name: 'pps', type: 'INT', range: UPLINKFAST_RATE_RANGE,
  description: 'Rate in packets per second',
};

function requirePriorityStep(raw: string): number {
  const value = Number(raw);
  if (value % STP_BRIDGE_PRIORITY_STEP !== 0) throw new PriorityStepError();
  return value;
}

class PriorityStepError extends Error {}

function withPriority(apply: (priority: number) => void) {
  return (raw: string): string => {
    try {
      apply(requirePriorityStep(raw));
      return '';
    } catch (erreur) {
      if (erreur instanceof PriorityStepError) return PRIORITY_MUST_STEP_BY_4096;
      throw erreur;
    }
  };
}

function eachVlan(raw: string, apply: (vlan: number) => void): string {
  const vlans = parseVlanList(raw);
  if (vlans === null) throw new CliInvalidInput({ token: raw });
  for (const vlan of vlans) apply(vlan);
  return '';
}

function eachInstance(raw: string, apply: (instance: number) => void): string {
  const instances = parseVlanList(raw, MST_INSTANCE_BOUNDS);
  if (instances === null) throw new CliInvalidInput({ token: raw });
  for (const instance of instances) apply(instance);
  return '';
}

/**
 * La famille `spanning-tree` GLOBALE, declaree au socle.
 *
 * Elle etait servie par un unique gestionnaire glouton qui AVALAIT ses
 * onze mots-cles : aucun d'eux n'etait un noeud, donc aucun ne portait
 * sa place, son refus ni son aide. La consequence tenait en deux
 * mesures. `spanning-tree vlan 10 ?` reproposait les SOEURS du mot-cle —
 * `backbonefast`, `extend`, `portfast`… — c'est-a-dire les enfants du
 * noeud parent rejoues un cran plus bas, la ou un Catalyst annonce les
 * cinq reglages du VLAN. Et `spanning-tree mst 0 priority 100`, servi
 * par un SECOND enregistrement glouton qui ne validait rien, acceptait
 * n'importe quel nombre : le controle vivait dans un `refusReglageStpGlobal`
 * que cette forme-la ne traversait pas.
 *
 * Une forme = une commande. La plage est declaree une fois et vaut pour
 * l'analyse comme pour l'aide, si bien qu'un `hello-time 99` ne peut
 * plus etre a la fois refuse par un controle et annonce par un autre.
 *
 * Le pas de 4096 n'est PAS une plage et reste dans le gestionnaire : ce
 * n'est pas un intervalle mais une condition sur la valeur, et IOS la
 * refuse en la DISANT plutot que par un caret.
 */
export function stpGlobalSpecs(ctx: () => StpGlobalHost): CommandSpec[] {
  const agent = () => ctx().stpAgent();
  const timer = (
    knob: 'hello-time' | 'forward-time' | 'max-age',
    apply: (a: StpGlobalAgent, vlan: number, value: number) => void,
  ): CommandSpec => ({
    id: `spanning-tree-vlan-${knob}`,
    path: ['spanning-tree', 'vlan', VLAN_RANGE, knob, {
      name: 'seconds', type: 'INT', range: STP_TIMER_RANGES[knob],
      description: `Set the ${knob} for the spanning tree`,
    }],
    description: `Set the ${knob} for the spanning tree`,
    modes: MODES, minPrivilege: 15,
    run: (_session, args) => eachVlan(args.vlans,
      (vlan) => apply(agent(), vlan, Number(args.seconds))),
  });

  return [
    {
      id: 'spanning-tree-mode',
      path: ['spanning-tree', 'mode', MODE],
      description: 'Spanning tree operating mode',
      undoDescription: 'Return to the default spanning tree mode',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => { ctx().applyStpMode(args.mode); return ''; },
      undo: () => { ctx().applyStpMode('pvst'); return ''; },
    },
    {
      id: 'spanning-tree-mode-no',
      path: ['spanning-tree', 'mode'],
      description: 'Spanning tree operating mode',
      undoDescription: 'Return to the default spanning tree mode',
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { ctx().applyStpMode('pvst'); return ''; },
    },
    {
      id: 'spanning-tree-mst-configuration',
      path: ['spanning-tree', 'mst', 'configuration'],
      description: 'Enter MST configuration sub-mode',
      modes: MODES, minPrivilege: 15,
      run: () => { ctx().enterMstConfiguration(); return ''; },
    },
    {
      id: 'spanning-tree-mst-priority',
      path: ['spanning-tree', 'mst', MST_RANGE, 'priority', PRIORITY],
      description: 'Set the bridge priority for an MST instance',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        let refus = '';
        eachInstance(args.instances, (instance) => {
          refus = withPriority((p) => agent().setMstInstancePriority(instance, p))(
            args.priority);
        });
        return refus;
      },
    },
    {
      id: 'spanning-tree-priority',
      path: ['spanning-tree', 'priority', PRIORITY],
      description: 'Bridge priority of the spanning tree',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) =>
        withPriority((p) => agent().setBridgePriority(p))(args.priority),
    },
    {
      id: 'spanning-tree-vlan',
      path: ['spanning-tree', 'vlan', VLAN_RANGE],
      description: 'Per-VLAN spanning tree configuration',
      undoDescription: 'Disable spanning tree on a VLAN',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) =>
        eachVlan(args.vlans, (vlan) => agent().setVlanStpEnabled(vlan, true)),
      undo: (_session, args) =>
        eachVlan(args.vlans, (vlan) => agent().setVlanStpEnabled(vlan, false)),
    },
    {
      id: 'spanning-tree-vlan-priority',
      path: ['spanning-tree', 'vlan', VLAN_RANGE, 'priority', PRIORITY],
      description: 'Set the bridge priority for the spanning tree',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        let refus = '';
        eachVlan(args.vlans, (vlan) => {
          refus = withPriority((p) => agent().setVlanPriority(vlan, p))(args.priority);
        });
        return refus;
      },
    },
    timer('hello-time', (a, vlan, value) => a.setVlanHelloSec(vlan, value)),
    timer('forward-time', (a, vlan, value) => a.setVlanForwardDelaySec(vlan, value)),
    timer('max-age', (a, vlan, value) => a.setVlanMaxAgeSec(vlan, value)),
    {
      id: 'spanning-tree-vlan-root',
      path: ['spanning-tree', 'vlan', VLAN_RANGE, 'root', ROOT_ROLE],
      description: 'Configure switch as root',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => eachVlan(args.vlans, (vlan) =>
        agent().setVlanPriority(vlan, args.role === 'primary' ? 24576 : 28672)),
    },
    {
      id: 'spanning-tree-backbonefast',
      path: ['spanning-tree', 'backbonefast'],
      description: 'Enable BackboneFast',
      undoDescription: 'Disable BackboneFast',
      modes: MODES, minPrivilege: 15,
      run: () => { agent().setBackboneFast(true); return ''; },
      undo: () => { agent().setBackboneFast(false); return ''; },
    },
    {
      id: 'spanning-tree-uplinkfast',
      path: ['spanning-tree', 'uplinkfast'],
      description: 'Enable UplinkFast',
      undoDescription: 'Disable UplinkFast',
      modes: MODES, minPrivilege: 15,
      run: () => { agent().setUplinkFast(true); return ''; },
      undo: () => { agent().setUplinkFast(false); return ''; },
    },
    {
      id: 'spanning-tree-uplinkfast-rate',
      path: ['spanning-tree', 'uplinkfast', 'max-update-rate', UPDATE_RATE],
      description: 'Rate at which station learning frames are sent',
      undoDescription: 'Disable UplinkFast',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        agent().setUplinkFast(true, Number(args.pps));
        return '';
      },
      undo: () => { agent().setUplinkFast(false); return ''; },
    },
    {
      id: 'spanning-tree-extend-system-id',
      path: ['spanning-tree', 'extend', 'system-id'],
      description: 'Enable extended system ID',
      modes: MODES, minPrivilege: 15,
      run: () => '',
    },
    {
      id: 'spanning-tree-loopguard-default',
      path: ['spanning-tree', 'loopguard', 'default'],
      description: 'Enable loop guard by default on all ports',
      undoDescription: 'Disable the default loop guard',
      modes: MODES, minPrivilege: 15,
      run: () => { agent().setLoopGuardGlobal(true); return ''; },
      undo: () => { agent().setLoopGuardGlobal(false); return ''; },
    },
    {
      id: 'spanning-tree-loopguard-no',
      path: ['spanning-tree', 'loopguard'],
      description: 'Default loop guard on all ports',
      undoDescription: 'Disable the default loop guard',
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { agent().setLoopGuardGlobal(false); return ''; },
    },
    {
      id: 'spanning-tree-pathcost-no',
      path: ['spanning-tree', 'pathcost'],
      description: 'Spanning tree pathcost options',
      undoDescription: 'Return to the default path cost method',
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { agent().setPathcostMethod('short'); return ''; },
    },
    {
      id: 'spanning-tree-pathcost-method',
      path: ['spanning-tree', 'pathcost', 'method', PATHCOST_METHOD],
      description: 'Method to calculate the default path cost',
      undoDescription: 'Return to the default path cost method',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        agent().setPathcostMethod(args.method === 'long' ? 'long' : 'short');
        return '';
      },
      undo: () => { agent().setPathcostMethod('short'); return ''; },
    },
    {
      id: 'spanning-tree-portfast-default',
      path: ['spanning-tree', 'portfast', 'default'],
      description: 'Enable portfast by default on access ports',
      undoDescription: 'Disable the default portfast',
      modes: MODES, minPrivilege: 15,
      run: () => { agent().setPortfastDefault(true); return ''; },
      undo: () => { agent().setPortfastDefault(false); return ''; },
    },
    {
      id: 'spanning-tree-portfast-edge',
      path: ['spanning-tree', 'portfast', 'edge'],
      description: 'Portfast edge options',
      modes: MODES, minPrivilege: 15,
      run: () => '',
    },
    {
      id: 'spanning-tree-portfast-bpduguard',
      path: ['spanning-tree', 'portfast', 'bpduguard', 'default'],
      description: 'Enable BPDU guard by default on portfast ports',
      undoDescription: 'Disable the default BPDU guard',
      modes: MODES, minPrivilege: 15,
      run: () => { agent().setBpduGuardGlobal(true); return ''; },
      undo: () => { agent().setBpduGuardGlobal(false); return ''; },
    },
    {
      id: 'spanning-tree-portfast-bpdufilter',
      path: ['spanning-tree', 'portfast', 'bpdufilter', 'default'],
      description: 'Enable BPDU filtering by default on portfast ports',
      undoDescription: 'Disable the default BPDU filtering',
      modes: MODES, minPrivilege: 15,
      run: () => { agent().setBpduFilterGlobal(true); return ''; },
      undo: () => { agent().setBpduFilterGlobal(false); return ''; },
    },
  ];
}
