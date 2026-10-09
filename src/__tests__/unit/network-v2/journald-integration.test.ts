/*
 * Integration of the oracle-checked journald and journalctl ports (255.4) and of the logger port (util-linux 2.39.3) into
 * the simulated host.  Every line a service, the kernel or logger writes now crosses the journald ingestion path - a
 * syslog or native datagram carrying the sender's credentials - and journalctl reads the resulting journal records, so
 * the fields (_PID, _COMM, _EXE, _SYSTEMD_UNIT, UNIT, _TRANSPORT) are the ones journald derives, not ones the command
 * invents.  Measured before the integration (module absent, git stash push -u -- src/network): 13 of the 14 cases fall.
 * The one that passes either way is "logger without -i writes no pid into the file": a non-regression witness, since the
 * old command also left the pid out of the line unless -i was given.
 */
import { describe, it, expect } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { simulationNowMs } from '@/network/core/SystemClock';

function host(): LinuxCommandExecutor {
  const exec = new LinuxCommandExecutor(true);
  exec.attachEventBus(new EventBus(), 'journald-integration');
  return exec;
}

function journalFiles(exec: LinuxCommandExecutor): string[] {
  return (exec.vfs.listDirectory(exec.logMgr.journald.directory) ?? []).map((entry) => entry.name).filter((name) => name.endsWith('.journal')).sort();
}

function entries(exec: LinuxCommandExecutor, args: string): Array<Record<string, string>> {
  return exec.execute(`journalctl -o json ${args}`).split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, string>);
}

describe('journald and logger integrated in the host', () => {
  it('a logger line carries the credentials of the logger process', () => {
    const exec = host();
    exec.execute('logger -t probe "hello journal"');
    const [entry] = entries(exec, '-t probe');
    expect(entry.MESSAGE).toBe('hello journal');
    expect(entry._TRANSPORT).toBe('syslog');
    expect(entry._COMM).toBe('logger');
    expect(entry._EXE).toBe('/usr/bin/logger');
    expect(Number(entry._PID)).toBeGreaterThan(0);
    expect(entry.SYSLOG_IDENTIFIER).toBe('probe');
  });

  it('logger -i records SYSLOG_PID and the syslog file shows it', () => {
    const exec = host();
    exec.execute('logger -i -t probe "with pid"');
    const [entry] = entries(exec, '-t probe');
    expect(entry.SYSLOG_PID).toBe(entry._PID);
    expect(exec.vfs.readFile('/var/log/syslog')).toMatch(new RegExp(`probe\\[${entry._PID}\\]: with pid`));
  });

  it('logger without -i writes no pid into the file', () => {
    const exec = host();
    exec.execute('logger -t probe "bare"');
    expect(exec.vfs.readFile('/var/log/syslog')).toMatch(/ probe: bare/);
  });

  it('logger kern.warning is filed under the user facility, as util-linux does', () => {
    const exec = host();
    exec.execute('logger -p kern.warning "not a kernel line"');
    const [entry] = entries(exec, '-g "not a kernel line"');
    expect(entry.SYSLOG_FACILITY).toBe('1');
    expect(exec.vfs.readFile('/var/log/kern.log')).not.toContain('not a kernel line');
    expect(exec.vfs.readFile('/var/log/syslog')).toContain('not a kernel line');
  });

  it('logger refuses a numeric priority like the real tool', () => {
    expect(host().execute('logger -p 13 x')).toContain('unknown priority name: 13');
  });

  it('logger --journald stores structured fields', () => {
    const exec = host();
    exec.execute('logger --journald <<< ""');
    exec.execute('printf "MESSAGE=structured\\nTICKET=42\\n" | logger --journald');
    const [entry] = entries(exec, 'TICKET=42');
    expect(entry.MESSAGE).toBe('structured');
    expect(entry._TRANSPORT).toBe('journal');
  });

  it('systemd start messages are matched by journalctl -u through the UNIT field of PID 1', () => {
    const exec = host();
    const out = exec.execute('journalctl -u ssh -o cat');
    expect(out).toContain('Started ssh.service');
    const [entry] = entries(exec, '-u ssh --lines=all').filter((candidate) => candidate.UNIT === 'ssh.service');
    expect(entry._PID).toBe('1');
    expect(entry._SYSTEMD_UNIT).toBe('init.scope');
  });

  it('kernel messages are _TRANSPORT=kernel and show up with -k', () => {
    const exec = host();
    exec.logMgr.logAt('kern.err', 'kernel', 'EXT4-fs error on sda1');
    const [entry] = entries(exec, '-k -g "EXT4-fs error"');
    expect(entry._TRANSPORT).toBe('kernel');
    expect(entry.SYSLOG_IDENTIFIER).toBe('kernel');
    expect(exec.execute('dmesg')).toContain('EXT4-fs error on sda1');
  });

  it('--header names the journal file that exists in the file system', () => {
    const exec = host();
    const path = /File path: (\S+)/.exec(exec.execute('journalctl --header'))![1];
    expect(path).toMatch(/^\/var\/log\/journal\/[0-9a-f]{32}\/system\.journal$/);
    expect(exec.vfs.exists(path)).toBe(true);
    expect(exec.execute('journalctl --disk-usage')).toContain('8.0M');
  });

  it('--rotate archives the active file under its sequence-numbered name and stays silent', () => {
    const exec = host();
    expect(exec.execute('journalctl --rotate')).toBe('');
    const names = journalFiles(exec);
    expect(names).toHaveLength(2);
    expect(names.some((name) => /^system@[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{16}\.journal$/.test(name))).toBe(true);
    expect(names).toContain('system.journal');
    exec.execute('logger -t probe "second generation"');
    exec.execute('journalctl --rotate');
    expect(journalFiles(exec)).toHaveLength(3);
    expect(exec.execute('journalctl --vacuum-files=1')).toContain('Deleted archived journal');
    expect(journalFiles(exec)).toHaveLength(2);
  });

  it('every record belongs to the current boot and --list-boots names it', () => {
    const exec = host();
    const boots = new Set(entries(exec, '--lines=all').map((entry) => entry._BOOT_ID));
    expect(boots.size).toBe(1);
    expect(exec.execute('journalctl --list-boots')).toContain([...boots][0]);
  });

  it('WITNESS -- stopping rsyslog freezes the file while the journal keeps recording', () => {
    const exec = host();
    exec.execute('systemctl stop rsyslog');
    exec.execute('logger -t probe "after stop"');
    expect(exec.vfs.readFile('/var/log/syslog')).not.toContain('after stop');
    expect(entries(exec, '-t probe')[0].MESSAGE).toBe('after stop');
    expect(simulationNowMs()).toBeGreaterThan(0);
  });

  it('journalctl -f applies the options of the command to every new record', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    const seen: string[] = [];
    const stop = server.followJournal(['-p', 'err', '-o', 'cat'], (line) => seen.push(line));
    await server.executeCommand('logger -p user.info "quiet line"');
    await server.executeCommand('logger -p user.err "loud line"');
    stop();
    await server.executeCommand('logger -p user.err "after stop"');
    expect(seen).toEqual(['loud line']);
  });

  it('journalctl -f -o json streams one parsable object per record', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    const seen: string[] = [];
    const stop = server.followJournal(['-o', 'json', '-t', 'probe'], (line) => seen.push(line));
    await server.executeCommand('logger -t probe "streamed"');
    stop();
    expect(seen).toHaveLength(1);
    expect((JSON.parse(seen[0]) as Record<string, string>).MESSAGE).toBe('streamed');
  });
});
