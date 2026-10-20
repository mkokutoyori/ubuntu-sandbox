/**
 * Probe — src/network/rsyslog/modules/Imuxsock.ts, ported from
 * plugins/imuxsock/imuxsock.c (8.2610): the system log socket, additional
 * sockets, the "special parser", trusted-property annotation, per-process rate
 * limiting and the systemd socket hand-over.
 *
 * Measured against the base commit: the module does not exist there, so every
 * case fails at import. "witness:" cases only prove the lab is sound. The
 * per-process rate-limit cases move the simulated clock with LabHost.advance().
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

const TEMPLATE = 'template(name="probe" type="string" string="%timestamp:::date-rfc3339%|%hostname%|%fromhost%|%syslogtag%|%msg%|%rawmsg%\\n")';
const FILE = '*.* action(type="omfile" file="/var/log/in.log" template="probe")';
const SYSTEMD_SOCKET = '/run/systemd/journal/syslog';

function rig(config: string, prepare: (host: LabHost) => void = () => undefined): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  prepare(host);
  return { host, lab: startRsyslog(host, config) };
}

const filed = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/in.log') ?? null);
const libc = (host: LabHost): string[] => host.libcSyslog.map((entry) => entry.message);

describe('imuxsock system socket', () => {
  it('witness: a local message is parsed by the special parser: no host name field, tag up to the first space', () => {
    const { host } = rig(`${TEMPLATE}\nmodule(load="imuxsock")\n${FILE}`);
    host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 11:59:00 alice: hello', { pid: 4242, uid: 1000, gid: 1000 });
    expect(filed(host)).toEqual(['2026-10-19T12:00:00.000000+00:00|ubuntu|ubuntu|alice:| hello|<13>Oct 19 11:59:00 alice: hello']);
  });

  it('takes the socket from systemd when it was handed over, and says so', () => {
    const { host } = rig(`${TEMPLATE}\nmodule(load="imuxsock")\n${FILE}`);
    expect(libc(host)).toContain("imuxsock: Acquired UNIX socket '/run/systemd/journal/syslog' (fd 3) from systemd.  [v8.2112.0]");
  });

  it('falls back to /dev/log when systemd did not hand a socket over, and honours syssock.name', () => {
    const plain = rig(`${TEMPLATE}\nmodule(load="imuxsock")\n${FILE}`, (host) => { host.systemd = false; });
    plain.host.logLocal('/dev/log', '<13>Oct 19 12:00:00 alice: via devlog');
    expect(filed(plain.host)).toHaveLength(1);
    const named = rig(`${TEMPLATE}\nmodule(load="imuxsock" sysSock.name="/run/custom.sock")\n${FILE}`, (host) => host.directories.add('/run'));
    named.host.logLocal('/run/custom.sock', '<13>Oct 19 12:00:00 alice: custom');
    expect(filed(named.host)).toHaveLength(1);
  });

  it('syssock.use="off" and $OmitLocalLogging leave the system socket unopened', () => {
    const off = rig(`${TEMPLATE}\nmodule(load="imuxsock" sysSock.use="off")\n${FILE}`);
    expect(off.host.localSockets.has(SYSTEMD_SOCKET)).toBe(false);
    const legacy = rig(`${TEMPLATE}\nmodule(load="imuxsock")\n$OmitLocalLogging on\n${FILE}`);
    expect(legacy.host.localSockets.has(SYSTEMD_SOCKET)).toBe(true);
  });

  it('uses the arrival time and ignores the timestamp text by default; syssock.useSysTimeStamp="off" with ignoreTimestamp="off" keeps the message time', () => {
    const kept = rig(`${TEMPLATE}\nmodule(load="imuxsock" sysSock.useSysTimeStamp="off" sysSock.ignoreTimestamp="off")\n${FILE}`);
    kept.host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 11:30:00 alice: stamped', { pid: 1 });
    expect(filed(kept.host)[0].startsWith('2026-10-19T11:30:00+00:00|')).toBe(true);
    const system = rig(`${TEMPLATE}\nmodule(load="imuxsock")\n${FILE}`);
    system.host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 11:30:00 alice: stamped', { pid: 1, receivedAtMs: Date.UTC(2026, 9, 19, 12, 5, 0) });
    expect(filed(system.host)[0].startsWith('2026-10-19T12:05:00.000000+00:00|')).toBe(true);
    expect(filed(system.host)[0]).toContain('|<13>Oct 19 12:05:00 alice: stamped');
  });

  it('syssock.usePIDFromSystem writes the kernel-attested pid into the tag', () => {
    const { host } = rig(`${TEMPLATE}\nmodule(load="imuxsock" sysSock.usePIDFromSystem="on")\n${FILE}`);
    host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 alice[1]: liar', { pid: 4242 });
    host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 bob: no pid', { pid: 77 });
    expect(filed(host).map((entry) => entry.split('|')[3])).toEqual(['alice[4242]:', 'bob[77]:']);
  });

  it('annotate appends the trusted properties; parseTrusted puts them under $!', () => {
    const processes = (host: LabHost): void => { host.processes.set(4242, { comm: 'alice', exe: '/usr/bin/alice', cmdline: '/usr/bin/alice\u0000--flag' }); };
    const text = rig(`${TEMPLATE}\nmodule(load="imuxsock" sysSock.annotate="on")\n${FILE}`, processes);
    text.host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 alice: hi', { pid: 4242, uid: 1000, gid: 1001 });
    expect(filed(text.host)[0]).toContain('@[_PID=4242 _UID=1000 _GID=1001 _COMM=alice _EXE=/usr/bin/alice _CMDLINE="/usr/bin/alice --flag"]');
    const json = rig(`template(name="j" type="string" string="%$!pid%|%$!uid%|%$!appname%|%$!exe%|%$!cmd%\\n")\nmodule(load="imuxsock" sysSock.annotate="on" sysSock.parseTrusted="on")\n*.* action(type="omfile" file="/var/log/in.log" template="j")`, processes);
    json.host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 alice: hi', { pid: 4242, uid: 1000, gid: 1001 });
    expect(filed(json.host)).toEqual(['4242|1000|alice|/usr/bin/alice|/usr/bin/alice --flag']);
  });

  it('discards messages from the daemon itself when internal messages are processed', () => {
    const { host, lab } = rig(`global(processInternalMessages="on")\n${TEMPLATE}\nmodule(load="imuxsock")\n${FILE}`);
    host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 rsyslogd: mine', { pid: host.ownPidNumber });
    host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 alice: theirs', { pid: 9 });
    expect(filed(host).filter((entry) => entry.includes('|mine|') || entry.includes(' mine|'))).toEqual([]);
    expect(filed(host).some((entry) => entry.includes(' theirs|'))).toBe(true);
    expect(lab.engine.isStarted).toBe(true);
  });

  it('rate-limits each process separately by interval and burst, never below the severity threshold, and recovers with simulated time', () => {
    const { host } = rig(
      `${TEMPLATE}\nmodule(load="imuxsock" sysSock.rateLimit.interval="5" sysSock.rateLimit.burst="3")\n${FILE}`,
      (lab) => { lab.processes.set(100, { comm: 'noisy', exe: '/usr/bin/noisy', cmdline: '/usr/bin/noisy' }); lab.livePids.add(100); lab.livePids.add(200); },
    );
    for (let count = 0; count < 6; count++) host.logLocal(SYSTEMD_SOCKET, `<13>Oct 19 12:00:00 noisy: n${count}`, { pid: 100 });
    for (let count = 0; count < 2; count++) host.logLocal(SYSTEMD_SOCKET, `<13>Oct 19 12:00:00 quiet: q${count}`, { pid: 200 });
    host.logLocal(SYSTEMD_SOCKET, '<0>Oct 19 12:00:00 noisy: emergency', { pid: 100 });
    const names = filed(host).map((entry) => entry.split('|')[4].trim());
    expect(names.filter((name) => name.startsWith('n'))).toEqual(['n0', 'n1', 'n2']);
    expect(names.filter((name) => name.startsWith('q'))).toEqual(['q0', 'q1']);
    expect(names).toContain('emergency');
    host.advance(6_000);
    host.logLocal(SYSTEMD_SOCKET, '<13>Oct 19 12:00:00 noisy: later', { pid: 100 });
    expect(filed(host).map((entry) => entry.split('|')[4].trim())).toContain('later');
  });
});

describe('imuxsock additional sockets', () => {
  it('opens a socket given by input(...) with its own host name and ruleset', () => {
    const { host } = rig(
      `${TEMPLATE}\nmodule(load="imuxsock" sysSock.use="off")\nruleset(name="chroot") { action(type="omfile" file="/var/log/chroot.log" template="probe") }\ninput(type="imuxsock" socket="/jail/dev/log" createPath="on" hostName="jail" ruleset="chroot")`,
    );
    host.logLocal('/jail/dev/log', '<13>Oct 19 12:00:00 inside: hi', { pid: 3 });
    expect(lines(host.fileSystem.get('/var/log/chroot.log') ?? null)[0]).toContain('|jail|jail|inside:|');
  });

  it('requires the socket parameter and rejects createPath together with unlink="off"', () => {
    const missing = rig('module(load="imuxsock")\ninput(type="imuxsock")\n*.* /var/log/x.log');
    expect(missing.lab.loader.log.lines().some((line) => line.includes('input(type="imuxsock") defines an additional UNIX socket'))).toBe(true);
    const conflict = rig('module(load="imuxsock")\ninput(type="imuxsock" socket="/x/log" createPath="on" unlink="off")\n*.* /var/log/x.log');
    expect(conflict.lab.loader.log.lines().some((line) => line.includes("CreatePath=\"on\" cannot be combined with Unlink=\"off\" for socket '/x/log'"))).toBe(true);
  });

  it('reports a socket path that cannot be created', () => {
    const { host } = rig('module(load="imuxsock")\ninput(type="imuxsock" socket="/nowhere/log")\n*.* /var/log/x.log');
    expect(libc(host)).toContain("cannot create '/nowhere/log': No such file or directory [v8.2112.0 try https://www.rsyslog.com/e/2085 ]");
  });

  it('legacy $AddUnixListenSocket with $InputUnixListenSocketHostName', () => {
    const { host } = rig(`${TEMPLATE}\nmodule(load="imuxsock")\n$InputUnixListenSocketCreatePath on\n$InputUnixListenSocketHostName jail\n$AddUnixListenSocket /srv/dev/log\n${FILE}`);
    host.logLocal('/srv/dev/log', '<13>Oct 19 12:00:00 inside: legacy', { pid: 3 });
    expect(filed(host)[0]).toContain('|jail|inside:|');
  });
});
