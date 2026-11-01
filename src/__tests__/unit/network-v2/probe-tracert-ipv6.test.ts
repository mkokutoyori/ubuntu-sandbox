/**
 * `tracert -6` / `tracert <litteral IPv6>` d'un poste Windows. Mesure de depart : tout litteral IPv6 recevait « Unable to contact IP driver. General failure. » (WinTracert) alors que
 * `EndHost.executeTraceroute6` sait tracer ; `-6` et `-4` etaient lus puis ignores (forceV6, forceV4), un nom n'etait resolu qu'en IPv4, et `-S srcaddr` etait stocke sans effet.
 * Le chemin est celui du lot `traceroute -6` (boucle de sauts partagee, sonde ICMPv6 echo avec limite de sauts croissante, comme tracert) ; la mise en page des lignes est celle d'IPv4
 * (WinTracert.formatWinTracertHop, une seule). `-S` n'est honore qu'avec une adresse IPv6 que le poste porte ; autrement tracert ne sonde rien (« Unable to contact IP driver. General failure. »,
 * texte deja utilise par ce fichier pour une pile inutilisable). `-4` sur un litteral IPv6 et `-6` sur un litteral IPv4 ne resolvent pas (« Unable to resolve target system name »).
 * Reserve : `-R` (en-tete de routage, IPv6 seulement) reste lu et ignore, comme avant (TODO.md).
 *
 * Discrimine par `git stash` sur src/network : 7 des 9 cas tombent avant. TEMOINS : la trace IPv4 d'un laboratoire sain ; « -S d'une adresse que le poste ne porte pas » passe avant pour une mauvaise raison
 * (tout litteral IPv6 recevait ce meme message du pilote) ; sa contrepartie positive est le cas « -S d'une adresse du poste ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

type Machine = LinuxPC | LinuxServer;

async function lab() {
  const a = new WindowsPC('windows-pc', 'WIN');
  const gw = new LinuxServer('linux-server', 'GW');
  const b = new LinuxPC('linux-pc', 'B');
  for (const device of [a, gw, b]) device.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, b.getPort('eth0')!);
  const run = async (device: Machine, command: string): Promise<string> => {
    const machine = device as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
    return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
  };
  const host = a as unknown as {
    configureIPv6Interface(name: string, address: IPv6Address, prefix: number): boolean;
    setDefaultGateway6(gateway: IPv6Address): void;
  };
  host.configureIPv6Interface('eth0', new IPv6Address('2001:db8:1::2'), 64);
  host.setDefaultGateway6(new IPv6Address('2001:db8:1::1'));
  for (const line of ['ip -6 addr add 2001:db8:1::1/64 dev eth0', 'ip -6 addr add 2001:db8:2::1/64 dev eth1', 'sysctl -w net.ipv6.conf.all.forwarding=1']) await run(gw, line);
  for (const line of ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:2::2/64 dev eth0', 'ip -6 route add default via 2001:db8:2::1']) await run(b, line);
  return { a, gw, b, run };
}

describe('tracert reaches an IPv6 target through a forwarding gateway', () => {
  it('a literal alone selects IPv6 and lists the gateway then the target', async () => {
    const { a } = await lab();
    const out = await a.executeCommand('tracert -d 2001:db8:2::2');
    expect(out).toContain('Tracing route to 2001:db8:2::2 over a maximum of 30 hops');
    expect(out).toMatch(/^\s+1\s+(<1|\d+) ms\s+(<1|\d+) ms\s+(<1|\d+) ms\s+2001:db8:1::1$/m);
    expect(out).toMatch(/^\s+2\s+.*2001:db8:2::2$/m);
    expect(out).toContain('Trace complete.');
  });

  it('-6 with the same literal gives the same trace', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('tracert -d -6 2001:db8:2::2')).toMatch(/^\s+2\s+.*2001:db8:2::2$/m);
  });

  it('-h 1 stops at the gateway', async () => {
    const { a } = await lab();
    const out = await a.executeCommand('tracert -d -h 1 2001:db8:2::2');
    expect(out).toMatch(/^\s+1\s+.*2001:db8:1::1$/m);
    expect(out).not.toMatch(/^\s+2\s/m);
  });

  it('a name from the hosts file resolves to its IPv6 address under -6', async () => {
    const { a } = await lab();
    await a.executeCommand('echo 2001:db8:2::2 farhost >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    const out = await a.executeCommand('tracert -d -6 farhost');
    expect(out).toContain('Tracing route to farhost [2001:db8:2::2]');
  });

  it('-S with an address of the host is the source of the probes', async () => {
    const { a, b } = await lab();
    (a as unknown as { configureIPv6Interface(n: string, x: IPv6Address, p: number): boolean })
      .configureIPv6Interface('eth0', new IPv6Address('2001:db8:1::99'), 64);
    const sources = new Set<string>();
    b.attachCapture(({ direction, frame }) => {
      const ip = frame.payload as { type?: string; sourceIP?: { toString(): string } } | undefined;
      if (direction === 'in' && ip?.type === 'ipv6') sources.add(ip.sourceIP!.toString());
    });
    await a.executeCommand('tracert -d -S 2001:db8:1::99 2001:db8:2::2');
    expect([...sources]).toContain('2001:db8:1::99');
  });

  it('-S with an address the host does not own probes nothing', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('tracert -d -S 2001:db8:1::77 2001:db8:2::2')).toBe('Unable to contact IP driver. General failure.');
  });
});

describe('the family flags decide', () => {
  it('-4 on an IPv6 literal does not resolve', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('tracert -4 2001:db8:2::2')).toBe('Unable to resolve target system name 2001:db8:2::2.');
  });

  it('-6 on an IPv4 literal does not resolve', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('tracert -6 10.0.0.1')).toBe('Unable to resolve target system name 10.0.0.1.');
  });

  it('WITNESS — the IPv4 trace of a sane lab still works', async () => {
    const { a, gw, b, run } = await lab();
    await a.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.1.2 255.255.255.0 10.0.1.1');
    await run(gw, 'ip addr add 10.0.1.1/24 dev eth0');
    await run(gw, 'ip addr add 10.0.2.1/24 dev eth1');
    await run(b, 'ip addr add 10.0.2.2/24 dev eth0');
    await run(b, 'ip route add default via 10.0.2.1');
    await run(gw, 'sysctl -w net.ipv4.ip_forward=1');
    const out = await a.executeCommand('tracert -d 10.0.2.2');
    expect(out).toContain('Tracing route to 10.0.2.2 over a maximum of 30 hops');
    expect(out).toMatch(/^\s+2\s.*10\.0\.2\.2$/m);
  });
});
