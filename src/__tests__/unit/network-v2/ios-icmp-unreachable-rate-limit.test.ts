/**
 * Probe — IOS rate-limits ICMP unreachables (one per 500 ms by default),
 * and its traceroute probes with UDP, so the limit shows where a learner
 * sees it on a real router: `U.U.U` from ping and `N msec *  N msec` on
 * the last hop of a traceroute to a Cisco router.
 *
 * Authority: Cisco IOS IP Application Services command reference
 * (`ip icmp rate-limit unreachable [df] milliseconds`, default one
 * unreachable per 500 ms, two timers — DF and all others); the
 * traceroute layout comes from captured IOS transcripts in ntc-templates
 * (tests/cisco_ios/traceroute/*.raw): no blank line after `VRF info`,
 * `%3d ` hop numbers, ` * ` per lost probe, ` !H ` per unreachable, and
 * a changed address on a continuation line indented by four spaces.
 *
 * The limit exposed two client-side time compressions, closed here and
 * probed as non-regressions: a TCP connect decided on its first SYN (the
 * kernel retransmits after the RFC 6298 initial RTO of 1 s), and a
 * Windows ping that never paused between echoes (the real one waits a
 * second). `nc -w` bounds the connect as netcat.c's timeout_connect does.
 *
 * Discrimination (`git stash` of the sources): 10 of 13 cases fail before.
 * Three pass on both trees: the witness `ping 10.0.12.2` — echo replies
 * are not unreachables, so the lab and the path are proven sound without
 * the limiter; and the nc-retransmission and Windows-pacing cases, which
 * are non-regressions — without a limiter every probe was answered, and
 * they prove the limiter did not take that away where a real client
 * would still see every answer.
 */
import { describe, expect, it } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: unknown, lines: readonly string[]): Promise<string> {
  let last = '';
  for (const line of lines) last = await (device as Cli).executeCommand(line);
  return last;
}

async function lab() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const near = new LinuxPC('linux-pc', 'NEAR', -150, 0);
  const far = new LinuxPC('linux-pc', 'FAR', 150, 0);
  for (const device of [r1, r2, near, far]) device.powerOn();
  new Cable('a').connect(near.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(r2.getPort('GigabitEthernet0/1')!, far.getPort('eth0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.12.1', 'end']);
  for (const [pc, ip, gw] of [[near, '10.0.0.2', '10.0.0.1'], [far, '10.0.2.2', '10.0.2.1']] as const) {
    await type(pc, ['ip link set eth0 up']);
    pc.getPort('eth0')!.configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    await type(pc, [`ip route add default via ${gw}`]);
  }
  await type(r1, ['ping 10.0.12.2 repeat 1']);
  return { r1, r2, near, far };
}

const HEADER = [
  'Type escape sequence to abort.',
  'Tracing the route to 10.0.12.2',
  'VRF info: (vrf in name/id, vrf out name/id)',
];

describe('IOS ICMP unreachable rate limit', () => {
  it('witness: echo replies are not rate-limited', async () => {
    const { r1 } = await lab();
    expect(await type(r1, ['ping 10.0.12.2'])).toContain('!!!!!');
  }, 30000);

  it('traceroute header has no blank line after the VRF info line', async () => {
    const { r1 } = await lab();
    const lines = (await type(r1, ['traceroute 10.0.12.2'])).split('\n');
    expect(lines.slice(0, 3)).toEqual(HEADER);
    expect(lines[3]).toMatch(/^ {2}1 10\.0\.12\.2 /);
  }, 30000);

  it('the second UDP probe to a Cisco router is refused its port unreachable', async () => {
    const { r1 } = await lab();
    const lines = (await type(r1, ['traceroute 10.0.12.2'])).split('\n');
    expect(lines[3]).toMatch(/^ {2}1 10\.0\.12\.2 \d+ msec \* {2}\d+ msec$/);
  }, 30000);

  it('a ping answered by unreachables alternates U and dot', async () => {
    const { r1 } = await lab();
    expect(await type(r1, ['ping 10.9.9.9'])).toContain('\nU.U.U\n');
  }, 30000);

  it('an unreachable in traceroute is printed per probe', async () => {
    const { r1 } = await lab();
    const out = await type(r1, ['traceroute 10.9.9.9 ttl 2 2']);
    expect(out.split('\n')[3]).toBe('  2 10.0.12.2 !N  *  !N ');
  }, 30000);

  it('no ip icmp rate-limit unreachable lifts the limit', async () => {
    const { r1, r2 } = await lab();
    await type(r2, ['configure terminal', 'no ip icmp rate-limit unreachable', 'end']);
    expect(await type(r1, ['ping 10.9.9.9'])).toContain('\nUUUUU\n');
    expect((await type(r1, ['traceroute 10.0.12.2'])).split('\n')[3])
      .toMatch(/^ {2}1 10\.0\.12\.2 \d+ msec \d+ msec \d+ msec$/);
  }, 30000);

  it('running-config renders only what departs from the default', async () => {
    const { r2 } = await lab();
    expect(await type(r2, ['show running-config | include rate-limit'])).toBe('');
    await type(r2, ['configure terminal',
      'no ip icmp rate-limit unreachable', 'ip icmp rate-limit unreachable df 10', 'end']);
    expect(await type(r2, ['show running-config | include rate-limit']))
      .toBe('no ip icmp rate-limit unreachable\nip icmp rate-limit unreachable df 10');
    await type(r2, ['configure terminal', 'ip icmp rate-limit unreachable 500', 'end']);
    expect(await type(r2, ['show running-config | include rate-limit']))
      .toBe('ip icmp rate-limit unreachable df 10');
  }, 30000);

  it('help announces the interval range and the df timer', async () => {
    const { r2 } = await lab();
    const help = await type(r2, ['configure terminal', 'ip icmp rate-limit unreachable ?']);
    expect(help).toContain('<1-4294967295>');
    expect(help).toMatch(/\n? *df +/);
    expect(await type(r2, ['ip icmp rate-limit unreachable 0'])).toContain('% Invalid input');
  }, 30000);

  it('a configured interval is the one enforced', async () => {
    const { r1, r2 } = await lab();
    await type(r2, ['configure terminal', 'ip icmp rate-limit unreachable 5000', 'end']);
    expect(await type(r1, ['ping 10.9.9.9'])).toContain('\nU...U\n');
  }, 30000);

  it('nc retransmits a SYN whose unreachable the limit silenced, as the kernel does after 1 s', async () => {
    const { r1, near } = await lab();
    await type(r1, ['configure terminal', 'access-list 100 deny tcp any any eq 22',
      'access-list 100 permit ip any any', 'interface GigabitEthernet0/0', 'ip access-group 100 in', 'end']);
    const first = await type(near, ['nc -zv 10.0.2.2 22']);
    const second = await type(near, ['nc -zv 10.0.2.2 22']);
    expect(second).toBe(first);
    expect(second).not.toContain('timed out');
  }, 30000);

  it('nc -w bounds the connect: a timeout shorter than the RTO gives up before the retransmission', async () => {
    const { r1, near } = await lab();
    await type(r1, ['configure terminal', 'access-list 100 deny tcp any any eq 22',
      'access-list 100 permit ip any any', 'interface GigabitEthernet0/0', 'ip access-group 100 in', 'end']);
    await type(near, ['nc -zv 10.0.2.2 22']);
    expect(await type(near, ['nc -zv -w 0 10.0.2.2 22'])).toContain('Connection timed out');
  }, 30000);

  it('Windows ping pauses a second after an error reply, so every echo gets its unreachable', async () => {
    const { r1, r2 } = await lab();
    await type(r2, ['configure terminal', 'ip route 10.0.3.0 255.255.255.0 10.0.12.1', 'end']);
    const win = new WindowsPC('windows-pc', 'WIN');
    win.powerOn();
    new Cable('d').connect(win.getPort('eth0')!, r1.getPort('GigabitEthernet0/2')!);
    await type(r1, ['configure terminal', 'interface GigabitEthernet0/2',
      'ip address 10.0.3.1 255.255.255.0', 'no shutdown', 'end']);
    win.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
    win.setDefaultGateway(new IPAddress('10.0.3.1'));
    const out = await type(win, ['ping 10.9.9.9']);
    expect(out.split('Reply from 10.0.12.2: Destination net unreachable.')).toHaveLength(5);
  }, 30000);

  it('Linux traceroute to a Cisco router loses the probes the limit refuses', async () => {
    const { near } = await lab();
    const out = await type(near, ['traceroute -n 10.0.12.2']);
    expect(out.split('\n')[2]).toMatch(/^ 2 {2}10\.0\.12\.2 {2}[\d.]+ ms \* \*$/);
  }, 30000);
});
