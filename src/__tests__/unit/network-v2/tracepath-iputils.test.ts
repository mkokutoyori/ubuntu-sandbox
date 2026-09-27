/*
 * tracepath read against iputils 20221126 tracepath.c: getopt
 * "46nbh?l:m:p:V", strtol_or_err ranges, the host/port form, a first probe
 * of 65535 bytes (DEFAULT_MTU_IPV4) sent with IP_PMTUDISC_DO so the kernel
 * answers EMSGSIZE with the route MTU (" 1?: [LOCALHOST]  pmtu N"), the
 * restart of a hop whenever the MTU changes (hence the doubled first
 * hop), recverr's errno switch (pmtu, reached, !N, !H, asymm), print_host's
 * 52-column host field, "%3ld.%03ldms ", "Too many hops" and the Resume
 * line, usage() and its exit(-1). The errno of each ICMP error is the one a
 * UDP socket with IP_RECVERR reads (net/ipv4/icmp.c icmp_err_convert, and
 * EMSGSIZE for a frag-needed), and the local EMSGSIZE comes from the path
 * MTU the host has learned (net/ipv4/route.c).
 *
 * Measured before: the pmtu column never moved and came from the first
 * interface; -l and -p were parsed and ignored; the hop count was capped at
 * 8 and "back" was the hop count; the LOCALHOST padding, the usage text and
 * the refusals were invented, and every exit status was 0.
 *
 * DISCRIMINATION (git stash of src/network): 6 of the 7 cases fall before
 * the change. The witness passes on both trees: the lab carries a ping to
 * the far host.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(): Promise<LinuxPC> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  const router = new CiscoRouter('R1', 50, 0);
  new Cable('a').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(router.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.254 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.254 255.255.255.0', 'ip mtu 1400', 'no shutdown', 'end']) {
    await router.executeCommand(c);
  }
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc.executeCommand('sudo ip route add default via 10.0.0.254');
  await srv.executeCommand('ifconfig eth0 10.0.1.2 netmask 255.255.255.0');
  await srv.executeCommand('ip route add default via 10.0.1.254');
  return pc;
}

const withoutTimes = (out: string) => out.split('\n').map((l) => l.replace(/\d+\.\d{3}ms /, '<t> '));
const hop = (n: string, host: string, tail: string) => `${n}:  ${host.padEnd(52)}  <t> ${tail}`;

describe('the path MTU is discovered along the path', () => {
  it('the local MTU first, then the router frag-needed, then the destination', async () => {
    const pc = await lab();
    expect(withoutTimes(await pc.executeCommand('tracepath -n 10.0.1.2'))).toEqual([
      ' 1?: [LOCALHOST]                      pmtu 1500',
      hop(' 1', '10.0.0.254', ''),
      hop(' 1', '10.0.0.254', ''),
      hop(' 2', '10.0.0.254', 'pmtu 1400'),
      hop(' 2', '10.0.1.2', 'reached'),
      '     Resume: pmtu 1400 hops 2 back 2 ',
    ]);
  }, 20000);

  it('a second run starts from the MTU the host remembers, and -l sets the first length', async () => {
    const pc = await lab();
    await pc.executeCommand('tracepath -n 10.0.1.2');
    expect((await pc.executeCommand('tracepath -n 10.0.1.2')).split('\n')[0]).toBe(' 1?: [LOCALHOST]                      pmtu 1400');
    expect((await pc.executeCommand('tracepath -n -l 1000 10.0.0.254')).split('\n').pop())
      .toBe('     Resume: pmtu 1000 hops 1 back 1 ');
  }, 20000);

  it('-m bounds the hops, and an unroutable destination ends on !N', async () => {
    const pc = await lab();
    expect((await pc.executeCommand('tracepath -n -m 1 10.0.1.2')).split('\n').slice(-2))
      .toEqual(['     Too many hops: pmtu 1500', '     Resume: pmtu 1500 ']);
    expect(withoutTimes(await pc.executeCommand('tracepath -n 192.0.2.1')).slice(-2))
      .toEqual([hop(' 2', '10.0.0.254', '!N'), '     Resume: pmtu 1500 ']);
  }, 20000);
});

describe('refusals and exit statuses', () => {
  it('iputils words and codes', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('tracepath -z x; echo rc=$?')).toMatch(/^tracepath: invalid option -- 'z'\n\nUsage\n {2}tracepath \[options\] <destination>\n[\s\S]*For more details see tracepath\(8\)\.\nrc=255$/);
    expect(await pc.executeCommand('tracepath -4 -6 x; echo rc=$?')).toBe('tracepath: Only one -4 or -6 option may be specified\nrc=2');
    expect(await pc.executeCommand('tracepath nosuch; echo rc=$?')).toBe('tracepath: nosuch: Name or service not known\nrc=1');
    expect(await pc.executeCommand('tracepath -m 300 x')).toBe("tracepath: invalid argument: '300': out of range: 0 <= value <= 255");
    expect(await pc.executeCommand('tracepath -l 20 10.0.1.2')).toBe('tracepath: pktlen must be within: 28 < value <= 2147483647');
  }, 20000);

  it('the old host/port form sets the base port', async () => {
    const pc = await lab();
    expect((await pc.executeCommand('tracepath -n 10.0.1.2/33434')).split('\n').pop()).toBe('     Resume: pmtu 1400 hops 2 back 2 ');
  }, 20000);

  it('a loopback target is reached at hop 1', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('tracepath -n 127.0.0.1')).toMatch(/^ 1: {2}127\.0\.0\.1 +\d+\.\d{3}ms reached\n {5}Resume: pmtu 65535 hops 1 back 1 $/);
  }, 20000);

  it('witness: the lab carries a ping to the far host', async () => {
    const pc = await lab();
    expect((await pc.executeCommand('ping -c 1 10.0.1.2')).split('\n')[1]).toMatch(/^64 bytes from 10\.0\.1\.2: icmp_seq=1 ttl=63/);
  }, 20000);
});
