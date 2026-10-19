/**
 * Probe — src/network/rsyslog/modules/Immark.ts and Imklog.ts, ported from
 * plugins/immark/immark.c, plugins/imklog/{imklog,bsd}.c and the mark logic of
 * runtime/action.c (8.2610).
 *
 * Measured against the base commit: the modules do not exist there, so every
 * case fails at import. "witness:" cases only prove the lab is sound. The mark
 * cases advance the simulated clock with LabHost.advance(): a mark message is
 * a timer, not an event, so none of them can pass without the clock moving.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

function rig(config: string): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config) };
}

const read = (host: LabHost, path = '/var/log/x.log'): string[] => lines(host.fileSystem.get(path) ?? null);
const libc = (host: LabHost): { priority: number; message: string }[] => host.libcSyslog;

describe('immark', () => {
  it('witness: with the default syslog() path the mark goes to the local log socket every interval of simulated time', () => {
    const { host } = rig('module(load="immark" interval="60")\n*.* /var/log/x.log');
    host.advance(59_000);
    expect(libc(host)).toEqual([]);
    host.advance(1_000);
    expect(libc(host)).toEqual([{ priority: 46, message: '-- MARK --' }]);
    host.advance(120_000);
    expect(libc(host)).toHaveLength(3);
  });

  it('the default period is twenty minutes and $MarkMessagePeriod changes it', () => {
    const plain = rig('module(load="immark")\n*.* /var/log/x.log');
    plain.host.advance(19 * 60_000);
    expect(libc(plain.host)).toHaveLength(0);
    plain.host.advance(60_000);
    expect(libc(plain.host)).toHaveLength(1);
    const legacy = rig('$ModLoad immark\n$MarkMessagePeriod 30\n*.* /var/log/x.log');
    legacy.host.advance(30_000);
    expect(libc(legacy.host)).toHaveLength(1);
  });

  it('use.syslogcall="off" injects the message into the rulesets, tagged rsyslogd: and flagged MARK', () => {
    const { host } = rig('module(load="immark" interval="60" use.syslogcall="off" markMessageText="~ tick ~")\n$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n*.* /var/log/x.log');
    host.advance(60_000);
    expect(read(host)).toEqual(['Oct 19 12:01:00 ubuntu rsyslogd: ~ tick ~']);
    expect(libc(host)).toEqual([]);
  });

  it('refuses a zero period, and reports a ruleset that is combined with the syslog() path', () => {
    const zero = rig('module(load="immark" interval="0")\n*.* /var/log/x.log');
    expect(zero.lab.loader.log.lines()).toEqual(['rsyslogd: immark: mark message period must not be 0, can not run [v8.2112.0]']);
    expect(zero.lab.config.inputs.filter((record) => record.module === 'immark')).toHaveLength(0);
    zero.host.advance(3600_000);
    expect(libc(zero.host)).toEqual([]);
    const routed = rig('module(load="immark" interval="60" ruleset="marks")\nruleset(name="marks") { action(type="omfile" file="/var/log/marks.log") }\n*.* /var/log/x.log');
    expect(routed.lab.loader.log.lines()).toEqual(['rsyslogd: immark: ruleset specified, but configured to log via syslog call - switching to rsyslog-internal logging [v8.2112.0]']);
    routed.host.advance(60_000);
    expect(libc(routed.host)).toEqual([]);
    expect(read(routed.host, '/var/log/marks.log')).toHaveLength(1);
  });

  it('action.writeAllMarkMessages="off" suppresses a mark when the action wrote less than half an interval ago', () => {
    const { host } = rig('module(load="immark" interval="60" use.syslogcall="off")\n*.* action(type="omfile" file="/var/log/x.log" action.writeAllMarkMessages="off")');
    host.advance(60_000);
    expect(read(host)).toHaveLength(1);
    host.advance(60_000);
    expect(read(host)).toHaveLength(2);
    const busy = rig('module(load="immark" interval="60" use.syslogcall="off")\n*.* action(type="omfile" file="/var/log/x.log" action.writeAllMarkMessages="off")');
    busy.host.advance(45_000);
    busy.lab.engine.submit({ raw: '<13>Oct 19 12:00:45 ubuntu alice: busy', inputName: 'imuxsock', fromHost: 'ubuntu', fromHostIp: '127.0.0.1', fromHostPort: null, ruleset: null });
    busy.host.advance(15_000);
    expect(read(busy.host)).toHaveLength(1);
  });
});

describe('imklog', () => {
  const KERNEL = 'module(load="imklog")\n$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n*.* /var/log/x.log';

  it('witness: a kernel line becomes a kern message tagged kernel:', () => {
    const { host } = rig(KERNEL);
    host.kernelLogHandler?.('<6>Linux version 6.8.0\n');
    expect(read(host)).toEqual(['Oct 19 12:00:00 ubuntu kernel: Linux version 6.8.0']);
  });

  it('reassembles a line split across reads and splits several lines of one read', () => {
    const { host } = rig(KERNEL);
    host.kernelLogHandler?.('<6>first');
    host.kernelLogHandler?.(' half\n<4>second\n<3>third');
    host.kernelLogHandler?.('\n');
    expect(read(host).map((entry) => entry.split('kernel: ')[1])).toEqual(['first half', 'second', 'third']);
  });

  it('drops a non-kernel facility unless permitNonKernelFacility is on', () => {
    const { host } = rig(KERNEL);
    host.kernelLogHandler?.('<30>daemon chatter\n');
    expect(read(host)).toEqual([]);
    const permissive = rig('module(load="imklog" permitNonKernelFacility="on")\n*.* /var/log/x.log');
    permissive.host.kernelLogHandler?.('<30>daemon chatter\n');
    expect(read(permissive.host)).toHaveLength(1);
  });

  it('prefers the second priority systemd puts in front of the real message', () => {
    const { host } = rig('module(load="imklog" permitNonKernelFacility="on")\ntemplate(name="p" type="string" string="%pri%|%msg%\\n")\n*.* action(type="omfile" file="/var/log/x.log" template="p")');
    host.kernelLogHandler?.('<6><30>from the journal\n');
    expect(read(host)).toEqual(['30|from the journal']);
  });

  it('strips the kernel timestamp by default, keeps it with keepKernelTimestamp and dates the message with parseKernelTimestamp', () => {
    const stripped = rig('module(load="imklog")\ntemplate(name="m" type="string" string="%msg%\\n")\n*.* action(type="omfile" file="/var/log/x.log" template="m")');
    stripped.host.kernelLogHandler?.('<6>[  12.345678] eth0: link up\n');
    expect(read(stripped.host)).toEqual([' eth0: link up']);
    const kept = rig('module(load="imklog" keepKernelTimestamp="on")\ntemplate(name="m" type="string" string="%msg%\\n")\n*.* action(type="omfile" file="/var/log/x.log" template="m")');
    kept.host.kernelLogHandler?.('<6>[  12.345678] eth0: link up\n');
    expect(read(kept.host)[0]).toContain('[  12.345678] eth0: link up');
    const dated = rig('module(load="imklog" parseKernelTimestamp="on")\ntemplate(name="t" type="string" string="%timestamp:::date-rfc3339%\\n")\n*.* action(type="omfile" file="/var/log/x.log" template="t")');
    dated.host.kernelLogHandler?.('<6>[  60.500000] eth0: link up\n');
    expect(read(dated.host)).toEqual(['2026-10-19T11:01:00.500000+00:00']);
  });

  it('sets and restores the console log level', () => {
    const { host, lab } = rig('module(load="imklog" consoleLogLevel="1")\n*.* /var/log/x.log');
    expect(host.consoleLogLevel).toBe(1);
    lab.engine.stop();
    expect(host.consoleLogLevel).toBeNull();
  });

  it('reports an unreadable kernel log the way imklog does and keeps the daemon running', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.kernelLogErrno = 'EPERM';
    const lab = startRsyslog(host, KERNEL);
    expect(libc(host).map((entry) => [entry.priority, entry.message])).toEqual([[3, 'imklog: cannot open kernel log (/proc/kmsg): Operation not permitted.']]);
    expect(lab.engine.isStarted).toBe(true);
  });

  it('rate-limits the kernel flood with ratelimitInterval/ratelimitBurst', () => {
    const { host } = rig('module(load="imklog" ratelimitInterval="5" ratelimitBurst="2")\n*.* /var/log/x.log');
    host.kernelLogHandler?.('<6>a\n<6>b\n<6>c\n<6>d\n');
    expect(read(host)).toHaveLength(2);
    host.advance(6_000);
    host.kernelLogHandler?.('<6>e\n');
    expect(read(host)).toHaveLength(3);
  });
});
