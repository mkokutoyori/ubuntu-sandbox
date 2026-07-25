import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { formatPingReplyLine, formatPingStats } from '@/network/devices/linux/LinuxFormatHelpers';
import { formatWinPingReplyLine, formatWinPingStats } from '@/network/devices/windows/WinPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

/**
 * A cable pulled mid-ping must not stop the ping. Real ping keeps
 * sending, prints one failure line per sequence, and its summary counts
 * every probe it transmitted.
 */
interface Lab {
  linux: LinuxPC;
  windows: WindowsPC;
  peer: LinuxPC;
  peerCable: Cable;
}

function lab(): Lab {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const linux = new LinuxPC('linux-pc', 'PC1');
  const windows = new WindowsPC('windows-pc', 'WIN1');
  const peer = new LinuxPC('linux-pc', 'PC2');
  linux.getPorts()[0].configureIP(new IPAddress('192.168.10.1'), MASK);
  windows.getPorts()[0].configureIP(new IPAddress('192.168.10.2'), MASK);
  peer.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), MASK);
  new Cable('c1').connect(linux.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(windows.getPorts()[0], sw.getPorts()[1]);
  const peerCable = new Cable('c3');
  peerCable.connect(peer.getPorts()[0], sw.getPorts()[2]);
  return { linux, windows, peer, peerCable };
}

interface Row { seq: number; success: boolean; error?: string }

/** Stream `count` pings, pulling the peer's cable after `unplugAfter`. */
async function streamWithUnplug(
  device: LinuxPC | WindowsPC,
  target: string,
  count: number,
  unplugAfter: number,
  cable: Cable,
): Promise<Row[]> {
  const rows: Row[] = [];
  const dev = device as unknown as {
    pingStreamInSession(t: string, o: Record<string, unknown>): Promise<unknown>;
  };
  await dev.pingStreamInSession(target, {
    count,
    timeoutMs: 50,
    intervalMs: 0,
    onResult: (r: { seq: number; success: boolean; error?: string }) => {
      rows.push({ seq: r.seq, success: r.success, error: r.error });
      if (rows.length === unplugAfter) cable.disconnect();
    },
    shouldStop: () => false,
    sleep: async () => undefined,
  });
  return rows;
}

describe('a cable pulled mid-ping does not stop the ping', () => {
  it('linux keeps emitting one result per sequence', async () => {
    const { linux, peerCable } = lab();
    const rows = await streamWithUnplug(linux, '192.168.10.20', 10, 5, peerCable);

    expect(rows.length, 'ping must transmit all ten probes').toBe(10);
    expect(rows.slice(0, 5).every((r) => r.success), 'the first five reply').toBe(true);
    expect(rows.slice(5).every((r) => !r.success), 'the last five fail').toBe(true);
  }, 30000);

  it('linux reports each failure as a real per-sequence error', async () => {
    const { linux, peerCable } = lab();
    const rows = await streamWithUnplug(linux, '192.168.10.20', 10, 5, peerCable);
    for (const row of rows.slice(5)) {
      expect(row.error ?? '', `seq ${row.seq} needs a reason to print`).not.toBe('');
    }
  }, 30000);

  it('windows keeps emitting one result per sequence too', async () => {
    const { windows, peerCable } = lab();
    const rows = await streamWithUnplug(windows, '192.168.10.20', 10, 5, peerCable);

    expect(rows.length).toBe(10);
    expect(rows.slice(0, 5).every((r) => r.success)).toBe(true);
    expect(rows.slice(5).every((r) => !r.success)).toBe(true);
  }, 30000);
});


/** Render what the terminal would actually show, line by line. */
async function transcript(
  device: LinuxPC | WindowsPC,
  target: string,
  cable: Cable,
  render: 'linux' | 'windows',
): Promise<string[]> {
  const results: Array<Record<string, unknown>> = [];
  const dev = device as unknown as {
    pingStreamInSession(t: string, o: Record<string, unknown>): Promise<unknown>;
  };
  const lines: string[] = [];
  const startedAt = Date.now();
  await dev.pingStreamInSession(target, {
    count: 10, timeoutMs: 50, intervalMs: 0,
    onResult: (r: Record<string, unknown>) => {
      results.push(r);
      const line = render === 'linux'
        ? formatPingReplyLine(r as never, 56)
        : formatWinPingReplyLine(r as never, 32);
      if (line !== null) lines.push(line);
      if (results.length === 5) cable.disconnect();
    },
    shouldStop: () => false,
    sleep: async () => undefined,
  });
  const stats = render === 'linux'
    ? formatPingStats(target, results.length, results as never, Date.now() - startedAt)
    : formatWinPingStats(target, results.length, results as never);
  return [...lines, ...stats];
}

describe('the terminal shows every lost probe, not a silent gap', () => {
  it('linux prints a line for each timed-out sequence', async () => {
    const { linux, peerCable } = lab();
    const out = await transcript(linux, '192.168.10.20', peerCable, 'linux');
    const perProbe = out.filter((l) => /icmp_seq/.test(l));
    expect(perProbe.length, 'ten probes, ten lines — no silent gap').toBe(10);
    for (const seq of [6, 7, 8, 9, 10]) {
      expect(out.join('\n')).toMatch(new RegExp(`icmp_seq[= ]${seq}\\b`));
    }
  }, 30000);

  it('linux summarises transmitted, received, errors, loss and elapsed time', async () => {
    const { linux, peerCable } = lab();
    const out = await transcript(linux, '192.168.10.20', peerCable, 'linux');
    const summary = out.find((l) => /packets transmitted/.test(l)) ?? '';
    expect(summary).toMatch(/^10 packets transmitted, 5 received,/);
    expect(summary, 'real ping reports the wall time of the run').toMatch(/time \d+ms$/);
    expect(out.join('\n')).toMatch(/rtt min\/avg\/max\/mdev = /);
  }, 30000);

  it('linux counts ICMP errors separately when the local link is the one that died', async () => {
    const sw = new GenericSwitch('switch-generic', 'SW2');
    const a = new LinuxPC('linux-pc', 'PCA');
    const b = new LinuxPC('linux-pc', 'PCB');
    a.getPorts()[0].configureIP(new IPAddress('10.9.9.1'), MASK);
    b.getPorts()[0].configureIP(new IPAddress('10.9.9.2'), MASK);
    const own = new Cable('x1');
    own.connect(a.getPorts()[0], sw.getPorts()[0]);
    new Cable('x2').connect(b.getPorts()[0], sw.getPorts()[1]);

    const out = await transcript(a, '10.9.9.2', own, 'linux');
    expect(out.join('\n')).toMatch(/Destination Host Unreachable/);
    const summary = out.find((l) => /packets transmitted/.test(l)) ?? '';
    expect(summary, 'unreachable probes are errors, not plain losses').toMatch(/\+5 errors/);
  }, 30000);

  it('windows prints Request timed out. for each lost probe', async () => {
    const { windows, peerCable } = lab();
    const out = await transcript(windows, '192.168.10.20', peerCable, 'windows');
    expect(out.filter((l) => l === 'Request timed out.').length).toBe(5);
    expect(out.join('\n')).toMatch(/Packets: Sent = 10, Received = 5, Lost = 5 \(50% loss\)/);
    expect(out.join('\n')).toMatch(/Approximate round trip times/);
  }, 30000);
});
