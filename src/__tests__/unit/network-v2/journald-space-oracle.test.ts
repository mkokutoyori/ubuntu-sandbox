/*
 * Oracle: how systemd-journald 255.4 (Ubuntu 24.04 binary) sizes, rotates, vacuums and rate-limits its journal.
 * scripts/oracle/record_journald_space.py starts the real daemon once per scenario with a drop-in in journald.conf.d, flushes it to
 * /var/log/journal, sends native-protocol datagrams from one process (the big floods are kept as a generator and a list of send
 * times, the small timed scenarios as payloads), and records what is left on disk: per file its st_size and the counters of
 * `journalctl --header`, the driver messages journald wrote, and the outcome of `journalctl --vacuum-*` on a copy of the first scenario.
 * The same sends are replayed through LinuxJournald with the recorded configuration read by readJournaldConfig, the recorded statvfs,
 * a simulated clock and a timer queue; the four entries the real daemon copied from its runtime journal at the flush are copied
 * with copyEntry.  The files must match the real ones one by one: entries, data, fields, entry arrays, objects, st_size and the
 * sequence range, which pins the byte size of every object, the 75% hash table fill rule, E2BIG at MaxFileSize, MaxFileSec,
 * MaxRetentionSec (the timer of journald.c), MaxUse and MaxFiles.  The rate-limit scenario compares what survives and the
 * "Suppressed N messages" driver messages.  The vacuum cases compare the files kept by journal_directory_vacuum.
 * Inputs taken from the recording because the daemon fixes them itself: the process facts of the sender and of journald, the
 * statvfs of the journal directory and the SELinux label.
 * Measured before the port (git stash push -- src/network): every file comparison falls - sizes were a constant 8 MiB, there was
 * no rotation, vacuum, retention timer or rate limit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { LinuxJournald, type JournaldPlatform } from '@/network/devices/linux/journal/LinuxJournald';
import { JOURNALD_CONFIG_FILE, readJournaldConfig } from '@/network/devices/linux/journal/JournaldConfig';
import { type ProcessFacts } from '@/network/devices/linux/journal/JournaldServer';
import { type JournalRecord } from '@/network/devices/linux/journal/JournalRecord';

interface Credentials { pid: number; uid: number; gid: number; comm: string; exe: string; cmdline: string; capeff: string; cgroup: string; loginuid: string; sessionid: string }
interface RecordedEntry { realtime: number; monotonic: number; seqnum: number; bootId: string; fields: Array<[string, string]> }
interface RecordedFile {
  name: string; size: number; state: string; headSeqnum: number; tailSeqnum: number; objects: number; entries: number; data: number; fields: number; entryArrays: number;
}
interface Scenario {
  name: string; conf: string; unit: string | null; credentials: Credentials; endedAt: number;
  statvfs: { bsize: number; frsize: number; blocks: number; bavail: number };
  startEntries: RecordedEntry[]; drivers: RecordedEntry[];
  extraSenders: Array<{ credentials: Credentials; sends: Array<{ at: number; payload: string }> }>;
  sends: Array<{ at: number; payload?: string }>; generator: { kind: 'flood' | 'fat'; count: number } | null;
  files: RecordedFile[];
  vacuums: Array<{ args: string[]; before: string[]; after: string[]; output: string[] }>;
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/journald-space-255.4.json', 'utf8')) as { machineId: string; scenarios: Scenario[] };
const text = (value: string): string => Buffer.from(value, 'base64').toString('latin1');
const fieldOf = (entry: RecordedEntry, name: string): string | null => {
  const found = entry.fields.find(([n]) => n === name);
  return found === undefined ? null : text(found[1]);
};

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const native = (fields: Array<[string, string]>): Uint8Array => Uint8Array.from(Buffer.from(fields.map(([k, v]) => `${k}=${v}\n`).join('')));

function payloadOf(scenario: Scenario, index: number): Uint8Array {
  const generator = scenario.generator;
  const recorded = scenario.sends[index].payload;
  if (generator === null) return Uint8Array.from(Buffer.from(recorded as string, 'base64'));
  if (generator.kind === 'flood') {
    const message = `message ${index} ${Array.from({ length: index % 11 + 1 }, (_, k) => WORDS[(index + k) % 8]).join(' ')}`;
    return native([['MESSAGE', message], ['PRIORITY', String(index % 8)], ['SYSLOG_IDENTIFIER', `probe${index % 5}`], ['SEQ', String(index)]]);
  }
  const shared = Array.from({ length: 100 }, (_, k): [string, string] => [`F${String(k).padStart(3, '0')}`, `shared value number ${k}`]);
  return native([['MESSAGE', `fat entry ${index}`], ['PRIORITY', String(index % 8)], ...shared]);
}

function factsOf(credentials: Credentials, label: Uint8Array | null): ProcessFacts {
  return {
    uid: credentials.uid, gid: credentials.gid, comm: credentials.comm, exe: credentials.exe, cmdline: credentials.cmdline, capeff: credentials.capeff.replace(/^0+(?=.)/, ''), label,
    auditId: credentials.sessionid === '4294967295' ? null : Number(credentials.sessionid), loginUid: credentials.loginuid === '4294967295' ? null : Number(credentials.loginuid),
    cgroup: credentials.cgroup === '' ? null : credentials.cgroup, invocationId: null,
  };
}

function journaldFacts(entry: RecordedEntry): ProcessFacts {
  const value = (name: string): string | null => fieldOf(entry, name);
  return {
    uid: Number(value('_UID')), gid: Number(value('_GID')), comm: value('_COMM'), exe: value('_EXE'), cmdline: value('_CMDLINE'), capeff: value('_CAP_EFFECTIVE'),
    label: value('_SELINUX_CONTEXT') === null ? null : Uint8Array.from(Buffer.from(value('_SELINUX_CONTEXT') as string, 'latin1')), auditId: null, loginUid: null, cgroup: value('_SYSTEMD_CGROUP'), invocationId: null,
  };
}

interface Timer { due: number; callback: () => void; cancelled: boolean }

function replay(scenario: Scenario): { journald: LinuxJournald; driverRecords: JournalRecord[]; files: RecordedFile[]; spaceMessages: JournalRecord[] } {
  const clock = { now: scenario.startEntries[0].realtime };
  const timers: Timer[] = [];
  const runTimers = (until: number): void => {
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (due === undefined) break;
      clock.now = Math.max(clock.now, due.due);
      due.cancelled = true;
      due.callback();
    }
    clock.now = Math.max(clock.now, until);
  };
  const config = { readFile: (path: string) => (path === JOURNALD_CONFIG_FILE ? `[Journal]\n${scenario.conf}` : null), listDirectory: () => null };
  const settings = readJournaldConfig(config).settings;
  const journaldEntry = scenario.startEntries[0];
  const sample = scenario.startEntries[scenario.startEntries.length - 1];
  const labelText = fieldOf(sample, '_SELINUX_CONTEXT');
  const label = labelText === null ? null : Uint8Array.from(Buffer.from(labelText, 'latin1'));
  const journaldPid = Number(fieldOf(journaldEntry, '_PID'));
  const bootId = journaldEntry.bootId;
  const bootUsec = clock.now - journaldEntry.monotonic;
  const platform: JournaldPlatform = {
    nowUsec: () => clock.now,
    bootUsec: () => bootUsec,
    machineId: () => fixture.machineId,
    hostname: () => fieldOf(journaldEntry, '_HOSTNAME') as string,
    probe: (pid) => {
      if (pid === journaldPid) return journaldFacts(journaldEntry);
      const sender = [scenario.credentials, ...scenario.extraSenders.map((extra) => extra.credentials)].find((credentials) => credentials.pid === pid);
      return sender === undefined ? null : factsOf(sender, label);
    },
    journaldPid: () => journaldPid,
    persistentStorage: () => true,
    filesystem: () => ({ sizeBytes: scenario.statvfs.blocks * scenario.statvfs.frsize, availableBytes: scenario.statvfs.bavail * scenario.statvfs.bsize }),
    trustedClock: () => true,
    schedule: (delayMs, callback) => {
      const timer: Timer = { due: clock.now + delayMs * 1000, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  const journald = new LinuxJournald(platform, settings, scenario.startEntries[0].seqnum);
  (journald as unknown as { bootId: string }).bootId = bootId;
  const driverRecords: JournalRecord[] = [];
  const spaceMessages: JournalRecord[] = [];
  journald.bind();
  for (const entry of scenario.startEntries.slice(0, -1)) {
    clock.now = entry.realtime;
    journald.copyEntry(entry.fields.map(([name, value]): [string, Uint8Array] => [name, Uint8Array.from(Buffer.from(value, 'base64'))]), entry.realtime, entry.monotonic, entry.bootId);
  }
  journald.onRecord((record) => {
    const transport = record.fields.find(([n]) => n === '_TRANSPORT');
    if (transport === undefined || Buffer.from(transport[1]).toString() !== 'driver') return;
    driverRecords.push(record);
    if (record.fields.some(([n, v]) => n === 'MESSAGE_ID' && Buffer.from(v).toString() === 'ec387f577b844b8fa948f33cad9a75e6')) spaceMessages.push(record);
  });
  const ucred = { pid: scenario.credentials.pid, uid: scenario.credentials.uid, gid: scenario.credentials.gid };
  clock.now = sample.realtime;
  journald.deliverNative(native([['MESSAGE', 'sample'], ['PRIORITY', '6'], ['SYSLOG_IDENTIFIER', 'sample']]), ucred, label, sample.realtime - 100);
  const timeline = [
    ...scenario.sends.map((send, index) => ({ at: send.at, bytes: payloadOf(scenario, index), ucred })),
    ...scenario.extraSenders.flatMap((extra) => extra.sends.map((send) => ({
      at: send.at, bytes: Uint8Array.from(Buffer.from(send.payload, 'base64')), ucred: { pid: extra.credentials.pid, uid: extra.credentials.uid, gid: extra.credentials.gid },
    }))),
  ].sort((a, b) => a.at - b.at);
  for (const send of timeline) {
    runTimers(send.at + 300);
    journald.deliverNative(send.bytes, send.ucred, label, send.at + 150);
  }
  const rotateAt = scenario.endedAt - 800_000;
  runTimers(rotateAt);
  if (scenario.name === 'size' || scenario.name === 'use' || scenario.name === 'keepfree-low') journald.rotate();
  runTimers(scenario.endedAt - 100_000);
  journald.stop();
  const files = journald.fileInfos().map((info): RecordedFile => ({
    name: info.path.slice(info.path.lastIndexOf('/') + 1), size: info.diskUsageBytes, state: info.state, headSeqnum: info.headSeqnum, tailSeqnum: info.tailSeqnum, objects: info.objects,
    entries: info.entries, data: info.data, fields: info.fields, entryArrays: info.entryArrays,
  }));
  return { journald, driverRecords, files, spaceMessages };
}

const stemOf = (name: string): string => name.replace(/\.journal$/, '').replace(/@.*/, '');
const shape = (file: RecordedFile): string => `${stemOf(file.name)} ${file.name.includes('@') ? 'archived' : 'active'} size=${file.size} entries=${file.entries} data=${file.data} fields=${file.fields} arrays=${file.entryArrays} objects=${file.objects} seq=${file.headSeqnum}-${file.tailSeqnum}`;
const ordered = (files: RecordedFile[]): RecordedFile[] => [...files].sort((a, b) => a.headSeqnum - b.headSeqnum || (a.name.startsWith('system@') ? -1 : 1));

const driverFields = (record: JournalRecord | RecordedEntry, names: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  const fields = 'realtimeUsec' in record ? record.fields.map(([n, v]) => [n, Buffer.from(v).toString('latin1')] as const) : record.fields.map(([n, v]) => [n, text(v)] as const);
  for (const [name, value] of fields) if (names.includes(name)) out[name] = value;
  return out;
};
const USAGE_ID = 'ec387f577b844b8fa948f33cad9a75e6';
const DROPPED_ID = 'a596d6fe7bfa4994828e72309e95d61e';
const isMessage = (entry: RecordedEntry, id: string): boolean => fieldOf(entry, 'MESSAGE_ID') === id;
const headOf = (name: string): string => name.startsWith('system@') ? name.split('-')[1] : 'active';

describe('journald space, rotation and vacuum against the real daemon', () => {
  for (const scenario of fixture.scenarios) {
    it(`${scenario.name}: the files left on disk are the real ones`, () => {
      const run = replay(scenario);
      expect(ordered(run.files).map(shape)).toEqual(ordered(scenario.files).map(shape));
    });
  }
});

describe('driver messages against the real daemon', () => {
  const usage = ['JOURNAL_NAME', 'JOURNAL_PATH', 'CURRENT_USE', 'MAX_USE', 'DISK_KEEP_FREE', 'LIMIT', 'AVAILABLE', 'MESSAGE'];
  for (const name of ['size', 'use', 'keepfree-low']) {
    it(`${name}: the disk space message written after a rotation carries the real numbers`, () => {
      const scenario = fixture.scenarios.find((s) => s.name === name) as Scenario;
      const run = replay(scenario);
      const real = scenario.drivers.filter((entry) => isMessage(entry, USAGE_ID)).map((entry) => driverFields(entry, usage));
      const simulated = run.spaceMessages.map((record) => driverFields(record, usage));
      expect(real.length).toBeGreaterThan(0);
      expect(simulated[simulated.length - 1]).toEqual(real[real.length - 1]);
    });
  }

  it('ratelimit: the suppression message counts what the real daemon counted, the sample sent before the flood using one slot of its pool', () => {
    const scenario = fixture.scenarios.find((s) => s.name === 'ratelimit') as Scenario;
    const run = replay(scenario);
    const names = ['MESSAGE', 'N_DROPPED', 'OBJECT_PID'];
    const real = scenario.drivers.filter((entry) => isMessage(entry, DROPPED_ID)).map((entry) => driverFields(entry, names));
    const simulated = run.driverRecords.filter((record) => record.fields.some(([n, v]) => n === 'MESSAGE_ID' && Buffer.from(v).toString() === DROPPED_ID)).map((record) => driverFields(record, names));
    expect(real).toHaveLength(1);
    expect(simulated).toEqual(real);
  });
});

describe('journalctl --vacuum against the real binary', () => {
  const scenario = fixture.scenarios.find((s) => s.name === 'fill') as Scenario;
  for (const recorded of scenario.vacuums) {
    it(`${recorded.args.join(' ')} keeps the files the real journalctl kept`, () => {
      const run = replay(scenario);
      const argument = recorded.args[0];
      const value = argument.split('=')[1];
      const spec = { size: 0, files: 0, time: 0 };
      if (argument.startsWith('--vacuum-files')) spec.files = Number(value);
      else if (argument.startsWith('--vacuum-size')) spec.size = value.endsWith('M') ? Number(value.slice(0, -1)) * 1024 * 1024 : Number(value.slice(0, -1)) * 1024;
      else spec.time = Number(value.slice(0, -1)) * 1_000_000;
      const afterClock = run.journald.fileInfos();
      expect(afterClock.length).toBe(recorded.before.length);
      run.journald.vacuum(spec);
      const kept = run.journald.fileInfos().map((info) => headOf(info.path.slice(info.path.lastIndexOf('/') + 1))).sort();
      expect(kept).toEqual(recorded.after.map(headOf).sort());
    });
  }
});
