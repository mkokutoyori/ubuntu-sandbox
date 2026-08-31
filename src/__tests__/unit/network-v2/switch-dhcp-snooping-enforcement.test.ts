/**
 * DHCP snooping enforcement gaps: `verify mac-address` and rate limiting.
 *
 * The existing drop-server-messages-on-untrusted-ports behavior is already
 * covered elsewhere; this file covers the two CLI knobs that were accepted
 * but never enforced: `ip dhcp snooping verify mac-address` (chaddr must
 * match the Ethernet source MAC on client messages from untrusted ports)
 * and `ip dhcp snooping limit rate <n>` (per-port DHCP packet-rate cap).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import {
  MACAddress, IPAddress, ETHERTYPE_IPV4, IP_PROTO_UDP, createIPv4Packet,
} from '@/network/core/types';
import type { UDPPacket } from '@/network/core/types';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { EventBus } from '@/events/EventBus';

function makeDhcpFrame(ethSrc: string, chaddr: string, xid = 1) {
  const dhcp = DHCPPacket.createDiscover(chaddr, xid);
  const udp: UDPPacket = {
    type: 'udp', sourcePort: 68, destinationPort: 67, length: 0, checksum: 0, payload: dhcp,
  };
  const ip = createIPv4Packet(new IPAddress('0.0.0.0'), new IPAddress('255.255.255.255'), IP_PROTO_UDP, 64, udp);
  return {
    srcMAC: new MACAddress(ethSrc),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: ip,
  };
}

function injectDhcp(sw: CiscoSwitch, port: string, frame: ReturnType<typeof makeDhcpFrame>) {
  (sw as unknown as { handleFrame: (p: string, f: ReturnType<typeof makeDhcpFrame>) => void }).handleFrame(port, frame);
}

function setupSwitch(bus?: EventBus) {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  if (bus) sw.setEventBus(bus);
  for (const name of sw.getPortNames()) sw.getPort(name)!.setUp(true);
  return sw;
}

const REAL_MAC = 'aa:aa:aa:00:00:01';
const SPOOFED_CHADDR = 'bb:bb:bb:00:00:02';

beforeEach(() => {});

describe('DHCP snooping — verify mac-address', () => {
  it('drops a client message whose chaddr does not match the Ethernet source MAC on an untrusted port', () => {
    const sw = setupSwitch();
    sw._getDHCPSnoopingConfig().enabled = true;
    sw._getDHCPSnoopingConfig().verifyMac = true;

    const before = sw._getDHCPSnoopingViolations();
    injectDhcp(sw, 'FastEthernet0/1', makeDhcpFrame(REAL_MAC, SPOOFED_CHADDR));

    expect(sw._getDHCPSnoopingViolations()).toBe(before + 1);
    expect(sw._getDHCPSnoopingLog().some(l => l.includes('mac-address') || l.includes('chaddr'))).toBe(true);
  });

  it('passes a client message whose chaddr matches the Ethernet source MAC', () => {
    const sw = setupSwitch();
    sw._getDHCPSnoopingConfig().enabled = true;
    sw._getDHCPSnoopingConfig().verifyMac = true;

    const before = sw._getDHCPSnoopingViolations();
    injectDhcp(sw, 'FastEthernet0/1', makeDhcpFrame(REAL_MAC, REAL_MAC));

    expect(sw._getDHCPSnoopingViolations()).toBe(before);
  });

  it('does not check chaddr once verification is turned off', () => {
    const sw = setupSwitch();
    sw._getDHCPSnoopingConfig().enabled = true;
    sw._getDHCPSnoopingConfig().verifyMac = false;

    const before = sw._getDHCPSnoopingViolations();
    injectDhcp(sw, 'FastEthernet0/1', makeDhcpFrame(REAL_MAC, SPOOFED_CHADDR));

    expect(sw._getDHCPSnoopingViolations()).toBe(before);
  });
});

describe('DHCP snooping — rate limiting', () => {
  it('drops DHCP packets on a port once the configured rate is exceeded', () => {
    const sw = setupSwitch();
    sw._getDHCPSnoopingConfig().enabled = true;
    sw._getDHCPSnoopingConfig().rateLimits.set('FastEthernet0/1', 2);

    const before = sw._getDHCPSnoopingViolations();
    for (let i = 0; i < 5; i++) {
      injectDhcp(sw, 'FastEthernet0/1', makeDhcpFrame(REAL_MAC, REAL_MAC, i));
    }

    expect(sw._getDHCPSnoopingViolations()).toBeGreaterThan(before);
    expect(sw._getDHCPSnoopingLog().some(l => l.toLowerCase().includes('rate'))).toBe(true);
  });

  it('does not rate-limit a port with no configured limit', () => {
    const sw = setupSwitch();
    sw._getDHCPSnoopingConfig().enabled = true;

    const before = sw._getDHCPSnoopingViolations();
    for (let i = 0; i < 20; i++) {
      injectDhcp(sw, 'FastEthernet0/1', makeDhcpFrame(REAL_MAC, REAL_MAC, i));
    }

    expect(sw._getDHCPSnoopingViolations()).toBe(before);
  });
});
