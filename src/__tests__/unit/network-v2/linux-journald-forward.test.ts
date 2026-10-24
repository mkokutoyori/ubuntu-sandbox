/**
 * Probe — what systemd-journald 255 forwards besides rsyslog (src/journal/journald-wall.c, journald-console.c,
 * journald-kmsg.c, journald-server.c, journald-native.c): ForwardToWall (on by default, MaxLevelWall=emerg) broadcasts to the
 * logged-in terminals with the header of shared/wall.c; ForwardToConsole writes "[ secs.micro] identifier[pid]: message" to
 * TTYPath (default /dev/console) at or above MaxLevelConsole (info); ForwardToKMsg writes "<pri>identifier[pid]: message" to the
 * kernel ring at or above MaxLevelKMsg (notice), where the kernel keeps it and journald, which ignores non-kernel records while it
 * forwards to kmsg, does not read it back; ReadKMsg=no stops journald reading the ring at all. Forwarding does not depend on what
 * the journal stores. Settings are read when the daemon starts.
 * Audit= defaults to yes and sets the kernel audit enabled flag when the daemon starts (journald-audit.c); an empty value leaves it.
 * Measured against the preceding commit (git stash of src/network): 8 of the 10 cases fall - no hook existed for the wall, the
 * console or the ring, ReadKMsg and Audit were never read. The 2 that pass either way are WITNESSES: a message below MaxLevelWall is not
 * broadcast, and the ring is written and read back by dmesg when nothing is forwarded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function configured(body: string): Promise<LinuxServer> {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  await host.executeCommand('mkdir -p /etc/systemd/journald.conf.d');
  await host.executeCommand(`printf '[Journal]\\n${body}\\n' > /etc/systemd/journald.conf.d/zz-forward.conf`);
  await host.executeCommand('systemctl restart systemd-journald');
  return host;
}

function watch(host: LinuxServer): string[] {
  const seen: string[] = [];
  host.getBus().subscribe('linux.tty.written', (event) => { seen.push(`${event.payload.tty}:${event.payload.text}`); });
  return seen;
}

const send = (host: LinuxServer, level: string, text: string): Promise<string> => host.executeCommand(`logger -p user.${level} -t probe ${text}`);

describe('ForwardToWall', () => {
  it('broadcasts an emergency to the logged-in terminals with the header of wall(3)', async () => {
    const host = await configured('ForwardToWall=yes');
    const seen = watch(host);
    await send(host, 'emerg', 'meltdown');
    const wall = seen.find((line) => line.startsWith('tty1:') && line.includes('systemd-journald@')) ?? '';
    expect(wall).toMatch(/^tty1:\r\nBroadcast message from systemd-journald@host1 \([A-Z][a-z]{2} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+\):\r\n\r\nprobe\[\d+\]: meltdown\r\n\r\n$/);
  }, 60_000);

  it('witness: a message below MaxLevelWall is not broadcast', async () => {
    const host = await configured('ForwardToWall=yes');
    const seen = watch(host);
    await send(host, 'err', 'merely-bad');
    expect(seen.join('')).not.toContain('merely-bad');
  }, 60_000);

  it('ForwardToWall=no keeps even an emergency to itself, and MaxLevelWall=err lets an error through', async () => {
    const silent = await configured('ForwardToWall=no');
    const seenSilent = watch(silent);
    await send(silent, 'emerg', 'unheard');
    expect(seenSilent.filter((line) => line.includes('systemd-journald@'))).toEqual([]);
    const loud = await configured('MaxLevelWall=err');
    const seenLoud = watch(loud);
    await send(loud, 'err', 'heard');
    expect(seenLoud.join('')).toContain('heard');
  }, 60_000);
});

describe('ForwardToConsole', () => {
  it('writes the line with the kernel time stamp to /dev/console, at or above MaxLevelConsole', async () => {
    const host = await configured('ForwardToConsole=yes\\nForwardToWall=no');
    const seen = watch(host);
    await send(host, 'info', 'on-the-console');
    await send(host, 'debug', 'too-quiet');
    const written = seen.filter((line) => line.startsWith('console:'));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^console:\[ *\d+\.\d{6}\] probe\[\d+\]: on-the-console\n$/);
  }, 60_000);

  it('TTYPath chooses the terminal', async () => {
    const host = await configured('ForwardToConsole=yes\\nTTYPath=/dev/tty2\\nForwardToWall=no');
    const seen = watch(host);
    await send(host, 'info', 'elsewhere');
    expect(seen.some((line) => line.startsWith('tty2:') && line.includes('elsewhere'))).toBe(true);
  }, 60_000);
});

describe('the kernel ring', () => {
  it('ForwardToKMsg puts the line in the ring, at or above MaxLevelKMsg, and the journal does not read it back', async () => {
    const host = await configured('ForwardToKMsg=yes');
    await send(host, 'notice', 'to-the-ring');
    await send(host, 'info', 'not-this-one');
    const ring = await host.executeCommand('dmesg');
    expect(ring).toMatch(/probe\[\d+\]: to-the-ring/);
    expect(ring).not.toContain('not-this-one');
    expect(await host.executeCommand('journalctl --no-pager -k 2>&1')).not.toContain('to-the-ring');
    expect(await host.executeCommand('journalctl --no-pager -t probe 2>&1')).toContain('to-the-ring');
  }, 60_000);

  it('ReadKMsg=no leaves what is written to the ring out of the journal, the ring keeps it', async () => {
    const host = await configured('ReadKMsg=no');
    await host.executeCommand("echo '<3>disk-on-fire' > /dev/kmsg");
    expect(await host.executeCommand('dmesg')).toContain('disk-on-fire');
    expect(await host.executeCommand('journalctl --no-pager -k 2>&1')).not.toContain('disk-on-fire');
  }, 60_000);

  it('witness: with nothing forwarded the ring is written and read back, and the journal reads it', async () => {
    const host = await configured('ForwardToWall=no');
    await host.executeCommand("echo '<3>disk-on-fire' > /dev/kmsg");
    expect(await host.executeCommand('dmesg')).toContain('disk-on-fire');
    expect(await host.executeCommand('journalctl --no-pager -k 2>&1')).toContain('disk-on-fire');
  }, 60_000);
});

describe('Audit=', () => {
  const enabled = async (host: LinuxServer): Promise<string> => (await host.executeCommand('auditctl -s')).match(/^enabled (\d)/m)?.[1] ?? '?';

  it('Audit=no switches the kernel audit off when journald starts, Audit=yes switches it back on', async () => {
    const host = await configured('Audit=no');
    expect(await enabled(host)).toBe('0');
    await host.executeCommand('printf "[Journal]\\nAudit=yes\\n" > /etc/systemd/journald.conf.d/zz-forward.conf');
    await host.executeCommand('systemctl restart systemd-journald');
    expect(await enabled(host)).toBe('1');
  }, 60_000);

  it('the default is to enable it, and an empty Audit= leaves the kernel state alone', async () => {
    const host = await configured('ForwardToWall=no');
    await host.executeCommand('auditctl -e 0');
    await host.executeCommand('systemctl restart systemd-journald');
    expect(await enabled(host)).toBe('1');
    await host.executeCommand('printf "[Journal]\\nAudit=\\n" > /etc/systemd/journald.conf.d/zz-forward.conf');
    await host.executeCommand('auditctl -e 0');
    await host.executeCommand('systemctl restart systemd-journald');
    expect(await enabled(host)).toBe('0');
  }, 60_000);
});
