/**
 * Probe — src/network/rsyslog/{config,engine}/ and modules/{Omfile,Omusrmsg,Omdiscard}.ts
 * (configuration loader, ruleset execution, action state machine, queues,
 * internal messages), ported from rsyslog grammar/, runtime/{action,queue,
 * ratelimit}.c and tools/{omfile,omusrmsg,omdiscard,rsyslogd}.c (8.2610).
 *
 * Measured against the base commit: the engine does not exist there, so every
 * case fails at import. "witness:" cases only prove the lab is sound. Every
 * time-dependent case moves the simulated clock with LabHost.advance(); none
 * reads the real clock.
 */
import { describe, expect, it } from 'vitest';
import { catalogWith, FlakyOutput, flakyModule, LabHost, LabNetwork, lines, startRsyslog, submitLocal } from './_helpers/rsyslogLab';

const MSG = (text: string, pri = 13, second = 1): string => `<${pri}>Oct 19 12:00:0${second} ubuntu alice: ${text}`;

function single(config: string, files: Record<string, string> = {}): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config, { files }) };
}

const read = (host: LabHost, path: string): string[] => lines(host.fileSystem.get(path) ?? null);
const libc = (host: LabHost): string[] => host.libcSyslog.map((entry) => entry.message);

const DEBIAN = `
module(load="imuxsock")
$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat
$IncludeConfig /etc/rsyslog.d/*.conf
`;

const DEBIAN_RULES = `
auth,authpriv.*                 /var/log/auth.log
*.*;auth,authpriv.none          -/var/log/syslog
kern.*                          -/var/log/kern.log
mail.err                        /var/log/mail.err
*.emerg                         :omusrmsg:*
`;

describe('configuration loading', () => {
  it('witness: the Debian layout loads without a diagnostic and routes by facility', () => {
    const { host, lab } = single(DEBIAN, { '/etc/rsyslog.d/50-default.conf': DEBIAN_RULES });
    expect(lab.loader.log.lines()).toEqual([]);
    submitLocal(lab, '<38>Oct 19 12:00:00 ubuntu sshd[12]: Accepted password');
    submitLocal(lab, MSG('hello'));
    expect(read(host, '/var/log/auth.log')).toEqual(['Oct 19 12:00:00 ubuntu sshd[12]: Accepted password']);
    expect(read(host, '/var/log/syslog')).toEqual(['Oct 19 12:00:01 ubuntu alice: hello']);
  });

  it('reports an unknown module the way rsyslogd -N1 does', () => {
    const { lab } = single('module(load="imfoo")\n*.* /var/log/x.log');
    expect(lab.loader.log.lines()[0]).toBe(
      "rsyslogd: could not load module 'imfoo', errors: trying to load module /usr/lib/x86_64-linux-gnu/rsyslog/imfoo.so: /usr/lib/x86_64-linux-gnu/rsyslog/imfoo.so: cannot open shared object file: No such file or directory [v8.2610.0 try https://www.rsyslog.com/e/2066 ]",
    );
  });

  it('reports a config without any action', () => {
    const { lab } = single('module(load="imudp")');
    expect(lab.loader.log.lines()).toContain(
      'rsyslogd: there are no active actions configured. Inputs would run, but no output whatsoever were created. [v8.2610.0 try https://www.rsyslog.com/e/2103 ]',
    );
  });

  it('reports a missing include file and an unknown legacy directive', () => {
    const { lab } = single('$IncludeConfig /etc/none.conf\n$NoSuchDirective on\n*.* /var/log/x.log');
    const messages = lab.loader.log.lines().join('\n');
    expect(messages).toContain('invalid or yet-unknown config file command');
  });
});

describe('ruleset execution', () => {
  it('stop ends the ruleset, including the callers of a called ruleset', () => {
    const { host, lab } = single(`
ruleset(name="inner") { if $msg contains "drop" then stop }
*.* call inner
*.* /var/log/after.log
`);
    submitLocal(lab, MSG('keep'));
    submitLocal(lab, MSG('drop'));
    expect(read(host, '/var/log/after.log').filter((entry) => entry.includes('keep'))).toHaveLength(1);
    expect(read(host, '/var/log/after.log').filter((entry) => entry.includes('drop'))).toHaveLength(0);
  });

  it('the legacy ~ selector is a deprecated stop and says so', () => {
    const { host, lab } = single('*.* ~\n*.* /var/log/never.log');
    submitLocal(lab, MSG('x'));
    expect(host.fileSystem.has('/var/log/never.log')).toBe(false);
    expect(lab.loader.log.lines()).toContain("rsyslogd: warning: ~ action is deprecated, consider using the 'stop' statement instead [v8.2610.0 try https://www.rsyslog.com/e/2307 ]");
  });

  it('omusrmsg writes to the terminals of the named user and * reaches everybody', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    const aliceScreen: string[] = [];
    const rootScreen: string[] = [];
    host.terminals.set('alice', [{ write: (text) => aliceScreen.push(text) }]);
    host.terminals.set('root', [{ write: (text) => rootScreen.push(text) }]);
    const lab = startRsyslog(host, '*.err :omusrmsg:alice\n*.emerg :omusrmsg:*');
    submitLocal(lab, MSG('plain', 11));
    submitLocal(lab, MSG('panic', 8));
    expect(aliceScreen).toHaveLength(3);
    expect(rootScreen).toHaveLength(1);
    expect(rootScreen[0]).toContain('panic');
  });
});

describe('internal messages', () => {
  it('go to the local syslog() by default, with the severity filter at warning-and-above', () => {
    const { host, lab } = single('*.* /var/log/x.log');
    lab.engine.internal(3, -2027, 'an error');
    lab.engine.internal(6, -1, 'an information');
    lab.engine.internal(7, -1, 'debug chatter');
    expect(host.libcSyslog.map((entry) => [entry.priority, entry.message])).toEqual([[43, 'an error'], [46, 'an information']]);
  });

  it('internalmsg.severity widens the filter', () => {
    const { host, lab } = single('global(internalmsg.severity="debug")\n*.* /var/log/x.log');
    lab.engine.internal(7, -1, 'debug chatter');
    expect(libc(host)).toEqual(['debug chatter']);
  });

  it('processInternalMessages submits them to the rulesets, tagged rsyslogd-<code>:', () => {
    const { host, lab } = single('global(processInternalMessages="on")\n$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n*.* /var/log/x.log');
    lab.engine.internal(3, -2027, 'an error');
    lab.engine.internal(6, -1, 'an information');
    expect(read(host, '/var/log/x.log')).toEqual(['Oct 19 12:00:00 ubuntu rsyslogd-2027: an error', 'Oct 19 12:00:00 ubuntu rsyslogd: an information']);
    expect(libc(host)).toEqual([]);
  });

  it('are rate limited per interval/burst of internalmsg.ratelimit on the simulated clock', () => {
    const { host, lab } = single('global(internalmsg.ratelimit.interval="10" internalmsg.ratelimit.burst="2")\n*.* /var/log/x.log');
    for (let count = 0; count < 5; count++) lab.engine.internal(3, -1, `error ${count}`);
    expect(libc(host).filter((text) => text.startsWith('error '))).toEqual(['error 0', 'error 1']);
    host.advance(11_000);
    lab.engine.internal(3, -1, 'error later');
    expect(libc(host).some((text) => text === 'error later')).toBe(true);
    expect(libc(host).some((text) => text.includes('messages lost due to rate-limiting'))).toBe(true);
  });
});

describe('action state machine on the simulated clock', () => {
  const flaky = (config: string): { host: LabHost; lab: ReturnType<typeof startRsyslog>; target: FlakyOutput } => {
    const target = new FlakyOutput();
    const host = new LabHost('10.0.0.1', new LabNetwork());
    const lab = startRsyslog(host, `module(load="omflaky")\n${config}`, { catalog: catalogWith(flakyModule(target)) });
    return { host, lab, target };
  };

  it('suspends when delivery fails, drops while suspended, resumes after action.resumeInterval and reports both transitions', () => {
    const { host, lab, target } = flaky('*.* action(type="omflaky")');
    submitLocal(lab, MSG('one'));
    expect(libc(host).some((text) => text.startsWith("action 'action-0-omflaky' suspended (module 'omflaky'), next retry is Mon Oct 19 12:00:30 2026, retry nbr 0."))).toBe(true);
    target.up = true;
    submitLocal(lab, MSG('two'));
    expect(target.delivered).toEqual([]);
    host.advance(31_000);
    submitLocal(lab, MSG('three'));
    expect(target.delivered).toEqual(['Oct 19 12:00:01 ubuntu alice: three']);
    expect(libc(host)).toContain("action 'action-0-omflaky' resumed (module 'omflaky') [v8.2610.0 try https://www.rsyslog.com/e/2359 ]");
  });

  it('the suspension lengthens by one resume interval after every ten failed retries in a row', () => {
    const { host, lab } = flaky('*.* action(type="omflaky" action.resumeInterval="10" action.reportSuspensionContinuation="on")');
    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      submitLocal(lab, MSG(`m${attempt}`));
      const last = libc(host).filter((text) => text.includes('next retry is')).pop() ?? '';
      const match = /next retry is (.*?), retry nbr (\d+)/.exec(last);
      const retryAt = Date.parse(`${(match as RegExpExecArray)[1]} UTC`);
      delays.push((retryAt - host.clock.wallMs()) / 1000);
      host.advance(retryAt - host.clock.wallMs() + 1_000);
    }
    expect(delays.slice(0, 10).every((delay) => delay === 10)).toBe(true);
    expect(delays[10]).toBe(20);
  });

  it('action.resumeRetryCount=-1 keeps retrying on its own timer until the target comes back', () => {
    const { host, lab, target } = flaky('*.* action(type="omflaky" action.resumeRetryCount="-1" action.resumeInterval="5")');
    submitLocal(lab, MSG('patient'));
    expect(target.delivered).toEqual([]);
    target.up = true;
    host.advance(5_000);
    expect(target.delivered).toEqual(['Oct 19 12:00:01 ubuntu alice: patient']);
  });

  it('an action queue holds the messages of a suspended action and delivers them in order once it resumes', () => {
    const { host, lab, target } = flaky('*.* action(type="omflaky" queue.type="LinkedList" queue.size="100" action.resumeRetryCount="-1" action.resumeInterval="10")');
    submitLocal(lab, MSG('first'));
    submitLocal(lab, MSG('second'));
    target.up = true;
    expect(target.delivered).toEqual([]);
    host.advance(10_000);
    expect(target.delivered.map((entry) => entry.split(': ')[1])).toEqual(['first', 'second']);
  });

  it('queue.dequeueTimeBegin/End hold messages until the local hour window opens', () => {
    const { host, lab } = single('*.* action(type="omfile" file="/var/log/night.log" queue.type="LinkedList" queue.size="100" queue.dequeueTimeBegin="22" queue.dequeueTimeEnd="23")');
    submitLocal(lab, MSG('queued at noon'));
    expect(host.fileSystem.has('/var/log/night.log')).toBe(false);
    host.advance(9 * 3600_000);
    expect(host.fileSystem.has('/var/log/night.log')).toBe(false);
    host.advance(1 * 3600_000 + 1_000);
    expect(read(host, '/var/log/night.log')).toHaveLength(1);
  });

  it('queue.dequeueSlowdown makes the worker sleep after each batch, in simulated microseconds', () => {
    const { host, lab } = single('*.* action(type="omfile" file="/var/log/slow.log" queue.type="LinkedList" queue.size="100" queue.dequeueSlowdown="2000000")');
    for (const word of ['a', 'b', 'c']) submitLocal(lab, MSG(word));
    expect(read(host, '/var/log/slow.log')).toHaveLength(1);
    host.advance(1_999);
    expect(read(host, '/var/log/slow.log')).toHaveLength(1);
    host.advance(1);
    expect(read(host, '/var/log/slow.log')).toHaveLength(3);
    submitLocal(lab, MSG('d'));
    expect(read(host, '/var/log/slow.log')).toHaveLength(3);
    host.advance(2_000);
    expect(read(host, '/var/log/slow.log')).toHaveLength(4);
  });

  it('action.execOnlyOnceEveryInterval swallows repeats inside the window and lets the next through after it', () => {
    const { host, lab } = single('*.* action(type="omfile" file="/var/log/once.log" action.execOnlyOnceEveryInterval="60")');
    submitLocal(lab, MSG('a'));
    submitLocal(lab, MSG('b'));
    host.advance(61_000);
    submitLocal(lab, MSG('c'));
    expect(read(host, '/var/log/once.log').map((entry) => entry.split(': ')[1])).toEqual(['a', 'c']);
  });

  it('action.execOnlyEveryNthTime with a timeout restarts the count after the timeout', () => {
    const { host, lab } = single('*.* action(type="omfile" file="/var/log/nth.log" action.execOnlyEveryNthTime="3" action.execOnlyEveryNthTimeTimeout="30")');
    for (const word of ['a', 'b', 'c', 'd']) submitLocal(lab, MSG(word));
    expect(read(host, '/var/log/nth.log')).toHaveLength(1);
    host.advance(31_000);
    submitLocal(lab, MSG('e'));
    submitLocal(lab, MSG('f'));
    submitLocal(lab, MSG('g'));
    expect(read(host, '/var/log/nth.log')).toHaveLength(2);
  });

  it('omfile reports an open failure and suspends, but its empty tryResume resumes it at once (it has no retry timer of its own)', () => {
    const { host, lab } = single('*.* action(type="omfile" file="/var/missing/out.log" createDirs="off")');
    submitLocal(lab, MSG('one'));
    expect(libc(host)[0]).toBe("omfile: open file '/var/missing/out.log' failed: No such file or directory [v8.2610.0 try https://www.rsyslog.com/e/2207 ]");
    expect(libc(host).some((text) => text.startsWith("action 'action-0-builtin:omfile' suspended (module 'builtin:omfile'), retry 0."))).toBe(true);
    expect(libc(host).some((text) => text.startsWith("action 'action-0-builtin:omfile' resumed"))).toBe(true);
  });
});

describe('repeated message reduction', () => {
  it('collapses identical messages into "message repeated N times" when the sequence breaks', () => {
    const { host, lab } = single('$RepeatedMsgReduction on\n$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n*.* /var/log/x.log');
    for (let count = 0; count < 4; count++) submitLocal(lab, MSG('same'));
    submitLocal(lab, MSG('different'));
    expect(read(host, '/var/log/x.log')).toEqual([
      'Oct 19 12:00:01 ubuntu alice: same',
      'Oct 19 12:00:01 ubuntu alice: message repeated 3 times: [ same]',
      'Oct 19 12:00:01 ubuntu alice: different',
    ]);
  });
});

describe('dynamic file names and descriptor lifetime', () => {
  it('closes an idle dynamic file after closeTimeout minutes of simulated time', () => {
    const { host, lab } = single('template(name="dyn" type="string" string="/var/log/%programname%.log")\n*.* action(type="omfile" dynaFile="dyn" closeTimeout="1")');
    submitLocal(lab, MSG('x'));
    expect(host.fileSystem.has('/var/log/alice.log')).toBe(true);
    host.advance(3 * 60_000);
    expect(lab.engine.actionRuntimes()).toHaveLength(1);
  });
});
