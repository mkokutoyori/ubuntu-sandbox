/**
 * Transfert IPv6 d'un hote Linux (`net.ipv6.conf.all.forwarding=1`). Mesure de depart : le reglage etait stocke (et changeait l'acceptation des RA) mais `EndHost.handleIPv6`
 * comptait tout paquet non local en `Ip6InAddrErrors` et le jetait ; un LinuxServer a deux cartes ne routait donc jamais d'IPv6, et `Ip6OutForwDatagrams`/`Ip6InNoRoutes`/`Ip6InTooBigErrors` etaient figes a zero. Source : net/ipv6/ip6_output.c ip6_forward (v6.8) — `all.forwarding == 0` jette (InAddrErrors) ;
 * hop_limit <= 1 repond Time Exceeded code 0 (InHdrErrors) ; source ANY/multicast/loopback jetee, source de lien refusee par Destination Unreachable code 2 (« not neighbour »)
 * seulement quand l'interface de sortie differe de celle d'entree ; MTU de sortie plancher 1280 -> Packet Too Big ; sinon hop_limit-- puis le crochet FORWARD (ip6tables) puis
 * l'emission vers le voisin du saut suivant (ndisc). Pas de route -> Destination Unreachable code 0 (InNoRoutes). Reserve : le Redirect IPv6 (meme interface entree/sortie) n'est pas emis (TODO.md).
 *
 * Discrimine par `git stash` sur src/network : 7 des 10 cas tombent avant. TEMOINS : le ping direct hote-hote sur un meme lien (le laboratoire est sain), sans `forwarding` rien ne passe
 * et InAddrErrors compte (le comportement par defaut est conserve), la regle FORWARD DROP bloque (passe avant pour une mauvaise raison : rien ne passait) ; sa contrepartie
 * positive est le cas « traverse » voisin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(options: { forwarding?: boolean } = {}) {
  const a = new LinuxPC('linux-pc', 'A');
  const gw = new LinuxServer('linux-server', 'GW');
  const b = new LinuxPC('linux-pc', 'B');
  for (const device of [a, gw, b]) device.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, b.getPort('eth0')!);
  const run = async (device: LinuxPC | LinuxServer, command: string): Promise<string> => {
    const machine = device as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
    return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
  };
  for (const [device, lines] of [
    [a, ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:1::2/64 dev eth0', 'ip -6 route add default via 2001:db8:1::1']],
    [gw, ['ip -6 addr add 2001:db8:1::1/64 dev eth0', 'ip -6 addr add 2001:db8:2::1/64 dev eth1']],
    [b, ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:2::2/64 dev eth0', 'ip -6 route add default via 2001:db8:2::1']],
  ] as const) {
    for (const line of lines) await run(device, line);
  }
  if (options.forwarding !== false) await run(gw, 'sysctl -w net.ipv6.conf.all.forwarding=1');
  return { a, gw, b, run };
}

const counter = async (run: (d: LinuxPC | LinuxServer, c: string) => Promise<string>, device: LinuxPC | LinuxServer, name: string): Promise<number> => {
  const text = await run(device, 'cat /proc/net/snmp6');
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return Number(line?.trim().split(/\s+/)[1]);
};

describe('a host with forwarding=1 routes IPv6', () => {
  it('WITNESS — hosts on one link reach each other', async () => {
    const { a, gw } = await lab({ forwarding: false });
    expect(await a.executeCommand('ping6 -c 1 2001:db8:1::1')).toMatch(/1 received/);
    expect(gw).toBeDefined();
  });

  it('a packet crosses the gateway', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('ping6 -c 1 2001:db8:2::2')).toMatch(/1 received/);
  });

  it('the gateway counts what it forwarded', async () => {
    const { a, gw, run } = await lab();
    await a.executeCommand('ping6 -c 1 2001:db8:2::2');
    expect(await counter(run, gw, 'Ip6OutForwDatagrams')).toBeGreaterThanOrEqual(2);
  });

  it('without forwarding nothing crosses and the packet is an address error', async () => {
    const { a, gw, run } = await lab({ forwarding: false });
    expect(await a.executeCommand('ping6 -c 1 -W 1 2001:db8:2::2')).toMatch(/0 received/);
    expect(await counter(run, gw, 'Ip6InAddrErrors')).toBeGreaterThan(0);
    expect(await counter(run, gw, 'Ip6OutForwDatagrams')).toBe(0);
  });
});

describe('errors the gateway owes the sender', () => {
  it('hop limit 1 dies at the gateway with Time Exceeded, sourced from the ingress address', async () => {
    const { a, gw, run } = await lab();
    const out = await a.executeCommand('ping6 -c 1 -t 1 2001:db8:2::2');
    expect(out).toMatch(/Time exceeded: Hop limit/i);
    expect(out).toContain('2001:db8:1::1');
    expect(await counter(run, gw, 'Ip6InHdrErrors')).toBeGreaterThan(0);
  });

  it('hop limit 2 is exactly enough to cross one gateway', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('ping6 -c 1 -t 2 2001:db8:2::2')).toMatch(/1 received/);
  });

  it('no route: Destination Unreachable, and the counter moves', async () => {
    const { a, gw, run } = await lab();
    const out = await a.executeCommand('ping6 -c 1 2001:db8:9::9');
    expect(out).toMatch(/Destination unreachable|No route|Network is unreachable/i);
    expect(await counter(run, gw, 'Ip6InNoRoutes')).toBeGreaterThan(0);
  });

  it('a packet larger than the outgoing MTU gets Packet Too Big with that MTU', async () => {
    const { a, gw, run } = await lab();
    await run(gw, 'ip link set dev eth1 mtu 1280');
    const out = await a.executeCommand('ping6 -c 1 -s 1400 2001:db8:2::2');
    expect(out).toMatch(/Packet too big|mtu = 1280|mtu 1280/i);
    expect(await counter(run, gw, 'Ip6InTooBigErrors')).toBeGreaterThan(0);
  });
});

describe('policy applies to transit traffic', () => {
  it('an ip6tables FORWARD DROP stops the packet', async () => {
    const { a, gw, run } = await lab();
    await run(gw, 'ip6tables -A FORWARD -j DROP');
    expect(await a.executeCommand('ping6 -c 1 -W 1 2001:db8:2::2')).toMatch(/0 received/);
    expect(await counter(run, gw, 'Ip6OutForwDatagrams')).toBe(0);
  });

  it('an INPUT rule on echo requests stops the gateway itself and not the transit traffic', async () => {
    const { a, gw, run } = await lab();
    await run(gw, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j DROP');
    expect(await a.executeCommand('ping6 -c 1 -W 1 2001:db8:1::1')).toMatch(/0 received/);
    expect(await a.executeCommand('ping6 -c 1 2001:db8:2::2')).toMatch(/1 received/);
  });
});
