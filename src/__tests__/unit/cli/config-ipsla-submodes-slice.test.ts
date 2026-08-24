import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  return device;
}

async function dans(entree: readonly string[]): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', ...entree]) {
    await device.executeCommand(c);
  }
  return device;
}

function shellDe(device: Cli): Record<string, unknown> {
  return (device as unknown as { shell: Record<string, unknown> }).shell;
}

const SLA = ['ip sla 1'];
const ECHO = [...SLA, 'icmp-echo 10.0.0.9'];
const JITTER = [...SLA, 'udp-jitter 10.0.0.9 5000'];
const ICMPJITTER = [...SLA, 'icmp-jitter 10.0.0.9'];
const UDP = [...SLA, 'udp-echo 10.0.0.9 7'];
const TCP = [...SLA, 'tcp-connect 10.0.0.9 80'];
const HTTP = [...SLA, 'http get http://10.0.0.9/'];
const DNS = [...SLA, 'dns exemple.local name-server 10.0.0.53'];
const PATHECHO = [...SLA, 'path-echo 10.0.0.9'];
const RAW = [...HTTP, 'http-raw-request'];

describe('les dix arbres IP SLA sont VIDES', () => {
  it.each(['configIpSlaTrie', 'configIpSlaHttpRawTrie'])(
    '%s ne porte plus aucun chemin', (champ) => {
      expect((shellDe(nu())[champ] as CommandTrie).enumerateExecutablePaths())
        .toEqual([]);
    });

  it.each([
    'config-ipsla-echo', 'config-ipsla-icmpjitter', 'config-ipsla-jitter',
    'config-ipsla-udp', 'config-ipsla-tcp', 'config-ipsla-http',
    'config-ipsla-dns', 'config-ipsla-pathecho',
  ])('l\'arbre de type %s ne porte plus aucun chemin', (mode) => {
    const tries = shellDe(nu()).configIpSlaTypeTries as Record<string, CommandTrie>;
    expect(tries[mode].enumerateExecutablePaths()).toEqual([]);
  });

  it('un arbre range dans une TABLE est elague comme un champ', () => {
    const tries = shellDe(nu()).configIpSlaTypeTries as Record<string, CommandTrie>;
    const total = Object.values(tries)
      .reduce((somme, trie) => somme + trie.enumerateExecutablePaths().length, 0);
    expect(total).toBe(0);
  });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [SLA, 'icmp-echo 10.0.0.9'],
  [SLA, 'icmp-echo 10.0.0.9 source-interface GigabitEthernet0/0'],
  [SLA, 'icmp-jitter 10.0.0.9 num-packets 20 interval 30'],
  [SLA, 'udp-echo 10.0.0.9 7'],
  [SLA, 'udp-jitter 10.0.0.9 5000 codec g711ulaw'],
  [SLA, 'tcp-connect 10.0.0.9 80'],
  [SLA, 'http get http://10.0.0.9/'],
  [SLA, 'http raw http://10.0.0.9/'],
  [SLA, 'dns exemple.local name-server 10.0.0.53'],
  [SLA, 'path-echo 10.0.0.9'],
  [ECHO, 'frequency 60'],
  [ECHO, 'timeout 5000'],
  [ECHO, 'threshold 2000'],
  [ECHO, 'request-data-size 128'],
  [ECHO, 'tos 160'],
  [ECHO, 'verify-data'],
  [ECHO, 'no verify-data'],
  [ECHO, 'tag un essai'],
  [ECHO, 'owner administrateur reseau'],
  [ECHO, 'history lives-kept 2'],
  [ECHO, 'history buckets-kept 30'],
  [ECHO, 'history filter all'],
  [ECHO, 'history distributions-of-statistics-kept 5'],
  [ECHO, 'history statistics-distribution-interval 20'],
  [ECHO, 'history hours-of-statistics-kept 3'],
  [JITTER, 'precision microseconds'],
  [JITTER, 'frequency 30'],
  [ICMPJITTER, 'precision milliseconds'],
  [UDP, 'frequency 10'],
  [TCP, 'timeout 3000'],
  [HTTP, 'frequency 120'],
  [HTTP, 'http-raw-request'],
  [DNS, 'frequency 15'],
  [PATHECHO, 'request-data-size 64'],
  [RAW, 'exit'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('le reglage atteint son moteur', () => {
  it('l\'operation garde son type, sa cible et sa frequence', async () => {
    const device = await dans(ECHO);
    await device.executeCommand('frequency 60');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show ip sla configuration 1');
    expect(vue).toContain('10.0.0.9');
    expect(vue).toContain('60');
  });

  it('`no verify-data` defait ce que `verify-data` a pose', async () => {
    const device = await dans(ECHO);
    await device.executeCommand('verify-data');
    await device.executeCommand('no verify-data');
    await device.executeCommand('end');
    expect(await device.executeCommand('show ip sla configuration 1'))
      .not.toContain('Invalid input');
  });

  it('le type d\'operation ressort dans la configuration', async () => {
    const device = await dans(TCP);
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('tcp-connect');
  });
});

describe('`?` annonce l\'intervalle que la commande accepte vraiment', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [SLA, 'icmp-echo ', 'A.B.C.D'],
    [SLA, 'udp-echo 10.0.0.9 ', '<1-65535>'],
    [SLA, 'http ', 'Build the request from the URL'],
    [SLA, '', 'ICMP Jitter Operation'],
    [ECHO, 'frequency ', '<1-604800>'],
    [ECHO, 'timeout ', '<0-604800000>'],
    [ECHO, 'threshold ', '<0-2147483647>'],
    [ECHO, 'request-data-size ', '<0-16384>'],
    [ECHO, 'tos ', '<0-255>'],
    [ECHO, 'tag ', 'LINE'],
    [ECHO, 'history ', 'Number of history buckets kept'],
    [ECHO, 'history buckets-kept ', '<1-60>'],
    [ECHO, 'history lives-kept ', '<0-2>'],
    [ECHO, 'history filter ', 'Keep the operations over the threshold'],
    [JITTER, 'precision ', 'Keep timestamps to the microsecond'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it.each([
    [ECHO, 'frequency 604801'],
    [ECHO, 'tos 256'],
    [ECHO, 'request-data-size 16385'],
    [ECHO, 'history lives-kept 3'],
    [ECHO, 'history buckets-kept 61'],
  ] as ReadonlyArray<readonly [readonly string[], string]>)(
    '%s › `%s` est refuse au caret', async (entree, commande) => {
      expect(await (await dans(entree)).executeCommand(commande))
        .toContain('Invalid input detected');
    });

  it('une precision inconnue est refusee au caret', async () => {
    expect(await (await dans(JITTER)).executeCommand('precision nanoseconds'))
      .toContain('Invalid input detected');
  });
});

describe('un type ne porte que les reglages qui sont les siens', () => {
  it('`precision` existe sous la gigue et pas sous l\'echo', async () => {
    expect((await dans(JITTER)).cliHelp('')).toContain('Timestamp precision');
    expect((await dans(ECHO)).cliHelp('')).not.toContain('Timestamp precision');
  });

  it('`http-raw-request` existe sous HTTP et pas ailleurs', async () => {
    expect((await dans(HTTP)).cliHelp('')).toContain('Enter HTTP raw request mode');
    expect((await dans(TCP)).cliHelp('')).not.toContain('Enter HTTP raw request mode');
  });

  it('`request-data-size` n\'existe pas sous tcp-connect', async () => {
    expect(await (await dans(TCP)).executeCommand('request-data-size 64'))
      .toContain('Invalid input');
  });

  it('`vrf` dit ce qui manque au lieu de faire semblant', async () => {
    expect(await (await dans(ECHO)).executeCommand('vrf CLIENT'))
      .toContain('not supported in this simulator');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`freq` se complete dans un sous-mode de type', async () => {
    expect((await dans(ECHO)).cliTabCandidates('freq')).toEqual(['frequency']);
  });

  it('`history buck` garde son mot', async () => {
    expect((await dans(ECHO)).cliTabCandidates('history buck'))
      .toEqual(['history buckets-kept']);
  });

  it('`icmp-e` se complete dans le sous-mode de l\'operation', async () => {
    expect((await dans(SLA)).cliTabCandidates('icmp-e')).toEqual(['icmp-echo']);
  });
});
