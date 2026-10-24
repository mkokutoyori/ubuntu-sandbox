/*
 * imfile, ported from plugins/imfile/imfile.c and the read side of runtime/stream.c: file discovery (wildcards, rotation,
 * deletion), inotify and polling modes (the VFS reports entry and content changes), partial lines held until their LF,
 * state files in the work directory named after the inode and the siphash of the first 512 bytes, resumption after a
 * restart, freshStartTail, multi-line modes (readMode 1/2, startmsg.regex, endmsg.regex, readTimeout) and the
 * truncation check of reopenOnTruncate. Every case drives a LinuxServer through its shell; time is the simulated clock.
 * Measured against the previous commit (95f1e55b9, where `module(load="imfile")` fails with "could not load module"):
 * 17 of the 18 cases fall (the module does not exist, and the previous run's stash leaves only the pure SipHash module).
 * The one that passes either way is the SipHash vectors: a pure function with no lab. The silent-file case is not a
 * witness of its own - it is paired in the same case with the read that follows the first write.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { sipHash24 } from '@/network/rsyslog/SipHash';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const KEY = Uint8Array.from({ length: 16 }, (_, index) => index);

function machine(): LinuxServer {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  return host;
}

const OUTPUT_TEMPLATE = 'template(name="t" type="string" string="%syslogtag%%msg%|%$!metadata!filename%|%$!metadata!fileoffset%|%$!metadata!line_number%\\n")';

async function configure(host: LinuxServer, body: string, moduleLine = 'module(load="imfile")'): Promise<void> {
  const text = [
    moduleLine, OUTPUT_TEMPLATE, body,
    'if $inputname == "imfile" then { action(type="omfile" file="/var/log/imfile.out" template="t") stop }',
  ].join('\n');
  await host.executeCommand(`cat > /etc/rsyslog.d/30-imfile.conf <<'EOF'\n${text}\nEOF`);
  await host.executeCommand('systemctl restart rsyslog');
}

async function output(host: LinuxServer): Promise<string> {
  return host.executeCommand('cat /var/log/imfile.out 2>&1');
}

async function append(host: LinuxServer, path: string, text: string): Promise<void> {
  await host.executeCommand(`printf '${text.replace(/'/g, "'\\''")}' >> ${path}`);
}

describe('siphash', () => {
  it('SipHash-2-4 matches the reference vectors (key 00..0f)', () => {
    expect([...sipHash24(new Uint8Array(0), KEY)].map((byte) => byte.toString(16).padStart(2, '0')).join('')).toBe('310e0edd47db6f72');
    const fifteen = Uint8Array.from({ length: 15 }, (_, index) => index);
    expect([...sipHash24(fifteen, KEY)].map((byte) => byte.toString(16).padStart(2, '0')).join('')).toBe('e545be4961ca29a1');
  });
});

describe('reading', () => {
  it('reads the lines a file already holds at start, with their metadata', async () => {
    const host = machine();
    await host.executeCommand("printf 'first\\nsecond\\n' > /var/log/app.log");
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    expect(await output(host)).toBe('app:first|/var/log/app.log|0|1\napp:second|/var/log/app.log|6|2');
  }, 60_000);

  it('witness: a file nobody writes produces nothing, and the same file once written is read at once (inotify)', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/app.log');
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    expect(await output(host)).toContain('No such file');
    await append(host, '/var/log/app.log', 'later\\n');
    expect(await output(host)).toContain('app:later|/var/log/app.log|0|1');
  }, 60_000);

  it('holds a line without LF until it is completed', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/app.log');
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    await append(host, '/var/log/app.log', 'half a li');
    expect(await output(host)).toContain('No such file');
    await append(host, '/var/log/app.log', 'ne\\n');
    expect(await output(host)).toContain('app:half a line|');
  }, 60_000);

  it('polling mode sees new lines only when the polling interval elapses on the simulated clock', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/app.log');
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")', 'module(load="imfile" mode="polling" pollingInterval="5")');
    await append(host, '/var/log/app.log', 'polled\\n');
    expect(await output(host)).toContain('No such file');
    host.advanceTime(4_000);
    expect(await output(host)).toContain('No such file');
    host.advanceTime(2_000);
    expect(await output(host)).toContain('app:polled|');
  }, 60_000);

  it('the legacy directives monitor a file in polling mode', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/legacy.log');
    const text = ['$ModLoad imfile', '$InputFilePollInterval 3', '$InputFileName /var/log/legacy.log', '$InputFileTag legacy:', '$InputFileStateFile legacy-state', '$InputRunFileMonitor', OUTPUT_TEMPLATE,
      'if $inputname == "imfile" then { action(type="omfile" file="/var/log/imfile.out" template="t") stop }'].join('\n');
    await host.executeCommand(`cat > /etc/rsyslog.d/30-imfile.conf <<'EOF'\n${text}\nEOF`);
    await host.executeCommand('systemctl restart rsyslog');
    await append(host, '/var/log/legacy.log', 'old school\\n');
    host.advanceTime(4_000);
    expect(await output(host)).toContain('legacy:old school|');
  }, 60_000);

  it('freshStartTail ignores what the file already holds', async () => {
    const host = machine();
    await host.executeCommand("printf 'before\\n' > /var/log/app.log");
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:" freshStartTail="on")');
    await append(host, '/var/log/app.log', 'after\\n');
    const out = await output(host);
    expect(out).toContain('app:after|');
    expect(out).not.toContain('before');
  }, 60_000);

  it('an unreadable monitored file is reported at start and read once it exists', async () => {
    const host = machine();
    await configure(host, 'input(type="imfile" file="/var/log/missing.log" tag="app:")');
    expect(await host.executeCommand('journalctl -t rsyslogd --no-pager; cat /var/log/syslog')).toContain(
      "imfile: on startup file '/var/log/missing.log' does not exist but is configured in static file monitor",
    );
    await host.executeCommand("printf 'born later\\n' > /var/log/missing.log");
    expect(await output(host)).toContain('app:born later|');
  }, 60_000);
});

describe('state files and restarts', () => {
  it('a restart resumes where the previous run stopped, from the state file named after the inode', async () => {
    const host = machine();
    await host.executeCommand("printf 'one\\ntwo\\n' > /var/log/app.log");
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    const inode = (await host.executeCommand('stat -c %i /var/log/app.log')).trim();
    expect(await host.executeCommand(`ls /var/spool/rsyslog/imfile-state:${inode} 2>&1`)).toContain('No such file');
    await host.executeCommand('systemctl restart rsyslog');
    const state = await host.executeCommand(`cat /var/spool/rsyslog/imfile-state:${inode}`);
    expect(state).toContain('"filename": "\\/var\\/log\\/app.log"');
    expect(state).toContain('"curr_offs": 8');
    await append(host, '/var/log/app.log', 'three\\n');
    await host.executeCommand('systemctl restart rsyslog');
    const lines = (await output(host)).trim().split('\n');
    expect(lines.map((line) => line.split('|')[0])).toEqual(['app:one', 'app:two', 'app:three']);
  }, 60_000);

  it('deleting the monitored file removes its state file once the deletion delay has elapsed', async () => {
    const host = machine();
    await host.executeCommand(`printf '${'d'.repeat(600)}\\n' > /var/log/app.log`);
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:" deleteStateOnFileDelete="on")');
    const inode = (await host.executeCommand('stat -c %i /var/log/app.log')).trim();
    expect(await host.executeCommand(`ls /var/spool/rsyslog/ | grep -c imfile-state:${inode}`)).toBe('1');
    await host.executeCommand('rm /var/log/app.log');
    expect(await host.executeCommand(`ls /var/spool/rsyslog/ | grep -c imfile-state:${inode}`)).toBe('1');
    host.advanceTime(8_000);
    expect(await host.executeCommand(`ls /var/spool/rsyslog/ | grep -c imfile-state:${inode}`)).toBe('0');
  }, 60_000);

  it('a state file past 512 bytes carries the siphash of the first 512 bytes in its name', async () => {
    const host = machine();
    await host.executeCommand(`printf '${'a'.repeat(600)}\\n' > /var/log/app.log`);
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    const inode = (await host.executeCommand('stat -c %i /var/log/app.log')).trim();
    const listing = await host.executeCommand(`ls /var/spool/rsyslog/ | grep imfile-state:${inode}`);
    expect(listing.trim()).toMatch(new RegExp(`^imfile-state:${inode}:[0-9a-f]{16}$`));
  }, 60_000);
});

describe('discovery', () => {
  it('a wildcard picks up files created later, in inotify mode', async () => {
    const host = machine();
    await host.executeCommand('mkdir -p /var/log/apps && touch /var/log/apps/a.log');
    await configure(host, 'input(type="imfile" file="/var/log/apps/*.log" tag="app:")');
    await append(host, '/var/log/apps/a.log', 'from a\\n');
    await host.executeCommand("printf 'from b\\n' > /var/log/apps/b.log");
    const out = await output(host);
    expect(out).toContain('app:from a|/var/log/apps/a.log|');
    expect(out).toContain('app:from b|/var/log/apps/b.log|');
  }, 60_000);

  it('rotation: the old file is drained, the new file of the same name is read from its start', async () => {
    const host = machine();
    await host.executeCommand("printf 'before\\n' > /var/log/app.log");
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    await append(host, '/var/log/app.log', 'last of the old\\n');
    await host.executeCommand('mv /var/log/app.log /var/log/app.log.1');
    await host.executeCommand("printf 'first of the new\\n' > /var/log/app.log");
    await append(host, '/var/log/app.log', 'second of the new\\n');
    const lines = (await output(host)).trim().split('\n').map((line) => line.split('|')[0]);
    expect(lines).toEqual(['app:before', 'app:last of the old', 'app:first of the new', 'app:second of the new']);
  }, 60_000);

  it('a symbolic link is followed to its target', async () => {
    const host = machine();
    await host.executeCommand("printf 'real\\n' > /var/log/target.log && ln -s /var/log/target.log /var/log/link.log");
    await configure(host, 'input(type="imfile" file="/var/log/link.log" tag="app:")');
    expect(await output(host)).toContain('app:real|/var/log/link.log|0|1');
  }, 60_000);
});

describe('multi-line messages', () => {
  it('readMode 2 joins indented lines to the line above', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/trace.log');
    await configure(host, 'input(type="imfile" file="/var/log/trace.log" tag="app:" readMode="2")');
    await append(host, '/var/log/trace.log', 'Exception\\n  at one\\n  at two\\nnext\\n');
    const out = await output(host);
    expect(out).toContain('app:Exception#012  at one#012  at two|');
  }, 60_000);

  it('startmsg.regex starts a message at each matching line and a read timeout releases the last one', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/java.log');
    await configure(host, 'input(type="imfile" file="/var/log/java.log" tag="app:" startmsg.regex="^[0-9]{4}-" readTimeout="3")', 'module(load="imfile" timeoutGranularity="1")');
    await append(host, '/var/log/java.log', '2026-01-01 boom\\n\\tcaused by x\\n2026-01-02 next\\n');
    const first = await output(host);
    expect(first).toContain('app:2026-01-01 boom\\n\tcaused by x|');
    expect(first).not.toContain('2026-01-02 next');
    host.advanceTime(5_000);
    expect(await output(host)).toContain('app:2026-01-02 next|');
  }, 60_000);

  it('only one of readMode, startmsg.regex and endmsg.regex may be set', async () => {
    const host = machine();
    await host.executeCommand('touch /var/log/java.log');
    await configure(host, 'input(type="imfile" file="/var/log/java.log" tag="app:" readMode="1" startmsg.regex="^x")');
    expect(await host.executeCommand('rsyslogd -N1 -f /etc/rsyslog.conf')).toContain('only one of readMode or startmsg.regex or endmsg.regex can be set at the same time');
  }, 60_000);
});

describe('truncation', () => {
  it('without reopenOnTruncate a rewritten shorter file stays silent; with it the file is read again from its start', async () => {
    const host = machine();
    await host.executeCommand("printf 'aaaaaaaa\\nbbbbbbbb\\n' > /var/log/app.log");
    await configure(host, 'input(type="imfile" file="/var/log/app.log" tag="app:")');
    await host.executeCommand("printf 'c\\n' > /var/log/app.log");
    expect(await output(host)).not.toContain('app:c|');
    await host.executeCommand("printf 'aaaaaaaa\\nbbbbbbbb\\n' > /var/log/rot.log");
    await configure(host, 'input(type="imfile" file="/var/log/rot.log" tag="rot:" reopenOnTruncate="on")');
    await host.executeCommand("printf 'd\\n' > /var/log/rot.log");
    expect(await output(host)).toContain('rot:d|');
    expect(await host.executeCommand('cat /var/log/syslog')).toContain("truncation detected, (last block could not be re-read) - re-start reading from beginning (data 2)");
  }, 60_000);
});
