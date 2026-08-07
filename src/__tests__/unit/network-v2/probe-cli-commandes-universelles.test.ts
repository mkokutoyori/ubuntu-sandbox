import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

async function routeur(): Promise<CiscoRouter & Cli> {
  const r = new CiscoRouter('R1') as CiscoRouter & Cli;
  r.powerOn?.();
  await r.executeCommand('enable');
  return r;
}

function motsCles(help: string): string[] {
  return help.split('\n').map((l) => l.trim().split(/\s{2,}/)[0]).filter(Boolean);
}

const MODES: Array<[string, string[], string[]]> = [
  ['privileged EXEC', [], ['end', 'exit', 'help']],
  ['global config', ['configure terminal'], ['default', 'do', 'end', 'exit', 'help']],
  ['config-if', ['configure terminal', 'interface GigabitEthernet0/0'],
    ['default', 'do', 'end', 'exit', 'help']],
  ['config-line', ['configure terminal', 'line vty 0 4'], ['default', 'do', 'end', 'exit', 'help']],
  ['config-router', ['configure terminal', 'router rip'], ['default', 'do', 'end', 'exit', 'help']],
  ['config-route-map', ['configure terminal', 'route-map RM permit 10'],
    ['default', 'do', 'end', 'exit', 'help']],
  ['config-dhcp', ['configure terminal', 'ip dhcp pool P'], ['default', 'do', 'end', 'exit', 'help']],
];

describe('les commandes universelles sont proposées partout où elles marchent', () => {
  for (const [nom, mode, attendus] of MODES) {
    it(nom, async () => {
      const r = await routeur();
      for (const c of mode) await r.executeCommand(c);
      const kws = motsCles(r.cliHelp(''));
      for (const u of attendus) {
        expect(kws, `${nom}: \`?\` doit proposer \`${u}\``).toContain(u);
      }
    }, 30_000);
  }

  it('`help` décrit le système d\'aide, en EXEC comme en configuration', async () => {
    const r = await routeur();
    const exec = String(await r.executeCommand('help'));
    expect(exec).toContain('Help may be requested at any point');
    expect(exec).not.toContain('Translating');
    await r.executeCommand('configure terminal');
    expect(String(await r.executeCommand('help'))).toContain('Two styles of help are provided');
  }, 30_000);

  it('`default <commande>` remet vraiment à zéro', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    expect(String(await r.executeCommand('do show ip interface brief'))).toContain('10.0.0.1');
    expect(String(await r.executeCommand('default ip address'))).toBe('');
    expect(String(await r.executeCommand('do show ip interface brief'))).not.toContain('10.0.0.1');
  }, 30_000);

  it('`do` seul est une commande incomplète, pas une erreur de syntaxe', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    expect(String(await r.executeCommand('do'))).toBe('% Incomplete command.');
  }, 30_000);
});

describe('le `|` est un nœud de l\'arbre, et ses écritures écrivent', () => {
  it('`| ?` liste les modificateurs d\'IOS', async () => {
    const r = await routeur();
    const help = r.cliHelp('show running-config | ');
    for (const m of ['append', 'begin', 'count', 'exclude', 'include', 'redirect', 'section', 'tee']) {
      expect(help, `| ? doit proposer ${m}`).toContain(m);
    }
    expect(r.cliHelp('show running-config | re')).toContain('redirect');
  }, 30_000);

  it('`redirect` crée le fichier et n\'affiche rien', async () => {
    const r = await routeur();
    const out = String(await r.executeCommand('show running-config | redirect flash:cfg.txt'));
    expect(out).not.toContain('Building configuration');
    expect(String(await r.executeCommand('dir flash:'))).toContain('cfg.txt');
    expect(String(await r.executeCommand('more flash:cfg.txt'))).toContain('hostname R1');
  }, 30_000);

  it('`append` ajoute au lieu de remplacer', async () => {
    const r = await routeur();
    await r.executeCommand('show running-config | redirect flash:cfg.txt');
    await r.executeCommand('show version | append flash:cfg.txt');
    const contenu = String(await r.executeCommand('more flash:cfg.txt'));
    expect(contenu).toContain('hostname R1');
    expect(contenu).toContain('Cisco IOS Software');
  }, 30_000);

  it('`tee` écrit ET affiche — c\'est ce qui le distingue', async () => {
    const r = await routeur();
    const out = String(await r.executeCommand('show clock | tee flash:t.txt'));
    expect(out).toMatch(/UTC/);
    expect(String(await r.executeCommand('more flash:t.txt'))).toMatch(/UTC/);
  }, 30_000);
});

describe('une console est un port série, une vty une session réseau', () => {
  const SERIE = ['speed 9600', 'databits 8', 'parity none', 'flowcontrol hardware'];
  const RESEAU = ['access-class 10 in'];

  it('la vty refuse les réglages de port série', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    for (const c of SERIE) {
      expect(String(await r.executeCommand(c)), c).toContain('% Invalid input detected');
    }
    for (const c of RESEAU) expect(String(await r.executeCommand(c)), c).toBe('');
    const kws = motsCles(r.cliHelp(''));
    expect(kws).toContain('access-class');
    expect(kws).not.toContain('speed');
    expect(kws).not.toContain('databits');
  }, 30_000);

  it('la console refuse les réglages de session réseau', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('line console 0');
    for (const c of SERIE) expect(String(await r.executeCommand(c)), c).toBe('');
    for (const c of RESEAU) {
      expect(String(await r.executeCommand(c)), c).toContain('% Invalid input detected');
    }
    const kws = motsCles(r.cliHelp(''));
    expect(kws).toContain('speed');
    expect(kws).toContain('parity');
    expect(kws).not.toContain('access-class');
    expect(kws).not.toContain('rotary');
  }, 30_000);

  it('l\'auxiliaire est un port série qui accepte aussi `rotary`', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('line aux 0');
    for (const c of SERIE) expect(String(await r.executeCommand(c)), c).toBe('');
    expect(String(await r.executeCommand('rotary 1'))).toBe('');
    expect(String(await r.executeCommand('access-class 10 in'))).toContain('% Invalid input detected');
  }, 30_000);
});
