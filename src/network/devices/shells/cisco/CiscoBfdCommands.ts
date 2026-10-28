import type { Router } from '../../Router';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { MODES_INTERFACE } from './CiscoConfigCommands';
import type { BfdSessionRuntime } from '../../../bfd/types';
import { isValidIPv4 } from '@/network/core/ip';
import type { BfdAgent } from '../../../bfd/BfdAgent';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

interface IfCtx {
  selectedPorts(): string[];
  r(): Router;
}

interface ShowCtx {
  r(): Router;
}

function agent(router: Router): import('../../../bfd/BfdAgent').BfdAgent | undefined {
  return (router as unknown as { getBfdAgent?: () => import('../../../bfd/BfdAgent').BfdAgent }).getBfdAgent?.();
}

/**
 * Le mode echo est ACTIF par defaut sur IOS, donc seul `no bfd echo`
 * porte une information : ecrire le defaut ferait dire a la
 * configuration ce qu'aucune vraie machine n'y met, et taire l'ecart
 * ferait perdre a l'import la seule des deux lignes qui compte.
 */
function bfdEchoSpecs(ctx: IfCtx): CommandSpec[] {
  const poser = (desactive: boolean) => (): string => {
    const extra = ctx.r()._getOSPFExtraConfig();
    for (const iface of ctx.selectedPorts()) {
      const pending = extra.pendingIfConfig.get(iface) ?? {};
      if (desactive) pending.bfdEchoDisabled = true;
      else delete pending.bfdEchoDisabled;
      extra.pendingIfConfig.set(iface, pending);
    }
    return '';
  };
  return [{
    id: 'config-if-bfd-echo',
    path: ['bfd', 'echo'],
    description: 'Enable BFD echo mode',
    undoDescription: 'Disable BFD echo mode',
    modes: MODES_INTERFACE, minPrivilege: 15,
    run: poser(false),
    undo: poser(true),
  }];
}

export function bfdInterfaceSpecs(ctx: IfCtx): CommandSpec[] {
  const base = { modes: MODES_INTERFACE, minPrivilege: 15 };
  const withAgent = (run: (a: BfdAgent) => string): string => {
    const a = agent(ctx.r());
    return a ? run(a) : '';
  };
  const words = (value: string | undefined): string[] =>
    (value ?? '').trim().split(/\s+/).filter(Boolean);
  const dropNeighbor = (args: Record<string, string>): string => withAgent((a) => {
    const ip = words(args.neighbor)[0];
    if (!ip) return '';
    for (const port of ctx.selectedPorts()) a.removeSession(port, ip);
    return '';
  });
  const neighborPlace: ArgumentSpec = {
    name: 'neighbor', type: 'REST', description: 'Address of the BFD neighbour',
    alternatives: [{ keyword: 'A.B.C.D', description: 'Address of the BFD neighbour' }],
  };
  return [...bfdEchoSpecs(ctx),
    {
      ...base, id: 'config-if-bfd-interval',
      path: ['bfd', 'interval', {
        name: 'values', type: 'REST',
        description: 'Transmit interval in milliseconds, then min_rx and multiplier',
        alternatives: [
          { keyword: '<1-9999>', description: 'Transmit interval in milliseconds' },
          { keyword: 'min_rx', description: 'Minimum receive interval in milliseconds' },
          { keyword: 'multiplier', description: 'Detection multiplier' },
        ],
      }],
      description: 'BFD timers (ms)',
      run: (_session, args) => withAgent((a) => {
        const list = words(args.values);
        const pairs: Record<string, number> = {};
        const leading = parseInt(list[0] ?? '', 10);
        if (!Number.isNaN(leading)) pairs['interval'] = leading;
        for (let i = Number.isNaN(leading) ? 0 : 1; i + 1 < list.length; i += 2) {
          const k = list[i].toLowerCase();
          const v = parseInt(list[i + 1], 10);
          if (!Number.isNaN(v)) pairs[k] = v;
        }
        const tx = pairs['interval'] ?? 1000;
        const rx = pairs['min_rx'] ?? pairs['min-rx'] ?? 1000;
        const mult = pairs['multiplier'] ?? 3;
        for (const port of ctx.selectedPorts()) {
          for (const s of a.listSessions().filter((x) => x.iface === port)) {
            a.setTimers(port, s.neighborIp, tx, rx, mult);
          }
        }
        return '';
      }),
    },
    {
      ...base, id: 'config-if-bfd-neighbor', path: ['bfd', 'neighbor', neighborPlace],
      description: 'BFD static neighbor', undoDescription: 'Remove BFD neighbor',
      run: (_session, args) => withAgent((a) => {
        const ip = words(args.neighbor)[0];
        if (!ip || !isValidIPv4(ip)) return '% Invalid neighbor';
        for (const port of ctx.selectedPorts()) a.ensureSession(port, ip);
        return '';
      }),
      undo: (_session, args) => dropNeighbor(args),
    },
  ];
}

const BFD_NEIGHBORS_HEADER =
  'NeighAddr        LD/RD     RH/RS   Holdown(mult) State     Int';

function bfdStateLabel(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function bfdNeighborRow(s: BfdSessionRuntime): string {
  return `${padToWidth(s.neighborIp, 17)}` +
    `${padToWidth(`${s.localDiscriminator}/${s.remoteDiscriminator}`, 10)}` +
    `${padToWidth(s.state === 'up' ? '1/Up' : `0/${s.state}`, 8)}` +
    `${padToWidth(`${Math.round(s.desiredMinTxUs / 1000) * s.detectMultiplier}(${s.detectMultiplier})`, 15)}` +
    `${padToWidth(bfdStateLabel(s.state), 10)}${s.iface}`;
}

function bfdNeighborDetail(s: BfdSessionRuntime, echo: boolean): string[] {
  return [
    `Session state is ${s.state.toUpperCase()} and ` +
      `${echo ? 'using' : 'not using'} echo function.`,
    `Local Diag: ${s.localDiag}, Demand mode: 0, Poll bit: 0`,
    `MinTxInt: ${s.desiredMinTxUs}, MinRxInt: ${s.requiredMinRxUs}, ` +
      `Multiplier: ${s.detectMultiplier}`,
    `Received MinTxInt: ${s.remoteMinTxUs}, Received MinRxInt: ${s.remoteMinRxUs}, ` +
      `Received Diag: ${s.remoteDiag}`,
  ];
}

function bfdEchoEnabled(router: Router, iface: string): boolean {
  return !router._getOSPFExtraConfig().pendingIfConfig.get(iface)?.bfdEchoDisabled;
}

function bfdNeighborsView(ctx: ShowCtx, details: boolean): string {
  const a = agent(ctx.r());
  if (!a) return '';
  const lines = [BFD_NEIGHBORS_HEADER];
  for (const s of a.listSessions()) {
    lines.push(bfdNeighborRow(s));
    if (details) lines.push(...bfdNeighborDetail(s, bfdEchoEnabled(ctx.r(), s.iface)));
  }
  return lines.join('\n');
}

export function bfdShowSpecs(ctx: ShowCtx): CommandSpec[] {
  return [{
    id: 'show-bfd-neighbors',
    path: ['show', 'bfd', 'neighbors'],
    description: 'Display BFD sessions',
    modes: ['user', 'privileged'], minPrivilege: 1,
    options: [{ keyword: 'details', description: 'Detailed information' }],
    run: (_session, args) => bfdNeighborsView(ctx, args.details !== undefined),
  }];
}
