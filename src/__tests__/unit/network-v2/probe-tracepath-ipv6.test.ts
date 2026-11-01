/**
 * `tracepath -6` (et un litteral IPv6 seul). Mesure de depart : tout `-6` ou litteral IPv6 repondait « option -6: this simulator cannot build an IPv6 probe socket with IPV6_RECVERR »,
 * faute d'un equivalent IPv6 de `EndHost.udpErrorProbe`. Source : tracepath.c d'iputils 20221126 (le meme code sert les deux familles : surcharge IPv6 + UDP = 48 octets, MTU par defaut 128000,
 * `pktlen must be within: 48 < value <= INT_MAX`, le message ICMPv6 Packet Too Big devient EMSGSIZE et `pmtu`, le port injoignable ECONNREFUSED « reached », Destination Unreachable
 * code 0 ENETUNREACH `!N`, Time Exceeded EHOSTUNREACH, via `udpSocketErrorForV6` deja ecrit pour les prises UDP connectees). La sonde IPv6 attend l'erreur citee par le bus de la machine, comme celle d'IPv4.
 *
 * Discrimine par `git stash` sur src/network : 6 des 7 cas tombent avant. TEMOIN : `-4 -6` (le refus de deux familles existait deja et son texte n'a pas change).
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



describe('tracepath over IPv6 crosses a forwarding gateway', () => {
  it('lists the gateway then reaches the target, with the IPv6 pmtu', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'tracepath -6 -n 2001:db8:2::2');
    expect(out).toMatch(/^1\?: \[LOCALHOST\]\s+pmtu 1500$/m);
    expect(out).toMatch(/^ 1:  2001:db8:1::1\s+[\d.]+ms $/m);
    expect(out).toMatch(/^ 2:  2001:db8:2::2\s+[\d.]+ms reached$/m);
    expect(out).toContain('Resume: pmtu 1500 hops 2 back 2');
  });

  it('an IPv6 literal alone selects the family', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'tracepath -n 2001:db8:2::2')).toContain('reached');
  });

  it('a narrower link downstream is found as pmtu 1400 from Packet Too Big', async () => {
    const { a, gw, run } = await lab();
    await run(gw, 'ip link set dev eth1 mtu 1400');
    const out = await run(a, 'tracepath -n 2001:db8:2::2');
    expect(out).toMatch(/^ 2:  2001:db8:1::1\s+[\d.]+ms pmtu 1400$/m);
    expect(out).toContain('Resume: pmtu 1400 hops 2 back 2');
  });

  it('-l sets the first packet length, down to the 1280 floor of a path that allows it', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'tracepath -n -l 1280 2001:db8:2::2');
    expect(out).toContain('Resume: pmtu 1280 hops 2 back 2');
    expect(out).not.toContain('[LOCALHOST]');
  });

  it('-l 48 is refused with the IPv6 overhead as the bound', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'tracepath -n -l 48 2001:db8:2::2')).toBe('tracepath: pktlen must be within: 48 < value <= 2147483647');
  });

  it('a gateway without a route answers !N', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'tracepath -6 -n 2001:db8:9::9');
    expect(out).toMatch(/^ 2:  2001:db8:1::1\s+[\d.]+ms !N$/m);
  });

  it('WITNESS — two families on one command line are still refused', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'tracepath -4 -6 2001:db8:2::2')).toBe('tracepath: Only one -4 or -6 option may be specified');
  });
});
