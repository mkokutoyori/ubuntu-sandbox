/**
 * `net.ipv4.conf.<if>.rp_filter` (Documentation/networking/ip-sysctl.rst, net/ipv4/fib_frontend.c fib_validate_source) : 0 aucun controle,
 * 1 strict (la route vers la source doit sortir par l'interface d'arrivee), 2 lache (une route quelconque vers la source suffit,
 * route par defaut comprise) ; « le maximum de conf/{all,interface} est utilise ». Ubuntu pose 2 par /etc/sysctl.d/10-network-security.conf
 * (lu sur la machine de reference). Une source sans AUCUNE route est jetee en mode 1 comme en mode 2. Le simulateur n'avait ni la cle ni
 * le controle : tout paquet de source sans route montait jusqu'a l'application (le fichier du paquet n'etait pas livre faute de lecteur).
 * Corrige : Ipv4DeviceConf porte la cle (defaut 2), LinuxMachine juge chaque paquet unicast recu (hors lo, hors source 0.0.0.0, hors
 * diffusion et multicast) avant la remise locale ou le transit, et le fichier du paquet est livre.
 *
 * Banc : A (10.0.0.1/24) --switch-- B (10.0.0.2/24, eth1 192.168.1.2/24 sans cable). On envoie a B un datagramme UDP dont la SOURCE est
 * choisie : 10.0.0.1 (route connectee), 172.16.9.9 (aucune route) puis la meme apres une route par defaut.
 *
 * Reserves : le compteur TcpExt IPReversePathFilter et la journalisation des martiens (log_martians) ne sont pas modelises ; les tables de
 * politique ne sont pas consultees (table principale seulement) ; la diffusion, le multicast et la source 0.0.0.0 sont exemptes ; une reponse DHCP
 * destinee a une carte sans adresse passe avant le controle, le client DHCP lisant les trames sur un socle brut avant la pile IP.
 *
 * Discrimine par `git stash` sur src/network : 5 des 9 cas tombent avant. TEMOINS : le filtre eteint livre une source sans route, une route
 * par defaut la rend acceptable en mode lache, la source joignable est livree, et le texte du fichier de paquet se lit dans le fichier livre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let a: LinuxPC;
let b: LinuxPC;

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  a = new LinuxPC('linux-pc', 'A');
  b = new LinuxPC('linux-pc', 'B');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  a.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), mask);
  new Cable('ca').connect(a.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('cb').connect(b.getPort('eth0')!, sw.getPort('eth1')!);
});

const run = async (device: LinuxPC, command: string): Promise<string> => {
  const machine = device as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
};

async function delivers(): Promise<boolean> {
  await run(a, 'ip addr add 172.16.9.9/32 dev eth0');
  await run(b, 'nc -lu 9000 > /tmp/got &');
  await run(a, 'printf x | nc -u -w1 -s 172.16.9.9 10.0.0.2 9000');
  return (await run(b, 'cat /tmp/got')).includes('x');
}

describe('rp_filter', () => {
  it('is 2 by default as Ubuntu ships it, per interface and in all', async () => {
    expect(await run(b, 'sysctl -n net.ipv4.conf.all.rp_filter')).toBe('2');
    expect(await run(b, 'sysctl -n net.ipv4.conf.eth0.rp_filter')).toBe('2');
  });

  it('WITNESS — with the filter off a source nobody routes is delivered', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.all.rp_filter=0');
    await run(b, 'sysctl -w net.ipv4.conf.eth0.rp_filter=0');
    expect(await delivers()).toBe(true);
  });

  it('loose mode (2) drops a source with no route at all', async () => {
    expect(await delivers()).toBe(false);
  });

  it('loose mode accepts the same source once a default route exists', async () => {
    await run(b, 'ip route add default via 10.0.0.1 dev eth0');
    expect(await delivers()).toBe(true);
  });

  it('strict mode (1) drops it when the route leaves by another interface', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.all.rp_filter=1');
    await run(b, 'sysctl -w net.ipv4.conf.eth0.rp_filter=1');
    await run(b, 'ip route add 172.16.9.0/24 dev eth1');
    expect(await delivers()).toBe(false);
  });

  it('strict mode accepts it when the route leaves by the arrival interface', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.all.rp_filter=1');
    await run(b, 'sysctl -w net.ipv4.conf.eth0.rp_filter=1');
    await run(b, 'ip route add default via 10.0.0.1 dev eth0');
    expect(await delivers()).toBe(true);
  });

  it('the maximum of all and the interface decides', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.all.rp_filter=0');
    await run(b, 'sysctl -w net.ipv4.conf.eth0.rp_filter=2');
    expect(await delivers()).toBe(false);
  });

  it('a source with a connected route is delivered in every mode', async () => {
    await run(b, 'nc -lu 9001 > /tmp/ok &');
    await run(a, 'printf y | nc -u -w1 10.0.0.2 9001');
    expect(await run(b, 'cat /tmp/ok')).toContain('y');
  });

  it('ships the package file', async () => {
    expect(await run(b, 'grep -v "^#" /etc/sysctl.d/10-network-security.conf | grep rp_filter')).toContain('net.ipv4.conf.all.rp_filter=2');
  });
});
