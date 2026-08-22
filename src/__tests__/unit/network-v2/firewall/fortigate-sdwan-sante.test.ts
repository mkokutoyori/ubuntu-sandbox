import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

const SONDE_A = '100.64.0.10';
const SONDE_B = '100.64.0.11';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const lan = new LinuxPC('linux-pc', 'PC-LAN', -100, 0);
  const fai1 = new CiscoRouter('R1-EDGE', 100, -60);
  const fai2 = new CiscoRouter('R2-EDGE', 100, 60);
  const dorsale = new GenericSwitch('switch-generic', 'DORSALE', 8, 220, 0);
  const cible = new LinuxPC('linux-pc', 'CIBLE', 320, 0);

  const cableA = new Cable('wan-a');
  const cableB = new Cable('wan-b');
  new Cable('lan').connect(lan.getPort('eth0')!, fgt.getPort('port2')!);
  cableA.connect(fgt.getPort('port1')!, fai1.getPort('GigabitEthernet0/0')!);
  cableB.connect(fgt.getPort('port4')!, fai2.getPort('GigabitEthernet0/0')!);
  new Cable('d1').connect(fai1.getPort('GigabitEthernet0/1')!, dorsale.getPort('eth0')!);
  new Cable('d2').connect(fai2.getPort('GigabitEthernet0/1')!, dorsale.getPort('eth1')!);
  new Cable('d3').connect(cible.getPort('eth0')!, dorsale.getPort('eth2')!);

  await taper(fgt, [
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port4"', 'set mode static',
    'set ip 192.168.101.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next', 'end',
  ]);

  for (const [routeur, wan, dorsaleIp] of [
    [fai1, '192.168.100.1', '100.64.0.1'],
    [fai2, '192.168.101.1', '100.64.0.2'],
  ] as const) {
    await taper(routeur, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address ${wan} 255.255.255.0`,
      'no shutdown', 'exit',
      'interface GigabitEthernet0/1', `ip address ${dorsaleIp} 255.255.255.0`,
      'no shutdown', 'exit', 'end',
    ]);
  }
  await taper(lan, [
    'ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(cible, [
    'ip link set eth0 up', `ip addr add ${SONDE_A}/24 dev eth0`,
    `ip addr add ${SONDE_B}/24 dev eth0`,
    'ip route add 192.168.100.0/24 via 100.64.0.1',
    'ip route add 192.168.101.0/24 via 100.64.0.2',
  ]);
  const rebrancherA = (): void => {
    cableA.connect(fgt.getPort('port1')!, fai1.getPort('GigabitEthernet0/0')!);
  };
  return { fgt, lan, cableA, cableB, cible, rebrancherA };
}

async function sdwan(fgt: FortiGate): Promise<void> {
  await taper(fgt, [
    'config system sdwan', 'set status enable',
    'config zone', 'edit "SDWAN-INTERNET"', 'next', 'end',
    'config members',
    'edit 1', 'set interface "port1"', 'set zone "SDWAN-INTERNET"',
    'set gateway 192.168.100.1', 'set priority 1', 'next',
    'edit 2', 'set interface "port4"', 'set zone "SDWAN-INTERNET"',
    'set gateway 192.168.101.1', 'set priority 2', 'next', 'end',
    'config health-check', 'edit "Qualite"',
    `set server "${SONDE_A}" "${SONDE_B}"`, 'set protocol ping',
    'set interval 500', 'set failtime 2', 'set recoverytime 2',
    'set members 1 2', 'next', 'end',
    'config service', 'edit 1', 'set name "Trafic"', 'set mode sla',
    'set dst "all"', 'set src "NET-LAN"',
    'config sla', 'edit "Qualite"', 'set id 1', 'next', 'end',
    'set priority-members 1 2', 'next', 'end',
    'end',
    'config router static', 'edit 1',
    'set dst 0.0.0.0 0.0.0.0', 'set device "SDWAN-INTERNET"', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "SDWAN-INTERNET"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'set nat enable', 'next', 'end',
  ]);
}

async function sonder(fgt: FortiGate, tours: number): Promise<void> {
  for (let tour = 0; tour < tours; tour += 1) await fgt.runSdwanHealthChecks();
}

describe('la table de routage SUIT la sante des membres', () => {
  it('les deux membres vivants donnent deux routes par defaut', async () => {
    const { fgt } = await laboratoire();
    await sdwan(fgt);
    await sonder(fgt, 3);

    const table = await fgt.executeCommand('get router info routing-table all');

    expect(table).toContain('port1');
    expect(table).toContain('port4');
  });

  it('un membre declare MORT quitte la table de routage', async () => {
    const { fgt, cableA } = await laboratoire();
    await sdwan(fgt);
    await sonder(fgt, 3);

    cableA.disconnect();
    await sonder(fgt, 4);

    expect(await fgt.executeCommand('diagnose sys sdwan health-check'))
      .toMatch(/Seq\(1 port1\): state\(dead\)/);

    const table = await fgt.executeCommand('get router info routing-table all');
    const defaut = table.split('\n').filter(l => l.includes('0.0.0.0/0'));

    expect(defaut.join('\n')).not.toContain('port1');
    expect(defaut.join('\n')).toContain('port4');
  });

  it('le membre qui REVIENT retrouve sa route', async () => {
    const { fgt, cableA, rebrancherA } = await laboratoire();
    await sdwan(fgt);
    await sonder(fgt, 3);
    cableA.disconnect();
    await sonder(fgt, 4);

    rebrancherA();
    await sonder(fgt, 4);

    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table.split('\n').filter(l => l.includes('0.0.0.0/0')).join('\n'))
      .toContain('port1');
  });

  it('`update-static-route disable` laisse la route en place', async () => {
    const { fgt, cableA } = await laboratoire();
    await sdwan(fgt);
    await taper(fgt, [
      'config system sdwan', 'config health-check', 'edit "Qualite"',
      'set update-static-route disable', 'next', 'end', 'end',
    ]);
    await sonder(fgt, 3);

    cableA.disconnect();
    await sonder(fgt, 4);

    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table.split('\n').filter(l => l.includes('0.0.0.0/0')).join('\n'))
      .toContain('port1');
  });
});

describe('une session DEJA ouverte suit le changement de membre', () => {
  it('la session portee par le membre MORT est fermee', async () => {
    const { fgt, lan, cableA } = await laboratoire();
    await sdwan(fgt);
    await sonder(fgt, 3);

    await lan.executeCommand(`ping -c 1 ${SONDE_A}`);
    expect(await fgt.executeCommand('diagnose sys session list'))
      .toContain('gwy=192.168.100.1');

    cableA.disconnect();
    await sonder(fgt, 4);

    expect(await fgt.executeCommand('diagnose sys session list'))
      .toContain('total session 0');
  });

  it('le trafic vers la MEME adresse repart par l\'autre membre', async () => {
    const { fgt, lan, cableA } = await laboratoire();
    await sdwan(fgt);
    await sonder(fgt, 3);
    await lan.executeCommand(`ping -c 1 ${SONDE_A}`);

    cableA.disconnect();
    await sonder(fgt, 4);
    await lan.executeCommand(`ping -c 1 ${SONDE_A}`);

    const apres = await fgt.executeCommand('diagnose sys session list');
    expect(apres).toContain('gwy=192.168.101.1');
    expect(apres).not.toContain('gwy=192.168.100.1');
  });

  it('une session portee par le membre VIVANT survit a la chute de l\'autre',
    async () => {
      const { fgt, lan, cableB } = await laboratoire();
      await sdwan(fgt);
      await sonder(fgt, 3);
      cableB.disconnect();
      await sonder(fgt, 4);
      await lan.executeCommand(`ping -c 1 ${SONDE_A}`);
      const ouverte = await fgt.executeCommand('diagnose sys session list');

      expect(ouverte).toContain('gwy=192.168.100.1');
      expect(ouverte).toContain('total session 1');
    });
});
