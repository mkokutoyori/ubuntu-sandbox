import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { openFortiConsole } from './fortiConsoleHarness';
import { FortiTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string, ctrl = false): KeyEvent =>
  ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

async function taper(d: FortiGate, commandes: readonly string[]): Promise<void> {
  for (const c of commandes) await d.executeCommand(c);
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await taper(pc as never, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
  ]);
  await taper(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system admin', 'edit "admin"', 'set password "Fortinet123"', 'next', 'end',
  ]);
  return { fgt, pc };
}

async function session(fgt: FortiGate): Promise<FortiTerminalSession> {
  return openFortiConsole(fgt, 'Fortinet123');
}

const vu = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');

async function tab(s: FortiTerminalSession, input: string, fois = 1): Promise<string> {
  s.setInput(input);
  for (let i = 0; i < fois; i++) { s.handleKey(key('Tab')); await tick(); }
  return s.input;
}

describe('Tab FAIT DEFILER les candidats, comme sur un vrai FortiGate', () => {
  it('un prefixe unique se complete', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    expect(await tab(s, 'conf')).toBe('config ');
    expect(await tab(s, 'config sy')).toBe('config system ');
  });

  it('apres une espace, Tab propose le premier candidat', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    const premier = await tab(s, 'config ');

    expect(premier).not.toBe('config ');
    expect(premier.startsWith('config ')).toBe(true);
  });

  it('deux Tab de suite donnent DEUX candidats differents', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    const premier = await tab(s, 'config ');
    const second = await tab(s, 'config ', 2);

    expect(second).not.toBe(premier);
  });

  it('le defilement revient au depart apres un tour complet', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);
    const total = fgt.cliTabCandidates('config ').length;
    expect(total).toBeGreaterThan(1);

    const premier = await tab(s, 'config ');
    expect(premier).not.toBe('config ');
    const apresUnTour = await tab(s, 'config ', total + 1);

    expect(apresUnTour).toBe(premier);
  });

  it('Maj+Tab defile en sens inverse', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);
    const candidats = fgt.cliTabCandidates('config ');

    s.setInput('config ');
    s.handleKey({ ...key('Tab'), shiftKey: true } as KeyEvent);
    await tick();

    expect(s.input).toBe(`${candidats[candidats.length - 1]} `.trimEnd());
  });

  it('un mot inconnu n est pas complete', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    expect(await tab(s, 'zorglub')).toBe('zorglub');
  });
});

describe('`get` et `show` proposent l arbre des objets', () => {
  it('`get ` propose les branches', async () => {
    const { fgt } = await laboratoire();

    const candidats = fgt.cliTabCandidates('get ');

    expect(candidats).toContain('get system');
    expect(candidats).toContain('get firewall');
    expect(candidats).toContain('get router');
  });

  it('`get sys` se complete', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    expect(await tab(s, 'get sys')).toBe('get system ');
  });

  it('`show ?` les DECRIT', async () => {
    const { fgt } = await laboratoire();

    const aide = fgt.cliHelp('show ');

    expect(aide).toMatch(/^system\s+\S/m);
    expect(aide).toMatch(/^firewall\s+\S/m);
  });

  it('un chemin qui n est pas une branche reste accepte', async () => {
    const { fgt } = await laboratoire();

    const vu1 = await fgt.executeCommand('get system status');
    const vu2 = await fgt.executeCommand('get router info routing-table all');

    expect(vu1).toContain('Version:');
    expect(vu2).toContain('Codes:');
  });
});

describe('`execute ping-options` regle le ping, et `view-settings` le rend', () => {
  it('les valeurs par defaut sont celles du vrai', async () => {
    const { fgt } = await laboratoire();

    const vu1 = await fgt.executeCommand('execute ping-options view-settings');

    expect(vu1).toContain('Ping Options:');
    expect(vu1).toMatch(/Repeat Count: 5/);
    expect(vu1).toMatch(/Data Size: 56/);
    expect(vu1).toMatch(/Timeout: 2/);
    expect(vu1).toMatch(/Source Address: auto/);
  });

  it('`repeat-count` change le NOMBRE de paquets envoyes', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('execute ping-options repeat-count 2');

    const vu1 = await fgt.executeCommand('execute ping 192.168.10.10');

    expect(vu1).toContain('2 packets transmitted');
    expect((vu1.match(/icmp_seq=/g) ?? []).length).toBe(2);
  });

  it('`data-size` change la taille annoncee ET celle des reponses', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('execute ping-options data-size 100');

    const vu1 = await fgt.executeCommand('execute ping 192.168.10.10');

    expect(vu1).toContain('100 data bytes');
    expect(vu1).toContain('108 bytes from');
  });

  it('une valeur hors domaine est refusee sans rien changer', async () => {
    const { fgt } = await laboratoire();

    const refus = await fgt.executeCommand('execute ping-options repeat-count 0');

    expect(refus).toMatch(/value parse error|Command fail/i);
    expect(await fgt.executeCommand('execute ping-options view-settings'))
      .toMatch(/Repeat Count: 5/);
  });

  it('une option que ce simulateur ne peut pas tenir est refusee en le disant', async () => {
    const { fgt } = await laboratoire();

    const refus = await fgt.executeCommand('execute ping-options pattern ff');

    expect(refus).toMatch(/exists on a real FortiGate/i);
    expect(refus).toMatch(/payload/i);
  });

  it('`source` choisit l adresse d origine', async () => {
    const { fgt, pc } = await laboratoire();
    await fgt.executeCommand('execute ping-options source 192.168.10.1');

    await fgt.executeCommand('execute ping 192.168.10.10');

    expect(await pc.executeCommand('ip neigh')).toContain('192.168.10.1');
  });
});

describe('`execute ping` DIFFUSE ses reponses au fil de l eau', () => {
  it('l entete parait AVANT la derniere reponse', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    s.setInput('execute ping 192.168.10.10');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 5; i++) await tick();

    const pendant = vu(s);
    expect(pendant).toContain('PING 192.168.10.10');
    expect(pendant).not.toContain('ping statistics');
  });

  it('la course va jusqu au bout et rend les statistiques', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('execute ping-options repeat-count 3');
    const s = await session(fgt);

    s.setInput('execute ping 192.168.10.10');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 400 && (s as unknown as { hasForegroundAsyncJob: boolean })
      .hasForegroundAsyncJob; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const sortie = vu(s);
    expect(sortie).toContain('3 packets transmitted, 3 packets received');
    expect((sortie.match(/icmp_seq=/g) ?? []).length).toBe(3);
  });

  it('Ctrl+C INTERROMPT et rend les statistiques de ce qui est parti', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('execute ping-options repeat-count 100');
    const s = await session(fgt);

    s.setInput('execute ping 192.168.10.10');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 5; i++) await tick();
    s.handleKey(key('c', true));
    for (let i = 0; i < 20; i++) await tick();

    const sortie = vu(s);
    expect(sortie).toContain('ping statistics');
    const transmis = Number(/(\d+) packets transmitted/.exec(sortie)?.[1] ?? '-1');
    expect(transmis).toBeGreaterThan(0);
    expect(transmis).toBeLessThan(100);
    expect((s as unknown as { hasForegroundAsyncJob: boolean }).hasForegroundAsyncJob)
      .toBe(false);
  });

  it('une cible sans route le dit tout de suite', async () => {
    const { fgt } = await laboratoire();
    const s = await session(fgt);

    s.setInput('execute ping 203.0.113.9');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20; i++) await tick();

    expect(vu(s)).toContain('No route to destination');
  });
});
