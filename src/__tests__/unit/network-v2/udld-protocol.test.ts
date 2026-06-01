import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  ETHERTYPE_UDLD, UDLD_MULTICAST_MAC,
} from '@/network/udld/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('UDLD — port mode toggling', () => {
  it('setPortMode normal moves an unconfigured port to unknown then ready', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    sw.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    const rt = sw.getUdldAgent().getPortRuntime('FastEthernet0/0');
    expect(rt).toBeDefined();
    expect(rt!.mode).toBe('normal');
    expect(['unknown', 'bidirectional']).toContain(rt!.state);
  });

  it('setPortMode disabled drives the runtime to shutdown', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    sw.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw.getUdldAgent().setPortMode('FastEthernet0/0', 'disabled');
    expect(sw.getUdldAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('shutdown');
  });
});

describe('UDLD — wire format', () => {
  it('frames carry etherType 0x0111 to the CDP/UDLD multicast MAC', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);

    let seen: { etherType: number; dstMac: string; opcode: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const frame = e.payload.frame;
      if (frame.etherType === ETHERTYPE_UDLD) {
        const payload = (frame.payload as unknown) as { type?: string; opcode?: string };
        if (payload?.type === 'udld') {
          seen = {
            etherType: frame.etherType,
            dstMac: frame.dstMAC.toString().toLowerCase(),
            opcode: payload.opcode!,
          };
        }
      }
    });
    cable.connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');

    expect(seen).not.toBeNull();
    expect(seen!.etherType).toBe(ETHERTYPE_UDLD);
    expect(seen!.dstMac).toBe(UDLD_MULTICAST_MAC);
    expect(['probe', 'echo']).toContain(seen!.opcode);
  });
});

describe('UDLD — bidirectional confirmation', () => {
  it('two cabled UDLD-enabled switches reach bidirectional state', () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw2.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    expect(sw1.getUdldAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('bidirectional');
    expect(sw2.getUdldAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('bidirectional');
  });

  it('publishes udld.state.changed when transitioning to bidirectional', () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    const transitions: Array<{ deviceId: string; newState: string }> = [];
    bus.subscribe('udld.state.changed', (e) => transitions.push(e.payload));
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw2.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    expect(transitions.some(t => t.deviceId === sw1.id && t.newState === 'bidirectional')).toBe(true);
    expect(transitions.some(t => t.deviceId === sw2.id && t.newState === 'bidirectional')).toBe(true);
  });
});

describe('UDLD — neighbor learning', () => {
  it('learns the peer device-id and port-id from received probes', () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw2.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    const sw1Neighbors = sw1.getUdldAgent().getNeighborsFor('FastEthernet0/0');
    expect(sw1Neighbors.length).toBe(1);
    expect(sw1Neighbors[0].remoteDeviceId).toBe(sw2.id);
    expect(sw1Neighbors[0].remotePortId).toBe('FastEthernet0/0');
  });
});

describe('UDLD — link down flushes neighbours', () => {
  it('shutting the local port clears the neighbour and resets to unknown', () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw2.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    expect(sw1.getUdldAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('bidirectional');

    sw1.getPort('FastEthernet0/0')!.setUp(false);
    expect(sw1.getUdldAgent().getNeighborsFor('FastEthernet0/0').length).toBe(0);
    expect(sw1.getUdldAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('unknown');
  });

  it('disabling UDLD on a port flushes its neighbour table', () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw2.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'normal');
    expect(sw1.getUdldAgent().getNeighborsFor('FastEthernet0/0').length).toBe(1);
    sw1.getUdldAgent().setPortMode('FastEthernet0/0', 'disabled');
    expect(sw1.getUdldAgent().getNeighborsFor('FastEthernet0/0').length).toBe(0);
  });
});

describe('UDLD — show udld', () => {
  it('renders the runtime state for a configured port', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    await sw1.executeCommand('enable');
    await sw1.executeCommand('configure terminal');
    await sw1.executeCommand('interface FastEthernet0/0');
    await sw1.executeCommand('udld port');
    await sw1.executeCommand('end');
    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    await sw2.executeCommand('interface FastEthernet0/0');
    await sw2.executeCommand('udld port');
    await sw2.executeCommand('end');
    await sw1.executeCommand('configure terminal');
    await sw1.executeCommand('interface FastEthernet0/0');
    await sw1.executeCommand('udld port');
    await sw1.executeCommand('end');

    const out = await sw1.executeCommand('show udld FastEthernet0/0');
    expect(out).toMatch(/Interface FastEthernet0\/0/);
    expect(out).toMatch(/Bidirectional|bidirectional/);
    expect(out).toMatch(new RegExp(`Device ID: ${sw2.id}`));
  });
});
