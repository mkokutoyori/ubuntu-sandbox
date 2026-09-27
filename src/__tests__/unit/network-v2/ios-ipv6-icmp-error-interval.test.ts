/**
 * Probe — IOS limits ICMPv6 errors with a token bucket, and its IPv6
 * traceroute probes with UDP, the way its IPv4 one does.
 *
 * Measured on two CiscoRouter before the change: no ICMPv6 error was
 * ever limited, `ipv6 icmp error-interval` did not exist, `traceroute
 * ipv6` sent ICMPv6 echoes, the router's ICMPv6 errors quoted nothing of
 * the invoking packet (RFC 4443 §3 asks for as much of it as fits), and
 * addresses were printed in lower case where IOS prints upper case, and
 * `traceroute ipv6 ... ttl <min> <max>` ignored its minimum.
 *
 * Authority: Cisco IOS IPv6 command reference and "IPv6 ICMP Rate
 * Limiting" configuration guide — `ipv6 icmp error-interval
 * milliseconds [bucketsize]`, one token per error, a token every 100 ms
 * into a bucket of 10 by default, 0 disabling the limit; the example
 * `ipv6 icmp error-interval 50 20`. RFC 4443 §3.1 for the unreachable
 * codes and the quoted invoking packet.
 *
 * Discrimination (`git stash` of the sources): 6 of 8 cases fail before.
 * Two pass on both trees: the witness `ping ipv6` — echo replies are not
 * errors, so the lab is proven sound without the bucket involved — and
 * `error-interval 0`, a non-regression: with no bucket at all every one
 * of the eleven errors was already sent.
 */
import { describe, expect, it } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: unknown, lines: readonly string[]): Promise<string> {
  let last = '';
  for (const line of lines) last = await (device as Cli).executeCommand(line);
  return last;
}

async function lab() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  for (const device of [r1, r2]) device.powerOn();
  new Cable('a').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  await type(r1, ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:12::1/64', 'no shutdown', 'exit',
    'ipv6 route ::/0 2001:db8:12::2', 'end']);
  await type(r2, ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:12::2/64', 'no shutdown', 'exit', 'end']);
  return { r1, r2 };
}

const hopLine = (out: string): string => out.split('\n')[3] ?? '';
const count = (text: string, token: RegExp): number => (text.match(token) ?? []).length;

describe('IOS ICMPv6 error token bucket', () => {
  it('witness: echo replies are not errors', async () => {
    const { r1 } = await lab();
    expect(await type(r1, ['ping ipv6 2001:db8:12::2'])).toContain('!!!!!');
  }, 30000);

  it('traceroute ipv6 prints the addresses the way IOS does, in upper case', async () => {
    const { r1 } = await lab();
    const out = await type(r1, ['traceroute ipv6 2001:db8:12::2']);
    expect(out.split('\n')[1]).toBe('Tracing the route to 2001:DB8:12::2');
    expect(hopLine(out)).toMatch(/^ {2}1 2001:DB8:12::2 \d+ msec \d+ msec \d+ msec$/);
  }, 30000);

  it('the probes are UDP: the destination answers each with a port unreachable, which the bucket counts', async () => {
    const { r1, r2 } = await lab();
    await type(r2, ['configure terminal', 'ipv6 icmp error-interval 60000 1', 'end']);
    expect(hopLine(await type(r1, ['traceroute ipv6 2001:db8:12::2 timeout 1'])))
      .toMatch(/^ {2}1 2001:DB8:12::2 \d+ msec \* {2}\* $/);
  }, 30000);

  it('a burst of ten errors passes, the eleventh waits for a token', async () => {
    const { r1 } = await lab();
    const line = hopLine(await type(r1, ['traceroute ipv6 2001:db8:99::1 probe 11 ttl 1 1 timeout 1']));
    expect(count(line, /\d+ msec/g)).toBe(10);
    expect(count(line, /\*/g)).toBe(1);
  }, 30000);

  it('an interval of 0 lifts the limit', async () => {
    const { r1, r2 } = await lab();
    await type(r2, ['configure terminal', 'ipv6 icmp error-interval 0', 'end']);
    const line = hopLine(await type(r1, ['traceroute ipv6 2001:db8:99::1 probe 11 ttl 1 1 timeout 1']));
    expect(count(line, /\d+ msec/g)).toBe(11);
  }, 30000);

  it('an unreachable is printed per probe', async () => {
    const { r1 } = await lab();
    const out = await type(r1, ['traceroute ipv6 2001:db8:99::1 ttl 2 2']);
    expect(hopLine(out)).toBe('  2 2001:DB8:12::2 !N  !N  !N ');
  }, 30000);

  it('running-config renders only what departs from the default', async () => {
    const { r2 } = await lab();
    expect(await type(r2, ['show running-config | include error-interval'])).toBe('');
    await type(r2, ['configure terminal', 'ipv6 icmp error-interval 50 20', 'end']);
    expect(await type(r2, ['show running-config | include error-interval'])).toBe('ipv6 icmp error-interval 50 20');
    await type(r2, ['configure terminal', 'ipv6 icmp error-interval 50', 'end']);
    expect(await type(r2, ['show running-config | include error-interval'])).toBe('ipv6 icmp error-interval 50');
    await type(r2, ['configure terminal', 'no ipv6 icmp error-interval', 'end']);
    expect(await type(r2, ['show running-config | include error-interval'])).toBe('');
  }, 30000);

  it('help announces both ranges, and the announced range is applied', async () => {
    const { r2 } = await lab();
    await type(r2, ['configure terminal']);
    expect(await type(r2, ['ipv6 icmp error-interval ?'])).toContain('<0-2147483647>');
    expect(await type(r2, ['ipv6 icmp error-interval 50 ?'])).toContain('<1-200>');
    expect(await type(r2, ['ipv6 icmp error-interval 50 201'])).toContain('% Invalid input');
  }, 30000);
});
