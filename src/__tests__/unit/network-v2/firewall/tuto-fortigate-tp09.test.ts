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
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

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
  await srvDmz.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next',
    'end',
    'config firewall policy', 'edit 2',
    'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
    'set service "PING" "HTTP"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function armerTrace(fgt: FortiGate, adresse: string): Promise<string[]> {
  return taper(fgt, [
    'diagnose debug reset',
    'diagnose debug flow filter clear',
    `diagnose debug flow filter addr ${adresse}`,
    'diagnose debug flow show function-name enable',
    'diagnose debug flow trace start 20',
    'diagnose debug enable',
  ]);
}

describe('TP 9 — voir le pare-feu penser avec `debug flow`', () => {
  it('etape 1 : les six commandes d\'armement sont acceptees', async () => {
    const { fgt } = await laboratoire();
    propre(await armerTrace(fgt, '192.168.20.10'));
  });

  it('etape 2 : un trafic AUTORISE trace la politique qui a decide', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    const trace = await fgt.executeCommand('diagnose debug enable');
    expect(trace).toMatch(/received a packet\(proto=6,\s*192\.168\.10\.10/);
    expect(trace).toContain('from port2');
    expect(trace).toContain('allocate a new session');
    expect(trace).toMatch(/find a route:.*port3/);
    expect(trace).toMatch(/Allowed by Policy-2/);
  });

  it('etape 2 : `show function-name enable` ajoute le nom de fonction', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    const trace = await fgt.executeCommand('diagnose debug enable');
    expect(trace).toContain('func=print_pkt_detail');
    expect(trace).toContain('func=fw_forward_handler');
  });

  it('etape 3 : un trafic REFUSE trace la politique 0', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    await pcLan.executeCommand('curl -sS https://192.168.20.10/');

    const trace = await fgt.executeCommand('diagnose debug enable');
    expect(trace).toMatch(/Denied by forward policy check \(policy 0\)/);
  });

  it('etape 4 : l\'arret du debogage est accepte et TAIT la trace', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    propre(await taper(fgt, [
      'diagnose debug disable',
      'diagnose debug flow trace stop',
      'diagnose debug reset',
    ]));

    await pcLan.executeCommand('curl -sS http://192.168.20.10/');
    expect(await fgt.executeCommand('diagnose debug flow filter'))
      .not.toContain('192.168.20.10');
  });

  it('etape 5 : une destination SANS route trace l\'absence de route', async () => {
    const { fgt } = await laboratoire();
    await armerTrace(fgt, '10.99.99.99');
    await fgt.executeCommand('execute ping 10.99.99.99');

    const trace = await fgt.executeCommand('diagnose debug enable');
    expect(trace).toContain('no route to destination');
  });

  it('etape 6 : les quatre criteres de filtre sont acceptes', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'diagnose debug flow filter clear',
      'diagnose debug flow filter saddr 192.168.10.10',
      'diagnose debug flow filter daddr 192.168.20.10',
      'diagnose debug flow filter proto 6',
      'diagnose debug flow filter port 80',
    ]));
  });

  it('etape 6 : `flow filter` sans argument RELIT le filtre', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'diagnose debug flow filter clear',
      'diagnose debug flow filter saddr 192.168.10.10',
      'diagnose debug flow filter daddr 192.168.20.10',
      'diagnose debug flow filter proto 6',
      'diagnose debug flow filter port 80',
    ]);
    const vu = await fgt.executeCommand('diagnose debug flow filter');
    expect(vu).not.toMatch(/Unknown action|parse error/i);
    expect(vu).toContain('192.168.10.10');
    expect(vu).toContain('192.168.20.10');
    expect(vu).toContain('6');
    expect(vu).toContain('80');
  });

  it('etape 6 : `filter clear` EFFACE vraiment le filtre', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'diagnose debug flow filter addr 192.168.20.10',
      'diagnose debug flow filter clear',
    ]);
    expect(await fgt.executeCommand('diagnose debug flow filter'))
      .not.toContain('192.168.20.10');
  });

  it('etape 7 : `sniffer packet` capture avec un filtre BPF', async () => {
    const { fgt, pcLan } = await laboratoire();
    await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10');

    const capture = await fgt.executeCommand(
      "diagnose sniffer packet any 'host 192.168.20.10' 4 10");
    expect(capture).not.toMatch(/Unknown action/i);
    expect(capture).toContain('192.168.20.10');
  });

  it('etape 7 : le niveau 4 NOMME l\'interface', async () => {
    const { fgt, pcLan } = await laboratoire();
    await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10');

    const niveau4 = await fgt.executeCommand(
      "diagnose sniffer packet any 'icmp' 4 10");
    expect(niveau4).toMatch(/port2|port3/);
  });

  it('etape 7 : un filtre BPF compose est honore', async () => {
    const { fgt, pcLan } = await laboratoire();
    await pingOnSimulatedClock(pcLan, 'ping -c 2 192.168.20.10');
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    const seulementIcmp = await fgt.executeCommand(
      "diagnose sniffer packet any 'host 192.168.10.10 and not port 80' 4 50");
    expect(seulementIcmp).not.toMatch(/\.80 /);
  });
  it('`show` LIT l\'option qu\'on lui nomme : `console` n\'est pas `function-name`', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    await fgt.executeCommand('diagnose debug flow show function-name disable');
    await fgt.executeCommand('diagnose debug flow show console enable');
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    expect(await fgt.executeCommand('diagnose debug enable'))
      .not.toContain('func=');
  });

  it('`show console disable` TAIT la trace, et la trace seule', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    await fgt.executeCommand('diagnose debug flow show console disable');
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    expect(await fgt.executeCommand('diagnose debug enable')).toBe('');
  });

  it('`show console` est ACTIVE par defaut — la trace se lit sans la demander', async () => {
    const { fgt, pcLan } = await laboratoire();
    await armerTrace(fgt, '192.168.20.10');
    await pcLan.executeCommand('curl -sS http://192.168.20.10/');

    expect(await fgt.executeCommand('diagnose debug enable'))
      .toMatch(/Allowed by Policy-2/);
  });

  it('une option de `show` sans valeur est REFUSEE, pas prise pour un `enable`', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('diagnose debug flow show function-name'))
      .toMatch(/parse error|Command fail/i);
  });

  it('`show iprope` NOMME la brique absente au lieu d\'etre acceptee sans effet', async () => {
    const { fgt } = await laboratoire();
    const refus = await fgt.executeCommand('diagnose debug flow show iprope enable');

    expect(refus).toMatch(/Command fail/i);
    expect(refus).toContain('iprope');
  });
});
