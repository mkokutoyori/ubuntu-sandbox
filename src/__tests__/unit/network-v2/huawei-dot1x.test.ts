import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  ETHERTYPE_EAPOL, EAPOL_PAE_GROUP_MAC, type EapolPacket,
} from '@/network/dot1x/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const IF = 'GigabitEthernet0/0/1';

function eapolStart(srcMac: string): EthernetFrame {
  const payload: EapolPacket = { type: 'eapol', version: 2, packetType: 'eapol-start' };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}
function eapResponseId(srcMac: string, id: number, identity: string): EthernetFrame {
  const payload: EapolPacket = {
    type: 'eapol', version: 2, packetType: 'eap-packet',
    eap: { type: 'eap', code: 'response', identifier: id, eapType: 'identity', payload: identity },
  };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}

async function sys(sw: HuaweiSwitch, cmds: string[]) {
  await sw.executeCommand('system-view');
  for (const c of cmds) await sw.executeCommand(c);
}

describe('Huawei 802.1X — vendor-neutral Dot1xAgent wired on HuaweiSwitch', () => {
  it('dot1x enable (global + interface) puts the port in auto/unauthorized', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sys(sw, ['dot1x enable', `interface ${IF}`, 'dot1x enable']);
    const rt = sw.getDot1xAgent().getPortRuntime(IF);
    expect(rt?.mode).toBe('auto');
    expect(sw.getDot1xAgent().isPortAuthorized(IF)).toBe(false);
  });

  it('dot1x port-control authorized-force always authorizes the port', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sys(sw, ['dot1x enable', `interface ${IF}`, 'dot1x port-control authorized-force']);
    expect(sw.getDot1xAgent().isPortAuthorized(IF)).toBe(true);
  });

  it('a real EAPOL handshake authorizes the port (frames processed on Huawei)', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    const sup = new CiscoSwitch('switch-cisco', 'SUP', 4);
    new Cable('c').connect(sw.getPort(IF)!, sup.getPort('FastEthernet0/1')!);
    await sys(sw, ['dot1x enable', `interface ${IF}`, 'dot1x enable']);
    sw.getDot1xAgent().addLocalUser('alice', 'pw');

    const mac = sup.getPort('FastEthernet0/1')!.getMAC().toString();
    sup.getPort('FastEthernet0/1')!.sendFrame(eapolStart(mac));
    const rt = sw.getDot1xAgent().getPortRuntime(IF)!;
    sup.getPort('FastEthernet0/1')!.sendFrame(eapResponseId(mac, rt.pendingEapId!, 'alice'));

    expect(sw.getDot1xAgent().isPortAuthorized(IF)).toBe(true);
  });

  it('undo dot1x enable disables enforcement on the port', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sys(sw, ['dot1x enable', `interface ${IF}`, 'dot1x enable', 'undo dot1x enable']);
    expect(sw.getDot1xAgent().isPortAuthorized(IF)).toBe(true);
  });
});
