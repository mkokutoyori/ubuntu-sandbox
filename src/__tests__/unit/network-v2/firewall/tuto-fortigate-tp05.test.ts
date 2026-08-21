import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const wan = new LinuxServer('linux-server', 'ISP1', 200, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -100, 0);

  new Cable('wan').connect(fgt.getPort('port1')!, wan.getPort('eth0')!);
  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);

  await taper(wan, [
    'ip addr add 192.168.100.1/24 dev eth0', 'ip link set eth0 up',
  ]);
  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
  ]);
  return { fgt, wan, pcLan };
}

async function routePrincipale(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config router static', 'edit 1',
    'set dst 0.0.0.0 0.0.0.0',
    'set gateway 192.168.100.1',
    'set device "port1"',
    'set distance 10',
    'set priority 5',
    'set comment "Defaut - operateur principal"',
    'next', 'end',
  ]);
}

async function routeSecours(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config router static', 'edit 2',
    'set dst 0.0.0.0 0.0.0.0',
    'set gateway 192.168.10.254',
    'set device "port2"',
    'set distance 20',
    'set comment "Defaut - secours (fictif)"',
    'next', 'end',
  ]);
}

describe('TP 5 — router, casser, observer', () => {
  it('etape 1 : les routes connectees existent sans qu\'on les declare', async () => {
    const { fgt } = await laboratoire();
    const vue = await fgt.executeCommand('get router info routing-table all');
    expect(vue).toMatch(/C\s+\*?>?\s*192\.168\.10\.0\/24 is directly connected, port2/);
    expect(vue).toMatch(/C\s+\*?>?\s*192\.168\.20\.0\/24 is directly connected, port3/);
  });

  it('etape 1 : `routing-table static` ne rend QUE les statiques', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    const vue = await fgt.executeCommand('get router info routing-table static');
    expect(vue).not.toMatch(/Unknown action/i);
    expect(vue).toContain('0.0.0.0/0');
    expect(vue).not.toContain('directly connected');
  });

  it('etape 2 : `routing-table database` porte son entete de codes', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    const vue = await fgt.executeCommand('get router info routing-table database');
    expect(vue).not.toMatch(/Unknown action/i);
    expect(vue).toMatch(/Codes: K - kernel, C - connected, S - static/);
    expect(vue).toMatch(/> - selected route, \* - FIB route/);
    expect(vue).toMatch(/S\s+\*>\s*0\.0\.0\.0\/0 \[10\/0\] via 192\.168\.100\.1, port1/);
  });

  it('etape 3 : la route par defaut se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await routePrincipale(fgt));
    const conf = await fgt.executeCommand('show router static 1');
    expect(conf).toContain('set gateway 192.168.100.1');
    expect(conf).toContain('set device "port1"');
    expect(conf).toContain('set distance 10');
    expect(conf).toContain('set priority 5');
    expect(conf).toContain('set comment "Defaut - operateur principal"');
  });

  it('etape 4 : le pare-feu pingue sa passerelle par la route declaree', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    expect(await fgt.executeCommand('execute ping 192.168.100.1'))
      .toMatch(/0% packet loss/);
  });

  it('etape 6 : la flottante est dans la BASE et pas dans la TABLE', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    propre(await routeSecours(fgt));

    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table).toContain('via 192.168.100.1');
    expect(table).not.toContain('192.168.10.254');

    const base = await fgt.executeCommand('get router info routing-table database');
    expect(base).toContain('192.168.100.1');
    expect(base).toContain('192.168.10.254');
    expect(base).toMatch(/S\s+\*>\s*0\.0\.0\.0\/0 \[10\/0\]/);
    expect(base).toMatch(/S\s+ {2}0\.0\.0\.0\/0 \[20\/0\]/);
  });

  it('etapes 7-8 : couper port1 fait BASCULER la route par defaut', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    await routeSecours(fgt);

    await taper(fgt, [
      'config system interface', 'edit port1', 'set status down', 'next', 'end',
    ]);

    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table).not.toContain('via 192.168.100.1');
    expect(table).toContain('via 192.168.10.254');

    const base = await fgt.executeCommand('get router info routing-table database');
    expect(base).toMatch(/S\s+\*>\s*0\.0\.0\.0\/0 \[20\/0\]/);
  });

  it('etape 9 : remettre port1 fait REVENIR la principale', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    await routeSecours(fgt);

    await taper(fgt, [
      'config system interface', 'edit port1', 'set status down', 'next', 'end',
    ]);
    await taper(fgt, [
      'config system interface', 'edit port1', 'set status up', 'next', 'end',
    ]);

    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table).toContain('via 192.168.100.1');
    expect(table).not.toContain('via 192.168.10.254');
  });

  it('etape 10 : supprimer la route de secours la retire des deux vues', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    await routeSecours(fgt);
    propre(await taper(fgt, ['config router static', 'delete 2', 'end']));

    expect(await fgt.executeCommand('get router info routing-table database'))
      .not.toContain('192.168.10.254');
  });

  it('la PRIORITE departage deux routes de meme distance', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    propre(await taper(fgt, [
      'config router static', 'edit 3',
      'set dst 0.0.0.0 0.0.0.0',
      'set gateway 192.168.10.254', 'set device "port2"',
      'set distance 10', 'set priority 30',
      'next', 'end',
    ]));

    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table).toContain('via 192.168.100.1');
    expect(table).not.toContain('via 192.168.10.254');
  });

  it('etape 4 : `execute traceroute` existe', async () => {
    const { fgt } = await laboratoire();
    await routePrincipale(fgt);
    const out = await fgt.executeCommand('execute traceroute 192.168.100.1');
    expect(out).not.toMatch(/Unknown action|is not implemented/i);
    expect(out).toContain('192.168.100.1');
  });
});
