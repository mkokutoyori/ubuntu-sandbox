/**
 * `Add-NetLbfoTeamNic` cree une interface d'equipe ETIQUETEE, et cette
 * etiquette voyage. Reference : la documentation PowerShell de
 * Microsoft, dont le depot `windows-powershell-docs` donne la syntaxe
 * `Add-NetLbfoTeamNic [-Team] <String> [-VlanID] <UInt32>
 * [[-Name] <String>]`, la contrainte de plage mot pour mot — « VlanID
 * values must meet the criteria 0 <= VlanID < 4095 » — les alias
 * `ifAlias`/`InterfaceAlias` du nom, et le nom par defaut
 * `<equipe> - VLAN <id>` que ses propres exemples emploient.
 *
 * LE DEFAUT MESURE : `Get-NetLbfoTeamNic` enumerait l'interface
 * PRIMAIRE et rien d'autre, `Add-NetLbfoTeamNic` n'existait pas, et
 * `WindowsPC` n'avait AUCUNE notion de sous-interface VLAN alors que
 * `LinuxMachine` en avait une complete. Le mecanisme n'est donc pas
 * recopie : il monte dans `EndHost`, ou les deux plateformes le
 * partagent, et `LinuxMachine` perd ses trois surcharges.
 *
 * La montee corrige au passage un defaut du mecanisme lui-meme : le
 * demultiplexage a l'arrivee comparait le port PHYSIQUE au parent
 * declare, donc une sous-interface posee sur une AGREGATION ne pouvait
 * jamais recevoir — la trame arrive sur un membre, pas sur le bond. Il
 * lit desormais l'interface LOGIQUE, celle que `aggregateIngressPort`
 * nomme deja.
 *
 * DISCRIMINATION : 11 des 13 cas tombent contre l'etat d'avant — j'en
 * annoncais 10, la mesure a corrige l'annonce, le refus d'un nom deja
 * pris tombant lui aussi puisque la commande n'existait pas du tout.
 * Les 2 qui passent des deux cotes sont nommes : le TEMOIN de
 * l'interface primaire, que `Get-NetLbfoTeamNic` rendait deja, et le
 * ping recu par l'equipe elle-meme sur une trame NON etiquetee, qui
 * marchait deja et garde que la montee dans `EndHost` ne l'a pas
 * cassee — c'est justement ce qu'un deplacement de mecanisme risque.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';
import type { EthernetFrame } from '@/network/core/types';

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

describe('une interface d\'equipe LBFO porte un VLAN', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('TEMOIN : l\'interface primaire est enumeree', async () => {
    const { pc } = await labo();
    expect(await ps(pc, 'Get-NetLbfoTeamNic -Team Team1')).toContain('Team1');
  }, 30_000);

  it('`Add-NetLbfoTeamNic` cree une interface au nom par defaut', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(pc.getPort('Team1 - VLAN 42')).toBeTruthy();
  }, 30_000);

  it('elle est enumeree avec son VLAN, et n\'est ni primaire ni par defaut', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    const nics = pc.getNicTeam('Team1')!.teamNics;
    expect(nics).toHaveLength(2);
    expect(nics[1]).toMatchObject({ name: 'Team1 - VLAN 42', vlanId: 42, primary: false });
  }, 30_000);

  it('`-Name` impose le nom', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 7 -Name Voix');
    expect(pc.getPort('Voix')).toBeTruthy();
  }, 30_000);

  it('un VLAN hors plage est refuse dans les mots de la documentation', async () => {
    const { pc } = await labo();
    expect(await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 4095'))
      .toContain('0 <= VlanID < 4095');
  }, 30_000);

  it('un VLAN deja pris sur l\'equipe est refuse', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42'))
      .toContain('already exists');
  }, 30_000);

  it('un nom deja pris est refuse', async () => {
    const { pc, nics } = await labo();
    expect(await ps(pc, `Add-NetLbfoTeamNic -Team Team1 -VlanID 8 -Name ${nics[0]}`))
      .toContain('already exists');
  }, 30_000);

  it('une equipe inconnue est refusee', async () => {
    const { pc } = await labo();
    expect(await ps(pc, 'Add-NetLbfoTeamNic -Team Zorglub -VlanID 42'))
      .toContain("The team 'Zorglub' was not found.");
  }, 30_000);

  it('la trame emise par l\'interface d\'equipe porte l\'etiquette', async () => {
    const { pc, nics } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    const vues: { portName: string; frame: EthernetFrame }[] = [];
    pc.getBus().subscribe('port.frame.tx-requested', (e) => {
      vues.push(e.payload as { portName: string; frame: EthernetFrame });
    });
    pc.sendFrame('Team1 - VLAN 42', {
      srcMAC: pc.getPort('Team1 - VLAN 42')!.getMAC(),
      dstMAC: MACAddress.broadcast(), etherType: 0x0800, payload: {} as never,
    } as EthernetFrame);
    const surMembre = vues.filter(v => nics.includes(v.portName));
    expect(surMembre.length).toBeGreaterThan(0);
    expect(surMembre.every(v => (v.frame as { dot1q?: { vid: number } }).dot1q?.vid === 42))
      .toBe(true);
  }, 30_000);

  it('un hote du VLAN 42 repond a l\'interface etiquetee', async () => {
    const { pc, sw } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    const hote = new LinuxPC('linux-pc', 'PC42', 900, 0);
    hote.powerOn();
    new Cable('c42').connect(hote.getPorts()[0], sw.getPort('FastEthernet0/5')!);
    await taper(sw, ['configure terminal', 'vlan 42', 'exit',
      'interface FastEthernet0/5', 'switchport mode access', 'switchport access vlan 42', 'end']);
    await taper(hote, ['ip addr add 10.42.0.2/24 dev eth0', 'ip link set eth0 up']);
    await pc.executeCommand(
      'netsh interface ip set address name="Team1 - VLAN 42" static 10.42.0.1 255.255.255.0');
    await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    vi.useRealTimers();
    expect(await pc.executeCommand('ping 10.42.0.2')).toContain('Reply from 10.42.0.2');
  }, 30_000);

  it('l\'interface etiquetee suit la porteuse de l\'equipe', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(pc.getPort('Team1 - VLAN 42')!.getIsUp()).toBe(true);
  }, 30_000);

  it('`Remove-NetLbfoTeamNic` la retire, et refuse la primaire', async () => {
    const { pc } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    await ps(pc, 'Remove-NetLbfoTeamNic -Team Team1 -VlanID 42');
    expect(pc.getPort('Team1 - VLAN 42')).toBeUndefined();
    expect(pc.getNicTeam('Team1)')).toBeUndefined();
    expect(await ps(pc, 'Remove-NetLbfoTeamNic -Team Team1 -VlanID 0'))
      .toContain('No team interface with VLAN ID 0');
  }, 30_000);

  it('une trame NON etiquetee reste recue par l\'equipe elle-meme', async () => {
    const { pc, sw } = await labo();
    await ps(pc, 'Add-NetLbfoTeamNic -Team Team1 -VlanID 42');
    const hote = new LinuxPC('linux-pc', 'PC1', 900, 0);
    hote.powerOn();
    new Cable('c1').connect(hote.getPorts()[0], sw.getPort('FastEthernet0/6')!);
    await taper(hote, ['ip addr add 10.0.0.2/24 dev eth0', 'ip link set eth0 up']);
    await pc.executeCommand(
      'netsh interface ip set address name="Team1" static 10.0.0.1 255.255.255.0');
    await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    vi.useRealTimers();
    expect(await pc.executeCommand('ping 10.0.0.2')).toContain('Reply from 10.0.0.2');
  }, 30_000);
});
