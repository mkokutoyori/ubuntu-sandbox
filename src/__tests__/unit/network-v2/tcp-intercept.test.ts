/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `ip tcp intercept list|mode|
 * drop-mode|connection-timeout|finrst-timeout|watch-timeout|max-incomplete|one-minute`, `show tcp
 * intercept connections|statistics`.
 *
 * Book (ip tcp intercept mode): in intercept mode the router answers each client SYN with a SYN-ACK on
 * behalf of the server, waits for the client's ACK, then sends the original SYN to the server, performs
 * the three-way handshake with it and joins the two half connections. In watch mode it lets the
 * attempt through and, if it is not established within watch-timeout (30 s, 15 s in aggressive mode),
 * sends a reset to the server. Aggressive mode (1100 incomplete connections or requests per minute by
 * default, back below 900) deletes the oldest partial connection on each new arrival.
 *
 * Lab: CLIENT PC - FW - SERVER PC, real frames. The tap on the server counts the SYN and RST segments
 * that reach it, so "protected" means "the server never saw the flood", not "the command printed
 * something".
 *
 * Measured with src stashed to HEAD: `ip tcp intercept` was refused as an invalid command, so 14 of the
 * 18 cases fall. Four pass either way: the flood witness without intercept, the SYN outside the access
 * list, the refused connection (a real server's reset reaches the client with or without the proxy) and
 * the refusal of malformed values.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import { zoneLab, type ZoneLab } from './_helpers/zoneFirewallLab';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const PROTECT = ['access-list 101 permit tcp any host 10.0.2.10', 'ip tcp intercept list 101'];

interface ServerSegments { syn: number; rst: number; ack: number }

function tapServer(lab: ZoneLab): ServerSegments {
  const seen: ServerSegments = { syn: 0, rst: 0, ack: 0 };
  lab.outside.getPort('eth0')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    if (direction !== 'in') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const segment = packet?.type === 'ipv4' ? packet.payload as { type?: string; flags?: { syn: boolean; ack: boolean; rst: boolean } } : undefined;
    if (segment?.type !== 'tcp' || !segment.flags) return;
    if (segment.flags.rst) seen.rst++;
    else if (segment.flags.syn && !segment.flags.ack) seen.syn++;
    else if (segment.flags.ack) seen.ack++;
  });
  return seen;
}

async function flood(lab: ZoneLab, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await lab.inside.executeCommand(`sudo hping3 -S -a 10.0.1.${100 + i} -c 1 -p 8080 10.0.2.10`);
}

describe('tcp intercept: intercept mode', () => {
  it('witness (passes either way): without intercept every SYN of a flood reaches the server', async () => {
    const lab = await zoneLab();
    const server = tapServer(lab);
    await flood(lab, 3);
    expect(server.syn).toBe(3);
  });

  it('a SYN flood is answered by the router and never reaches the server', async () => {
    const lab = await zoneLab(PROTECT);
    const server = tapServer(lab);
    const reply = await lab.inside.executeCommand('sudo hping3 -S -c 3 -p 8080 10.0.2.10');
    expect(reply).toContain('flags=SA');
    expect(server.syn).toBe(0);
  });

  it('show tcp intercept connections lists the incomplete connections', async () => {
    const lab = await zoneLab(PROTECT);
    await flood(lab, 2);
    const shown = await lab.fw.executeCommand('show tcp intercept connections');
    expect(shown).toContain('Incomplete:');
    expect(shown.match(/10\.0\.1\.\d+:\d+\s+10\.0\.2\.10:8080\s+SYNRCVD/g)?.length).toBe(2);
    expect(shown).toContain('Established:');
  });

  it('an incomplete connection is forgotten once its time is up', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab(PROTECT);
    await flood(lab, 1);
    expect(await lab.fw.executeCommand('show tcp intercept connections')).toContain('SYNRCVD');
    clock.advance(31_000);
    expect(await lab.fw.executeCommand('show tcp intercept connections')).not.toContain('SYNRCVD');
  });

  it('a real client completes the handshake and exchanges data both ways through the splice', async () => {
    const lab = await zoneLab(PROTECT);
    const server = tapServer(lab);
    lab.outside.getTcpStack().listen(8080, {
      onAccept: (socket) => { socket.onData((data) => { socket.write(`echo:${String(data)}`); }); },
    });
    const socket = lab.inside.getTcpStack().connect('10.0.2.10', 8080);
    expect(socket?.state).toBe('established');
    const received: string[] = [];
    socket!.onData((data) => { received.push(String(data)); });
    socket!.write('hello');
    socket!.write('world');
    expect(received.join('')).toContain('echo:hello');
    expect(received.join('')).toContain('echo:world');
    expect(server.syn).toBe(1);
    const shown = await lab.fw.executeCommand('show tcp intercept connections');
    expect(shown).toMatch(/10\.0\.1\.10:\d+\s+10\.0\.2\.10:8080\s+ESTAB\s+\S+\s+\S+\s+I/);
    expect(await lab.fw.executeCommand('show tcp intercept statistics')).toContain('0 incomplete, 1 established connections (total 1)');
  });

  it('witness (passes either way): a SYN to a server outside the access list is not intercepted', async () => {
    const lab = await zoneLab(['access-list 101 permit tcp any host 10.0.2.77', 'ip tcp intercept list 101']);
    const server = tapServer(lab);
    await flood(lab, 2);
    expect(server.syn).toBe(2);
  });

  it('the connection is forgotten finrst-timeout seconds after the close', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept finrst-timeout 3']);
    lab.outside.getTcpStack().listen(8080, { onAccept: () => {} });
    const socket = lab.inside.getTcpStack().connect('10.0.2.10', 8080);
    expect(socket?.state).toBe('established');
    socket!.close();
    expect(await lab.fw.executeCommand('show tcp intercept connections')).toContain('ESTAB');
    clock.advance(4_000);
    expect(await lab.fw.executeCommand('show tcp intercept connections')).not.toContain('ESTAB');
  });

  it('a refused connection is reset toward the client and forgotten', async () => {
    const lab = await zoneLab(PROTECT);
    const socket = lab.inside.getTcpStack().connect('10.0.2.10', 8080);
    expect(socket === null || socket.state !== 'established').toBe(true);
    const shown = await lab.fw.executeCommand('show tcp intercept connections');
    expect(shown).not.toMatch(/SYNSENT|SYNRCVD|ESTAB/);
  });
});

describe('tcp intercept: watch mode', () => {
  it('lets the SYN through and resets the server when the connection never completes', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept mode watch']);
    const server = tapServer(lab);
    lab.outside.getTcpStack().listen(8080, { onAccept: () => {} });
    await flood(lab, 1);
    expect(server.syn).toBe(1);
    expect(server.rst).toBe(0);
    clock.advance(31_000);
    expect(server.rst).toBe(1);
  });

  it('a real client connects normally and nothing is reset', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept mode watch']);
    const server = tapServer(lab);
    lab.outside.getTcpStack().listen(8080, { onAccept: () => {} });
    const socket = lab.inside.getTcpStack().connect('10.0.2.10', 8080);
    expect(socket?.state).toBe('established');
    clock.advance(40_000);
    expect(server.rst).toBe(0);
    expect(await lab.fw.executeCommand('show tcp intercept connections')).toMatch(/ESTAB\s+\S+\s+\S+\s+W/);
  });

  it('watch-timeout moves the deadline', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept mode watch', 'ip tcp intercept watch-timeout 60']);
    const server = tapServer(lab);
    lab.outside.getTcpStack().listen(8080, { onAccept: () => {} });
    await flood(lab, 1);
    clock.advance(31_000);
    expect(server.rst).toBe(0);
    clock.advance(30_000);
    expect(server.rst).toBe(1);
  });
});

describe('tcp intercept: aggressive mode', () => {
  it('above max-incomplete high each new SYN deletes the oldest partial connection', async () => {
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept max-incomplete low 1 high 2']);
    await flood(lab, 6);
    const shown = await lab.fw.executeCommand('show tcp intercept connections');
    expect(shown.match(/SYNRCVD/g)?.length).toBe(2);
    expect(await lab.fw.executeCommand('show tcp intercept statistics')).toContain('2 incomplete, 0 established connections (total 2)');
  });

  it('above one-minute high the same happens although few connections are incomplete', async () => {
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept one-minute low 1 high 2']);
    await flood(lab, 6);
    expect((await lab.fw.executeCommand('show tcp intercept connections')).match(/SYNRCVD/g)?.length).toBe(2);
  });

  it('in watch mode a deleted partial connection is reset on the server', async () => {
    const lab = await zoneLab([...PROTECT, 'ip tcp intercept mode watch', 'ip tcp intercept max-incomplete low 1 high 2']);
    const server = tapServer(lab);
    lab.outside.getTcpStack().listen(8080, { onAccept: () => {} });
    await flood(lab, 5);
    expect(server.rst).toBeGreaterThanOrEqual(2);
  });
});

describe('tcp intercept: configuration and views', () => {
  it('show tcp intercept statistics prints the book layout', async () => {
    const lab = await zoneLab(PROTECT);
    await flood(lab, 2);
    expect(await lab.fw.executeCommand('show tcp intercept statistics')).toBe([
      'intercepting new connections using access-list 101',
      '2 incomplete, 0 established connections (total 2)',
      '1 minute connection request rate 0 requests/sec',
    ].join('\n'));
  });

  it('every setting is rendered in the running-config and cleared by its no form', async () => {
    const lab = await zoneLab([
      ...PROTECT, 'ip tcp intercept mode watch', 'ip tcp intercept drop-mode random',
      'ip tcp intercept connection-timeout 43200', 'ip tcp intercept finrst-timeout 10', 'ip tcp intercept watch-timeout 60',
      'ip tcp intercept max-incomplete low 1000 high 1500', 'ip tcp intercept one-minute low 1000 high 1400',
    ]);
    const running = await lab.fw.executeCommand('show running-config');
    for (const line of ['ip tcp intercept list 101', 'ip tcp intercept mode watch', 'ip tcp intercept drop-mode random',
      'ip tcp intercept connection-timeout 43200', 'ip tcp intercept finrst-timeout 10', 'ip tcp intercept watch-timeout 60',
      'ip tcp intercept max-incomplete low 1000 high 1500', 'ip tcp intercept one-minute low 1000 high 1400']) expect(running).toContain(line);
    await lab.fw.executeCommand('configure terminal');
    for (const line of ['ip tcp intercept list 101', 'ip tcp intercept mode', 'ip tcp intercept drop-mode', 'ip tcp intercept connection-timeout',
      'ip tcp intercept finrst-timeout', 'ip tcp intercept watch-timeout', 'ip tcp intercept max-incomplete', 'ip tcp intercept one-minute']) {
      await lab.fw.executeCommand(`no ${line}`);
    }
    await lab.fw.executeCommand('end');
    expect(await lab.fw.executeCommand('show running-config')).not.toContain('ip tcp intercept');
  });

  it('the single-threshold forms of the book are accepted and the bare command is incomplete', async () => {
    const lab = await zoneLab(['ip tcp intercept max-incomplete high 1500', 'ip tcp intercept one-minute low 800']);
    const running = await lab.fw.executeCommand('show running-config');
    expect(running).toContain('ip tcp intercept max-incomplete low 900 high 1500');
    expect(running).toContain('ip tcp intercept one-minute low 800 high 1100');
    await lab.fw.executeCommand('configure terminal');
    expect(await lab.fw.executeCommand('ip tcp intercept max-incomplete')).toContain('% Incomplete command.');
  });

  it('refuses an access list outside 100-199, a zero timeout and an unknown mode', async () => {
    const lab = await zoneLab();
    await lab.fw.executeCommand('configure terminal');
    expect(await lab.fw.executeCommand('ip tcp intercept list 99')).toContain('% Invalid input');
    expect(await lab.fw.executeCommand('ip tcp intercept watch-timeout 0')).toContain('% Invalid input');
    expect(await lab.fw.executeCommand('ip tcp intercept mode zorglub')).toContain('% Invalid input');
  });
});
