/*
 * Probe - queue.cry.provider on a disk queue and on a disk-assisted queue (runtime/queue.c initCryprov, qAddDisk, qqueueApplyCnfParam;
 * runtime/stream.c strmPhysWrite, strmReadBuf, strmSeekCurrOffs, strmMultiFileSeek): every numbered queue file is written through the
 * crypto provider, the side file "<file>.NNNNNNNN.encinfo" records its IV and, once the file is closed, its END offset, the queue
 * info file stays in clear text and its offsets are PHYSICAL ones (whole cipher blocks, since every message is flushed on its own), the
 * state file is removed with the data file, and after a restart the backlog is decrypted by reading the file from its start with the
 * same chain and delivered.  A queue that cannot hold a provider (no file name, segmentedDisk) refuses it in the words of queue.c.
 * Measured before the port (git stash push -- src/network): 6 of the 11 cases fall - the queue files were clear text, no state file
 * existed, the provider was never configured so a wrong key length went unnoticed and the ossl keyprogram was not reported.  The 5 that
 * pass either way: the WITNESS (a disk queue without provider), the restart and the removal of the files (they worked on clear text,
 * so these are non-regression checks of the new read path), the segmentedDisk refusal and the missing file name (both already
 * worded after queue.c by the previous commit).
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const SPOOL = '/var/spool/rsyslog';
const KEY = '0123456789abcdef';
const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const HEAD = `template(name="probe" type="string" string="%msg%\\n")\nglobal(workDirectory="${SPOOL}")\n`;
const stuck = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" action.resumeRetryCount="-1" action.resumeInterval="30" ${queue})\n`;
const healthy = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/var/log/x.log" template="probe" action.resumeRetryCount="-1" ${queue})\n`;
const ENCRYPTED = `queue.type="Disk" queue.filename="dq" queue.cry.provider="gcry" queue.cry.key="${KEY}"`;

function lab(config: string, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  host.directories.add(SPOOL);
  return { host, engine: startRsyslog(host, config) };
}

function submit(engine: LabEngine, ...texts: string[]): void {
  for (const text of texts) submitLocal(engine, MSG(text));
}

const spool = (host: LabHost): string[] => [...host.fileSystem.keys()].filter((path) => path.startsWith(`${SPOOL}/`)).map((path) => path.slice(SPOOL.length + 1)).sort();
const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());
const messages = (lab_: { engine: LabEngine }): string => lab_.engine.loader.log.lines().join('\n') + lab_.engine.internalMessages.map((entry) => entry.text).join('\n');

describe('encrypted disk queue', () => {
  it('witness: without a provider the records are readable and no encinfo file exists', () => {
    const started = lab(stuck('queue.type="Disk" queue.filename="dq"'));
    submit(started.engine, 'one');
    expect(spool(started.host).filter((name) => name.endsWith('.encinfo'))).toEqual([]);
    expect(started.host.fileSystem.get(`${SPOOL}/dq.00000001`)).toContain('one');
  });

  it('writes ciphertext, in whole cipher blocks, next to a private encinfo file', () => {
    const started = lab(stuck(ENCRYPTED));
    submit(started.engine, 'one', 'two');
    const data = started.host.fileSystem.get(`${SPOOL}/dq.00000001`) ?? '';
    expect(data).not.toContain('one');
    expect(data.length).toBeGreaterThan(0);
    expect(data.length % 16).toBe(0);
    expect(started.host.fileSystem.get(`${SPOOL}/dq.00000001.encinfo`)).toMatch(/^FILETYPE:rsyslog-enrcyption-info\nIV:[0-9a-f]{32}\n$/);
  });

  it('records the END offset when the file is closed at shutdown, and keeps the queue info file readable', () => {
    const started = lab(stuck(ENCRYPTED));
    submit(started.engine, 'one', 'two');
    started.engine.engine.stop();
    const size = (started.host.fileSystem.get(`${SPOOL}/dq.00000001`) ?? '').length;
    expect(started.host.fileSystem.get(`${SPOOL}/dq.00000001.encinfo`)).toMatch(new RegExp(`\\nEND:${size}\\n$`));
    expect(started.host.fileSystem.get(`${SPOOL}/dq.qi`)).toContain('iQueueSize');
    expect(started.host.fileSystem.get(`${SPOOL}/dq.qi`)).not.toContain('probe');
  });

  it('delivers the backlog after a restart: the file is decrypted from its start with the same chain', () => {
    const first = lab(stuck(ENCRYPTED));
    submit(first.engine, 'alpha', 'beta', 'gamma');
    first.engine.engine.stop();
    const second = lab(healthy(ENCRYPTED), first.host);
    second.host.advance(60_000);
    expect(written(second.host)).toEqual(['alpha', 'beta', 'gamma']);
    expect(messages(second)).toContain('queue files exist on disk, re-starting with 3 messages');
  });

  it('keeps the write pointer and the size on disk in physical offsets: whole cipher blocks', () => {
    const first = lab(stuck(ENCRYPTED));
    submit(first.engine, 'alpha', 'beta');
    first.engine.engine.stop();
    const info = first.host.fileSystem.get(`${SPOOL}/dq.qi`) ?? '';
    const size = (first.host.fileSystem.get(`${SPOOL}/dq.00000001`) ?? '').length;
    expect(size % 16).toBe(0);
    expect(info).toContain(`+tVars.disk.sizeOnDisk:2:${String(size).length}:${size}:`);
    expect(info).toContain(`+iCurrOffs:2:${String(size).length}:${size}:`);
  });

  it('removes the encinfo file together with the data file once the queue is empty', () => {
    const first = lab(stuck(ENCRYPTED));
    submit(first.engine, 'alpha');
    first.engine.engine.stop();
    const second = lab(healthy(ENCRYPTED), first.host);
    second.host.advance(60_000);
    second.engine.engine.stop();
    expect(spool(second.host).filter((name) => name.startsWith('dq.0'))).toEqual([]);
  });

  it('a disk-assisted queue hands its provider to the disk child', () => {
    const started = lab(stuck(`queue.type="LinkedList" queue.size="100" queue.highWatermark="10" queue.lowWatermark="4" queue.diskQueueType="disk" queue.filename="daq" queue.cry.provider="gcry" queue.cry.key="${KEY}"`));
    submit(started.engine, ...Array.from({ length: 11 }, (_, index) => `m${index + 1}`));
    const data = started.host.fileSystem.get(`${SPOOL}/daq.00000001`) ?? '';
    expect(data.length).toBeGreaterThan(0);
    expect(data).not.toContain('m1');
    expect(started.host.fileSystem.has(`${SPOOL}/daq.00000001.encinfo`)).toBe(true);
  });

  it('a key of the wrong length is refused and the queue carries on in clear text', () => {
    const started = lab(stuck(`queue.type="Disk" queue.filename="dq" queue.cry.provider="gcry" queue.cry.key="short"`));
    expect(messages(started)).toContain('Key length 16 expected, but key of length 5 given');
    submit(started.engine, 'plain');
    expect(started.host.fileSystem.get(`${SPOOL}/dq.00000001`)).toContain('plain');
  });

  it('a provider on a queue without a file name is ignored in the words of queue.c', () => {
    const started = lab(stuck(`queue.type="LinkedList" queue.cry.provider="gcry" queue.cry.key="${KEY}"`));
    expect(messages(started)).toContain("crypto provider can only be set for disk or disk assisted queue - ignored");
  });

  it('segmentedDisk refuses a provider', () => {
    const started = lab(stuck(`queue.type="SegmentedDisk" queue.filename="sq" queue.cry.provider="gcry" queue.cry.key="${KEY}"`));
    expect(messages(started)).toContain('queue.cry.provider is not yet supported by segmentedDisk');
  });

  it('the ossl provider takes its algorithm from queue.cry.algo and keeps keyprogram out', () => {
    const started = lab(stuck(`queue.type="Disk" queue.filename="dq" queue.cry.provider="ossl" queue.cry.algo="aes-256-cbc" queue.cry.key="${KEY}${KEY}" queue.cry.keyprogram="/bin/true"`));
    submit(started.engine, 'oo');
    expect(messages(started)).toContain("parameter 'queue.cry.keyprogram' not known");
    expect(started.host.fileSystem.get(`${SPOOL}/dq.00000001`)).not.toContain('oo');
  });
});
