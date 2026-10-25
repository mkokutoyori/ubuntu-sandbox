/**
 * Probe — action.externalstate.file and action.errorfile of rsyslog 8.2608.0 (runtime/action.c checkExternalStateFile,
 * actionDoRetry_extFile, actionWriteErrorFile).
 *
 * The external state file is read before each message reaches the action: a first line "SUSPENDED" (trailing blanks
 * ignored) suspends it with the warning of the source, and with action.resumeRetryCount="-1" the action waits, one
 * resumeInterval at a time, until the file says anything else ("resumed ... via external state file"). With the default
 * retry count the retries are exhausted at once, the action is suspended and - as in the source, which goes on to
 * beginTransaction() after actionDoRetry_extFile() - the message is still processed.
 * The error file receives one JSON line per message that the action could not process: a hard failure inside a
 * transaction of several messages (a lone failing message is only logged), or a message that arrives while the action is
 * suspended. Every such message is counted in "failed", with or without an error file.
 *
 * Measured against the preceding commit (git stash of src/network): 6 of the 9 cases fall - both parameters were stored and
 * never read, a message that arrived while the action was suspended was dropped without trace, and "failed" was
 * incremented for each lost message at once. The 3 that pass in both states are the WITNESS (an action with neither
 * parameter writes what it receives), the file that does not say SUSPENDED (ignoring it is also what the old code did) and
 * the transaction of several failing messages (the old code counted every one of them, which is right there).
 * The commit phase itself (a failed transaction replayed message by message) is probed in rsyslog-action-commit.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const STATS = 'module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\n';
const TEMPLATE = 'template(name="probe" type="string" string="%msg%\\n")\n';
const STATE = '/var/run/out.state';

function rig(config: string, files: Record<string, string> = {}): { host: LabHost; lab: LabEngine } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config, { files }) };
}

const written = (host: LabHost, path = '/var/log/x.log'): string[] => lines(host.fileSystem.get(path) ?? null).map((line) => line.trim());
const internal = (lab: LabEngine): string => lab.internalMessages.map((entry) => entry.text).join('\n');
const actionLine = (host: LabHost): string => lines(host.fileSystem.get('/var/log/stats.log') ?? null).map((line) => line.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d+: /, '')).filter((line) => line.startsWith('out: '))[0];
const action = (extra: string): string => `${TEMPLATE}${STATS}action(type="omfile" name="out" file="/var/log/x.log" template="probe" ${extra})\n`;

describe('action.externalstate.file', () => {
  it('witness: without the parameter an action writes what it receives', () => {
    const { host, lab } = rig(action(''));
    submitLocal(lab, MSG('one'));
    expect(written(host)).toEqual(['one']);
  });

  it('holds the message while the file says SUSPENDED and releases it when the file changes', () => {
    const { host, lab } = rig(action(`action.externalstate.file="${STATE}" action.resumeRetryCount="-1" action.resumeInterval="2"`), { [STATE]: 'SUSPENDED  \n' });
    submitLocal(lab, MSG('held'));
    host.advance(5_000);
    expect(written(host)).toEqual([]);
    expect(internal(lab)).toContain("action 'out' suspended (module 'builtin:omfile') by external state file");
    host.fileSystem.set(STATE, 'RUNNING\n');
    host.advance(3_000);
    expect(written(host)).toEqual(['held']);
    expect(internal(lab)).toContain("action 'out' resumed (module 'builtin:omfile') via external state file");
  });

  it('with the default retry count the action is suspended at once and the message is processed anyway', () => {
    const { host, lab } = rig(action(`action.externalstate.file="${STATE}"`), { [STATE]: 'SUSPENDED' });
    submitLocal(lab, MSG('through'));
    expect(written(host)).toEqual(['through']);
    expect(internal(lab)).toMatch(/action 'out' suspended \(module 'builtin:omfile'\), next retry is /);
  });

  it('ignores a file that does not say SUSPENDED, is empty, or is missing', () => {
    for (const content of ['RUNNING', 'suspended', '', null]) {
      const { host, lab } = rig(action(`action.externalstate.file="${STATE}" action.resumeRetryCount="-1"`), content === null ? {} : { [STATE]: content });
      submitLocal(lab, MSG('free'));
      expect(written(host)).toEqual(['free']);
    }
  });
});

describe('action.errorfile and the failed counter', () => {
  const unwritable = (extra: string): string => action(`createDirs="off" action.resumeRetryCount="0" action.resumeInterval="100" ${extra}`).replace('file="/var/log/x.log"', 'file="/no/such/x.log"');
  const flood = (lab: LabEngine, count: number): void => {
    for (let index = 0; index < count; index++) submitLocal(lab, MSG(`message number ${index}`));
  };

  it('a message that arrives while the action is suspended goes to the error file as one JSON line and is counted', () => {
    const { host, lab } = rig(unwritable('action.errorfile="/var/log/err.json"'));
    flood(lab, 25);
    const entries = written(host, '/var/log/err.json');
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]).toMatch(/^\{ "action": "out", "status": -2007, "template0": "\s*message number 0\\n" \}$/);
    expect(entries[1]).toMatch(/^\{ "action": "out", "status": 0, "template0": "\s*message number \d+\\n" \}$/);
    host.advance(60_000);
    expect(actionLine(host)).toContain(`failed=${entries.length} `);
  });

  it('counts a lost message as failed even when no error file is configured', () => {
    const { host, lab } = rig(unwritable(''));
    flood(lab, 25);
    host.advance(60_000);
    expect(actionLine(host)).not.toContain('failed=0 ');
    expect(host.fileSystem.has('/var/log/err.json')).toBe(false);
  });

  it('cuts a line that would pass action.errorfile.maxsize and keeps the newline', () => {
    const { host, lab } = rig(unwritable('action.errorfile="/var/log/err.json" action.errorfile.maxsize="70"'));
    flood(lab, 25);
    const content = host.fileSystem.get('/var/log/err.json') ?? '';
    expect(content.length).toBe(70);
    expect(content.endsWith('\n')).toBe(true);
  });

  const channel = (queue: string): string =>
    `$outchannel chan,/var/log/x.log,20,\n${TEMPLATE}${STATS}${queue}*.* :omfile:$chan;probe\n`;
  const lastLine = (host: LabHost): string => lines(host.fileSystem.get('/var/log/stats.log') ?? null).filter((line) => line.includes('action-0-builtin:omfile: '))[0] ?? '';

  it('a hard failure alone in its transaction is logged with the code of the module but neither written nor counted', () => {
    const { host, lab } = rig(channel(''));
    flood(lab, 6);
    host.advance(60_000);
    expect(internal(lab)).toContain("action 'action-0-builtin:omfile' (module 'builtin:omfile') message lost, could not be processed.");
    expect(internal(lab)).toContain('https://www.rsyslog.com/e/2127');
    expect(lastLine(host)).toContain(' failed=0 ');
  });

  it('hard failures in a transaction of several messages are counted, one per message', () => {
    const { host, lab } = rig(channel('$ActionQueueType LinkedList\n$ActionQueueDequeueBatchSize 8\n$ActionQueueDequeueSlowdown 1000000\n'));
    flood(lab, 6);
    host.advance(5_000);
    flood(lab, 6);
    host.advance(60_000);
    expect(lastLine(host)).toContain(' failed=5 ');
  });
});
