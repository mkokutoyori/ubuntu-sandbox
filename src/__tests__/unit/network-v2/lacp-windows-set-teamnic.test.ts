/**
 * `Set-NetLbfoTeamNic` pose un VLAN sur une interface d'equipe
 * existante, ou ramene la primaire en mode Default. Reference : la
 * documentation PowerShell de Microsoft, dont le depot
 * `windows-powershell-docs` donne la syntaxe
 * `Set-NetLbfoTeamNic [[-Name] <String[]>] [[-Team] <String[]>]
 * [-VlanID <UInt32>] [-Default]`, la regle « Only the team interface
 * that was created when the team was created can be set to Default
 * mode », et le nom que prend l'interface — ses propres exemples
 * ecrivent `Set-NetLbfoTeamNic -Name "Team1 - VLAN 5" -Default` apres
 * avoir pose le VLAN 5 sur la primaire nommee `Team1`.
 *
 * CE QUI BLOQUAIT, et qui etait inscrit au registre plutot que force :
 * la commande RENOMME l'interface dans TOUS ses cas d'emploi, et un
 * port ne se renommait pas — `Port.name` etait `private readonly` et
 * la cle de `Equipment.ports` n'est pas la seule chose a porter ce
 * nom. `Port.rename` et `Equipment.renamePort` le rendent possible, et
 * `WindowsPC` reporte le nouveau nom sur ce qui le NOMMAIT : les
 * routes, les adresses de `Get-NetIPAddress`, et l'etiquetage VLAN —
 * y compris celui des AUTRES interfaces de l'equipe quand c'est la
 * primaire, qui est leur parent, qui change de nom.
 *
 * DISCRIMINATION : les 9 cas tombent contre l'etat d'avant, la cmdlet
 * n'existant pas. Ils ne prouvent donc pas un correctif mais une
 * fonction ; ce qu'ils gardent vraiment est ce que le renommage
 * casserait s'il etait fait a moitie — le trafic etiquete continue de
 * passer, et l'interface renommee reste joignable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

async function ps(pc: WindowsPC, cmd: string): Promise<string> {
  return pc.executeCommand(`powershell ${cmd}`);
}

async function labo() {
  const pc = new WindowsPC('windows-pc', 'WS', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 400);
  pc.powerOn(); sw.powerOn();
  const nics = pc.getPorts().slice(0, 2).map(p => p.getName());
  for (let i = 0; i < 2; i++) {
    new Cable(`c${i}`).connect(pc.getPorts()[i], sw.getPort(`FastEthernet0/${i + 1}`)!);
  }
  await taper(sw, ['enable', 'configure terminal',
    'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'exit',
    'interface port-channel 1', 'switchport mode trunk', 'end']);
  await ps(pc, `New-NetLbfoTeam -Name Team1 -TeamMembers ${nics.join(',')} `
    + '-TeamingMode LACP -Confirm:$false');
  await vi.advanceTimersByTimeAsync(PERIODIC_MS);
  return { pc, sw, nics };
}

describe('`Set-NetLbfoTeamNic` renomme et rebalise', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('poser un VLAN sur la primaire la renomme', async () => {
    const { pc } = await labo();
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name Team1 -VlanID 5')).toBe('');
    expect(pc.getPort('Team1 - VLAN 5')).toBeTruthy();
    expect(pc.getPort('Team1')).toBeUndefined();
  }, 30_000);

  it('`-Default` la ramene au nom de l\'equipe et retire le VLAN', async () => {
    const { pc } = await labo();
    await ps(pc, 'Set-NetLbfoTeamNic -Name Team1 -VlanID 5');
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name "Team1 - VLAN 5" -Default')).toBe('');
    expect(pc.getPort('Team1')).toBeTruthy();
    expect(pc.getNicTeam('Team1')!.teamNics[0].vlanId).toBeNull();
  }, 30_000);

  it('seule la primaire accepte `-Default`', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name "Team1 - VLAN 42" -Default'))
      .toContain('created with the team');
  }, 30_000);

  it('changer le VLAN d\'une interface secondaire la renomme aussi', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name "Team1 - VLAN 42" -VlanID 43')).toBe('');
    expect(pc.getPort('Team1 - VLAN 43')).toBeTruthy();
    expect(pc.getPort('Team1 - VLAN 42')).toBeUndefined();
  }, 30_000);

  it('un VLAN deja pris sur l\'equipe est refuse', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 43');
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name "Team1 - VLAN 42" -VlanID 43'))
      .toContain('already exists');
  }, 30_000);

  it('un VLAN hors plage est refuse et l\'interface garde son nom', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name "Team1 - VLAN 42" -VlanID 4095'))
      .toContain('0 <= VlanID < 4095');
    expect(pc.getPort('Team1 - VLAN 42')).toBeTruthy();
  }, 30_000);

  it('une interface inconnue est refusee', async () => {
    const { pc } = await labo();
    expect(await ps(pc, 'Set-NetLbfoTeamNic -Name Zorglub -VlanID 5'))
      .toContain("The team interface 'Zorglub' was not found.");
  }, 30_000);

  it('l\'interface renommee reste joignable, et son adresse la suit', async () => {
    const { pc, sw } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    const hote = new LinuxPC('linux-pc', 'PC42', 900, 0);
    hote.powerOn();
    new Cable('c42').connect(hote.getPorts()[0], sw.getPort('FastEthernet0/5')!);
    await taper(sw, ['configure terminal', 'vlan 43', 'exit',
      'interface FastEthernet0/5', 'switchport mode access',
      'switchport access vlan 43', 'end']);
    await taper(hote, ['ip addr add 10.43.0.2/24 dev eth0', 'ip link set eth0 up']);
    await pc.executeCommand(
      'netsh interface ip set address name="Team1 - VLAN 42" static 10.43.0.1 255.255.255.0');
    await ps(pc, 'Set-NetLbfoTeamNic -Name "Team1 - VLAN 42" -VlanID 43');
    await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    vi.useRealTimers();
    expect(await pc.executeCommand('ping 10.43.0.2')).toContain('Reply from 10.43.0.2');
  }, 30_000);

  it('renommer la PRIMAIRE reetiquette les interfaces qui en dependent', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    await ps(pc, 'Set-NetLbfoTeamNic -Name Team1 -VlanID 5');
    expect(pc.getVlanSubInterface('Team1 - VLAN 42')?.parent).toBe('Team1 - VLAN 5');
  }, 30_000);
});
