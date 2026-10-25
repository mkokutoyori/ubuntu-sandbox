/**
 * Probe - src/network/rsyslog/engine/segdisk/, ported from runtime/segdisk_store.c, segdisk_state.c, segdisk_codec.c
 * and runtime/queue_da.c (rsyslog 8.2610): the engine of a disk-assisted queue is chosen at start from the spool contents
 * (.qi, numbered segments, <prefix>.segq, <prefix>.da-engine); a fresh queue gets segmentedDisk, whose store lives in
 * <prefix>.segq (a 512-byte two-slot state file and segment-NNNNNNNNNNNNNNNNNNNN.open|recover|seg files made of
 * CRC32C-framed records), is created on the first spill, and is removed again after queue.diskQueueIdleTimeout.
 *
 * Measured against the preceding commit (git stash push -- src/network): 24 of the 28 cases fall (a disk-assisted child
 * was always the classic .qi store, queue.type="segmentedDisk" was refused as unknown, queue.cry.provider was an unknown
 * parameter). The 4 that pass either way: two WITNESSES built in the same lab (a queue under its high watermark leaves
 * nothing on disk, queue.diskQueueType="disk" keeps the classic .qi store) and two non-regression cases (what a stopped
 * daemon saved is delivered once, in order, and saveOnShutdown="off" still loses the memory part: the delivery rules do
 * not depend on the engine). Time is the simulated clock.
 */
import { describe, expect, it } from 'vitest';
import { BuiltinModuleCatalog } from '@/network/rsyslog/modules/Catalog';
import { LabHost, LabNetwork, lines, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

const MSG = (text: string): string => `<13>Oct 19 12:00:01 ubuntu alice: ${text}`;
const SPOOL = '/var/spool/rsyslog';
const HEAD = `template(name="probe" type="string" string="%msg%\\n")\nglobal(workDirectory="${SPOOL}")\n`;
const stuck = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/no/such/x.log" createDirs="off" template="probe" action.resumeRetryCount="-1" action.resumeInterval="30" queue.type="LinkedList" ${queue})\n`;
const healthy = (queue: string): string =>
  `${HEAD}action(type="omfile" name="out" file="/var/log/x.log" template="probe" action.resumeRetryCount="-1" queue.type="LinkedList" ${queue})\n`;
const MARKS = 'queue.size="100" queue.highWatermark="10" queue.lowWatermark="4"';
const DA = `${MARKS} queue.filename="daq"`;
const SEGQ = `${SPOOL}/daq.segq`;

const WITHOUT_CRYPTO = new BuiltinModuleCatalog('/usr/lib/x86_64-linux-gnu/rsyslog', (path) => path.endsWith('.so') && !path.includes('lmcry_'));

function lab(config: string, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  host.directories.add(SPOOL);
  return { host, engine: startRsyslog(host, config, { catalog: WITHOUT_CRYPTO }) };
}

const configLog = (engine: LabEngine): string => engine.loader.log.lines().join('\n');
const SLOW = 'queue.dequeueSlowdown="1000000"';

function submit(engine: LabEngine, count: number, from = 1): void {
  for (let n = from; n < from + count; n++) submitLocal(engine, MSG(`m${n}`));
}

const spool = (host: LabHost): string[] => [...host.fileSystem.keys()].filter((path) => path.startsWith(`${SPOOL}/`)).map((path) => path.slice(SPOOL.length + 1)).sort();
const segments = (host: LabHost): string[] => spool(host).filter((name) => /segment-\d{20}\.(seg|open|recover)$/.test(name));
const written = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/x.log') ?? null).map((line) => line.trim());
const messages = (engine: LabEngine): string => engine.internalMessages.map((entry) => entry.text).join('\n');
const numbered = (count: number, from = 1): string[] => Array.from({ length: count }, (_, index) => `m${from + index}`);

function stats(host: LabHost, queue: string): Map<string, number> {
  const text = host.fileSystem.get('/var/log/stats.log') ?? '';
  const last = lines(text).filter((line) => line.includes(`: ${queue}: origin=core.queue `)).pop() ?? '';
  return new Map([...last.matchAll(/ ([\w.]+)=(-?\d+)/g)].map((match) => [match[1], Number(match[2])]));
}

describe('disk-assisted queue with the segmented engine', () => {
  it('witness: below the high watermark nothing reaches the disk', () => {
    const { host, engine } = lab(stuck(DA));
    submit(engine, 5);
    expect(spool(host)).toEqual([]);
  });

  it('witness: queue.diskQueueType="disk" keeps the classic store', () => {
    const { host, engine } = lab(stuck(`${DA} queue.diskQueueType="disk"`));
    submit(engine, 14);
    expect(spool(host)).toEqual(['daq.00000001']);
  });

  it('witness: an unrelated numbered file is not classic data', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.fileSystem.set(`${SPOOL}/other.00000001`, 'x');
    const { engine } = lab(stuck(DA), host);
    submit(engine, 14);
    expect(spool(host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
  });

  it('the first spill publishes the engine marker, the state file and an open segment', () => {
    const { host, engine } = lab(stuck(DA));
    submit(engine, 14);
    expect(host.fileSystem.get(`${SPOOL}/daq.da-engine`)).toBe('RSYSLOG-DA-ENGINE-V1 segmentedDisk\n');
    const state = host.fileSystem.get(`${SEGQ}/state`) ?? '';
    expect(state).toHaveLength(512);
    expect(state.startsWith('RSSEGST2') || state.slice(256).startsWith('RSSEGST2')).toBe(true);
    expect(segments(host)).toEqual(['daq.segq/segment-00000000000000000001.open']);
    const segment = host.fileSystem.get(`${SEGQ}/segment-00000000000000000001.open`) ?? '';
    expect(segment.startsWith('RSSEGH02')).toBe(true);
    expect(segment.length).toBeGreaterThan(52);
    expect(spool(host).some((name) => name.endsWith('.qi'))).toBe(false);
  });

  it('records are CRC-framed with a sequence number', () => {
    const { host, engine } = lab(stuck(DA));
    submit(engine, 14);
    const segment = host.fileSystem.get(`${SEGQ}/segment-00000000000000000001.open`) ?? '';
    expect(segment.slice(52, 60)).toBe('RSRECD02');
    expect(segment.charCodeAt(52 + 23)).toBe(1);
  });

  it('rotates at queue.maxFileSize: full segments are sealed with a footer, the last stays open', () => {
    const { host, engine } = lab(stuck(`${DA} queue.maxFileSize="1500"`));
    submit(engine, 25);
    const names = segments(host);
    expect(names.length).toBeGreaterThan(2);
    expect(names.slice(0, -1).every((name) => name.endsWith('.seg'))).toBe(true);
    expect(names[names.length - 1].endsWith('.open')).toBe(true);
    const sealed = host.fileSystem.get(`${SPOOL}/${names[0]}`) ?? '';
    expect(sealed.slice(sealed.length - 48, sealed.length - 40)).toBe('RSSEAL02');
    expect(sealed.length).toBeLessThanOrEqual(1500 + 600);
  });

  it('delivers everything after a restart and deletes the committed segments', () => {
    const first = lab(stuck(`${DA} queue.maxFileSize="1500"`));
    submit(first.engine, 25);
    first.engine.engine.stop();
    expect(segments(first.host).every((name) => name.endsWith('.seg'))).toBe(true);
    const second = lab(healthy(`${DA} queue.maxFileSize="1500"`), first.host);
    second.host.advance(5_000);
    expect(written(second.host).slice().sort()).toEqual(numbered(25).sort());
    const left = segments(second.host);
    expect(left).toHaveLength(2);
    expect(left[0].endsWith('.seg')).toBe(true);
    expect(left[1].endsWith('.open')).toBe(true);
    expect(second.host.fileSystem.get(`${SPOOL}/${left[1]}`)).toHaveLength(52);
  });

  it('what the stopped daemon saved is delivered in order, once', () => {
    const first = lab(stuck(DA));
    submit(first.engine, 14);
    first.engine.engine.stop();
    const second = lab(healthy(DA), first.host);
    second.host.advance(5_000);
    expect(written(second.host).slice().sort()).toEqual(numbered(14).sort());
    second.engine.engine.stop();
    const third = lab(healthy(DA), second.host);
    third.host.advance(5_000);
    expect(written(third.host).slice().sort()).toEqual(numbered(14).sort());
  });

  it('with saveOnShutdown off the memory part is lost but what went to disk stays', () => {
    const first = lab(stuck(`${DA} queue.saveOnShutdown="off"`));
    submit(first.engine, 14);
    first.engine.engine.stop();
    const second = lab(healthy(`${DA} queue.saveOnShutdown="off"`), first.host);
    second.host.advance(5_000);
    const delivered = written(second.host);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(14);
  });

  it('removes the store after the idle timeout and keeps the engine marker', () => {
    const { host, engine } = lab(healthy(`${DA} ${SLOW}`));
    submit(engine, 14);
    host.advance(1_000);
    expect(spool(host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
    host.advance(59_000);
    expect(spool(host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
    host.advance(61_000);
    expect(spool(host)).toEqual(['daq.da-engine']);
    expect(host.directories.has(SEGQ)).toBe(false);
  });

  it('a new spill after the cleanup materializes the store again', () => {
    const { host, engine } = lab(healthy(`${DA} ${SLOW}`));
    submit(engine, 14);
    host.advance(130_000);
    expect(spool(host)).toEqual(['daq.da-engine']);
    submit(engine, 14, 100);
    host.advance(1_000);
    expect(spool(host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
    host.advance(130_000);
    expect(written(host)).toHaveLength(28);
  });

  it('queue.diskQueueIdleTimeout sets the delay and -1 disables the cleanup', () => {
    const short = lab(healthy(`${DA} ${SLOW} queue.diskQueueIdleTimeout="5000"`));
    submit(short.engine, 14);
    short.host.advance(4_000);
    expect(spool(short.host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
    short.host.advance(12_000);
    expect(spool(short.host)).toEqual(['daq.da-engine']);
    const never = lab(healthy(`${DA} ${SLOW} queue.diskQueueIdleTimeout="-1"`), new LabHost('10.0.0.2', new LabNetwork()));
    submit(never.engine, 14);
    never.host.advance(3_600_000);
    expect(spool(never.host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
  });

  it('activity inside the idle window postpones the cleanup by a whole timeout', () => {
    const { host, engine } = lab(healthy(`${DA} ${SLOW}`));
    submit(engine, 14);
    host.advance(30_000);
    submit(engine, 14, 100);
    host.advance(35_000);
    expect(spool(host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
    host.advance(61_000);
    expect(spool(host)).toEqual(['daq.da-engine']);
  });

  it('a foreign file in the store prevents the cleanup, which is counted and retried', () => {
    const { host, engine } = lab(`${healthy(`${DA} ${SLOW}`)}module(load="impstats" interval="60" log.file="/var/log/stats.log" log.syslog="off")\n`);
    submit(engine, 14);
    host.advance(1_000);
    host.fileSystem.set(`${SEGQ}/notes.txt`, 'operator');
    host.advance(130_000);
    expect(host.fileSystem.has(`${SEGQ}/state`)).toBe(true);
    expect(stats(host, 'out queue[DA]').get('store.idleCleanupFailures')).toBeGreaterThanOrEqual(1);
    expect(messages(engine)).toContain('segmented disk-assisted idle store cleanup failed; will retry');
    host.fileSystem.delete(`${SEGQ}/notes.txt`);
    host.advance(130_000);
    expect(spool(host)).toEqual(['daq.da-engine']);
  });

  it('exposes the store counters on the child statistics object', () => {
    const { host, engine } = lab(`${stuck(DA)}module(load="impstats" interval="60" log.file="/var/log/stats.log" log.syslog="off")\n`);
    submit(engine, 14);
    host.advance(60_000);
    const child = stats(host, 'out queue[DA]');
    expect(child.get('store.materializations')).toBe(1);
    expect(child.get('segments')).toBe(1);
    expect(child.get('disk.usage')).toBeGreaterThan(52);
    expect(child.get('state.writes')).toBeGreaterThanOrEqual(1);
    expect(child.get('startup.payloadBytesRead')).toBe(0);
    expect(child.get('workers.current')).toBeGreaterThanOrEqual(1);
  });
});

describe('engine selection', () => {
  it('a classic backlog keeps the classic engine and says so', () => {
    const first = lab(stuck(`${DA} queue.diskQueueType="disk"`));
    submit(first.engine, 14);
    first.engine.engine.stop();
    const second = lab(healthy(DA), first.host);
    expect(messages(second.engine)).toContain("disk-assisted queue automatically selected the classic disk engine for prefix 'daq' because classic queue state is present or retained");
    second.host.advance(5_000);
    expect(written(second.host).slice().sort()).toEqual(numbered(14).sort());
    expect(second.host.fileSystem.get(`${SPOOL}/daq.da-engine`)).toBe('RSYSLOG-DA-ENGINE-V1 disk\n');
  });

  it('an explicit segmentedDisk with classic data is refused and the queue stays memory-only', () => {
    const first = lab(stuck(`${DA} queue.diskQueueType="disk"`));
    submit(first.engine, 14);
    first.engine.engine.stop();
    const second = lab(healthy(`${DA} queue.diskQueueType="segmentedDisk"`), first.host);
    expect(messages(second.engine)).toContain("cannot select disk-assisted queue engine for prefix 'daq'");
    expect(spool(second.host).some((name) => name.startsWith('daq.segq'))).toBe(false);
  });

  it('classic and segmented data together are a conflict', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.fileSystem.set(`${SPOOL}/daq.qi`, 'x');
    host.directories.add(SEGQ);
    const { engine } = lab(healthy(DA), host);
    expect(messages(engine)).toContain("cannot select disk-assisted queue engine for prefix 'daq'");
  });

  it('a malformed marker is refused rather than guessed', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.fileSystem.set(`${SPOOL}/daq.da-engine`, 'garbage\n');
    const { engine } = lab(healthy(DA), host);
    expect(messages(engine)).toContain("cannot select disk-assisted queue engine for prefix 'daq'");
  });

  it('a drained classic queue upgrades at restart only with queue.diskQueueAutoUpgrade', () => {
    const first = lab(healthy(`${DA} queue.diskQueueType="disk"`));
    submit(first.engine, 14);
    first.host.advance(5_000);
    first.engine.engine.stop();
    expect(first.host.fileSystem.get(`${SPOOL}/daq.da-engine`)).toBeUndefined();
    first.host.fileSystem.set(`${SPOOL}/daq.da-engine`, 'RSYSLOG-DA-ENGINE-V1 disk\n');
    const sticky = lab(stuck(DA), first.host);
    submit(sticky.engine, 14);
    expect(spool(sticky.host).filter((name) => name.includes('.segq'))).toEqual([]);
    sticky.engine.engine.stop();
    for (const name of spool(sticky.host)) if (name !== 'daq.da-engine') sticky.host.fileSystem.delete(`${SPOOL}/${name}`);
    const upgraded = lab(stuck(`${DA} queue.diskQueueAutoUpgrade="on"`), sticky.host);
    expect(upgraded.host.fileSystem.get(`${SPOOL}/daq.da-engine`)).toBe('RSYSLOG-DA-ENGINE-V1 segmentedDisk\n');
    submit(upgraded.engine, 14);
    expect(spool(upgraded.host).some((name) => name.startsWith('daq.segq/'))).toBe(true);
  });
});

describe('pure segmentedDisk queue', () => {
  const pure = (extra: string): string => stuck(`queue.type="segmentedDisk" queue.filename="sq" queue.size="1000" ${extra}`).replace('queue.type="LinkedList" ', '');

  it('creates its store at start, delivers, and removes it when empty at shutdown', () => {
    const { host, engine } = lab(healthy('queue.filename="sq"').replace('queue.type="LinkedList" queue.filename="sq"', 'queue.type="segmentedDisk" queue.filename="sq"'));
    expect(spool(host).some((name) => name.startsWith('sq.segq/state'))).toBe(true);
    submit(engine, 3);
    host.advance(1_000);
    expect(written(host)).toEqual(['m1', 'm2', 'm3']);
    engine.engine.stop();
    expect(spool(host)).toEqual([]);
  });

  it('keeps unprocessed records across a restart', () => {
    const first = lab(pure(''));
    submit(first.engine, 3);
    first.engine.engine.stop();
    expect(segments(first.host).some((name) => name.startsWith('sq.segq/'))).toBe(true);
    const second = lab(healthy('queue.filename="sq"').replace('queue.type="LinkedList" queue.filename="sq"', 'queue.type="segmentedDisk" queue.filename="sq"'), first.host);
    second.host.advance(5_000);
    expect(written(second.host).slice().sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('needs a file name and refuses queue.cry.provider', () => {
    const noName = lab(stuck('queue.type="segmentedDisk"').replace('queue.type="LinkedList" ', ''));
    expect(configLog(noName.engine)).toContain("error on queue 'out queue', segmentedDisk mode selected, but no queue file name given");
    const crypto = lab(stuck('queue.type="segmentedDisk" queue.filename="sq" queue.cry.provider="gcry"').replace('queue.type="LinkedList" ', ''));
    expect(configLog(crypto.engine)).toContain('queue.cry.provider is not yet supported by segmentedDisk');
  });

  it('a state file that went missing while segments remain is refused', () => {
    const first = lab(pure(''));
    submit(first.engine, 3);
    first.engine.engine.stop();
    first.host.fileSystem.delete(`${SPOOL}/sq.segq/state`);
    const second = lab(pure(''), first.host);
    expect(messages(second.engine)).toContain('segmentedDisk state is missing while queue files exist; offline recovery is required');
    expect(messages(second.engine)).toContain('segmentedDisk store initialization failed');
  });
});

describe('corruption', () => {
  function sealedSegmentWithFiveRecords(): { host: LabHost; name: string } {
    const first = lab(pureConfig());
    submit(first.engine, 5);
    first.engine.engine.stop();
    const name = segments(first.host)[0];
    return { host: first.host, name };
  }
  const pureConfig = (): string => stuck('queue.type="segmentedDisk" queue.filename="sq" queue.size="1000"').replace('queue.type="LinkedList" ', '');

  it('a record whose payload checksum fails is skipped and counted, the others are delivered', () => {
    const { host, name } = sealedSegmentWithFiveRecords();
    const path = `${SPOOL}/${name}`;
    const content = host.fileSystem.get(path) as string;
    const target = content.indexOf('m2');
    host.fileSystem.set(path, content.slice(0, target) + 'X' + content.slice(target + 1));
    const second = lab(`${healthy('')}`.replace('queue.type="LinkedList" ', 'queue.type="segmentedDisk" queue.filename="sq" '), host);
    second.host.advance(5_000);
    expect(written(host)).toEqual(['m1', 'm3', 'm4', 'm5']);
    expect(messages(second.engine)).toContain('segmentedDisk salvage skipped 1 corrupt records');
  });

  it('bytes that do not frame a record are scanned past one at a time and counted', () => {
    const { host, name } = sealedSegmentWithFiveRecords();
    const path = `${SPOOL}/${name}`;
    const content = host.fileSystem.get(path) as string;
    const footer = content.length - 48;
    host.fileSystem.set(path, content.slice(0, 52) + 'JUNKJUNK' + content.slice(52, footer) + content.slice(footer));
    const second = lab(`${healthy('')}`.replace('queue.type="LinkedList" ', 'queue.type="segmentedDisk" queue.filename="sq" ') + 'module(load="impstats" interval="60" log.file="/var/log/stats.log" log.syslog="off")\n', host);
    second.host.advance(60_000);
    expect(written(host)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(stats(host, 'out queue').get('corruption.bytes')).toBe(8);
    expect(stats(host, 'out queue').get('recovery.records')).toBe(5);
  });
});

describe('queue.cry.provider', () => {
  it('without a file name the provider is refused', () => {
    const { engine } = lab(stuck('queue.cry.provider="gcry"'));
    expect(configLog(engine)).toContain('crypto provider can only be set for disk or disk assisted queue - ignored');
  });

  it('with a file name but no provider library the load fails', () => {
    const { engine } = lab(stuck(`${DA} queue.cry.provider="gcry"`));
    expect(configLog(engine)).toContain("queue: could not load crypto provider 'lmcry_gcry' - encryption disabled");
  });
});
