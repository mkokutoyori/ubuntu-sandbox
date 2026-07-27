/**
 * Cisco IOS ping renders one character per probe, and the character says
 * WHY the probe ended:
 *
 *   !  reply received
 *   .  timed out (nothing came back at all)
 *   U  an ICMP Destination Unreachable was received
 *   &  an ICMP Time Exceeded was received (packet lifetime)
 *
 * The distinction that matters: `U` means a router actually answered with
 * an error. A probe that simply never gets a reply is `.`, even when the
 * local interface is down — nothing sent us an ICMP in that case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

/** The probe-marks line of an IOS ping transcript. */
function marks(transcript: string): string {
  const line = transcript.split('\n').find((l) => /^[!.UQM&?*C I]+$/.test(l.trim()) && l.trim().length > 0);
  return line?.trim() ?? '';
}

/** R1 --- R2, R1 routes everything unknown at R2. */
async function twoRouters() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);
  const [a] = r1.getPortNames();
  const [b] = r2.getPortNames();
  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${a}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end',
  ]) await r1.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal', 'hostname R2',
    `interface ${b}`, 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end',
  ]) await r2.executeCommand(c);
  return { r1, r2, a, b };
}

describe('IOS ping marks each probe with the reason it ended', () => {
  it('U — the next hop answers Destination Unreachable (no route)', async () => {
    const { r1 } = await twoRouters();
    // R2 has no route to 192.0.2.7, so it answers with an ICMP error
    // instead of staying silent.
    const out = await r1.executeCommand('ping 192.0.2.7 repeat 3');
    expect(
      marks(out),
      'a router replied with an error — that is a U, not a silent timeout',
    ).toBe('UUU');
    expect(out).toContain('Success rate is 0 percent (0/3)');
  }, 30000);

  it('U — a transit ACL denies the echo and the router says so (code 13)', async () => {
    const { r1, r2, b } = await twoRouters();
    // R2 would forward this on, but the inbound ACL denies it and answers
    // "administratively prohibited" rather than dropping in silence.
    for (const c of [
      'enable', 'configure terminal',
      'ip route 192.0.2.0 255.255.255.0 10.0.0.9',
      'access-list 101 deny icmp any 192.0.2.0 0.0.0.255',
      'access-list 101 permit ip any any',
      `interface ${b}`, 'ip access-group 101 in', 'end',
    ]) await r2.executeCommand(c);

    const out = await r1.executeCommand('ping 192.0.2.7 repeat 2');
    expect(
      marks(out),
      'administratively prohibited is still an ICMP unreachable',
    ).toBe('UU');
  }, 30000);

  // The same U, for an echo aimed at the router's own interface rather
  // than through it, lives in router-inbound-acl-control-plane.test.ts.

  it('. — nothing answered at all', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    new Cable('c1').connect(r1.getPorts()[0], pc.getPorts()[0]);
    const [a] = r1.getPortNames();
    for (const c of [
      'enable', 'configure terminal', `interface ${a}`,
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
    ]) await r1.executeCommand(c);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.9'), new SubnetMask('255.255.255.0'));

    // On-link address nobody owns: ARP goes unanswered, no ICMP comes back.
    const out = await r1.executeCommand('ping 10.0.0.44 repeat 2');
    expect(marks(out), 'silence is a dot').toBe('..');
  }, 30000);

  it('. — a down local interface is still silence, never U', async () => {
    const { r1, a } = await twoRouters();
    for (const c of ['enable', 'configure terminal', `interface ${a}`, 'shutdown', 'end']) {
      await r1.executeCommand(c);
    }
    const out = await r1.executeCommand('ping 10.0.0.2 repeat 2');
    expect(
      marks(out),
      'nothing sent us an ICMP error — the probe simply never left, so it is a dot',
    ).not.toMatch(/U/);
  }, 30000);

  it('! — a reply is still a reply', async () => {
    const { r1 } = await twoRouters();
    const out = await r1.executeCommand('ping 10.0.0.2 repeat 4');
    expect(marks(out)).toBe('!!!!');
    expect(out).toContain('Success rate is 100 percent (4/4)');
  }, 30000);
});
