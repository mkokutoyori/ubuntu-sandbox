/**
 * IEEE Std 802.1Q-2022, 6.9.1 b) 1): a received frame whose tag carries the
 * VID FFF (reserved in Table 9-2 for implementation use) is discarded.
 *
 * Measured on a git worktree of HEAD before the change: on an ACCESS port the
 * tag was ignored and the frame forwarded as if untagged, so the access-port
 * case falls (1 of 3). The 2 others pass either way: the untagged frame is the
 * witness that frames flow through the lab, and the FFF frame on a trunk was
 * already refused because 4095 is in no allowed-VLAN list.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import type { TaggedEthernetFrame } from '@/network/devices/Switch';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function framed(vid: number | undefined): TaggedEthernetFrame {
  return {
    srcMAC: new MACAddress('aa:bb:cc:00:00:01'), dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    ...(vid === undefined ? {} : { dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid } }),
  };
}

function sniff(sw: CiscoSwitch, portName: string): EthernetFrame[] {
  const sniffer = new Port(`sniff-${portName}`);
  const frames: EthernetFrame[] = [];
  sniffer.onFrame((_n, f) => { if (f.etherType === ETHERTYPE_IPV4) frames.push(f); });
  new Cable(`c-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return frames;
}

async function configure(sw: CiscoSwitch, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await sw.executeCommand(line);
}

describe('6.9.1: the reserved VID FFF', () => {
  it('discards a frame tagged FFF received on an access port', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await configure(sw, [
      'vlan 10', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10',
    ]);
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(framed(0xfff));
    expect(out).toHaveLength(0);
  });

  it('witness: an untagged frame on the same access port is flooded to the other', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await configure(sw, [
      'vlan 10', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10',
    ]);
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(framed(undefined));
    expect(out).toHaveLength(1);
  });

  it('discards a frame tagged FFF received on a trunk', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await configure(sw, [
      'interface FastEthernet0/1', 'switchport mode trunk',
      'interface FastEthernet0/2', 'switchport mode trunk',
    ]);
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(framed(0xfff));
    expect(out).toHaveLength(0);
  });
});
