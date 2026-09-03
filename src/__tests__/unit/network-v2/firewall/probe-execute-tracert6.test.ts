/**
 * `execute tracert6` marche les sauts pour de vrai.
 *
 * Mesure de depart : la commande n'existait pas (`unknown action
 * "tracert6"`), alors que TOUT le chemin etait deja construit --
 * `IPv6DataPlane.sendEchoRequest` acceptait deja un hop limit en dernier
 * argument, l'acheminement le decremente et emet un `time-exceeded`
 * quand il expire, et la reception classe deja ce message.
 *
 * IL MANQUAIT UN FIL, et c'est lui le defaut : le pare-feu ne branchait
 * PAS `onIcmpv6EchoFailed`. Un « time exceeded » ICMPv6 revenant vers le
 * pare-feu etait donc classe, puis n'atteignait personne -- de quoi
 * rendre un traceroute IPv6 impossible quel que soit le code qu'on
 * ecrirait au-dessus. Le crochet frere, `onIcmpv6EchoReply`, etait
 * branche depuis toujours.
 *
 * Le rendu est PARTAGE avec le traceroute v4 (`tracerouteHeader`,
 * `tracerouteHopLine`) plutot que recopie : les deux familles impriment
 * la meme forme de ligne, et deux ecritures auraient fini par diverger.
 * Ce qui differe est ce qui differe vraiment -- la taille annoncee (80
 * octets en IPv6 contre 84 en IPv4, l'en-tete fixe n'ayant pas la meme
 * taille) et le message d'echec, `tracert6:` portant le nom de sa propre
 * commande.
 *
 * `official_docs/forti-cli-ref-60.txt` atteste la commande et ses
 * options (`-F`, `-d`, `-n`, `-f <first_ttl>`, `-i <interface>`,
 * `-m <max_ttl>`, `-s <src_addr>`). Ce lot ouvre la forme SANS option,
 * qui est celle qu'on tape ; les options nommeraient des reglages que ce
 * traceroute ne lit pas encore, et les accepter sans les honorer serait
 * le decor que ce depot refuse. La derniere position de la ligne est
 * prise comme destination, de sorte qu'une option future ne changera pas
 * ou se trouve la cible.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 4 cas
 * tombent. Le seul qui passe des deux cotes est le TEMOIN, dont c'est
 * l'objet : `execute ping6` joint deja le voisin, donc un echec de
 * `tracert6` ne peut pas etre mis sur le compte d'un laboratoire mal
 * adresse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lignes: string[]): string {
  let dernier = '';
  for (const ligne of lignes) dernier = sh.execute(ligne);
  return dernier;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function voisinDirect() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const poste = new LinuxPC('linux-pc', 'PC', 200, 0);
  poste.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, poste.getPorts()[0]);
  await runOn(poste, ['ip link set eth0 up', 'ip addr add 2001:db8::10/64 dev eth0']);
  run(sh, 'config system interface', 'edit "port1"', 'config ipv6',
    'set ip6-address 2001:db8::1/64', 'set ip6-allowaccess ping', 'end', 'next', 'end');
  run(sh, 'execute ping6 2001:db8::10');
  return { fw, sh, poste };
}

async function deuxSauts() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const routeur = new CiscoRouter('R1', 200, 0);
  const loin = new LinuxPC('linux-pc', 'LOIN', 400, 0);
  loin.powerOn();

  new Cable('t').connect(fw.getPort('port2')!, routeur.getPort('GigabitEthernet0/0')!);
  new Cable('l').connect(routeur.getPort('GigabitEthernet0/1')!, loin.getPorts()[0]);

  run(sh, 'config system interface', 'edit "port2"', 'config ipv6',
    'set ip6-address 2001:db8:1::1/64', 'set ip6-allowaccess ping', 'end', 'next', 'end');
  await runOn(routeur, ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::2/64', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:2::1/64', 'no shutdown',
    'exit', 'end']);
  await runOn(loin, ['ip link set eth0 up', 'ip addr add 2001:db8:2::10/64 dev eth0',
    'ip -6 route add default via 2001:db8:2::1']);
  run(sh, 'config router static6', 'edit 1', 'set dst 2001:db8:2::/64',
    'set gateway 2001:db8:1::2', 'set device "port2"', 'next', 'end');
  return { fw, sh };
}

describe('FortiGate : execute tracert6', () => {
  it('TEMOIN : `execute ping6` joint le voisin sur ce laboratoire', async () => {
    const { sh } = await voisinDirect();
    expect(run(sh, 'execute ping6 2001:db8::10')).toContain(', 0% packet loss');
  });

  it('un voisin direct est atteint en UN saut', async () => {
    const { sh } = await voisinDirect();
    const vu = run(sh, 'execute tracert6 2001:db8::10');
    expect(vu).toContain('traceroute to 2001:db8::10 (2001:db8::10), 32 hops max, 80 byte packets');
    expect(vu).toContain(' 1  2001:db8::10');
    expect(vu.split('\n')).toHaveLength(2);
  });

  it('une cible hors de portee est refusee, dans les mots de la commande', async () => {
    const { sh } = await voisinDirect();
    expect(run(sh, 'execute tracert6 2001:db9::99')).toBe('tracert6: unknown host');
    expect(run(sh, 'execute tracert6 zorglub')).toBe('tracert6: unknown host');
    expect(run(sh, 'execute tracert6')).toContain('a destination is missing');
  });

  it('le ROUTEUR intermediaire se nomme, par son time-exceeded', async () => {
    const { sh } = await deuxSauts();
    const vu = run(sh, 'execute tracert6 2001:db8:2::10');
    expect(vu).toContain(' 1  2001:db8:1::2');
    expect(vu).toContain(' 2  2001:db8:2::10');
  });

  it('l aide nomme la commande a cote de sa jumelle v4', async () => {
    const { sh } = await voisinDirect();
    const mots = sh.help('execute trac').map(l => l.trim().split(/\s{2,}/)[0]);
    expect(mots).toEqual(['traceroute', 'tracert6']);
    expect(sh.completions('execute tracert')).toEqual(['execute tracert6']);
  });
});
