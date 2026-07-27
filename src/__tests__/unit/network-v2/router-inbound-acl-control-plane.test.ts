/**
 * `ip access-group X in` filters everything the interface receives, not
 * only what the router forwards. Cisco's documented inbound order of
 * operations puts the input ACL ahead of the local-delivery / forwarding
 * split, which is why an ACL that forgets the control plane takes down
 * the very session the operator is typing into.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
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

async function twoRouters() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);
  const [a] = r1.getPortNames();
  const [b] = r2.getPortNames();
  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${a}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await r1.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal', 'hostname R2',
    `interface ${b}`, 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end',
  ]) await r2.executeCommand(c);
  return { r1, r2, a, b };
}

async function configure(r: CiscoRouter, lines: string[]): Promise<void> {
  for (const c of ['enable', 'configure terminal', ...lines, 'end']) await r.executeCommand(c);
}

describe('an inbound ACL also filters traffic addressed to the router', () => {
  it('denies an echo aimed at the router s own interface', async () => {
    const { r1, r2, b } = await twoRouters();
    await configure(r2, [
      'access-list 101 deny icmp any any echo',
      'access-list 101 permit ip any any',
      `interface ${b}`, 'ip access-group 101 in',
    ]);

    const out = await r1.executeCommand('ping 10.0.0.2 repeat 2');
    expect(
      marks(out),
      'the destination is the router itself — IOS still applies the inbound ACL',
    ).toBe('UU');
    expect(out).toContain('Success rate is 0 percent (0/2)');
  }, 30000);

  it('lets the same echo through once the ACL permits it', async () => {
    const { r1, r2, b } = await twoRouters();
    await configure(r2, [
      'access-list 101 permit icmp any any',
      `interface ${b}`, 'ip access-group 101 in',
    ]);

    expect(marks(await r1.executeCommand('ping 10.0.0.2 repeat 2'))).toBe('!!');
  }, 30000);

  it('a standard ACL filters on the source, self-destined included', async () => {
    const { r1, r2, b } = await twoRouters();
    await configure(r2, [
      'access-list 1 deny 10.0.0.1',
      'access-list 1 permit any',
      `interface ${b}`, 'ip access-group 1 in',
    ]);

    expect(marks(await r1.executeCommand('ping 10.0.0.2 repeat 2'))).toBe('UU');
  }, 30000);

  it('`no ip unreachables` turns the denial into silence, not into a U', async () => {
    const { r1, r2, b } = await twoRouters();
    await configure(r2, [
      'access-list 101 deny icmp any any echo',
      'access-list 101 permit ip any any',
      `interface ${b}`, 'ip access-group 101 in', 'no ip unreachables',
    ]);

    const out = await r1.executeCommand('ping 10.0.0.2 repeat 2');
    expect(
      marks(out),
      'nothing answers, so the probe can only be a timeout',
    ).toBe('..');
  }, 30000);

  it('an ACL that forgets OSPF takes the adjacency down — and `permit ospf` keeps it', async () => {
    const { r1, r2, b } = await twoRouters();
    for (const r of [r1, r2]) {
      await configure(r, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']);
    }
    await r1.executeCommand('show ip ospf neighbor');
    expect(
      await r1.executeCommand('show ip ospf neighbor'),
      'the adjacency has to exist before an ACL can be shown to break it',
    ).toContain('10.0.0.2');

    await configure(r2, [
      'access-list 102 permit icmp any any',
      `interface ${b}`, 'ip access-group 102 in',
    ]);
    const denied = r2.getInterfaceACL(b, 'in');
    expect(denied).not.toBeNull();

    const ospfPkt = {
      version: 4, ihl: 5, tos: 0, totalLength: 64, identification: 1,
      flags: 0, fragmentOffset: 0, ttl: 1, protocol: 89, checksum: 0,
      sourceIP: new IPAddress('10.0.0.1'),
      destinationIP: new IPAddress('224.0.0.5'),
      payload: { type: 'ospf' },
    } as never;
    expect(
      r2.evaluateACLByName(String(denied), ospfPkt),
      'an ACL that only permits icmp denies the OSPF hello — the IOS gotcha',
    ).toBe('deny');

    await configure(r2, ['access-list 103 permit ospf any any', `interface ${b}`, 'ip access-group 103 in']);
    expect(
      r2.evaluateACLByName(String(r2.getInterfaceACL(b, 'in')), ospfPkt),
      '`permit ospf any any` is the documented fix and has to actually match proto 89',
    ).toBe('permit');
  }, 30000);
});
