/**
 * Une agregation survit a un Enregistrer/Ouvrir. Mesure de depart, sur
 * les quatre plateformes qui en portent une :
 *
 *   Windows : 0 equipe apres relecture, l'interface a VLAN avec.
 *   Linux   : `bond0` absent de `ip -br link show`.
 *   Huawei  : « Error: The Eth-Trunk 1 does not exist. »
 *   Cisco   : Port-channel1 present — la seule des quatre.
 *
 * TROIS CAUSES DIFFERENTES, et la deuxieme depasse de loin le sujet.
 *
 * (1) Le commutateur Huawei ne rendait AUCUNE configuration a la
 * sauvegarde : `Switch.getRunningConfig()` cherche `buildRunningConfig`
 * sur la coquille, `CiscoSwitchShell` la porte et `HuaweiSwitchShell`
 * non — sa vue s'appelle `displayCurrentConfig`. Ce n'est donc pas
 * l'Eth-Trunk qui etait perdu, c'est TOUT : VLAN, interfaces, STP,
 * listes de controle, routes. Le rejeu, lui, connaissait deja VRP
 * (`system-view`, separateur `#`) et attendait un texte qui n'arrivait
 * jamais. Une ligne le branche, et rien n'est recopie.
 *
 * (2) et (3) Un bond Linux et une equipe Windows ne sont decrits par
 * AUCUN fichier ni aucun texte de configuration : ils vivent sur
 * l'objet, comme la base de registre et les services Windows que ce
 * meme fichier a deja appris a capturer. Ils sont donc captures en
 * STRUCTURE et restaures par les vraies methodes de la machine. Les
 * options du bond passent par `bondOptionLines`, ecrit a cote de
 * l'analyseur qui les relit, de sorte que la grammaire n'existe qu'une
 * fois dans les deux sens.
 *
 * DISCRIMINATION : 6 des 8 cas tombent contre l'etat d'avant. Les 2
 * autres sont le TEMOIN Cisco, seule plateforme qui survivait deja, et
 * le cas des adresses, qui passe par `interfaces` et n'a jamais
 * dependu de ces trois chemins.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network/equipment/Equipment';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

async function allerRetour(devices: Equipment[]): Promise<Map<string, Equipment>> {
  const instances = new Map<string, Equipment>(devices.map(d => [d.getId(), d]));
  const json = exportTopology('lab', instances, []);
  const rouvert = await importTopology(JSON.parse(JSON.stringify(json)));
  return rouvert.deviceInstances;
}

const parNom = (m: Map<string, Equipment>, nom: string) =>
  [...m.values()].find(d => d.getName() === nom)!;

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('une agregation survit a un enregistrement', () => {
  it('Linux : le bond revient avec ses esclaves', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();
    await taper(srv, ['ip link add bond0 type bond',
      'ip link set bond0 type bond mode 802.3ad',
      'ip link set eth0 master bond0', 'ip link set eth1 master bond0']);

    const back = parNom(await allerRetour([srv]), 'SRV') as unknown as Cmd;

    expect(await back.executeCommand('ip -br link show')).toContain('bond0');
    const proc = await back.executeCommand('cat /proc/net/bonding/bond0');
    expect(proc).toContain('Slave Interface: eth0');
    expect(proc).toContain('Slave Interface: eth1');
  });

  it('Linux : les options du bond reviennent aussi', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();
    await taper(srv, ['ip link add bond0 type bond',
      'ip link set bond0 type bond mode 802.3ad lacp_rate fast',
      'ip link set bond0 type bond ad_select bandwidth min_links 2',
      'ip link set eth0 master bond0']);

    const back = parNom(await allerRetour([srv]), 'SRV') as unknown as Cmd;

    const proc = await back.executeCommand('cat /proc/net/bonding/bond0');
    expect(proc).toContain('IEEE 802.3ad Dynamic link aggregation');
    expect(proc).toContain('LACP rate: fast');
    expect(proc).toContain('Aggregator selection policy (ad_select): bandwidth');
    expect(proc).toContain('Min links: 2');
  });

  it('Linux : un bond en mode par defaut ne rend aucune option', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();
    await taper(srv, ['ip link add bond0 type bond']);

    const back = parNom(await allerRetour([srv]), 'SRV') as unknown as Cmd;

    expect(await back.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('Bonding Mode: load balancing (round-robin)');
  });

  it('Windows : l\'equipe revient avec ses membres', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.powerOn();
    const nics = pc.getPorts().slice(0, 2).map(p => p.getName());
    await pc.executeCommand(`powershell New-NetLbfoTeam -Name Team1 -TeamMembers ${nics.join(',')} `
      + '-TeamingMode LACP -LoadBalancingAlgorithm Dynamic -Confirm:$false');

    const back = parNom(await allerRetour([pc]), 'WIN1') as unknown as WindowsPC;

    const team = back.getNicTeam('Team1');
    expect(team).toBeTruthy();
    expect(team!.members.map(m => m.name)).toEqual(nics);
    expect(team!.teamingMode).toBe('LACP');
    expect(back.getPort('Team1')).toBeTruthy();
  });

  it('Windows : l\'interface d\'equipe a VLAN revient etiquetee', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.powerOn();
    const nics = pc.getPorts().slice(0, 2).map(p => p.getName());
    await pc.executeCommand(`powershell New-NetLbfoTeam -Name Team1 -TeamMembers ${nics.join(',')} `
      + '-TeamingMode LACP -Confirm:$false');
    await pc.executeCommand('powershell Add-NetLbfoTeamNic -Team Team1 -VlanID 42');

    const back = parNom(await allerRetour([pc]), 'WIN1') as unknown as WindowsPC;

    expect(back.getPort('Team1 - VLAN 42')).toBeTruthy();
    expect(back.getVlanSubInterface('Team1 - VLAN 42'))
      .toEqual({ parent: 'Team1', vid: 42 });
  });

  it('Huawei : l\'Eth-Trunk revient, et le reste de la configuration avec', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'HSW', 24, 300, 0);
    sw.powerOn();
    const ports = sw.getPorts().map(p => p.getName());
    await taper(sw, ['system-view', 'vlan 77', 'quit',
      'interface Eth-Trunk 1', 'mode lacp-static', 'quit',
      `interface ${ports[0]}`, 'eth-trunk 1', 'quit',
      `interface ${ports[1]}`, 'eth-trunk 1', 'quit', 'return']);

    const back = parNom(await allerRetour([sw]), 'HSW') as unknown as Cmd;

    expect(await back.executeCommand('display eth-trunk 1'))
      .toContain("Eth-Trunk1's state information is:");
    expect(await back.executeCommand('display vlan')).toContain('77');
  });

  it('TEMOIN Cisco : le Port-channel survivait deja', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'CSW', 24, 300, 0);
    sw.powerOn();
    await taper(sw, ['enable', 'configure terminal',
      'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'end']);

    const back = parNom(await allerRetour([sw]), 'CSW') as unknown as Cmd;

    expect(await back.executeCommand('show etherchannel summary')).toContain('Port-channel1');
  });

  it('les adresses des interfaces reviennent, comme avant', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();
    await taper(srv, ['ip addr add 10.9.0.1/24 dev eth0']);

    const back = parNom(await allerRetour([srv]), 'SRV') as unknown as Cmd;

    expect(await back.executeCommand('ip -br addr show')).toContain('10.9.0.1/24');
  });
});
