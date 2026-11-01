/**
 * `traceroute -6` et `traceroute6` : le chemin IPv6 d'un hote Linux. Mesure de depart : `traceroute -6 host` repondait « this simulator cannot build an IPv6 trace (this simulator
 * traces over IPv4 only) », un litteral IPv6 etait refuse de la meme facon, `-l` (etiquette de flux) aussi, et `traceroute6` n'existait pas alors que le paquet `traceroute`
 * le livre (LinuxCommandPackages). Source : traceroute 2.1.0 de Dmitry Butskoy (traceroute.c, lu dans l'archive sourceforge) : l'entete imprime `header_len + data_len` soit 40 + 8 + 32 = 80 octets en IPv6 ;
 * les annotations d'erreur ICMPv6 sont NOROUTE `!N`, BEYONDSCOPE et ADDR `!H`, ADMIN `!X`, NOPORT rien (destination atteinte), autre `!<code>` ; `-l` ecrit l'etiquette de flux sur 20 bits dans
 * le paquet et `-s` d'une autre famille que la cible est refuse (« IP version mismatch in addresses specified ») ; le nom du programme finissant par `6` force la famille. Les sondes UDP (defaut), ICMP (-I) et TCP (-T)
 * decrementent la limite de sauts ; la boucle de sauts est CELLE d'IPv4 (EndHost.collectTraceHops). `-P`/`-M raw` envoie un paquet IPv6 de protocole inconnu : la cible compte Ip6InUnknownProtos et repond un
 * Parameter Problem code 1 (RFC 4443 §3.4, ip6_input_finish) que traceroute imprime `!<4-1>` (type-code, sans nom) et qui arrete la trace ; apres le filtre INPUT d'ip6tables, qui le fait taire.
 *
 * Lot du Parameter Problem, discrimine par `git stash` sur src/network : les 4 cas `-P`/`-M raw` tombent avant (ils recevaient le refus) et les 17 autres passent avant comme apres ; le cas ip6tables ne prouve le filtre que contre son frere sans regle (meme trace, qui repond) ; le compteur est lu sur la cible et non deduit de la trace.
 * Lot initial, discrimine par `git stash` sur src/network et src/terminal : 17 des 18 cas tombaient avant. TEMOIN : la trace IPv4 d'un laboratoire sain (seul cas qui passe avant, et c'est son role : la boucle de sauts partagee
 * n'a pas bouge IPv4). Le cas « route absente » tombait aussi, mais pour une autre raison que celle qu'il prouve : `ip -6 route del default` exigeait `via` (reserve a `add`), si bien que la route
 * n'etait jamais retiree ; `ip -6 route del default` est corrige dans ce lot et le cas verifie d'abord que la route a disparu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { IPv6Packet } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

type Machine = LinuxPC | LinuxServer;

async function lab() {
  const a = new LinuxPC('linux-pc', 'A');
  const gw = new LinuxServer('linux-server', 'GW');
  const b = new LinuxPC('linux-pc', 'B');
  for (const device of [a, gw, b]) device.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, b.getPort('eth0')!);
  const run = async (device: Machine, command: string): Promise<string> => {
    const machine = device as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
    return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
  };
  for (const [device, lines] of [
    [a, ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:1::2/64 dev eth0', 'ip -6 route add default via 2001:db8:1::1']],
    [gw, ['ip -6 addr add 2001:db8:1::1/64 dev eth0', 'ip -6 addr add 2001:db8:2::1/64 dev eth1', 'sysctl -w net.ipv6.conf.all.forwarding=1']],
    [b, ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:2::2/64 dev eth0', 'ip -6 route add default via 2001:db8:2::1']],
  ] as const) {
    for (const line of lines) await run(device, line);
  }
  return { a, gw, b, run };
}

const HEADER = 'traceroute to 2001:db8:2::2 (2001:db8:2::2), 30 hops max, 80 byte packets';

describe('the UDP trace crosses a forwarding gateway', () => {
  it('traceroute -6 -n lists the gateway then the target, with the IPv6 header', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute -6 -n 2001:db8:2::2');
    expect(out.split('\n')[0]).toBe(HEADER);
    expect(out).toMatch(/^ 1  2001:db8:1::1  [\d.]+ ms  [\d.]+ ms  [\d.]+ ms$/m);
    expect(out).toMatch(/^ 2  2001:db8:2::2  [\d.]+ ms/m);
  });

  it('an IPv6 literal alone selects the family, as in traceroute.c set_host', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -n 2001:db8:2::2')).toContain(HEADER);
  });

  it('traceroute6 forces the family through its name', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute6 -n 2001:db8:2::2');
    expect(out.split('\n')[0]).toBe(HEADER);
    expect(out).toMatch(/^ 2  2001:db8:2::2/m);
  });

  it('-m 1 stops after the first hop', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute -6 -n -m 1 2001:db8:2::2');
    expect(out).toMatch(/^ 1  2001:db8:1::1/m);
    expect(out).not.toMatch(/^ 2 /m);
  });
});

describe('the other probe methods', () => {
  it('-I traces with ICMPv6 echo', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute -6 -n -I 2001:db8:2::2');
    expect(out).toMatch(/^ 1  2001:db8:1::1/m);
    expect(out).toMatch(/^ 2  2001:db8:2::2/m);
  });

  it('-T traces with TCP SYN, the closed port answering RST', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute -6 -n -T -p 81 2001:db8:2::2');
    expect(out).toMatch(/^ 1  2001:db8:1::1/m);
    expect(out).toMatch(/^ 2  2001:db8:2::2/m);
  });

  it('-U traces with UDP to a fixed port', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -6 -n -U 2001:db8:2::2')).toMatch(/^ 2  2001:db8:2::2/m);
  });

  it('-P 253 reaches the target, which answers a Parameter Problem on the unknown next header: !<4-1>', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute -6 -n -q 1 -P 253 2001:db8:2::2');
    expect(out).toMatch(/^ 1  2001:db8:1::1  [\d.]+ ms$/m);
    expect(out).toMatch(/^ 2  2001:db8:2::2  [\d.]+ ms !<4-1>$/m);
    expect(out).not.toMatch(/^ 3 /m);
  });

  it('the target counts the packet in Ip6InUnknownProtos', async () => {
    const { a, b, run } = await lab();
    await run(a, 'traceroute -6 -n -q 1 -P 253 2001:db8:2::2');
    expect(await run(b, 'grep Ip6InUnknownProtos /proc/net/snmp6')).toMatch(/Ip6InUnknownProtos\s+[1-9]/);
  });

  it('an ip6tables INPUT drop silences the answer: the packet never reaches the protocol demux', async () => {
    const { a, b, run } = await lab();
    await run(b, 'ip6tables -A INPUT -p 253 -j DROP');
    const out = await run(a, 'traceroute -6 -n -q 1 -w 1 -m 2 -P 253 2001:db8:2::2');
    expect(out).toMatch(/^ 2  \*$/m);
  });

  it('-M raw without -P is still the default protocol 253 trace', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -6 -n -q 1 -M raw 2001:db8:2::2')).toMatch(/^ 2  2001:db8:2::2  [\d.]+ ms !<4-1>$/m);
  });
});

describe('errors and options', () => {
  it('a gateway without a route answers !N', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'traceroute -6 -n -q 1 2001:db8:9::9');
    expect(out).toMatch(/^ 1  2001:db8:1::1  [\d.]+ ms$/m);
    expect(out).toMatch(/^ 2  2001:db8:1::1  [\d.]+ ms !N$/m);
  });

  it('WITNESS — no route at all: Network is unreachable', async () => {
    const { b, run } = await lab();
    await run(b, 'ip -6 route del default');
    expect(await run(b, 'ip -6 route show')).not.toContain('default');
    expect(await run(b, 'traceroute -6 -n 2001:db8:9::9')).toContain('connect: Network is unreachable');
  });

  it('-s from the other family is a version mismatch', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -6 -s 192.0.2.1 2001:db8:2::2')).toBe('IP version mismatch in addresses specified');
  });

  it('-s with an address of the host is the source of the probes', async () => {
    const { a, b, run } = await lab();
    await run(a, 'ip -6 addr add 2001:db8:1::99/64 dev eth0');
    const sources = new Set<string>();
    b.attachCapture(({ direction, frame }) => {
      const ip = frame.payload as IPv6Packet | undefined;
      if (direction === 'in' && ip?.type === 'ipv6') sources.add(ip.sourceIP.toString());
    });
    await run(a, 'traceroute -6 -n -s 2001:db8:1::99 2001:db8:2::2');
    expect([...sources]).toContain('2001:db8:1::99');
    expect([...sources]).not.toContain('2001:db8:1::2');
  });

  it('-s with an address the host does not own is refused', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -6 -s 2001:db8:1::77 2001:db8:2::2')).toContain('bind: Cannot assign requested address');
  });

  it('-l writes the flow label on the wire', async () => {
    const { a, b, run } = await lab();
    const labels = new Set<number>();
    b.attachCapture(({ direction, frame }) => {
      const ip = frame.payload as IPv6Packet | undefined;
      if (direction === 'in' && ip?.type === 'ipv6' && ip.flowLabel !== undefined) labels.add(ip.flowLabel);
    });
    await run(a, 'traceroute -6 -n -l 4660 2001:db8:2::2');
    expect([...labels]).toContain(4660);
  });

  it('-4 on an IPv6 literal is an unknown host', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -4 2001:db8:2::2')).toContain('Name or service not known');
  });

  it('a name from /etc/hosts resolves to its IPv6 address under -6', async () => {
    const { a, run } = await lab();
    await run(a, "sh -c 'echo \"2001:db8:2::2 farhost\" >> /etc/hosts'");
    const out = await run(a, 'traceroute -6 -n farhost');
    expect(out.split('\n')[0]).toBe('traceroute to farhost (2001:db8:2::2), 30 hops max, 80 byte packets');
  });

  it('the local address is its own first hop', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'traceroute -6 -n ::1')).toMatch(/^ 1  ::1/m);
  });
});

describe('IPv4 is unchanged', () => {
  it('WITNESS — the IPv4 trace of a sane lab keeps its 60-byte header', async () => {
    const { a, gw, b, run } = await lab();
    await run(a, 'ip addr add 10.0.1.2/24 dev eth0');
    await run(gw, 'ip addr add 10.0.1.1/24 dev eth0');
    await run(gw, 'ip addr add 10.0.2.1/24 dev eth1');
    await run(b, 'ip addr add 10.0.2.2/24 dev eth0');
    await run(a, 'ip route add default via 10.0.1.1');
    await run(b, 'ip route add default via 10.0.2.1');
    await run(gw, 'sysctl -w net.ipv4.ip_forward=1');
    const out = await run(a, 'traceroute -n 10.0.2.2');
    expect(out.split('\n')[0]).toBe('traceroute to 10.0.2.2 (10.0.2.2), 30 hops max, 60 byte packets');
    expect(out).toMatch(/^ 2  10.0.2.2/m);
  });
});
