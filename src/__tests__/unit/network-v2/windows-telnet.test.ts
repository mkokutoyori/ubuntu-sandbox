import { describe, it, expect, beforeEach, vi } from 'vitest';
import { worstCaseRetransmitWindowMs } from '@/network/tcp/RttEstimator';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildPair() {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(win.getPorts()[0], srv.getPorts()[0]);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  return { win, srv };
}

describe('Windows telnet.exe — real TCP', () => {
  it('connects to an open port (sshd on 22) via real TCP', async () => {
    const { win } = await buildPair();
    const out = await win.executeCommand('telnet 10.0.0.20 22');
    expect(out).toMatch(/Connecting To 10\.0\.0\.20/);
    expect(out).toMatch(/Welcome to Microsoft Telnet Client/);
  });

  it('refuses connection when no listener is bound to the port', async () => {
    const { win } = await buildPair();
    const out = await win.executeCommand('telnet 10.0.0.20 9999');
    expect(out).toMatch(/Could not open connection.*Connect failed/);
  });

  it('reports unreachable IP', async () => {
    // PRD-TCP.md P2: a SYN to an address nothing ever answers now really
    // waits through the RTO retry window (P1) instead of failing on the
    // same tick — fast-forward fake timers so the retries actually fire.
    vi.useFakeTimers();
    try {
      const { win } = await buildPair();
      const pending = win.executeCommand('telnet 10.99.99.99 22');
      await vi.advanceTimersByTimeAsync(worstCaseRetransmitWindowMs() + 1000);
      const out = await pending;
      expect(out).toMatch(/Could not open connection/);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('prints the Microsoft Telnet help when called with no host', async () => {
    const { win } = await buildPair();
    const out = await win.executeCommand('telnet');
    expect(out).toMatch(/Microsoft Telnet/);
    expect(out).toMatch(/o\s+- open hostname/);
  });
});
