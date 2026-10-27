/**
 * Sonde — un lab exporté puis réimporté redevient le même lab.
 *
 * Mesure d'origine (lab NTP du tutoriel, switch L3 + routeur + hôtes Linux et Windows, exporté en JSON puis rouvert) :
 * le fichier se rouvrait avec toutes les interfaces VLAN du switch en `administratively down` et le DNS du poste Windows vide,
 * si bien que le lab qui routait avant l'export ne routait plus après. Trois défauts :
 *  - `show running-config` ne dit pas `no shutdown` pour une interface levée (c'est le défaut d'IOS) alors que le simulateur
 *    crée une interface VLAN éteinte : le rejeu du texte ne pouvait pas la lever ;
 *  - `Set-DnsClientServerAddress` posait les serveurs dans la machine mais le fichier ne les portait pas ;
 *  - `New-NetIPAddress -DefaultGateway` ajoutait la route par défaut AVANT de poser l'adresse sur l'interface : la passerelle
 *    n'était sur aucun sous-réseau connecté, la route restait sans interface (`transmit failed. General failure`), alors que
 *    `netsh ... static <ip> <masque> <passerelle>` marchait sur la même machine.
 *
 * Discrimination `git stash` : 4 cas tombent avant le correctif — « New-NetIPAddress -DefaultGateway », « les interfaces VLAN
 * restent levées », « le DNS du poste Windows survit » et « le lab réimporté route entre ses sous-réseaux ».
 *
 * Passent des deux côtés, et pourquoi :
 *  - « même sous-réseau » — TÉMOIN : prouve que le lab est sain, donc qu'un échec accuse l'export et non la topologie.
 *  - « une interface VLAN éteinte par l'opérateur reste éteinte » — NON-RÉGRESSION : le correctif lève ce que le texte ne
 *    éteint pas, il ne doit pas lever ce qu'il éteint.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

const powershell = async (device: Equipment, line: string): Promise<string> =>
  (await PowerShellSubShell.create(device as never).subShell.processLine(line)).output.join('\n');

async function cli(device: Equipment, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

interface Lab {
  readonly switchCore: Equipment;
  readonly linuxHost: Equipment;
  readonly windowsHost: Equipment;
}

async function buildLab(): Promise<Lab> {
  const store = useNetworkStore.getState();
  const place = (type: 'switch-cisco' | 'linux-server' | 'windows-pc', name: string): Equipment => {
    const added = store.addDevice(type, 0, 0);
    store.updateDevice(added.id, { name, hostname: name });
    return useNetworkStore.getState().deviceInstances.get(added.id)!;
  };
  const switchCore = place('switch-cisco', 'SW-CORE');
  const linuxHost = place('linux-server', 'NTP1');
  const windowsHost = place('windows-pc', 'PC-WIN');
  store.addConnection(linuxHost.getId(), 'eth0', switchCore.getId(), 'FastEthernet0/1');
  store.addConnection(windowsHost.getId(), 'eth0', switchCore.getId(), 'FastEthernet0/2');
  await cli(switchCore, [
    'enable', 'configure terminal', 'ip routing', 'vlan 10', 'vlan 20', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20',
    'interface Vlan10', 'ip address 10.10.0.1 255.255.255.0', 'no shutdown',
    'interface Vlan20', 'ip address 10.20.0.1 255.255.255.0', 'no shutdown', 'end',
  ]);
  await cli(linuxHost, [
    "sudo tee /etc/netplan/01-netcfg.yaml >/dev/null <<'EOF'\nnetwork:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: false\n      addresses:\n        - 10.10.0.11/24\n      gateway4: 10.10.0.1\nEOF",
    'sudo netplan apply',
  ]);
  await powershell(windowsHost, 'New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.20.0.31 -PrefixLength 24 -DefaultGateway 10.20.0.1');
  await powershell(windowsHost, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.0.99');
  return { switchCore, linuxHost, windowsHost };
}

async function reopen(): Promise<Lab> {
  const state = useNetworkStore.getState();
  const file = JSON.parse(JSON.stringify(exportTopology('lab', state.deviceInstances, state.connections)));
  useNetworkStore.getState().clearAll();
  EquipmentRegistry.resetInstance();
  const imported = await importTopology(file);
  useNetworkStore.getState().replaceTopology(imported.deviceInstances, imported.connections);
  const named = (name: string): Equipment => [...imported.deviceInstances.values()].find((device) => device.getName() === name)!;
  return { switchCore: named('SW-CORE'), linuxHost: named('NTP1'), windowsHost: named('PC-WIN') };
}

describe('Probe — an exported lab reopens as the same lab', () => {
  it('TEMOIN: the lab routes before it is exported (same subnet)', async () => {
    const { windowsHost } = await buildLab();
    expect(await windowsHost.executeCommand('ping -n 1 10.20.0.1')).toContain('Received = 1');
  }, 60_000);

  it('New-NetIPAddress -DefaultGateway gives the host a route to another subnet', async () => {
    const { windowsHost } = await buildLab();
    expect(await windowsHost.executeCommand('ping -n 1 10.10.0.11')).toContain('Received = 1');
  }, 60_000);

  it('the VLAN interfaces of the switch stay up after the lab is reopened', async () => {
    await buildLab();
    const { switchCore } = await reopen();
    const brief = await switchCore.executeCommand('show ip interface brief | include Vlan');
    expect(brief).toMatch(/Vlan10\s+10\.10\.0\.1\s+YES manual up\s+up/);
    expect(brief).toMatch(/Vlan20\s+10\.20\.0\.1\s+YES manual up\s+up/);
  }, 120_000);

  it('a VLAN interface shut by the operator stays shut after the lab is reopened', async () => {
    const { switchCore } = await buildLab();
    await cli(switchCore, ['configure terminal', 'interface Vlan20', 'shutdown', 'end']);
    const reopened = await reopen();
    const brief = await reopened.switchCore.executeCommand('show ip interface brief | include Vlan20');
    expect(brief).toMatch(/Vlan20\s+10\.20\.0\.1\s+YES manual administratively down/);
  }, 120_000);

  it('the DNS servers of the Windows host survive the reopening', async () => {
    await buildLab();
    const { windowsHost } = await reopen();
    const servers = await powershell(windowsHost, 'Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv4');
    expect(servers).toContain('10.20.0.99');
  }, 120_000);

  it('the reopened lab still routes between its subnets', async () => {
    await buildLab();
    const { windowsHost } = await reopen();
    expect(await windowsHost.executeCommand('ping -n 1 10.10.0.11')).toContain('Received = 1');
  }, 120_000);
});
