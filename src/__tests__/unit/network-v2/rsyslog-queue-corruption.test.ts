/*
 * Probe - queue.onCorruption on a classic disk queue (runtime/queue.c qqueueVerifyAndRecover, qqueueSwitchToInMemoryEmergency,
 * qDeqDiskRecoverAfterCorruption, qqueueResetDiskQueueAfterCorruption): at startup the spool directory is scanned for
 * "<prefix>.<number>" files and compared with the .qi state - a .qi that is missing or invalid while numbered files exist, a number
 * out of range, a file missing from the chain between the delete and the write file and an orphaned file are all corruption.
 * "safe" (the default) moves the .qi and the numbered files into "<prefix>.bad.<YYYYMMDDHHMMSS>" and starts fresh, "inMemory" leaves
 * the files alone and runs the queue as a non-persistent linked list, "ignore" does not verify.  A damaged record inside a file is
 * skipped by a bounded resynchronisation on the next record header in "safe" mode; when none is found the whole queue is quarantined
 * into "<prefix>.bad.<stamp>.<pid>".  The encrypted queue files go with their .encinfo files, which libgcry keeps next to them
 * (the source leaves them behind, which would make the quarantined data unreadable).
 * Measured before the port (git stash push -- src/network): 9 of the 11 cases fall - a queue with a damaged spool directory either
 * threw at startup or carried on with orphaned files, and queue.onCorruption was stored without effect.  The two that pass either way
 * are the WITNESS (a healthy restart) and "ignore" on a missing .qi, which never verified anything.
 */
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const SPOOL = '/var/spool/rsyslog';
const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const HEAD = `template(name="probe" type="string" string="%msg%\\n")\nglobal(workDirectory="${SPOOL}")\n`;
const stuck = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" action.resumeRetryCount="-1" action.resumeInterval="30" ${queue})\n`;
const healthy = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/var/log/x.log" template="probe" action.resumeRetryCount="-1" ${queue})\n`;
const DISK = 'queue.type="Disk" queue.filename="dq"';

function lab(config: string, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  host.directories.add(SPOOL);
  return { host, engine: startRsyslog(host, config) };
}

function backlog(...texts: string[]): LabHost {
  const first = lab(stuck(DISK));
  for (const text of texts) submitLocal(first.engine, MSG(text));
  first.engine.engine.stop();
  return first.host;
}

const files = (host: LabHost): string[] => [...host.fileSystem.keys()].filter((path) => path.startsWith(`${SPOOL}/`)).map((path) => path.slice(SPOOL.length + 1)).sort();
const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());
const messages = (started: { engine: LabEngine }): string => started.engine.loader.log.lines().join('\n') + '\n' + started.engine.internalMessages.map((entry) => entry.text).join('\n');
const quarantined = (host: LabHost): string[] => files(host).filter((name) => /^dq\.bad\.\d{14}(\.\d+)?\//.test(name));

describe('verification at startup', () => {
  it('witness: a healthy spool directory restarts and delivers without any recovery', () => {
    const host = backlog('alpha', 'beta');
    const started = lab(healthy(DISK), host);
    started.host.advance(60_000);
    expect(written(started.host)).toEqual(['alpha', 'beta']);
    expect(messages(started)).not.toContain('queue corruption');
  });

  it('safe: a .qi that is missing while a numbered file exists moves the files to a .bad directory and starts fresh', () => {
    const host = backlog('alpha');
    host.fileSystem.delete(`${SPOOL}/dq.qi`);
    const started = lab(healthy(DISK), host);
    const text = messages(started);
    expect(text).toContain('queue corruption: .qi file missing or inaccessible but 1 segment files exist');
    expect(text).toContain('Queue corruption detected! Moving queue files to .bad directory and starting fresh.');
    expect(quarantined(host).map((name) => name.replace(/^dq\.bad\.\d{14}\//, ''))).toEqual(['dq.00000001']);
    expect(files(host).filter((name) => !name.includes('/'))).toEqual([]);
    submitLocal(started.engine, MSG('fresh'));
    started.host.advance(60_000);
    expect(written(started.host)).toEqual(['fresh']);
  });

  it('safe: a .qi that cannot be parsed, with no numbered file, is quarantined alone', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.directories.add(SPOOL);
    host.fileSystem.set(`${SPOOL}/dq.qi`, 'this is not an object stream\n');
    const started = lab(healthy(DISK), host);
    expect(messages(started)).toContain('queue corruption: .qi file is invalid and contains no usable queue state');
    expect(quarantined(host).map((name) => name.replace(/^dq\.bad\.\d{14}\//, ''))).toEqual(['dq.qi']);
  });

  it('safe: a file missing from the chain between the delete and the write file', () => {
    const host = backlog('alpha');
    const info = host.fileSystem.get(`${SPOOL}/dq.qi`) ?? '';
    host.fileSystem.set(`${SPOOL}/dq.qi`, info.replace(/(\+iCurrFNum:2:1:)1(:\n[^]*?\n>End\n\.\n<Obj:1:strm:1:\n\+iCurrFNum:2:1:)1/, '$13$21'));
    const started = lab(healthy(DISK), host);
    expect(messages(started)).toContain('queue corruption: missing file in sequence: 2');
  });

  it('safe: an orphaned file outside the range of the .qi state', () => {
    const host = backlog('alpha');
    host.fileSystem.set(`${SPOOL}/dq.00000009`, 'stray');
    const started = lab(healthy(DISK), host);
    expect(messages(started)).toContain('queue corruption: orphaned file found: dq.00000009 (seq 9 not in range [1, 1])');
    expect(quarantined(host).map((name) => name.replace(/^dq\.bad\.\d{14}\//, '')).sort()).toEqual(['dq.00000001', 'dq.00000009', 'dq.qi']);
  });

  it('safe: a sequence number beyond the 10,000,000 files a queue may span', () => {
    const host = backlog('alpha');
    host.fileSystem.set(`${SPOOL}/dq.99999999`, 'stray');
    const started = lab(healthy(DISK), host);
    expect(messages(started)).toContain('queue corruption: found file with out-of-range sequence number 99999999');
  });

  it('safe: the .encinfo file of an encrypted queue file goes to the .bad directory with its data file', () => {
    const encrypted = `${DISK} queue.cry.provider="gcry" queue.cry.key="0123456789abcdef"`;
    const first = lab(stuck(encrypted));
    submitLocal(first.engine, MSG('alpha'));
    first.engine.engine.stop();
    first.host.fileSystem.delete(`${SPOOL}/dq.qi`);
    const started = lab(healthy(encrypted), first.host);
    expect(quarantined(started.host).map((name) => name.replace(/^dq\.bad\.\d{14}\//, '')).sort()).toEqual(['dq.00000001', 'dq.00000001.encinfo']);
  });

  it('inMemory: the same corruption leaves the files alone and the queue runs without persistence', () => {
    const host = backlog('alpha');
    host.fileSystem.delete(`${SPOOL}/dq.qi`);
    const before = files(host);
    const started = lab(healthy(`${DISK} queue.onCorruption="inMemory"`), host);
    const text = messages(started);
    expect(text).toContain('Queue corruption detected. Entering emergency in-memory mode (non-persistent queue).');
    expect(text).toContain('Queue now runs in pure in-memory emergency mode. Data is not persistent and can be lost on restart or crash.');
    expect(files(host)).toEqual(before);
    submitLocal(started.engine, MSG('volatile'));
    started.host.advance(60_000);
    expect(written(started.host)).toEqual(['volatile']);
    started.engine.engine.stop();
    expect(files(host)).toEqual(before);
  });

  it('ignore: nothing is verified, a missing .qi is a clean start whatever lies in the directory', () => {
    const host = backlog('alpha');
    host.fileSystem.delete(`${SPOOL}/dq.qi`);
    const started = lab(healthy(`${DISK} queue.onCorruption="ignore"`), host);
    expect(messages(started)).not.toContain('queue corruption');
    expect(quarantined(host)).toEqual([]);
  });
});

describe('a damaged record inside a queue file', () => {
  const damage = (host: LabHost, occurrence: number): void => {
    const data = host.fileSystem.get(`${SPOOL}/dq.00000001`) ?? '';
    let at = -1;
    for (let found = 0; found <= occurrence; found++) at = data.indexOf('<Obj:1:msg:1:', at + 1);
    host.fileSystem.set(`${SPOOL}/dq.00000001`, `${data.slice(0, at)}<Obj:Z:mxx:1:${data.slice(at + '<Obj:1:msg:1:'.length)}`);
  };

  it('safe: the damaged record is skipped on the next record header and the others are delivered', () => {
    const host = backlog('alpha', 'beta', 'gamma');
    damage(host, 1);
    const started = lab(healthy(DISK), host);
    started.host.advance(60_000);
    expect(written(started.host)).toEqual(['alpha', 'gamma']);
    const text = messages(started);
    expect(text).toContain('out queue: disk queue corruption detected while dequeuing at file 1 offset');
    expect(text).toContain('attempting bounded resync');
    expect(text).toContain('disk queue corruption recovery resumed after skipping a damaged record; resynchronized at file 1 offset');
  });

  it('safe: when no further header is found the unread tail is quarantined and the queue starts again', () => {
    const host = backlog('alpha', 'beta');
    damage(host, 1);
    const started = lab(healthy(DISK), host);
    started.host.advance(60_000);
    const text = messages(started);
    expect(text).toContain('disk queue corruption recovery failed after bounded scan of');
    expect(text).toMatch(/disk queue corruption could not be resynchronized; quarantined unread tail into \/var\/spool\/rsyslog\/dq\.bad\.\d{14}\.\d+/);
    expect(text).toContain('out queue: disk queue active state reset after corruption quarantine');
    expect(quarantined(host).length).toBeGreaterThan(0);
    expect(files(host).filter((name) => !name.includes('/'))).toEqual([]);
  });
});
