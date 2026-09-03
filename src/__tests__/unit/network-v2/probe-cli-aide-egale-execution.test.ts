import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cli {
  executeCommand(c: string): Promise<string> | string;
  cliHelp(s: string): string;
}

function entries(help: string): Array<{ keyword: string; description: string }> {
  return help.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.search(/\s{2,}/);
    return i < 0
      ? { keyword: l, description: '' }
      : { keyword: l.slice(0, i), description: l.slice(i).trim() };
  });
}

const IS_ARGUMENT = /^[<A-Z]/;
const isPlaceholder = (mot: string): boolean =>
  IS_ARGUMENT.test(mot) || (mot.includes(':') && !mot.endsWith(':'));
const DEPTH = 3;

/**
 * Les commandes qu'on ne peut pas EXECUTER dans un balayage : elles
 * changent le mode, coupent la session, ou emportent la machine.
 */
const NE_PAS_EXECUTER = new Set([
  'exit', 'end', 'logout', 'disable', 'enable', 'reload', 'quit',
  'configure', 'interface', 'line', 'router', 'vlan', 'do',
  'crypto', 'archive', 'write', 'copy', 'erase', 'delete', 'more',
  'setup', 'connect', 'telnet', 'ssh', 'ping', 'traceroute', 'debug',
  'undebug', 'clear', 'terminal', 'send', 'test', 'tclsh', 'monitor',
  'route-map', 'class-map', 'policy-map', 'ip', 'no', 'default',
  'banner', 'boot', 'help', 'menu', 'name-connection', 'lock', 'resume',
  'start-chat', 'where', 'mrinfo', 'mstat', 'mtrace', 'pad', 'rlogin',
  'systat', 'x28', 'x3',
]);

async function balayer(
  dev: Cli,
  mode: readonly string[],
  verdict: (prefix: string, keyword: string, help: string) => Promise<string | null>,
): Promise<string[]> {
  const fautes: string[] = [];
  const visit = async (prefix: string, left: number): Promise<void> => {
    if (left === 0) return;
    await dev.executeCommand('end');
    for (const c of mode) await dev.executeCommand(c);
    const help = dev.cliHelp(prefix);
    if (help.includes('Invalid input') || help.includes('Ambiguous') || help.trim() === '') return;
    for (const e of entries(help)) {
      if (e.keyword.startsWith('%') || isPlaceholder(e.keyword)) continue;
      if (e.keyword !== '<cr>' && NE_PAS_EXECUTER.has(e.keyword.toLowerCase())) continue;
      const faute = await verdict(prefix, e.keyword, help);
      if (faute) fautes.push(faute);
      if (e.keyword === '<cr>') continue;
      await visit(`${prefix}${e.keyword} `, left - 1);
    }
  };
  await visit('', DEPTH);
  return fautes;
}

const MODES: Array<[string, string[]]> = [
  ['privileged EXEC', []],
  ['global config', ['configure terminal']],
  ['config-if', ['configure terminal', 'interface GigabitEthernet0/0']],
  ['config-line', ['configure terminal', 'line vty 0 4']],
  ['config-router (RIP)', ['configure terminal', 'router rip']],
  ['config-router (OSPF)', ['configure terminal', 'router ospf 1']],
];

/**
 * Le commutateur passe par le MEME balayage que le routeur.
 *
 * Il n'y passait pas, et l'invariant s'arretait donc a la moitie du parc
 * — ce qui se voyait : `spanning-tree ?` y offrait cinq mots que
 * l'analyseur refuse, `show lacp` et `show interfaces etherchannel`
 * etaient annonces et refuses, et `duplex` seul repondait « ce mot
 * n'existe pas » a un mot que la machine connait. Ses modes sont les
 * siens : pas de `router rip`, mais un `config-vlan`.
 */
const MODES_COMMUTATEUR: Array<[string, string[]]> = [
  ['privileged EXEC', []],
  ['global config', ['configure terminal']],
  ['config-if', ['configure terminal', 'interface GigabitEthernet0/1']],
  ['config-line', ['configure terminal', 'line vty 0 4']],
  ['config-vlan', ['configure terminal', 'vlan 10']],
];

async function routeur(): Promise<CiscoRouter & Cli> {
  const r = new CiscoRouter('R1') as CiscoRouter & Cli;
  r.powerOn?.();
  await r.executeCommand('enable');
  return r;
}

async function commutateur(): Promise<CiscoSwitch & Cli> {
  const s = new CiscoSwitch('switch-cisco', 'S1') as CiscoSwitch & Cli;
  s.powerOn?.();
  await s.executeCommand('enable');
  return s;
}

describe('un mot-clé que `?` propose est un mot-clé qui existe', () => {
  for (const [nom, mode] of MODES) {
    it(nom, async () => {
      const r = await routeur();
      const fautes = await balayer(r, mode, async (prefix, keyword) => {
        if (keyword === '<cr>') return null;
        const cmd = `${prefix}${keyword}`;
        await r.executeCommand('end');
        for (const c of mode) await r.executeCommand(c);
        const out = String(await r.executeCommand(cmd));
        return out.includes('% Invalid input detected') ? `${nom}: ${cmd}` : null;
      });
      expect(fautes, fautes.join('\n')).toEqual([]);
    }, 120_000);
  }
});

describe('sur un COMMUTATEUR aussi, un mot que `?` propose existe', () => {
  for (const [nom, mode] of MODES_COMMUTATEUR) {
    it(nom, async () => {
      const s = await commutateur();
      const fautes = await balayer(s, mode, async (prefix, keyword) => {
        if (keyword === '<cr>') return null;
        const cmd = `${prefix}${keyword}`;
        await s.executeCommand('end');
        for (const c of mode) await s.executeCommand(c);
        const out = String(await s.executeCommand(cmd));
        return out.includes('% Invalid input detected') ? `${nom}: ${cmd}` : null;
      });
      expect(fautes, fautes.join('\n')).toEqual([]);
    }, 120_000);
  }
});

describe('un nœud qui annonce <cr> est un nœud qui s\'exécute', () => {
  for (const [nom, mode] of MODES) {
    it(nom, async () => {
      const r = await routeur();
      const fautes = await balayer(r, mode, async (prefix, keyword) => {
        if (keyword !== '<cr>') return null;
        const cmd = prefix.trim();
        if (!cmd) return null;
        const tete = cmd.split(' ')[0].toLowerCase();
        if (NE_PAS_EXECUTER.has(tete)) return null;
        await r.executeCommand('end');
        for (const c of mode) await r.executeCommand(c);
        const out = String(await r.executeCommand(cmd));
        return out.includes('% Incomplete command') ? `${nom}: ${cmd}` : null;
      });
      expect(fautes, fautes.join('\n')).toEqual([]);
    }, 120_000);
  }
});
