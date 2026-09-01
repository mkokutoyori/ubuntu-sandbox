import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { MODES_INTERFACE } from './CiscoConfigCommands';

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

const BFD_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'bfd interval': {
    name: 'valeurs', type: 'REST',
    description: 'Transmit interval in milliseconds, then min_rx and multiplier',
    alternatives: [
      { keyword: '<1-9999>', description: 'Transmit interval in milliseconds' },
      { keyword: 'min_rx', description: 'Minimum receive interval in milliseconds' },
      { keyword: 'multiplier', description: 'Detection multiplier' },
    ],
  },
  'bfd neighbor': {
    name: 'voisin', type: 'REST', description: 'Address of the BFD neighbour',
    alternatives: [{ keyword: 'A.B.C.D', description: 'Address of the BFD neighbour' }],
  },
};

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
  return [...bfdEchoSpecs(ctx), ...specsFromTrieRegistrations(
    (collector) => buildBfdInterfaceCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: MODES_INTERFACE, minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => BFD_ARGUMENTS[path],
    },
  )];
}

export function buildBfdInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  trie.registerGreedy('bfd interval', 'BFD timers (ms)', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const pairs: Record<string, number> = {};
    for (let i = 0; i + 1 < args.length; i += 2) {
      const k = args[i].toLowerCase();
      const v = parseInt(args[i + 1], 10);
      if (!Number.isNaN(v)) pairs[k] = v;
    }
    const tx = pairs['interval'] ?? 1000;
    const rx = pairs['min_rx'] ?? pairs['min-rx'] ?? 1000;
    const mult = pairs['multiplier'] ?? 3;
    for (const port of ctx.selectedPorts()) {
      const sessions = a.listSessions().filter((s) => s.iface === port);
      for (const s of sessions) a.setTimers(port, s.neighborIp, tx, rx, mult);
    }
    return '';
  });

  trie.registerGreedy('bfd neighbor', 'BFD static neighbor', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const ip = args[0];
    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return '% Invalid neighbor';
    for (const port of ctx.selectedPorts()) a.ensureSession(port, ip);
    return '';
  });

  trie.registerGreedy('no bfd neighbor', 'Remove BFD neighbor', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const ip = args[0];
    if (!ip) return '';
    for (const port of ctx.selectedPorts()) a.removeSession(port, ip);
    return '';
  });
}

export function registerBfdShowCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('show bfd neighbors', 'Display BFD sessions', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const sessions = a.listSessions();
    if (args.includes('details') || args.includes('detail')) {
      return sessions.map((s) => [
        `NeighAddr ${s.neighborIp} LD/RD ${s.localDiscriminator}/${s.remoteDiscriminator}`,
        `  Interface ${s.iface}`,
        `  State: ${s.state.charAt(0).toUpperCase() + s.state.slice(1)}`,
        `  Local Diag: ${s.localDiag}`,
        `  Tx interval ${Math.round(s.desiredMinTxUs / 1000)} ms, Rx ${Math.round(s.requiredMinRxUs / 1000)} ms`,
        `  Detect multiplier ${s.detectMultiplier}`,
        `  Type: single-hop, Mode: async (echo not supported)`,
      ].join('\n')).join('\n');
    }
    const header = 'NeighAddr        LD/RD     RH/RS   Holdown(mult) State     Int';
    const rows = sessions.map((s) =>
      `${s.neighborIp.padEnd(17)}${(s.localDiscriminator + '/' + s.remoteDiscriminator).padEnd(10)}` +
      `${(s.state === 'up' ? '1/Up' : '0/' + s.state).padEnd(8)}` +
      `${(Math.round(s.desiredMinTxUs / 1000) * s.detectMultiplier + '(' + s.detectMultiplier + ')').padEnd(15)}` +
      `${(s.state.charAt(0).toUpperCase() + s.state.slice(1)).padEnd(10)}${s.iface}`);
    return [header, ...rows].join('\n');
  });
}
