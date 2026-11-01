/**
 * `config firewall vipgrp` (FortiOS CLI Reference 7.4.12 p.760 : name, color, comments, interface, member, uuid) : un groupe de VIP se nomme dans `dstaddr` d'une
 * politique et couvre ses membres, pas les autres VIP. Le groupe est un groupe d'adresses dont les membres sont les objets d'adresse que chaque VIP porte (la
 * meme chaine que `addrgrp`, sans second mecanisme). `interface` est refuse en disant pourquoi (rien ne le confronte a l'interface externe du VIP : criterion
 * stocke sans effet interdit par la regle 6).
 * Mesure de depart : `config firewall vipgrp` repondait « unknown configuration path » ; 4 des 7 cas tombent avant (affichage, trafic du membre, `interface` refuse, sauvegarde). Les 3 autres passent des deux cotes : le temoin (la VIP seule dans `dstaddr`), « une VIP hors groupe n'est pas couverte » et « un membre qui n'est pas une VIP est refuse » (le chemin inconnu refuse tout).
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab(dstaddr: string) {
  const web1 = new LinuxServer('linux-server', 'Web1', 0, 0);
  const web2 = new LinuxServer('linux-server', 'Web2', 0, 0);
  const wan = new LinuxServer('linux-server', 'WAN-Host', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(name: string): unknown };
  web1.powerOn(); web2.powerOn(); wan.powerOn();
  new Cable('l1').connect(web1.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('l2').connect(web2.getPort('eth0') as never, fw.getPort('port2') as never);
  new Cable('w').connect(fw.getPort('wan1') as never, wan.getPort('eth0') as never);
  await type(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit port2', 'set mode static', 'set ip 192.168.2.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    'config firewall vip', 'edit "VIP_A"', 'set extip 203.0.113.11', 'set mappedip "192.168.1.10"', 'next',
    'edit "VIP_B"', 'set extip 203.0.113.12', 'set mappedip "192.168.2.10"', 'next', 'end',
    'config firewall vipgrp', 'edit "GRP_A"', 'set member "VIP_A"', 'next', 'end',
    'config firewall policy',
    'edit 1', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"', `set dstaddr "${dstaddr}"`, 'set action accept', 'set schedule "always"', 'set service "HTTP"', 'next',
    'edit 2', 'set srcintf "wan1"', 'set dstintf "port2"', 'set srcaddr "all"', `set dstaddr "${dstaddr}"`, 'set action accept', 'set schedule "always"', 'set service "HTTP"', 'next', 'end',
  ]);
  await type(web1, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await type(web2, ['ip link set eth0 up', 'ip addr add 192.168.2.10/24 dev eth0', 'ip route add default via 192.168.2.1', 'systemctl start nginx']);
  await type(wan, ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1']);
  return {
    fw,
    toA: () => wan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.11/'),
    toB: () => wan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.12/'),
  };
}

describe('firewall vipgrp', () => {
  it('temoin : la VIP seule dans dstaddr est servie', async () => {
    expect(await (await lab('VIP_A')).toA()).toMatch(/nginx/i);
  });

  it('le groupe est affiche avec ses membres', async () => {
    const { fw } = await lab('GRP_A');
    const shown = await fw.executeCommand('show firewall vipgrp');
    expect(shown).toContain('edit "GRP_A"');
    expect(shown).toContain('set member "VIP_A"');
  });

  it('un membre du groupe est servi par une politique qui nomme le groupe', async () => {
    expect(await (await lab('GRP_A')).toA()).toMatch(/nginx/i);
  });

  it('une VIP hors groupe n est pas couverte', async () => {
    expect(await (await lab('GRP_A')).toB()).not.toMatch(/nginx/i);
  });

  it('un membre qui n est pas une VIP est refuse', async () => {
    const { fw } = await lab('GRP_A');
    const reply = await fw.executeCommand('config firewall vipgrp')
      + await fw.executeCommand('edit "BAD"') + await fw.executeCommand('set member "all"');
    await fw.executeCommand('end');
    expect(reply).toMatch(/entry not found|not found|parse error/i);
  });

  it('interface est refuse en disant pourquoi', async () => {
    const { fw } = await lab('GRP_A');
    await fw.executeCommand('config firewall vipgrp');
    await fw.executeCommand('edit "GRP_A"');
    const reply = await fw.executeCommand('set interface "wan1"');
    await fw.executeCommand('end');
    expect(reply).toMatch(/no effect|not evaluated|simulator|nothing here/i);
  });

  it('le groupe survit a la sauvegarde du lab', async () => {
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(fw, ['config firewall vip', 'edit "VIP_A"', 'set extip 203.0.113.11', 'set mappedip "192.168.1.10"', 'next', 'end',
      'config firewall vipgrp', 'edit "GRP_A"', 'set comments "web"', 'set member "VIP_A"', 'next', 'end']);
    const saved = JSON.parse(JSON.stringify(exportTopology('lab', new Map<string, Equipment>([[fw.getId(), fw as Equipment]]), [])));
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const back = await importTopology(saved);
    const reopened = [...back.deviceInstances.values()][0] as FortiGate;
    const shown = await reopened.executeCommand('show firewall vipgrp');
    expect(shown).toContain('set member "VIP_A"');
    expect(shown).toContain('set comments "web"');
  });
});
