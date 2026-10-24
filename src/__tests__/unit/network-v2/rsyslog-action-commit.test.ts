/**
 * Probe — the commit phase of rsyslog 8.2610 (runtime/action.c actionCommit, actionTryCommit,
 * actionTryRemoveHardErrorsFromBatch, actionWriteErrorFile, omfile.c and omfwd.c commitTransaction).
 *
 * A transactional action (omfile, omfwd) does not run once per message: the messages of a dequeued batch are collected
 * and handed to the module together when the batch ends. If that attempt fails and the batch holds several messages,
 * every message is committed again alone - so the ones the module had already written are written a second time - and
 * only the messages that still fail are logged and written to action.errorfile, with the status of the action state
 * (RS_RET_DATAFAIL), not the code the module logged. A lone failing message is logged only. The retry loop of the commit
 * waits on the simulated clock while the messages stay on the queue.
 *
 * Measured against the preceding commit (git stash of src/network): 7 of the 10 cases fall - the transaction was never
 * replayed (no duplicate lines, one "message lost" per failing message, the error file carried the module code -2125 and
 * "failed" was one short), omfile's tryResume was not the always-OK of the source (the first message went to the error
 * file with status 0 instead of -2007 after ten resumptions), and omfwd had no beginTransaction. The 3 that pass in both
 * states are WITNESSES from the same lab: a healthy action with the same batches writes every message once (the lab
 * itself is sound), a lone failing message is logged and not written to the error file, and a commit that waits for a
 * blocked file delivers the message once after the file appears (the queue keeps the batch while the commit sleeps).
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const TEMPLATE = 'template(name="probe" type="string" string="%msg%\\n")\n';
const STATS = 'module(load="impstats" interval="60" log.syslog="off" log.file="/var/log/stats.log")\n';
const BATCHES = 'queue.type="LinkedList" queue.dequeueBatchSize="8" queue.dequeueSlowdown="1000000"';
const ERRORS = 'action.errorfile="/var/log/err.json"';

function run(action: string, files: Record<string, string> = {}): { host: LabHost; lab: LabEngine } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  const lab = startRsyslog(host, `${TEMPLATE}${STATS}${action}\n`, { files });
  for (let index = 0; index < 5; index++) submitLocal(lab, MSG(`m${index}`));
  host.advance(5_000);
  for (let index = 5; index < 9; index++) submitLocal(lab, MSG(`m${index}`));
  host.advance(70_000);
  return { host, lab };
}

const written = (host: LabHost, path = '/var/log/x.log'): string[] => lines(host.fileSystem.get(path) ?? null).map((line) => line.trim());
const internal = (lab: LabEngine): string[] => lab.internalMessages.map((entry) => entry.text);
const statLine = (host: LabHost): string => lines(host.fileSystem.get('/var/log/stats.log') ?? null).filter((line) => line.includes(': out: '))[0] ?? '';
const entries = (host: LabHost): Array<{ status: number; template0: string }> => written(host, '/var/log/err.json').map((line) => JSON.parse(line) as { status: number; template0: string });

const failing = `action(type="omfile" name="out" file="/var/log/x.log" template="probe" rotation.sizeLimit="10" ioBufferSize="4" ${ERRORS} ${BATCHES})`;
const healthy = `action(type="omfile" name="out" file="/var/log/x.log" template="probe" ${ERRORS} ${BATCHES})`;

describe('a transaction that fails is committed again message by message', () => {
  it('witness: with the same batches a healthy action writes every message once and nothing reaches the error file', () => {
    const { host } = run(healthy);
    expect(written(host)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    expect(host.fileSystem.has('/var/log/err.json')).toBe(false);
    expect(statLine(host)).toContain(' failed=0 ');
  });

  it('the messages the module had written before the failure are written again by the replay', () => {
    const { host } = run(failing);
    expect(written(host)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm6', 'm7', 'm8']);
  });

  it('each message that still fails is written to the error file with the status of the action state, not the code of the module', () => {
    const { host } = run(failing);
    expect(entries(host).map((entry) => entry.template0.trim())).toEqual(['m1', 'm2', 'm3', 'm4', 'm6', 'm7', 'm8']);
    expect(new Set(entries(host).map((entry) => entry.status))).toEqual(new Set([-2218]));
  });

  it('"message lost" is logged once for the transaction and once for every replayed message that fails', () => {
    const { lab } = run(failing);
    const lost = internal(lab).filter((text) => text.includes('message lost, could not be processed'));
    expect(lost).toHaveLength(1 + 4 + 1 + 1 + 3);
    expect(lost.every((text) => text.includes('https://www.rsyslog.com/e/2125'))).toBe(true);
  });

  it('witness: a message that fails alone in its transaction is logged and neither replayed nor written to the error file', () => {
    const { host } = run(failing);
    expect(entries(host).map((entry) => entry.template0.trim())).not.toContain('m5');
    expect(written(host).filter((line) => line === 'm5')).toHaveLength(1);
  });

  it('"failed" counts one per replayed message that still fails', () => {
    const { host } = run(failing);
    expect(statLine(host)).toContain(' failed=7 ');
  });
});

describe('an action that is suspended', () => {
  const blocked = (retry: string): string =>
    `action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" ${retry} action.resumeInterval="100" ${ERRORS} ${BATCHES})`;

  it('omfile resumes at once, as its tryResume of the source does, until the guard of ten resumptions suspends it', () => {
    const { host, lab } = run(blocked('action.resumeRetryCount="0"'));
    expect(internal(lab).filter((text) => text.includes("action 'out' resumed"))).toHaveLength(9);
    expect(statLine(host)).toContain(' resumed=9 ');
  });

  it('the message that exhausted the retries goes to the error file with the status of the suspension, the next one with status 0', () => {
    const { host } = run(blocked('action.resumeRetryCount="0"'));
    expect(entries(host).slice(0, 2).map((entry) => [entry.status, entry.template0.trim()])).toEqual([[-2007, 'm0'], [0, 'm1']]);
  });

  it('witness: a commit that waits for a blocked file delivers the message once when the file appears', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    const lab = startRsyslog(host, `${TEMPLATE}${blocked('action.resumeRetryCount="-1"').replace('action.resumeInterval="100"', 'action.resumeInterval="30"')}\n`);
    submitLocal(lab, MSG('patient'));
    host.advance(10_000);
    expect(written(host, '/no/such/x.log')).toEqual([]);
    host.directories.add('/no/such');
    host.advance(40_000);
    expect(written(host, '/no/such/x.log')).toEqual(['patient']);
  });
});

describe('omfwd begins its transaction by resuming the pool', () => {
  it('a pool without a working target is reported at the start of the transaction, as omfwd.c beginTransaction does', () => {
    const { lab } = run(`action(type="omfwd" name="out" target="10.0.0.9" port="514" protocol="tcp" template="probe" action.resumeRetryCount="0" action.resumeInterval="100" ${BATCHES})`);
    expect(internal(lab).some((text) => text.includes('no working target servers in pool available, suspending action (state: beginTx)'))).toBe(true);
  });
});
