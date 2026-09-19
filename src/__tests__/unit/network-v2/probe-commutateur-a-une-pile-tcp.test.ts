/**
 * Sonde — un commutateur n'avait aucune pile TCP.
 *
 * Mesure AVANT : `getTcpStack' n'existe sur AUCUN des quatre
 * commutateurs (`Switch', `CiscoSwitch', `HuaweiSwitch',
 * `GenericSwitch'), alors que `Router', `LinuxMachine' et `WindowsPC' le
 * portent. Un commutateur a pourtant deja tout le plan de gestion : des
 * SVI avec adresse, une table ARP, et il repond au ping.
 *
 * La ou cela se voit, dans `SwitchSvi' : le paquet reconnu pour SOI
 * (`isOwnAddress') est aiguille par protocole, et il n'y a que deux
 * branches -- ICMP et UDP. Un segment TCP tombe donc au sol EN SILENCE :
 * ni traitement, ni RST, ni ICMP port unreachable. Le commutateur ne
 * pouvait etre ni serveur ni client TCP.
 *
 * Le meme defaut avait deja ete trouve et referme pour UDP, et le
 * commentaire est reste dans le fichier : « Tout ce qui n'est pas DHCP
 * tombait ici en silence, donc un Catalyst ne pouvait etre le client
 * d'aucun protocole UDP ». TCP est l'autre moitie.
 *
 * SIX cas sur huit tombent avant la correction. Les deux autres sont
 * NOMMES :
 *
 *   - le ping vers le SVI repond toujours : TEMOIN. Il prouve que le
 *     plan de gestion du commutateur est vivant et adresse, donc qu'un
 *     TCP muet est bien une pile absente et non un laboratoire casse.
 *   - le commutateur commute toujours entre deux hotes : NON-REGRESSION.
 *     Donner une pile au plan de gestion ne doit rien changer au plan de
 *     commutation.
 *
 * Les deux derniers cas disent a quoi la pile sert. AVANT, un `telnet'
 * vers un commutateur etait SYNTHETISE par le client -- il fabriquait
 * une invite et renvoyait l'echo de l'entree, sans qu'une trame parte.
 * APRES, la session traverse le cable et c'est le commutateur qui
 * authentifie et qui repond avec la sortie de son PROPRE shell.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';

const MASK = new SubnetMask('255.255.255.0');
const SWITCH_IP = '10.0.0.2';
const PC_IP = '10.0.0.10';
const PEER_IP = '10.0.0.11';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildLan(): Promise<{ pc: LinuxPC; peer: LinuxPC; sw: CiscoSwitch }> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1');
  const peer = new LinuxPC('linux-pc', 'PC2');
  pc.getPort('eth0')!.configureIP(new IPAddress(PC_IP), MASK);
  peer.getPort('eth0')!.configureIP(new IPAddress(PEER_IP), MASK);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(peer.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('interface Vlan1');
  await sw.executeCommand(`ip address ${SWITCH_IP} 255.255.255.0`);
  await sw.executeCommand('no shutdown');
  await sw.executeCommand('end');
  await settle();
  return { pc, peer, sw };
}

const stackOf = (sw: CiscoSwitch): TcpStack | undefined =>
  (sw as unknown as { getTcpStack?: () => TcpStack }).getTcpStack?.();

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('un commutateur porte une vraie pile TCP', () => {
  it('temoin : le SVI repond au ping', async () => {
    const { pc } = await buildLan();
    expect(await pc.executeCommand(`ping -c 1 ${SWITCH_IP}`)).toMatch(/1 (packets )?received|bytes from/);
  }, 30000);

  it('non-regression : le commutateur commute toujours entre deux hotes', async () => {
    const { pc } = await buildLan();
    expect(await pc.executeCommand(`ping -c 1 ${PEER_IP}`)).toMatch(/1 (packets )?received|bytes from/);
  }, 30000);

  it('le commutateur expose une pile TCP', async () => {
    const { sw } = await buildLan();
    expect(stackOf(sw)).toBeDefined();
  }, 30000);

  it('il accepte une connexion entrante sur un port en ecoute', async () => {
    const { pc, sw } = await buildLan();
    const stack = stackOf(sw);
    expect(stack).toBeDefined();
    let accepted: TcpSocket | null = null;
    stack!.listen(9100, { onAccept: (socket) => { accepted = socket; } });
    const client = await (pc as unknown as {
      tcpConnect(h: string, p: number): Promise<unknown>;
    }).tcpConnect(SWITCH_IP, 9100);
    await settle();
    expect(client).not.toBeNull();
    expect(accepted).not.toBeNull();
  }, 30000);

  it('un port sans ecoute est refuse au lieu de tomber en silence', async () => {
    const { pc } = await buildLan();
    const client = await (pc as unknown as {
      tcpConnect(h: string, p: number): Promise<unknown>;
    }).tcpConnect(SWITCH_IP, 9101);
    await settle();
    expect(client).toBeNull();
  }, 30000);

  it('un telnet vers le commutateur traverse le cable et demande le mot de passe', async () => {
    const { pc, sw } = await buildLan();
    for (const l of ['enable', 'configure terminal', 'line vty 0 4',
      'password cisco', 'login', 'exit', 'end']) await sw.executeCommand(l);
    const out = await pc.executeCommand(`telnet ${SWITCH_IP}`, 'cisco\nexit\n');
    expect(out).toContain('Password:');
  }, 30000);

  it('le commutateur repond avec la sortie de son propre shell', async () => {
    const { pc, sw } = await buildLan();
    for (const l of ['enable', 'configure terminal', 'line vty 0 4',
      'password cisco', 'login', 'exit', 'end']) await sw.executeCommand(l);
    const out = await pc.executeCommand(`telnet ${SWITCH_IP}`, 'cisco\nshow version\nexit\n');
    expect(out).toContain('Cisco IOS Software');
  }, 30000);

  it('il ouvre une connexion sortante vers un hote', async () => {
    const { peer, sw } = await buildLan();
    const stack = stackOf(sw);
    expect(stack).toBeDefined();
    (peer as unknown as { getTcpStack(): TcpStack }).getTcpStack()
      .listen(9200, { onAccept: () => undefined });
    await settle();
    const socket = stack!.connect(PEER_IP, 9200);
    await settle();
    expect(socket).not.toBeNull();
  }, 30000);
});
