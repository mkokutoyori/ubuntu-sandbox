/**
 * Audit (rapport 03, MAJEUR): NhrpService was a pure CLI config store —
 * `ip nhrp map`/`ip nhrp nhs` just pushed entries into in-memory Maps and
 * `show ip nhrp`/`show dmvpn` fabricated a session as "UP" immediately,
 * with no Resolution/Registration Request/Reply packet ever built or
 * sent. These tests assert NHRP now flows as real IP-protocol-54 packets
 * across a real Cable, with the hub's cache/DMVPN session populated only
 * by actually receiving and processing those packets.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_NHRP, resetNhrpRequestIds } from '@/network/nhrp/types';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  resetNhrpRequestIds();
});

/** Hub (R1) + spoke (R2), mGRE tunnel over a switched underlay — the standard minimal DMVPN lab. */
async function buildHubAndSpoke() {
  const bus = new EventBus();
  const hub = new CiscoRouter('R1');
  const spoke = new CiscoRouter('R2');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  hub.setEventBus(bus); spoke.setEventBus(bus); sw.setEventBus(bus);
  const cableHub = new Cable('a');
  cableHub.setEventBus(bus);
  cableHub.connect(hub.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(spoke.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);

  await run(hub, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Tunnel100', 'ip address 172.20.0.1 255.255.255.0',
    'tunnel source GigabitEthernet0/0', 'tunnel mode gre multipoint',
    'ip nhrp network-id 100',
    'exit', 'end',
  ]);
  await run(spoke, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface Tunnel100', 'ip address 172.20.0.2 255.255.255.0',
    'tunnel source GigabitEthernet0/0', 'tunnel mode gre multipoint',
    'ip nhrp network-id 100',
    'ip nhrp map 172.20.0.1 10.0.0.1',
    'exit', 'end',
  ]);
  return { bus, hub, spoke, sw, cableHub };
}

describe('NHRP registration — a real Registration Request/Reply exchange, not CLI fabrication', () => {
  it('the outer packet uses IP protocol 54 between the real NBMA addresses', async () => {
    const { bus, hub, spoke } = await buildHubAndSpoke();
    // Registration request AND reply both cross cable "a" (switch<->hub),
    // just in opposite directions and nested within the same synchronous
    // delivery call stack — collect every NHRP frame seen and pick out the
    // request specifically, rather than assuming arrival order.
    const seen: Array<{ proto: number; outerSrc: string; outerDst: string; opcode?: string }> = [];
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as
        { protocol?: number; sourceIP?: { toString: () => string }; destinationIP?: { toString: () => string }; payload?: { opcode?: string } } | undefined;
      if (ipPkt?.protocol === IP_PROTO_NHRP) {
        seen.push({
          proto: ipPkt.protocol, outerSrc: ipPkt.sourceIP!.toString(), outerDst: ipPkt.destinationIP!.toString(),
          opcode: ipPkt.payload?.opcode,
        });
      }
    });

    await spoke.executeCommand('configure terminal');
    await spoke.executeCommand('interface Tunnel100');
    await spoke.executeCommand('ip nhrp nhs 172.20.0.1');

    const request = seen.find(s => s.opcode === 'registration-request');
    expect(request).toBeDefined();
    expect(request!.proto).toBe(IP_PROTO_NHRP);
    expect(request!.outerSrc).toBe('10.0.0.2');
    expect(request!.outerDst).toBe('10.0.0.1');

    const reply = seen.find(s => s.opcode === 'registration-reply');
    expect(reply).toBeDefined();
    expect(reply!.outerSrc).toBe('10.0.0.1');
    expect(reply!.outerDst).toBe('10.0.0.2');
    void hub;
  });

  it('the hub\'s NHRP cache is populated by actually receiving the request, not by the spoke\'s CLI', async () => {
    const { hub, spoke } = await buildHubAndSpoke();

    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    const cache = hub.getNhrpService().listCache();
    const entry = cache.find(e => e.targetAddress === '172.20.0.2');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('dynamic');
    expect(entry!.nbmaAddress).toBe('10.0.0.2');
  });

  it('the hub\'s DMVPN session shows the spoke UP only after the real exchange', async () => {
    const { hub, spoke } = await buildHubAndSpoke();
    expect(hub.getDmvpnService().listSessions().length).toBe(0);

    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    const sessions = hub.getDmvpnService().listSessions();
    expect(sessions.some(s => s.peerTunnelAddress === '172.20.0.2' && s.state === 'UP')).toBe(true);
  });

  it('the spoke\'s NHS entry is marked registered only after a real Registration Reply comes back', async () => {
    const { spoke } = await buildHubAndSpoke();
    expect(spoke.getNhrpService().listNhsServers('Tunnel100').length).toBe(0);

    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    expect(spoke.getNhrpService().listNhsServers('Tunnel100')[0]?.registered).toBe(true);
  });

  it('show ip nhrp / show dmvpn on the hub reflect the real, wire-populated state', async () => {
    const { hub, spoke } = await buildHubAndSpoke();
    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    const nhrpOut = await hub.executeCommand('show ip nhrp');
    expect(nhrpOut).toContain('172.20.0.2');
    expect(nhrpOut).toContain('10.0.0.2');

    const dmvpnOut = await hub.executeCommand('show dmvpn');
    expect(dmvpnOut).toContain('10.0.0.2');
  });

  it('a mismatched NHRP authentication key is rejected — no cache entry, no session', async () => {
    const { hub, spoke } = await buildHubAndSpoke();
    await run(hub, ['configure terminal', 'interface Tunnel100', 'ip nhrp authentication HUBKEY', 'end']);
    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp authentication WRONGKEY', 'end']);

    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    expect(hub.getNhrpService().listCache().find(e => e.targetAddress === '172.20.0.2')).toBeUndefined();
    expect(spoke.getNhrpService().listNhsServers('Tunnel100')[0]?.registered).toBe(false);
  });

  it('a matching NHRP authentication key registers successfully', async () => {
    const { hub, spoke } = await buildHubAndSpoke();
    await run(hub, ['configure terminal', 'interface Tunnel100', 'ip nhrp authentication SECRET', 'end']);
    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp authentication SECRET', 'end']);

    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    expect(hub.getNhrpService().listCache().find(e => e.targetAddress === '172.20.0.2')).toBeDefined();
    expect(spoke.getNhrpService().listNhsServers('Tunnel100')[0]?.registered).toBe(true);
  });
});

describe('NHRP resolution — spoke-to-spoke NBMA lookup via the hub, real Resolution Request/Reply', () => {
  it('a second spoke can resolve the first spoke\'s NBMA address through the hub', async () => {
    const { bus, hub, spoke, sw } = await buildHubAndSpoke();
    const spoke2 = new CiscoRouter('R3');
    spoke2.setEventBus(bus);
    new Cable('c').connect(spoke2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/3')!);

    await run(spoke2, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.3 255.255.255.0', 'no shutdown', 'exit',
      'interface Tunnel100', 'ip address 172.20.0.3 255.255.255.0',
      'tunnel source GigabitEthernet0/0', 'tunnel mode gre multipoint',
      'ip nhrp network-id 100',
      'ip nhrp map 172.20.0.1 10.0.0.1',
      'exit', 'end',
    ]);

    // Register both spokes with the hub first (real registration).
    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);
    await run(spoke2, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    // spoke2 now asks the hub to resolve spoke1's NBMA address.
    const ok = spoke2.getNhrpEngine().sendResolutionRequest('GigabitEthernet0/0', 'Tunnel100', '172.20.0.3', '172.20.0.2');
    expect(ok).toBe(true);

    const resolved = spoke2.getNhrpService().lookupBinding('Tunnel100', '172.20.0.2');
    expect(resolved?.nbmaAddress).toBe('10.0.0.2');
    void hub;
  });

  it('resolving an unregistered target returns a real error reply, not a fabricated binding', async () => {
    const { hub, spoke } = await buildHubAndSpoke();
    await run(spoke, ['configure terminal', 'interface Tunnel100', 'ip nhrp nhs 172.20.0.1']);

    const ok = spoke.getNhrpEngine().sendResolutionRequest('GigabitEthernet0/0', 'Tunnel100', '172.20.0.2', '172.20.0.99');
    expect(ok).toBe(true);
    expect(spoke.getNhrpService().lookupBinding('Tunnel100', '172.20.0.99')).toBeUndefined();
    void hub;
  });
});
