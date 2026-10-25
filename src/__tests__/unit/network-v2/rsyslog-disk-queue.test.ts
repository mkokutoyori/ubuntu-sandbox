/*
 * Probe - src/network/rsyslog/engine/DiskQueueStore.ts, ObjectStream.ts and MessageCodec.ts, ported from
 * runtime/queue.c (qConstructDisk, qAddDisk, qqueuePersist, DoDeleteBatchFromQStore), runtime/stream.c (circular
 * files, strmMultiFileSeek, strmSerialize), runtime/obj.c (object stream) and runtime/msg.c (MsgSerialize): a
 * queue.type="Disk" queue writes every message to <fileName>.NNNNNNNN in the work directory, rotates at maxFileSize,
 * deletes a data file once the delete pointer has left it, writes its queue info file <fileName>.qi at a file change, at a
 * checkpoint and at shutdown, refuses messages past maxDiskSpace and picks its backlog up again after a restart.
 * Measured against the previous commit: 9 of the 12 cases fall - a Disk queue was a plain memory queue, so no file was
 * written, no .qi existed during the run, the backlog only survived through a JSON document and
 * maxFileSize/maxDiskSpace/checkpointInterval/spoolDirectory were read and ignored. The three that pass either way:
 * the WITNESS (a LinkedList queue without a file name creates no file), the empty-at-shutdown case (nothing was created
 * before, nothing remains after - structural) and the field round trip (the JSON state already kept the fields, so it
 * is a non-regression check of the new codec).
 * Time is the simulated clock; none of these cases waits for real time.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const SPOOL = '/var/spool/rsyslog';
const HEAD = `template(name="probe" type="string" string="%msg%\\n")\nglobal(workDirectory="${SPOOL}")\n`;
const stuck = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" action.resumeRetryCount="-1" action.resumeInterval="30" ${queue})\n`;
const healthy = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/var/log/x.log" template="probe" action.resumeRetryCount="-1" ${queue})\n`;

function lab(config: string, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  host.directories.add(SPOOL);
  return { host, engine: startRsyslog(host, config) };
}

function submit(engine: LabEngine, ...texts: string[]): void {
  for (const text of texts) submitLocal(engine, MSG(text));
}

const spool = (host: LabHost): string[] => [...host.fileSystem.keys()].filter((path) => path.startsWith(`${SPOOL}/`)).map((path) => path.slice(SPOOL.length + 1)).sort();
const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());
const DISK = 'queue.type="Disk" queue.filename="dq"';

describe('classic disk queue', () => {
  it('witness: a memory queue without a file name creates no file', () => {
    const { host, engine } = lab(stuck('queue.type="LinkedList"'));
    submit(engine, 'one', 'two');
    engine.engine.stop();
    expect(spool(host)).toEqual([]);
  });

  it('writes each message to the first numbered file as an object-stream record, with no queue info file yet', () => {
    const { host, engine } = lab(stuck(DISK));
    submit(engine, 'one', 'two');
    expect(spool(host)).toEqual(['dq.00000001']);
    const text = host.fileSystem.get(`${SPOOL}/dq.00000001`) ?? '';
    expect(text.match(/<Obj:1:msg:1:\n/g)).toHaveLength(2);
    expect(text).toContain('+pszRawMsg:1:37:<13>Oct 19 12:00:01 ubuntu alice: one:\n');
    expect(text.endsWith('>End\n.\n')).toBe(true);
  });

  it('rotates at maxFileSize and writes the queue info file at the file change', () => {
    const { host, engine } = lab(stuck(`${DISK} queue.maxFileSize="1k"`));
    submit(engine, 'one', 'two', 'three', 'four');
    expect(spool(host)).toEqual(['dq.00000001', 'dq.00000002', 'dq.qi']);
    const info = host.fileSystem.get(`${SPOOL}/dq.qi`) ?? '';
    expect(info.startsWith('<OPB:1:qqueue:1:\n+iQueueSize:2:1:4:\n+tVars.disk.sizeOnDisk:2:4:')).toBe(true);
    expect(info.match(/<Obj:1:strm:1:\n/g)).toHaveLength(2);
    expect(info).toContain('+iMaxFiles:2:8:10000000:\n');
    expect(info).toContain('+pszFName:1:2:dq:\n');
  });

  it('deletes a data file once the delete pointer has moved past it', () => {
    const { host, engine } = lab(healthy(`${DISK} queue.maxFileSize="1k"`));
    submit(engine, 'one', 'two', 'three', 'four');
    host.advance(1_000);
    expect(written(host)).toEqual(['one', 'two', 'three', 'four']);
    expect(spool(host)).toEqual(['dq.00000002', 'dq.qi']);
  });

  it('removes every file when the queue is empty at shutdown', () => {
    const { host, engine } = lab(healthy(`${DISK} queue.maxFileSize="1k"`));
    submit(engine, 'one', 'two', 'three', 'four');
    host.advance(1_000);
    engine.engine.stop();
    expect(spool(host)).toEqual([]);
  });

  it('keeps the files and the queue info file for a non-empty queue at shutdown', () => {
    const { host, engine } = lab(stuck(DISK));
    submit(engine, 'one', 'two', 'three');
    engine.engine.stop();
    expect(spool(host)).toEqual(['dq.00000001', 'dq.qi']);
    const info = host.fileSystem.get(`${SPOOL}/dq.qi`) ?? '';
    expect(info).toContain('+iQueueSize:2:1:3:\n');
    expect(info).toContain('+bDeleteOnClose:2:1:0:\n');
  });

  it('delivers the backlog after a restart, from the files, and reports the reopening', () => {
    const first = lab(stuck(DISK));
    submit(first.engine, 'one', 'two', 'three');
    first.engine.engine.stop();
    const second = lab(healthy(DISK), first.host);
    second.host.advance(5_000);
    expect(written(second.host)).toEqual(['one', 'two', 'three']);
    expect(second.engine.internalMessages.map((entry) => entry.text).join('\n')).toContain('queue files exist on disk, re-starting with 3 messages');
  });

  it('does not deliver the same backlog twice after a second restart', () => {
    const first = lab(stuck(DISK));
    submit(first.engine, 'one', 'two', 'three');
    first.engine.engine.stop();
    const second = lab(healthy(DISK), first.host);
    second.host.advance(5_000);
    second.engine.engine.stop();
    const third = lab(healthy(DISK), first.host);
    third.host.advance(5_000);
    expect(written(third.host)).toEqual(['one', 'two', 'three']);
    expect(spool(third.host)).toEqual([]);
  });

  it('keeps the fields of a message across the restart: facility, severity, tag, host and the MSG offset', () => {
    const first = lab(`${HEAD}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="fields" action.resumeRetryCount="-1" ${DISK})\n`.replace(HEAD, `${HEAD}template(name="fields" type="string" string="%syslogfacility-text%.%syslogseverity-text% %hostname% %syslogtag% [%msg%] %fromhost-ip%\\n")\n`));
    submit(first.engine, 'payload');
    first.engine.engine.stop();
    const second = lab(`${HEAD}template(name="fields" type="string" string="%syslogfacility-text%.%syslogseverity-text% %hostname% %syslogtag% [%msg%] %fromhost-ip%\\n")\naction(type="omfile" name="out" file="/var/log/x.log" template="fields" ${DISK})\n`, first.host);
    second.host.advance(5_000);
    expect(written(second.host)).toEqual(['user.notice ubuntu alice: [ payload] 127.0.0.1']);
  });

  it('refuses messages once the files hold more than maxDiskSpace', () => {
    const { host, engine } = lab(stuck(`${DISK} queue.maxFileSize="1k" queue.maxDiskSpace="2k" queue.timeoutEnqueue="0"`));
    submit(engine, ...Array.from({ length: 12 }, (_, index) => `m${index}`));
    const kept = (host.fileSystem.get(`${SPOOL}/dq.00000001`) ?? '').match(/<Obj:1:msg:1:/g)?.length ?? 0;
    const more = (host.fileSystem.get(`${SPOOL}/dq.00000002`) ?? '').match(/<Obj:1:msg:1:/g)?.length ?? 0;
    const third = (host.fileSystem.get(`${SPOOL}/dq.00000003`) ?? '').match(/<Obj:1:msg:1:/g)?.length ?? 0;
    expect([kept, more, third]).toEqual([3, 2, 0]);
    expect(spool(host).filter((name) => name !== 'dq.qi').length).toBeLessThanOrEqual(3);
  });

  it('writes the queue info file at every checkpoint', () => {
    const { host, engine } = lab(stuck(`${DISK} queue.checkpointInterval="2"`));
    submit(engine, 'one');
    expect(spool(host)).toEqual(['dq.00000001']);
    submit(engine, 'two');
    expect(spool(host)).toEqual(['dq.00000001', 'dq.qi']);
  });

  it('uses queue.spoolDirectory instead of the work directory', () => {
    const { host, engine } = lab(stuck(`${DISK} queue.spoolDirectory="/var/spool/other"`));
    host.directories.add('/var/spool/other');
    submit(engine, 'one');
    expect([...host.fileSystem.keys()].filter((path) => path.startsWith('/var/spool/other/'))).toEqual(['/var/spool/other/dq.00000001']);
    expect(spool(host)).toEqual([]);
  });
});
