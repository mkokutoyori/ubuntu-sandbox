/*
 * Oracle: the ingestion half of systemd-journald 255.4 (Ubuntu 24.04 binary).  scripts/oracle/record_journal_corpus.py starts the real
 * daemon and writes to its three sockets - native protocol datagrams, syslog datagrams on /dev/log, and stdout streams - from processes
 * placed in cgroups, logging every payload together with the credentials of the sender and of its parent read from /proc;
 * scripts/oracle/record_journald_ingest.py pairs those sends with the entries the daemon stored (field order included) and with the
 * counters of its journal files.  The same payloads are replayed through JournaldServer into a JournalFileSet and compared field by field,
 * in order, then the file counters (entries, data, fields, entry arrays, objects) are compared with the header of the real file.
 * Inputs taken from the recording because the daemon fixes them itself: the realtime and monotonic stamp of each entry, the kernel receive
 * time that becomes _SOURCE_REALTIME_TIMESTAMP, the random _STREAM_ID of a stream, and journald's own driver messages, which are
 * appended verbatim so that the data objects they create exist in the file as they did in the real one.
 * The files of the first two boots hold two data objects (the boot id and the pid of the next daemon) that no entry references: when the
 * next daemon starts it finds a different sequence number id, its first append creates its data in the old file and fails, and it
 * rotates; registerOrphans reproduces that from the first entry of the following boot.
 * Measured before the port (modules absent, git stash push -u -- src/network): every case falls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { JournaldServer, type JournaldHost, type ProcessFacts, DEFAULT_JOURNALD_SETTINGS } from '@/network/devices/linux/journal/JournaldServer';
import { JournalFileSet } from '@/network/devices/linux/journal/JournalFileSet';

interface Credentials {
  pid: number; uid: number; gid: number; comm: string; exe: string; cmdline: string; capeff: string; cgroup: string; loginuid: string; sessionid: string;
}
interface Send {
  boot: number;
  kind: 'native' | 'syslog' | 'stdout';
  payload: string;
  credentials: Credentials;
  parent: Credentials;
}
interface Entry {
  realtime: number;
  monotonic: number;
  bootId: string;
  fields: Array<[string, string]>;
}
interface Header {
  path: string; fileId: string; seqnumId: string; bootId: string; headSeqnum: number; entries: number; data: number; fields: number; entryArrays: number; objects: number;
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/journald-ingest-255.4.json', 'utf8')) as { machineId: string; sends: Send[]; entries: Entry[]; headers: Header[] };
const decode = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'base64'));
const field = (entry: Entry, name: string): string | null => {
  const found = entry.fields.find(([n]) => n === name);
  return found ? Buffer.from(found[1], 'base64').toString('latin1') : null;
};
const itemOf = (name: string, value: string): Uint8Array => Uint8Array.from(Buffer.concat([Buffer.from(`${name}=`), Buffer.from(value, 'base64')]));

const bootIds = [...new Set(fixture.entries.map(e => e.bootId))];
const label = Uint8Array.from(Buffer.from(field(fixture.entries.find(e => field(e, '_SELINUX_CONTEXT') !== null)!, '_SELINUX_CONTEXT') as string, 'latin1'));

function factsOf(credentials: Credentials): ProcessFacts {
  return {
    uid: credentials.uid, gid: credentials.gid, comm: credentials.comm, exe: credentials.exe, cmdline: credentials.cmdline,
    capeff: credentials.capeff.replace(/^0+/, ''), label,
    auditId: credentials.sessionid === '4294967295' ? null : Number(credentials.sessionid), loginUid: credentials.loginuid === '4294967295' ? null : Number(credentials.loginuid),
    cgroup: credentials.cgroup, invocationId: null,
  };
}

interface Outcome {
  send: number;
  produced: Array<[string, string]>[];
  expected: Array<[string, string]>[];
}

function replay(boot: number): { outcomes: Outcome[]; header: Header; counters: ReturnType<ReturnType<typeof newSet>['current']['info']>; leftover: number } {
  const bootId = bootIds[boot];
  const header = fixture.headers.find(h => h.bootId === bootId)!;
  const queue = fixture.entries.filter(e => e.bootId === bootId);
  const set = newSet(header);
  const probes = new Map<number, ProcessFacts>();
  for (const send of fixture.sends.filter(s => s.boot === boot)) {
    probes.set(send.credentials.pid, factsOf(send.credentials));
    probes.set(send.parent.pid, factsOf(send.parent));
  }
  let current = -1;
  let produced: Array<[string, string]>[] = [];
  let expectedNow: Array<[string, string]>[] = [];
  const host: JournaldHost = {
    probe: pid => probes.get(pid) ?? null,
    identity: () => ({ bootId, machineId: fixture.machineId, hostname: 'vm' }),
    cgroupRoot: () => '/',
    newStreamId: () => {
      const next = queue.find(e => field(e, '_STREAM_ID') !== null);
      return next === undefined ? '00000000000000000000000000000000' : (field(next, '_STREAM_ID') as string);
    },
    write: items => {
      const expected = queue.shift();
      const record = set.append(items, expected?.realtime ?? 0, expected?.monotonic ?? 0, bootId);
      produced.push(record.fields.map(([name, value]) => [name, Buffer.from(value).toString('base64')]));
      expectedNow.push(expected === undefined ? [['<nothing stored>', '']] : expected.fields);
    },
  };
  const server = new JournaldServer(host, DEFAULT_JOURNALD_SETTINGS);
  const outcomes: Outcome[] = [];
  const drain = (): void => {
    while (queue.length > 0 && field(queue[0], '_TRANSPORT') === 'driver') {
      const entry = queue.shift() as Entry;
      set.append(entry.fields.map(([name, value]) => itemOf(name, value)), entry.realtime, entry.monotonic, bootId);
    }
  };
  fixture.sends.forEach((send, index) => {
    if (send.boot !== boot) return;
    current = index;
    drain();
    produced = [];
    expectedNow = [];
    const ucred = { pid: send.credentials.pid, uid: send.credentials.uid, gid: send.credentials.gid };
    const upcoming = queue[0];
    const source = upcoming ? field(upcoming, '_SOURCE_REALTIME_TIMESTAMP') : null;
    const tv = source === null ? null : Number(source);
    if (send.kind === 'native') server.processNative(decode(send.payload), ucred, tv, null);
    else if (send.kind === 'syslog') server.processSyslog(decode(send.payload), ucred, tv, null);
    else {
      const stream = server.openStdoutStream(ucred, null);
      stream.feed(decode(send.payload));
      stream.close();
    }
    outcomes.push({ send: current, produced, expected: expectedNow });
  });
  drain();
  const next = fixture.entries.find(e => e.bootId === bootIds[boot + 1]);
  if (next !== undefined) set.current.registerOrphans(next.fields.map(([name, value]) => itemOf(name, value)));
  return { outcomes, header, counters: set.current.info(), leftover: queue.length };
}

function newSet(header: Header): JournalFileSet {
  return new JournalFileSet(() => ({ path: header.path, fileId: header.fileId, seqnumId: header.seqnumId, machineId: fixture.machineId }), header.headSeqnum);
}

describe('journald ingestion against the real daemon', () => {
  it('replays a witness set', () => {
    expect(fixture.sends.length).toBeGreaterThan(200);
    expect(new Set(fixture.sends.map(s => s.kind))).toEqual(new Set(['native', 'syslog', 'stdout']));
  });
  bootIds.forEach((_, boot) => {
    const run = replay(boot);
    for (const outcome of run.outcomes) {
      const send = fixture.sends[outcome.send];
      const preview = Buffer.from(send.payload, 'base64').toString('latin1').slice(0, 50).replace(/[^\x20-\x7e]/g, '.');
      it(`boot ${boot + 1} ${send.kind} #${outcome.send} ${preview}`, () => {
        expect(outcome.produced).toEqual(outcome.expected);
      });
    }
    it(`boot ${boot + 1} leaves no stored entry unexplained and matches the file counters`, () => {
      expect(run.leftover).toBe(0);
      expect({ entries: run.counters.entries, data: run.counters.data, fields: run.counters.fields, entryArrays: run.counters.entryArrays, objects: run.counters.objects })
        .toEqual({ entries: run.header.entries, data: run.header.data, fields: run.header.fields, entryArrays: run.header.entryArrays, objects: run.header.objects });
    });
  });
});
