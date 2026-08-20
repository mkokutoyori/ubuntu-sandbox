import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WireDhcpChannel } from '@/network/dhcp/DhcpServerChannel';
import type { DHCPPacket } from '@/network/dhcp/DHCPPacket';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildDirectLab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  await run(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool LAN', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1', 'exit',
    'ip dhcp excluded-address 10.0.1.1', 'end']);
  return { h1, r1 };
}

async function buildRelayLab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const relay = new CiscoRouter('RELAY');
  const server = new CiscoRouter('SERVER');
  new Cable('a').connect(h1.getPort('eth0')!, relay.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(relay.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
  await run(relay, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', 'ip helper-address 10.0.12.2', 'exit', 'end']);
  await run(server, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.1.0 255.255.255.0 10.0.12.1',
    'ip dhcp pool REMOTE', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1', 'exit',
    'ip dhcp excluded-address 10.0.1.1', 'end']);
  return { h1, relay, server };
}

const dhcpState = (h: LinuxPC, iface: string) => h.getDHCPClient().getState(iface);

describe('DHCP on the wire — direct server', () => {
  it('completes a broadcast DORA against a directly connected router via dhclient', async () => {
    const { h1 } = await buildDirectLab();

    const out = await h1.executeCommand('dhclient -v eth0');

    expect(out).toContain('DHCPOFFER');
    expect(out).toContain('DHCPACK');
    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.0\.1\./);
    expect(state.lease?.ipAddress).not.toBe('10.0.1.1');
    expect(await h1.executeCommand('ping -c 1 10.0.1.1')).toContain('0% packet loss');
  });
});

describe('DHCP on the wire — relay agent (RFC 3046)', () => {
  it('relays DORA across subnets with giaddr-based pool selection', async () => {
    const { h1 } = await buildRelayLab();

    const out = await h1.executeCommand('dhclient -v eth0');

    expect(out).toContain('DHCPACK');
    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.0\.1\./);
    expect(await h1.executeCommand('ping -c 1 10.0.12.2')).toContain('0% packet loss');
  });

  it('inserts Option 82 only when ip dhcp relay information option is enabled', async () => {
    const labA = await buildRelayLab();
    const busA = new EventBus();
    labA.h1.setEventBus(busA); labA.relay.setEventBus(busA); labA.server.setEventBus(busA);
    const receivedA: unknown[] = [];
    busA.subscribe('dhcp.server.option82-received', (e) => receivedA.push(e.payload));
    await labA.h1.executeCommand('dhclient eth0');
    expect(dhcpState(labA.h1, 'eth0').state).toBe('BOUND');
    expect(receivedA).toHaveLength(0);
  });

  it('carries circuit-id and remote-id to the server when enabled', async () => {
    const { h1, relay, server } = await buildRelayLab();
    await run(relay, ['configure terminal', 'ip dhcp relay information option', 'end']);
    const bus = new EventBus();
    h1.setEventBus(bus); relay.setEventBus(bus); server.setEventBus(bus);
    const received: Array<{ circuitId: string; remoteId: string; giaddr: string | null }> = [];
    bus.subscribe('dhcp.server.option82-received', (e) =>
      received.push(e.payload as { circuitId: string; remoteId: string; giaddr: string | null }));

    await h1.executeCommand('dhclient eth0');

    expect(dhcpState(h1, 'eth0').state).toBe('BOUND');
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0].circuitId).toBe('GigabitEthernet0/0');
    expect(received[0].remoteId).toBe('RELAY');
    expect(received[0].giaddr).toBe('10.0.1.1');
  });

  it('strips Option 82 from the reply before it reaches the client', async () => {
    const { h1, relay, server } = await buildRelayLab();
    await run(relay, ['configure terminal', 'ip dhcp relay information option', 'end']);

    // Every server reply enters the client through WireDhcpChannel.deliver —
    // observe Option 82 there, at the client's edge of the wire.
    const seenOnClient: unknown[] = [];
    const origDeliver = WireDhcpChannel.prototype.deliver;
    WireDhcpChannel.prototype.deliver = function (pkt: DHCPPacket) {
      seenOnClient.push(pkt.getOption(82));
      origDeliver.call(this, pkt);
    };
    try {
      await h1.executeCommand('dhclient eth0');
    } finally {
      WireDhcpChannel.prototype.deliver = origDeliver;
    }

    expect(dhcpState(h1, 'eth0').state).toBe('BOUND');
    expect(seenOnClient.length).toBeGreaterThanOrEqual(2);
    expect(seenOnClient.every(v => v === undefined)).toBe(true);
  });

  it('increments hops to 1 on the first relay hop and stamps giaddr with the ingress IP (RFC 951 §3)', async () => {
    const { h1, relay, server } = await buildRelayLab();
    const bus = new EventBus();
    h1.setEventBus(bus); relay.setEventBus(bus); server.setEventBus(bus);
    const forwarded: Array<{ giaddr: string; helpers: string[]; hops: number }> = [];
    bus.subscribe('dhcp.relay.forwarded', (e) =>
      forwarded.push(e.payload as { giaddr: string; helpers: string[]; hops: number }));

    await h1.executeCommand('dhclient eth0');

    expect(dhcpState(h1, 'eth0').state).toBe('BOUND');
    expect(forwarded.length).toBeGreaterThanOrEqual(2);
    expect(forwarded[0].giaddr).toBe('10.0.1.1');
    expect(forwarded[0].helpers).toEqual(['10.0.12.2']);
    expect(forwarded[0].hops).toBe(1);
  });

  it('drops the request and emits dhcp.relay.dropped once hops reaches 16 (RFC 951 §3 loop guard)', async () => {
    const { relay } = await buildRelayLab();
    const bus = new EventBus();
    relay.setEventBus(bus);
    const drops: Array<{ reason: string; hops: number }> = [];
    bus.subscribe('dhcp.relay.dropped', (e) =>
      drops.push(e.payload as { reason: string; hops: number }));

    type RelayInternals = {
      relayDhcpToHelpers: (port: string, pkt: DHCPPacket, helpers: string[]) => void;
    };
    const Pkt = (await import('@/network/dhcp/DHCPPacket')).DHCPPacket;
    const pkt = Pkt.createDiscover('aa:bb:cc:dd:ee:ff', 0xCAFEBABE);
    pkt.hops = 16;
    (relay as unknown as RelayInternals).relayDhcpToHelpers('GigabitEthernet0/0', pkt, ['10.0.12.2']);

    expect(drops.length).toBe(1);
    expect(drops[0].reason).toBe('hops-exceeded');
    expect(drops[0].hops).toBe(16);
  });
});
