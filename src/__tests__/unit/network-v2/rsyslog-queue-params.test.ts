/*
 * Probe - src/network/rsyslog/engine/QueueParams.ts and Queue.ts, ported from runtime/queue.c (qqueueApplyCnfParam,
 * qqueueCorrectParams, qqueueAdviseMaxWorkers, DequeueForConsumer, doEnqSingleObjContext, qqueueAdd): the queue
 * parameters are checked and corrected with the source's own words, an action queue is direct unless queue.type says
 * otherwise, the sampling interval drops all but every Nth message, queue.minDequeueBatchSize makes the worker wait for
 * a full batch, queue.workerThreads/workerThreadMinimumMessages run several workers, and the delay marks hold back the
 * producers of delayable inputs (light: one second at most, full: until the queue has room).
 * Measured against the previous commit: 15 of the 21 cases fall - none of these parameters existed (they were accepted
 * and never read, or refused as unknown), an action queue with a size alone silently became a linked list, and the
 * discard mark and the high/low watermarks kept hard-coded defaults. The six that pass either way are WITNESSES built in
 * the same lab: a sane queue gets no message, a direct queue without parameters gets none, and a queue without sampling,
 * without minimum batch, with one worker or without delay marks behaves as the engine always did.
 * Time is the simulated clock; none of these cases waits for real time.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const HEAD = 'template(name="probe" type="string" string="%msg%\\n")\n';
const action = (queue: string, file = '/var/log/x.log'): string => `action(type="omfile" name="out" file="${file}" template="probe" ${queue})\n`;

function lab(config: string): { host: LabHost; engine: LabEngine; log: string } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  host.directories.add('/var/spool/rsyslog');
  const engine = startRsyslog(host, `${HEAD}global(workDirectory="/var/spool/rsyslog")\n${config}`);
  return { host, engine, log: engine.loader.log.lines().join('\n') };
}

const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());

describe('queue parameter checks', () => {
  it('witness: a sane queue produces no queue message', () => {
    expect(lab(action('queue.type="LinkedList" queue.size="10000"')).log).not.toContain('queue');
  });

  it('witness: a direct queue without parameters produces none either', () => {
    expect(lab(action('')).log).not.toContain('direct mode');
  });

  it('a very small queue.size gets the advisory note', () => {
    expect(lab(action('queue.type="LinkedList" queue.size="50"')).log)
      .toContain('Note: queue.size="50" is very low and can lead to unpredictable results. See also https://www.rsyslog.com/lower-bound-for-queue-sizes/');
  });

  it('a high watermark below 60% of the size is questioned', () => {
    expect(lab(action('queue.type="LinkedList" queue.size="1000" queue.highWatermark="100"')).log)
      .toMatch(/queue "out queue": high water mark is set quite low at 100\. You should only set it below 60% \(600\) if you have a good reason for this\./);
  });

  it('a high watermark above the size is corrected to 90% of the size', () => {
    expect(lab(action('queue.type="LinkedList" queue.size="1000" queue.highWatermark="5000"')).log)
      .toContain('queue.highWaterMark is invalid (must be between 2 and queue size). It has been automatically adjusted to 900.');
  });

  it('a discard mark above the size is an error and one below 80% a warning', () => {
    expect(lab(action('queue.type="LinkedList" queue.size="1000" queue.discardMark="2000"')).log)
      .toContain('queue.discardMark 2000 is set larger than queue.size');
    expect(lab(action('queue.type="LinkedList" queue.size="1000" queue.discardMark="500"')).log)
      .toContain('queue.discardMark is set quite low at 500. You should only set it below 80% (800) if you have a good reason for this.');
  });

  it('an action queue is direct unless queue.type says otherwise, and says that the other parameters are ignored', () => {
    expect(lab(action('queue.size="2000"')).log)
      .toMatch(/warning on queue 'out queue': queue is in direct mode, but parameters have been set\. These PARAMETERS cannot be applied and WILL BE IGNORED\./);
  });

  it('a spool directory is refused when empty and loses its trailing slash', () => {
    expect(lab(action('queue.type="LinkedList" queue.filename="a" queue.spoolDirectory=""')).log).toContain('queue.spooldirectory must not be empty');
    expect(lab(action('queue.type="LinkedList" queue.filename="a" queue.spoolDirectory="/var/spool/other/"')).log)
      .toContain("queue.spooldirectory must not end with '/', corrected to '/var/spool/other'");
  });

  it('two queues cannot share a directory and a file name prefix', () => {
    const log = lab(`${action('queue.type="Disk" queue.filename="same"', '/var/log/a.log')}${action('queue.type="Disk" queue.filename="same"', '/var/log/b.log')}`).log;
    expect(log).toContain("queue directory '/var/spool/rsyslog' and file name prefix 'same' already used. This is not possible. Please make it unique.");
  });

  it('a very large queue.size is questioned and one beyond the maximum is corrected', () => {
    expect(lab(action('queue.type="LinkedList" queue.size="600000"')).log)
      .toContain('queue.size=600000 is very large - is this really intended? More info at https://www.rsyslog.com/avoid-overly-large-in-memory-queues/');
    expect(lab(action('queue.type="LinkedList" queue.size="3000000000"')).log).toContain('queue.size higher than maximum (2147483647) - corrected to maximum');
  });

  it('invalid disk queue engine settings are reported', () => {
    const log = lab(action('queue.type="LinkedList" queue.filename="a" queue.diskQueueType="floppy" queue.onCorruption="shrug"')).log;
    expect(log).toContain("queue.diskQueueType: invalid value 'floppy'; using 'auto'");
    expect(log).toContain("queue.oncorruption: invalid value 'shrug', using 'safe'");
  });
});

describe('queue behaviour parameters', () => {
  it('queue.samplingInterval keeps every Nth message', () => {
    const { host, engine } = lab(action('queue.type="LinkedList" queue.size="1000" queue.samplingInterval="2" queue.dequeueSlowdown="1000000"'));
    for (const word of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) submitLocal(engine, MSG(word));
    host.advance(10_000);
    expect(written(host)).toEqual(['m2', 'm4', 'm6']);
  });

  it('witness: without sampling every message is kept', () => {
    const { host, engine } = lab(action('queue.type="LinkedList" queue.size="1000"'));
    for (const word of ['m1', 'm2', 'm3']) submitLocal(engine, MSG(word));
    expect(written(host)).toEqual(['m1', 'm2', 'm3']);
  });

  it('queue.minDequeueBatchSize makes the worker wait for a full batch, up to the timeout', () => {
    const { host, engine } = lab(action('queue.type="LinkedList" queue.size="1000" queue.minDequeueBatchSize="3" queue.minDequeueBatchSize.timeout="5000"'));
    submitLocal(engine, MSG('m1'));
    submitLocal(engine, MSG('m2'));
    expect(written(host)).toEqual([]);
    host.advance(4_999);
    expect(written(host)).toEqual([]);
    host.advance(1);
    expect(written(host)).toEqual(['m1', 'm2']);
    for (const word of ['m3', 'm4', 'm5']) submitLocal(engine, MSG(word));
    expect(written(host)).toHaveLength(5);
  });

  it('witness: without a minimum batch the first message is written at once', () => {
    const { host, engine } = lab(action('queue.type="LinkedList" queue.size="1000"'));
    submitLocal(engine, MSG('m1'));
    expect(written(host)).toEqual(['m1']);
  });

  it('two workers drain a slowed-down queue twice as fast, and one worker does not', () => {
    const slow = 'queue.type="LinkedList" queue.size="1000" queue.dequeueBatchSize="1" queue.dequeueSlowdown="4000000"';
    const two = lab(action(`${slow} queue.workerThreads="2" queue.workerThreadMinimumMessages="2"`));
    const one = lab(action(slow));
    for (const word of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
      submitLocal(two.engine, MSG(word));
      submitLocal(one.engine, MSG(word));
    }
    expect([written(two.host).length, written(one.host).length]).toEqual([2, 1]);
    two.host.advance(4_000);
    one.host.advance(4_000);
    expect([written(two.host).length, written(one.host).length]).toEqual([4, 2]);
    two.host.advance(4_000);
    expect(written(two.host)).toHaveLength(6);
  });

  it('witness: below its minimum a queue keeps a single worker even when several are allowed', () => {
    const { host, engine } = lab(action('queue.type="LinkedList" queue.size="1000" queue.dequeueBatchSize="1" queue.dequeueSlowdown="4000000" queue.workerThreads="2" queue.workerThreadMinimumMessages="100"'));
    for (const word of ['m1', 'm2', 'm3']) submitLocal(engine, MSG(word));
    expect(written(host)).toHaveLength(1);
  });

  const BACKLOG = 'main_queue(queue.type="LinkedList" queue.size="10" queue.lightDelayMark="5" queue.fullDelayMark="5" queue.dequeueBatchSize="100" queue.dequeueSlowdown="10000000" queue.timeoutEnqueue="0")\n*.* action(type="omfile" file="/var/log/x.log" template="probe")\n';

  it('a light-delayable input is held back for one second when the queue has reached the light mark', () => {
    const { host, engine } = lab(BACKLOG);
    for (const word of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) submitLocal(engine, MSG(word));
    submitLocal(engine, MSG('m7'), { flowControl: 'light' });
    expect(engine.engine.mainQueue.pending()).toHaveLength(5);
    host.advance(1_000);
    expect(engine.engine.mainQueue.pending()).toHaveLength(6);
  });

  it('a full-delayable input waits until the queue has room', () => {
    const { host, engine } = lab(BACKLOG);
    for (const word of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) submitLocal(engine, MSG(word));
    submitLocal(engine, MSG('m7'), { flowControl: 'full' });
    host.advance(9_000);
    expect(engine.engine.mainQueue.pending()).toHaveLength(5);
    host.advance(1_000);
    expect(written(host)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(engine.engine.mainQueue.pending()).toHaveLength(1);
    host.advance(10_000);
    expect(written(host)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('witness: an input without flow control is never held back', () => {
    const { engine } = lab(BACKLOG);
    for (const word of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']) submitLocal(engine, MSG(word));
    expect(engine.engine.mainQueue.pending()).toHaveLength(6);
  });

  it('queue.mutexContentionStats adds its two counters before maxqsize, at zero for a machine without thread contention', () => {
    const { host, engine } = lab(`${action('queue.type="LinkedList" queue.size="1000" queue.mutexContentionStats="on"')}module(load="impstats" interval="60" log.file="/var/log/stats.log")\n`);
    submitLocal(engine, MSG('m1'));
    host.advance(60_000);
    const line = lines(host.fileSystem.get('/var/log/stats.log') ?? null).find((entry) => entry.includes(': out queue: origin=core.queue ')) ?? '';
    expect(line).toContain('discarded.nf=0 mutex.contention=0 mutex.wait_ns=0 maxqsize=1');
  });
});
