/*
 * omfile parameters that were parsed, stored and never evaluated: ioBufferSize/flushOnTXEnd/asyncWriting/flushInterval
 * (the stream buffer), zipLevel/veryRobustZip and compression.driver (gzip and zstd streams), rotation.sizeLimit and
 * the size-limit command, $outchannel, followSymlinks and the cry/sig providers. Each case drives a LinuxServer through
 * its shell and reads the effect back from the files. Time is the simulated clock (advanceTime).
 * Measured against the previous commit (a1827757c): 12 of the 14 cases fall - the buffer never held data back, nothing
 * was compressed, the size limit and the output channel were ignored (the latter even refused with "output channels are
 * not supported"), a symlink was always followed and a missing crypto provider never refused the action.
 * The two that pass either way are WITNESSES from the same lab: the default configuration shows every message at once
 * and an action without a provider is created.
 * sync="on" is accepted without a test: the inode store is already durable, so there is no crash for fsync to survive.
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

function machine(): LinuxServer {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  return host;
}

async function configure(host: LinuxServer, text: string): Promise<void> {
  await host.executeCommand(`printf '${text.replace(/'/g, "'\\''")}\\n' > /etc/rsyslog.d/40-test.conf`);
  await host.executeCommand('systemctl restart rsyslog');
}

async function log(host: LinuxServer, facility: string, text: string): Promise<void> {
  await host.executeCommand(`logger -p ${facility}.info -t probe ${text}`);
}

describe('the stream buffer', () => {
  it('witness: by default every message is in the file at once', async () => {
    const host = machine();
    await configure(host, 'local4.* /var/log/plain.log');
    await log(host, 'local4', 'one');
    expect(await host.executeCommand('cat /var/log/plain.log')).toContain('probe: one');
  }, 60_000);

  it('flushOnTXEnd off keeps data in the io buffer until it is full, and writes it in whole buffers', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/buffered.log" ioBufferSize="256" flushOnTXEnd="off" template="RSYSLOG_FileFormat")');
    await log(host, 'local4', 'first');
    expect((await host.executeCommand('wc -c < /var/log/buffered.log')).trim()).toBe('0');
    for (let index = 0; index < 8; index++) await log(host, 'local4', `filler-number-${index}-aaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    const size = Number((await host.executeCommand('wc -c < /var/log/buffered.log')).trim());
    expect(size).toBeGreaterThan(0);
    expect(size % 256).toBe(0);
  }, 60_000);

  it('HUP flushes the pending buffer', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/buffered.log" ioBufferSize="4096" flushOnTXEnd="off")');
    await log(host, 'local4', 'pending-line');
    expect((await host.executeCommand('wc -c < /var/log/buffered.log')).trim()).toBe('0');
    await host.executeCommand('kill -HUP $(pidof rsyslogd)');
    expect(await host.executeCommand('cat /var/log/buffered.log')).toContain('probe: pending-line');
  }, 60_000);

  it('asyncWriting writes the partial buffer when flushInterval elapses on the simulated clock', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/async.log" asyncWriting="on" flushInterval="3" flushOnTXEnd="off")');
    await log(host, 'local4', 'timed-line');
    expect((await host.executeCommand('wc -c < /var/log/async.log')).trim()).toBe('0');
    host.advanceTime(2_000);
    expect((await host.executeCommand('wc -c < /var/log/async.log')).trim()).toBe('0');
    host.advanceTime(2_000);
    expect(await host.executeCommand('cat /var/log/async.log')).toContain('probe: timed-line');
  }, 60_000);
});

describe('compression', () => {
  it('zipLevel writes a gzip stream; zcat reads it complete once the file is closed', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/packed.log.gz" zipLevel="6")');
    await log(host, 'local4', 'compressed-one');
    await log(host, 'local4', 'compressed-two');
    expect(await host.executeCommand('file /var/log/packed.log.gz')).toContain('gzip compressed data');
    const live = await host.executeCommand('zcat /var/log/packed.log.gz; echo "exit=$?"');
    expect(live).toContain('probe: compressed-one');
    expect(live).toContain('unexpected end of file');
    await host.executeCommand('kill -HUP $(pidof rsyslogd)');
    const closed = await host.executeCommand('zcat /var/log/packed.log.gz; echo "exit=$?"');
    expect(closed).toContain('probe: compressed-two');
    expect(closed).toContain('exit=0');
    expect(closed).not.toContain('unexpected end of file');
  }, 60_000);

  it('veryRobustZip finishes a gzip member at every write, so the live file is always complete', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/robust.log.gz" zipLevel="6" veryRobustZip="on")');
    await log(host, 'local4', 'robust-one');
    await log(host, 'local4', 'robust-two');
    const out = await host.executeCommand('zcat /var/log/robust.log.gz; echo "exit=$?"');
    expect(out).toContain('probe: robust-one');
    expect(out).toContain('probe: robust-two');
    expect(out).toContain('exit=0');
  }, 60_000);

  it('compression.driver zstd writes a zstd frame', async () => {
    const host = machine();
    await host.executeCommand("sed -i '1i module(load=\"builtin:omfile\" compression.driver=\"zstd\")' /etc/rsyslog.conf");
    await configure(host, 'local4.* action(type="omfile" file="/var/log/packed.log.zst" zipLevel="3")');
    await log(host, 'local4', 'zstd-one');
    const frame = (host as unknown as { executor: { vfs: { readFile(path: string): string | null } } }).executor.vfs.readFile('/var/log/packed.log.zst') ?? '';
    expect([...frame.slice(0, 4)].map((character) => character.charCodeAt(0))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
  }, 60_000);
});

describe('size limit and output channels', () => {
  async function rotationScript(host: LinuxServer, body: string): Promise<void> {
    await host.executeCommand(`printf '#!/bin/sh\\n${body}\\n' > /usr/local/bin/rotate.sh`);
    await host.executeCommand('chmod +x /usr/local/bin/rotate.sh');
  }

  it('an output channel with a size limit runs its command when the file reaches the limit', async () => {
    const host = machine();
    await rotationScript(host, 'mv /var/log/chan.log /var/log/chan.log.1');
    await host.executeCommand("sed -i '1i $outchannel chan,/var/log/chan.log,150,/usr/local/bin/rotate.sh' /etc/rsyslog.conf");
    await configure(host, 'local4.* :omfile:$chan');
    for (let index = 0; index < 6; index++) await log(host, 'local4', `rotated-message-${index}`);
    expect(await host.executeCommand('ls /var/log/chan.log.1 2>&1')).not.toContain('No such file');
    expect(Number((await host.executeCommand('wc -c < /var/log/chan.log.1')).trim())).toBeGreaterThanOrEqual(150);
    expect(await host.executeCommand('cat /var/log/chan.log')).toContain('probe: rotated-message-5');
  }, 60_000);

  it('an unknown output channel is refused in the words of the source', async () => {
    const host = machine();
    await configure(host, 'local4.* :omfile:$nosuchchannel');
    expect(await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf')).toContain("outchannel 'nosuchchannel' not found - ignoring action line");
  }, 60_000);

  it('rotation.sizeLimitCommand receives the file name by default', async () => {
    const host = machine();
    await rotationScript(host, 'mv "$1" "$1.old"');
    await configure(host, 'local4.* action(type="omfile" file="/var/log/limited.log" rotation.sizeLimit="120" rotation.sizeLimitCommand="/usr/local/bin/rotate.sh")');
    for (let index = 0; index < 5; index++) await log(host, 'local4', `limited-message-${index}`);
    expect(await host.executeCommand('ls /var/log/limited.log.old 2>&1')).not.toContain('No such file');
  }, 60_000);

  it('a command that does not shrink the file disables the stream and later messages are lost', async () => {
    const host = machine();
    await rotationScript(host, 'true');
    await configure(host, 'local4.* action(type="omfile" file="/var/log/stuck.log" rotation.sizeLimit="100" rotation.sizeLimitCommand="/usr/local/bin/rotate.sh")');
    for (let index = 0; index < 4; index++) await log(host, 'local4', `stuck-message-${index}`);
    const before = (await host.executeCommand('wc -c < /var/log/stuck.log')).trim();
    expect(await host.executeCommand('cat /var/log/syslog')).toContain("file size limit cmd for file '/var/log/stuck.log' did no resolve situation");
    await log(host, 'local4', 'after-the-disable');
    expect((await host.executeCommand('wc -c < /var/log/stuck.log')).trim()).toBe(before);
  }, 60_000);
});

describe('symlinks and providers', () => {
  it('followSymlinks off refuses a final-component symlink, the default follows it', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/real.log && ln -s /var/log/real.log /var/log/link.log');
    await configure(host, 'local4.* action(type="omfile" file="/var/log/link.log" followSymlinks="off")');
    await log(host, 'local4', 'must-not-follow');
    expect(await host.executeCommand('cat /var/log/real.log')).not.toContain('must-not-follow');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain('Too many levels of symbolic links');
    await configure(host, 'local4.* action(type="omfile" file="/var/log/link.log")');
    await log(host, 'local4', 'follows-by-default');
    expect(await host.executeCommand('cat /var/log/real.log')).toContain('follows-by-default');
  }, 60_000);

  it('a crypto provider that is not installed refuses the action, as the source does', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/secret.log" cry.provider="gcry")');
    const verdict = await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf');
    expect(verdict).toContain("omfile: could not load crypto provider 'lmcry_gcry' - encryption disabled");
    await log(host, 'local4', 'never-written');
    expect(await host.executeCommand('cat /var/log/secret.log 2>&1')).toContain('No such file');
  }, 60_000);

  it('witness: the same action without a provider is created', async () => {
    const host = machine();
    await configure(host, 'local4.* action(type="omfile" file="/var/log/open.log")');
    await log(host, 'local4', 'written');
    expect(await host.executeCommand('cat /var/log/open.log')).toContain('probe: written');
  }, 60_000);
});
