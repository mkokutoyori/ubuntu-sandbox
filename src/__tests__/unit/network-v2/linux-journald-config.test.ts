/**
 * Probe — journald.conf of systemd 255 (Ubuntu 24.04). The daemon reads /etc/systemd/journald.conf, then the drop-ins of
 * journald.conf.d in /etc, /run, /usr/local/lib and /usr/lib: files are merged by NAME, sorted by name, and a file of
 * /etc masks the file of the same name below it. Ubuntu ships /usr/lib/systemd/journald.conf.d/syslog.conf with
 * ForwardToSyslog=yes, which is what hands every journal entry to rsyslog. The settings are read when the daemon starts, so
 * `systemctl restart systemd-journald` applies them. What is evaluated here: ForwardToSyslog and MaxLevelSyslog (what
 * rsyslog receives), MaxLevelStore and Storage=none (what the journal keeps), LineMax and the diagnostics of the parser,
 * worded as in the binaries of the machine (libsystemd-shared 255 and systemd-journald).
 * Measured against the preceding commit (git stash of src/network): 7 of the 12 cases fall - the file was never read, so
 * ForwardToSyslog=no, MaxLevelSyslog, MaxLevelStore and Storage=none changed nothing, the Ubuntu files were not shipped and
 * no diagnostic was printed. The 5 that pass either way are WITNESSES: the default configuration forwards to rsyslog, the
 * two cases where the daemon must NOT have applied the setting (a drop-in that sorts before syslog.conf, a file written
 * but not yet read) which are only meaningful next to the case that shows the same setting applied by name order and by a
 * restart, and the two parser cases built on a fake file source, which need only the new parser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { readJournaldConfig } from '@/network/devices/linux/journal/JournaldConfig';
import { DEFAULT_JOURNALD_SETTINGS } from '@/network/devices/linux/journal/JournaldServer';

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

async function configure(host: LinuxServer, name: string, body: string): Promise<void> {
  await host.executeCommand('mkdir -p /etc/systemd/journald.conf.d');
  await host.executeCommand(`printf '[Journal]\\n${body}\\n' > /etc/systemd/journald.conf.d/${name}`);
  await host.executeCommand('systemctl restart systemd-journald');
}

const send = (host: LinuxServer, level: string, text: string): Promise<string> => host.executeCommand(`logger -p user.${level} -t probe ${text}`);
const syslogFile = (host: LinuxServer): Promise<string> => host.executeCommand('cat /var/log/syslog');
const journal = (host: LinuxServer): Promise<string> => host.executeCommand('journalctl --no-pager -t probe 2>&1');

function source(files: Record<string, string>) {
  return {
    readFile: (path: string): string | null => files[path] ?? null,
    listDirectory: (path: string): Array<{ name: string }> | null => {
      const prefix = `${path}/`;
      const names = Object.keys(files).filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'));
      return names.length === 0 ? null : names.map((file) => ({ name: file.slice(prefix.length) }));
    },
  };
}

describe('the files Ubuntu ships', () => {
  it('journald.conf is the commented file of the package and the syslog drop-in forwards to rsyslog', async () => {
    const host = machine();
    expect(await host.executeCommand('grep -c "^#" /etc/systemd/journald.conf')).not.toBe('0');
    expect(await host.executeCommand('cat /etc/systemd/journald.conf')).toContain('#ForwardToSyslog=no');
    expect(await host.executeCommand('cat /usr/lib/systemd/journald.conf.d/syslog.conf')).toContain('ForwardToSyslog=yes');
  }, 60_000);

  it('witness: by default what is logged reaches rsyslog', async () => {
    const host = machine();
    await send(host, 'info', 'reaches-rsyslog');
    expect(await syslogFile(host)).toContain('probe: reaches-rsyslog');
  }, 60_000);
});

describe('what rsyslog receives', () => {
  it('ForwardToSyslog=no in a drop-in that sorts after syslog.conf stops the hand-over once the daemon restarts', async () => {
    const host = machine();
    await configure(host, 'zz-no-forward.conf', 'ForwardToSyslog=no');
    await send(host, 'info', 'not-handed-over');
    expect(await syslogFile(host)).not.toContain('not-handed-over');
    expect(await journal(host)).toContain('not-handed-over');
  }, 60_000);

  it('a drop-in that sorts BEFORE syslog.conf loses to it: files are merged by name', async () => {
    const host = machine();
    await configure(host, '50-no-forward.conf', 'ForwardToSyslog=no');
    await send(host, 'info', 'still-handed-over');
    expect(await syslogFile(host)).toContain('still-handed-over');
  }, 60_000);

  it('a file of /etc with the name syslog.conf masks the one of /usr/lib', async () => {
    const host = machine();
    await configure(host, 'syslog.conf', 'ForwardToSyslog=no');
    await send(host, 'info', 'masked-drop-in');
    expect(await syslogFile(host)).not.toContain('masked-drop-in');
  }, 60_000);

  it('the settings are read when the daemon starts, not before', async () => {
    const host = machine();
    await host.executeCommand('mkdir -p /etc/systemd/journald.conf.d');
    await host.executeCommand("printf '[Journal]\\nForwardToSyslog=no\\n' > /etc/systemd/journald.conf.d/zz-late.conf");
    await send(host, 'info', 'before-restart');
    expect(await syslogFile(host)).toContain('before-restart');
  }, 60_000);

  it('MaxLevelSyslog keeps the less urgent messages away from rsyslog but not from the journal', async () => {
    const host = machine();
    await configure(host, 'zz-level.conf', 'MaxLevelSyslog=warning');
    await send(host, 'info', 'too-chatty');
    await send(host, 'err', 'urgent-enough');
    const syslog = await syslogFile(host);
    expect(syslog).not.toContain('too-chatty');
    expect(syslog).toContain('urgent-enough');
    expect(await journal(host)).toContain('too-chatty');
  }, 60_000);
});

describe('what the journal keeps', () => {
  it('MaxLevelStore drops the less urgent messages from the journal', async () => {
    const host = machine();
    await configure(host, 'zz-store.conf', 'MaxLevelStore=warning');
    await send(host, 'info', 'not-stored');
    await send(host, 'err', 'stored');
    const entries = await journal(host);
    expect(entries).not.toContain('not-stored');
    expect(entries).toContain('stored');
  }, 60_000);

  it('Storage=none keeps nothing while rsyslog still receives the messages', async () => {
    const host = machine();
    await configure(host, 'zz-none.conf', 'Storage=none');
    await send(host, 'info', 'kept-nowhere');
    expect(await journal(host)).not.toContain('kept-nowhere');
    expect(await syslogFile(host)).toContain('kept-nowhere');
  }, 60_000);
});

describe('the parser', () => {
  it('names the file and the line of what it ignores, in the words of systemd', async () => {
    const host = machine();
    await host.executeCommand('mkdir -p /etc/systemd/journald.conf.d');
    await host.executeCommand("printf '[Journal]\\nBogus=1\\nMaxLevelStore=loud\\nForwardToWall=maybe\\n[Elsewhere]\\nX=1\\n' > /etc/systemd/journald.conf.d/zz-bad.conf");
    await host.executeCommand('systemctl restart systemd-journald');
    const lines = await host.executeCommand('journalctl --no-pager -t systemd-journald 2>&1');
    expect(lines).toContain("/etc/systemd/journald.conf.d/zz-bad.conf:2: Unknown key name 'Bogus' in section 'Journal', ignoring.");
    expect(lines).toContain('/etc/systemd/journald.conf.d/zz-bad.conf:3: Failed to parse log level, ignoring: loud');
    expect(lines).toContain('/etc/systemd/journald.conf.d/zz-bad.conf:4: Failed to parse boolean value for ForwardToWall=, ignoring: maybe');
    expect(lines).toContain("/etc/systemd/journald.conf.d/zz-bad.conf:5: Unknown section 'Elsewhere'. Ignoring.");
  }, 60_000);

  it('witness: the defaults are the compile-time defaults of the manual when nothing is configured', () => {
    expect(readJournaldConfig(source({})).settings).toEqual(DEFAULT_JOURNALD_SETTINGS);
  });

  it('witness: LineMax is rounded up to 79, a value that does not parse keeps the previous one, an empty value restores the default', () => {
    const files = {
      '/etc/systemd/journald.conf': '[Journal]\nLineMax=10\nMaxLevelStore=info\nMaxLevelSyslog=err\n',
      '/etc/systemd/journald.conf.d/10-a.conf': '[Journal]\nMaxLevelStore=nonsense\nMaxLevelSyslog=\n',
    };
    const readout = readJournaldConfig(source(files));
    expect(readout.settings.lineMax).toBe(79);
    expect(readout.settings.maxLevelStore).toBe(6);
    expect(readout.settings.maxLevelSyslog).toBe(DEFAULT_JOURNALD_SETTINGS.maxLevelSyslog);
    expect(readout.diagnostics).toEqual(['/etc/systemd/journald.conf.d/10-a.conf:2: Failed to parse log level, ignoring: nonsense']);
  });
});
