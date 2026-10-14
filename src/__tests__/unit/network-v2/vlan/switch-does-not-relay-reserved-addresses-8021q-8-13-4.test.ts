/**
 * IEEE Std 802.1Q-2022, 8.13.4 and Tables 8-1, 8-2, 8-3 (docs/rfc/dot1q/8021Q-2022.pdf
 * p.206-208): any frame whose destination is a reserved MAC address shall not be
 * forwarded by a Bridge. Table 8-1 (MAC Bridge and C-VLAN component): the sixteen
 * addresses 01-80-C2-00-00-00 to 0F. Table 8-2 (S-VLAN component): 01 to 0A and 0E.
 * Table 8-3 (TPMR component): 01, 02, 04 and 0E.
 *
 * Measured on the code before the change (the switch flooded every group address):
 * the case that sends five Table 8-1 destinations falls, 5 frames crossed the
 * bridge. The 2 relay cases are witnesses that pass either way (an ordinary
 * multicast, and 01-80-C2-00-00-10 just after the block), and the 4 table cases
 * need no engine (pure function in a new module).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import { isReservedBridgeAddress } from '@/network/layers/link/vlan/ReservedAddresses';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function toward(destination: string): EthernetFrame {
  return {
    srcMAC: new MACAddress('aa:bb:cc:00:00:01'), dstMAC: new MACAddress(destination),
    etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
  };
}

async function labelled(): Promise<{ sw: CiscoSwitch; out: EthernetFrame[] }> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  for (const line of [
    'enable', 'configure terminal', 'vlan 10',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10', 'end',
  ]) await sw.executeCommand(line);
  const sniffer = new Port('sniff');
  const out: EthernetFrame[] = [];
  sniffer.onFrame((_n, f) => { if (f.etherType === ETHERTYPE_IPV4) out.push(f); });
  new Cable('c').connect(sw.getPort('FastEthernet0/2')!, sniffer);
  return { sw, out };
}

describe('8.13.4: reserved MAC addresses are not forwarded', () => {
  it('does not relay a frame addressed to a Table 8-1 address', async () => {
    const { sw, out } = await labelled();
    for (const last of ['00', '03', '08', '0d', '0f']) {
      sw.getPort('FastEthernet0/1')!.receiveFrame(toward(`01:80:c2:00:00:${last}`));
    }
    expect(out).toHaveLength(0);
  });

  it('witness: relays a frame addressed to an ordinary multicast', async () => {
    const { sw, out } = await labelled();
    sw.getPort('FastEthernet0/1')!.receiveFrame(toward('01:00:5e:01:02:03'));
    expect(out).toHaveLength(1);
  });

  it('witness: relays a frame addressed to the first address after the block, 01-80-C2-00-00-10', async () => {
    const { sw, out } = await labelled();
    sw.getPort('FastEthernet0/1')!.receiveFrame(toward('01:80:c2:00:00:10'));
    expect(out).toHaveLength(1);
  });
});

describe('Tables 8-1, 8-2, 8-3', () => {
  it('reserves all sixteen addresses 00 to 0F for a MAC Bridge or C-VLAN component', () => {
    for (let last = 0; last < 16; last++) {
      expect(isReservedBridgeAddress('c-vlan', `01-80-C2-00-00-${last.toString(16).padStart(2, '0')}`)).toBe(true);
    }
    expect(isReservedBridgeAddress('c-vlan', '01-80-C2-00-00-10')).toBe(false);
  });

  it('does not reserve 00, 0B, 0C, 0D, 0F for an S-VLAN component but does reserve 08 and 0E', () => {
    for (const last of ['00', '0b', '0c', '0d', '0f']) {
      expect(isReservedBridgeAddress('s-vlan', `01:80:c2:00:00:${last}`)).toBe(false);
    }
    for (const last of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '0a', '0e']) {
      expect(isReservedBridgeAddress('s-vlan', `01:80:c2:00:00:${last}`)).toBe(true);
    }
  });

  it('reserves only 01, 02, 04 and 0E for a TPMR component', () => {
    const reserved = Array.from({ length: 16 }, (_, last) => last)
      .filter(last => isReservedBridgeAddress('tpmr', `01:80:c2:00:00:${last.toString(16).padStart(2, '0')}`));
    expect(reserved).toEqual([0x01, 0x02, 0x04, 0x0e]);
  });

  it('is not a reserved address when the prefix differs', () => {
    expect(isReservedBridgeAddress('c-vlan', '01:80:c2:00:01:00')).toBe(false);
    expect(isReservedBridgeAddress('c-vlan', 'ff:ff:ff:ff:ff:ff')).toBe(false);
  });
});
