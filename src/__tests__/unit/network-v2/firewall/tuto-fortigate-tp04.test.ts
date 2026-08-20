import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

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
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -100, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 100, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function tp4(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system interface',
    'edit port2',
    'set alias "LAN"', 'set role lan', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0',
    'set allowaccess ping https ssh',
    'set description "Reseau des postes utilisateurs"',
    'set status up', 'next',
    'edit port3',
    'set alias "DMZ"', 'set role dmz', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0',
    'set allowaccess ping',
    'set description "Serveurs publies"',
    'set status up', 'next',
    'end',
  ]);
}

describe('TP 4 — adresser le laboratoire', () => {
  it('etapes 1-2 : les deux interfaces se configurent mot pour mot', async () => {
    const { fgt } = await laboratoire();
    propre(await tp4(fgt));
    const conf = await fgt.executeCommand('show system interface port2');
    expect(conf).toContain('set alias "LAN"');
    expect(conf).toContain('set role lan');
    expect(conf).toContain('set ip 192.168.10.1 255.255.255.0');
    expect(conf).toContain('set description "Reseau des postes utilisateurs"');
  });

  it('etape 3 : `get system interface physical` montre les trois etats', async () => {
    const { fgt } = await laboratoire();
    await tp4(fgt);
    const vue = await fgt.executeCommand('get system interface physical');
    expect(vue).toContain('port2');
    expect(vue).toContain('192.168.10.1 255.255.255.0');
    expect(vue).toContain('port3');
    expect(vue).toContain('192.168.20.1 255.255.255.0');
    expect(vue).toMatch(/status: up/);
  });

  it('etape 3 : `diagnose ip address list` numerote les interfaces', async () => {
    const { fgt } = await laboratoire();
    await tp4(fgt);
    const vue = await fgt.executeCommand('diagnose ip address list');
    expect(vue).toContain('192.168.10.1');
    expect(vue).toContain('devname=port2');
    expect(vue).toContain('192.168.20.1');
    expect(vue).toContain('devname=port3');
  });

  it('etape 4 : le PC du LAN pingue sa passerelle', async () => {
    const { fgt, pcLan } = await laboratoire();
    await tp4(fgt);
    expect(await pingOnSimulatedClock(pcLan, 'ping -c 3 192.168.10.1'))
      .toMatch(/ 0% packet loss/);
  });

  it('etape 5 : le serveur de la DMZ pingue sa passerelle', async () => {
    const { fgt, srvDmz } = await laboratoire();
    await tp4(fgt);
    expect(await pingOnSimulatedClock(srvDmz, 'ping -c 3 192.168.20.1'))
      .toMatch(/ 0% packet loss/);
  });

  it('etape 6 : LAN vers DMZ ECHOUE, faute de politique', async () => {
    const { fgt, pcLan } = await laboratoire();
    await tp4(fgt);
    expect(await pingOnSimulatedClock(pcLan, 'ping -c 3 192.168.20.10'))
      .toMatch(/ 100% packet loss/);
  });

  it('etape 6 : la route EXISTE pourtant, le refus vient de la politique', async () => {
    const { fgt } = await laboratoire();
    await tp4(fgt);
    const routes = await fgt.executeCommand('get router info routing-table all');
    expect(routes).toContain('192.168.10.0/24');
    expect(routes).toContain('192.168.20.0/24');
  });

  it('etape 7 : un VLAN se cree sur un port physique', async () => {
    const { fgt } = await laboratoire();
    await tp4(fgt);
    propre(await taper(fgt, [
      'config system interface',
      'edit "VLAN-COMPTA"',
      'set vdom "root"',
      'set interface "port2"',
      'set vlanid 30',
      'set ip 192.168.30.1 255.255.255.0',
      'set allowaccess ping',
      'set role lan',
      'set alias "Comptabilite"',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show system interface VLAN-COMPTA');
    expect(conf).toContain('set vlanid 30');
    expect(conf).toContain('set interface "port2"');
    expect(conf).toContain('set ip 192.168.30.1 255.255.255.0');
  });

  it('etape 7 : `show ... | grep -A3` rend le contexte demande', async () => {
    const { fgt } = await laboratoire();
    await tp4(fgt);
    await taper(fgt, [
      'config system interface', 'edit "VLAN-COMPTA"',
      'set interface "port2"', 'set vlanid 30', 'next', 'end',
    ]);
    const vue = await fgt.executeCommand('show system interface | grep -A3 "VLAN-COMPTA"');
    expect(vue).toContain('VLAN-COMPTA');
    expect(vue).toContain('set vlanid 30');
    expect(vue).not.toContain('192.168.10.1');
  });

  it('etape 8 : `set status down` COUPE vraiment l\'interface', async () => {
    const { fgt, srvDmz } = await laboratoire();
    await tp4(fgt);
    expect(await pingOnSimulatedClock(srvDmz, 'ping -c 2 192.168.20.1'))
      .toMatch(/ 0% packet loss/);

    propre(await taper(fgt, [
      'config system interface', 'edit port3', 'set status down', 'next', 'end',
    ]));
    expect(await fgt.executeCommand('get system interface physical'))
      .toMatch(/status: down/);
    expect(await pingOnSimulatedClock(srvDmz, 'ping -c 2 192.168.20.1'))
      .toMatch(/ 100% packet loss/);

    await taper(fgt, [
      'config system interface', 'edit port3', 'set status up', 'next', 'end',
    ]);
    expect(await pingOnSimulatedClock(srvDmz, 'ping -c 2 192.168.20.1'))
      .toMatch(/ 0% packet loss/);
  });

  it('etape 2 : `set allowaccess` VIDE ferme tout, ping compris', async () => {
    const { fgt, srvDmz } = await laboratoire();
    await tp4(fgt);
    propre(await taper(fgt, [
      'config system interface', 'edit port3', 'unset allowaccess', 'next', 'end',
    ]));
    expect(fgt.allowedAccessOn('port3')).toHaveLength(0);
    expect(await pingOnSimulatedClock(srvDmz, 'ping -c 2 192.168.20.1'))
      .toMatch(/ 100% packet loss/);
  });
});
