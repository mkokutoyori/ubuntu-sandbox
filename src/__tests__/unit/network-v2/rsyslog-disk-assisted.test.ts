/*
 * Probe - src/network/rsyslog/engine/Queue.ts and Engine.ts, ported from runtime/queue.c (qqueueChkIsDA, StartDA,
 * qqueueAdviseMaxWorkers, ConsumerDA, qqueueChkStopWrkrDA, qqueueSaveOnShutdown) and runtime/queue.c
 * (qqueueCorrectParams): a memory queue with queue.fileName is disk-assisted. Its child disk queue, named "<queue>[DA]",
 * exists from the start; when the number of waiting messages reaches queue.highWatermark the DA worker moves them to the
 * child, batch after batch, until the queue holds no more than queue.lowWatermark; the child delivers to the same action
 * with its own workers; at shutdown the child persists its backlog and, with saveOnShutdown, receives the memory part too.
 * Measured against the previous commit: 7 of the 9 cases fall - the watermarks were read and ignored, so no spill file
 * existed before shutdown, the child queue had no statistics object and no existence, and a lowered watermark changed
 * nothing. The two that pass either way: the WITNESS (a queue below its high watermark creates no file) and the restart
 * case (the previous JSON state also carried the whole backlog across a restart - a non-regression check of the new format).
 * Time is the simulated clock; none of these cases waits for real time.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const SPOOL = '/var/spool/rsyslog';
const HEAD = `template(name="probe" type="string" string="%msg%\\n")\nglobal(workDirectory="${SPOOL}")\n`;
const stuck = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" action.resumeRetryCount="-1" action.resumeInterval="30" queue.type="LinkedList" ${queue})\n`;
const healthy = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/var/log/x.log" template="probe" action.resumeRetryCount="-1" queue.type="LinkedList" ${queue})\n`;
const MARKS = 'queue.size="100" queue.highWatermark="10" queue.lowWatermark="4" queue.diskQueueType="disk"';

function lab(config: string, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  host.directories.add(SPOOL);
  return { host, engine: startRsyslog(host, config) };
}

function submit(engine: LabEngine, count: number, from = 1): void {
  for (let n = from; n < from + count; n++) submitLocal(engine, MSG(`m${n}`));
}

const spool = (host: LabHost): string[] => [...host.fileSystem.keys()].filter((path) => path.startsWith(`${SPOOL}/`)).map((path) => path.slice(SPOOL.length + 1)).sort();
const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());
const records = (host: LabHost, file: string): number => ((host.fileSystem.get(`${SPOOL}/${file}`) ?? '').match(/<Obj:1:msg:1:/g) ?? []).length;

describe('disk-assisted queue', () => {
  it('witness: below the high watermark nothing reaches the disk', () => {
    const { host, engine } = lab(stuck(`${MARKS} queue.filename="daq"`));
    submit(engine, 10);
    expect(spool(host)).toEqual([]);
  });

  it('witness: a queue without a file name has no disk child', () => {
    const { engine } = lab(stuck(MARKS));
    expect(engine.engine.mainQueue.assist).toBeNull();
    expect(engine.engine.actionRuntimes()).toHaveLength(1);
  });

  it('spills the waiting messages to the child when the high watermark is reached', () => {
    const { host, engine } = lab(stuck(`${MARKS} queue.filename="daq"`));
    submit(engine, 11);
    expect(spool(host)).toEqual(['daq.00000001']);
    expect(records(host, 'daq.00000001')).toBe(10);
  });

  it('keeps spilling in later waves once the memory queue has filled up again', () => {
    const { host, engine } = lab(stuck(`${MARKS} queue.filename="daq"`));
    submit(engine, 11);
    submit(engine, 10, 12);
    expect(records(host, 'daq.00000001')).toBe(20);
  });

  it('the child delivers to the same action: a healthy but slowed-down action receives the spilled messages', () => {
    const { host, engine } = lab(healthy(`${MARKS} queue.filename="daq" queue.dequeueSlowdown="10000000"`));
    submit(engine, 14);
    expect(written(host).length).toBeGreaterThan(1);
    host.advance(60_000);
    expect(written(host).slice().sort()).toEqual(Array.from({ length: 14 }, (_, index) => `m${index + 1}`).sort());
    expect(spool(host)).toEqual(['daq.00000001']);
    engine.engine.stop();
    expect(spool(host)).toEqual([]);
  });

  it('gives the child its own statistics object, named after the queue and created before it', () => {
    const { host, engine } = lab(`${stuck(`${MARKS} queue.filename="daq"`)}module(load="impstats" interval="60" log.file="/var/log/stats.log")\n`);
    submit(engine, 3);
    host.advance(60_000);
    const stats = lines(host.fileSystem.get('/var/log/stats.log') ?? null);
    const child = stats.findIndex((line) => line.includes(': out queue[DA]: origin=core.queue '));
    const parent = stats.findIndex((line) => line.includes(': out queue: origin=core.queue '));
    expect(child).toBeGreaterThanOrEqual(0);
    expect(child).toBeLessThan(parent);
  });

  it('saves the memory part into the child at shutdown, then delivers everything after the restart', () => {
    const first = lab(stuck(`${MARKS} queue.filename="daq"`));
    submit(first.engine, 14);
    first.engine.engine.stop();
    expect(records(first.host, 'daq.00000001')).toBe(14);
    expect(first.host.fileSystem.has(`${SPOOL}/daq.qi`)).toBe(true);
    const second = lab(healthy(`${MARKS} queue.filename="daq"`), first.host);
    second.host.advance(60_000);
    expect(written(second.host).slice().sort()).toEqual(Array.from({ length: 14 }, (_, index) => `m${index + 1}`).sort());
    expect(second.engine.internalMessages.map((entry) => entry.text).join('\n')).toContain('queue files exist on disk, re-starting with 14 messages');
  });

  it('with saveOnShutdown off the memory part is lost but what already went to disk stays', () => {
    const first = lab(stuck(`${MARKS} queue.filename="daq" queue.saveOnShutdown="off"`));
    submit(first.engine, 14);
    first.engine.engine.stop();
    expect(records(first.host, 'daq.00000001')).toBe(10);
    const second = lab(healthy(`${MARKS} queue.filename="daq" queue.saveOnShutdown="off"`), first.host);
    second.host.advance(60_000);
    expect(written(second.host)).toHaveLength(10);
  });

  it('a low watermark above the high one is corrected with the source wording', () => {
    const { engine } = lab(stuck('queue.size="100" queue.highWatermark="10" queue.lowWatermark="50" queue.filename="daq"'));
    const text = engine.loader.log.lines().join('\n');
    expect(text).toContain('queue.lowWaterMark is invalid (must be between 2 and highWaterMark). It has been automatically adjusted to 7.');
  });
});
