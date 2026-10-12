/*
 * Oracle: journalctl 255.4 (Ubuntu 24.04 binary).  scripts/oracle/record_journal_corpus.py runs the real systemd-journald
 * three times (three boot ids and clocks, senders placed in cgroups so _SYSTEMD_UNIT resolves) and scripts/oracle/record_journalctl.py
 * replays hundreds of journalctl invocations over that offline journal with --directory, the realtime clock and TZ pinned by
 * scripts/oracle/last_shim.c.  The entries of the corpus, with their field order recovered from -o verbose, are loaded into
 * a JournalctlHost and the same argv is replayed through runJournalctl; stdout, stderr and the exit status are compared.
 * Measured before the port (module absent, git stash push -u -- src/network): every case falls.
 * Comparisons that are not byte for byte, each for a reason of the binary and not of the port: the JSON modes compare the
 * parsed entries, because the real tool walks a hash map seeded at random and emits the keys in a different order on every
 * run; -N compares the sorted set of names for the same reason (the real order is the hash table's).
 * Two cases read file internals that the port does not model: --header is replayed from the counters printed by the binary (the
 * formatting is checked, the counters are inputs) and --verify is compared on its PASS lines only, the binary adding
 * 'Unused data (entry_offset==0)' lines that describe hash-chain bookkeeping of the real files.
 * Not recorded because they would change the machine (--rotate, --flush, --sync, --vacuum-*, --setup-keys) or print a random value
 * (--new-id128).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runJournalctl, type JournalctlHost, type JournalFileInfo, type PathStat } from '@/network/devices/linux/journal/JournalctlTool';
import { systemdCatalog } from '@/network/devices/linux/journal/Catalog';
import type { JournalRecord } from '@/network/devices/linux/journal/JournalRecord';

interface RecordedEntry {
  cursor: string;
  realtime: number;
  monotonic: number;
  seqnum: number;
  seqnumId: string;
  bootId: string;
  fields: Array<[string, string]>;
}
interface Recorded {
  zone: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  cursorFile?: { before: string; after: string };
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/journalctl-255.4.json', 'utf8')) as { now: number; entries: RecordedEntry[]; results: Recorded[] };
const DIRECTORY = '/tmp/jcorpus/journal';

const records: JournalRecord[] = fixture.entries.map(entry => ({
  fields: entry.fields.map(([name, value]) => [name, Uint8Array.from(Buffer.from(value, 'base64'))] as const),
  realtimeUsec: entry.realtime,
  monotonicUsec: entry.monotonic,
  seqnum: entry.seqnum,
  seqnumId: entry.seqnumId,
  bootId: entry.bootId,
  xorHash: /;x=([0-9a-f]+)$/.exec(entry.cursor)![1],
}));

function parseHeaders(output: string): JournalFileInfo[] {
  return output.split('\n\n').filter(block => block.trim() !== '').map(block => {
    const get = (label: string): string => new RegExp(`^${label}: (.*)$`, 'm').exec(block)![1];
    const stamp = (label: string): number => parseInt(/\(([0-9a-f]+)\)$/.exec(get(label))![1], 16);
    const flags = (label: string): string[] => (new RegExp(`^${label}:(.*)$`, 'm').exec(block)![1].trim().split(' ').filter(word => word !== ''));
    const spanUsec = /\(([0-9a-f]+)\)$/.exec(get('Tail monotonic timestamp'))![1];
    return {
      path: get('File path'), fileId: get('File ID'), machineId: get('Machine ID'), bootId: get('Boot ID'), seqnumId: get('Sequential number ID'),
      state: get('State') as JournalFileInfo['state'], compatibleFlags: flags('Compatible flags'), incompatibleFlags: flags('Incompatible flags'),
      headerSize: Number(get('Header size')), arenaSize: Number(get('Arena size')), dataHashTableSize: Number(get('Data hash table size')),
      fieldHashTableSize: Number(get('Field hash table size')), rotateSuggested: get('Rotate suggested') === 'yes',
      headSeqnum: Number(get('Head sequential number').split(' ')[0]), tailSeqnum: Number(get('Tail sequential number').split(' ')[0]),
      headRealtime: stamp('Head realtime timestamp'), tailRealtime: stamp('Tail realtime timestamp'), tailMonotonic: parseInt(spanUsec, 16),
      objects: Number(get('Objects')), entries: Number(get('Entry objects')), data: Number(get('Data objects')), fields: Number(get('Field objects')),
      tags: Number(get('Tag objects')), entryArrays: Number(get('Entry array objects')), fieldHashChainDepth: Number(get('Deepest field hash chain')),
      dataHashChainDepth: Number(get('Deepest data hash chain')), diskUsageBytes: 8 * 1024 * 1024,
    };
  });
}

function hostFor(zone: string, files: Map<string, string>, journalFiles: JournalFileInfo[] = []): JournalctlHost {
  return {
    files: () => journalFiles,
    varlink: () => ({ connectErrno: 'ECONNREFUSED' }),
    vacuum: () => [],
    flushed: () => true,
    newId128: () => '628b450012204471862fd18115d15fd4',
    records: () => records,
    journalDirectory: () => DIRECTORY,
    hasJournalFiles: () => true,
    nowUsec: () => fixture.now * 1_000_000,
    zoneName: () => zone,
    uid: () => 0,
    canReadJournal: () => true,
    currentBootId: () => '6ad7c9e62bea48b2818fa072a4931be8',
    columns: () => 80,
    hasPersistentStorage: () => true,
    statPath: (path): PathStat => {
      if (path === '/usr/bin/python3.11') return { kind: 'regular', executable: true, interpreter: null, interpreterIsLink: false, name: 'python3.11' };
      if (path === '/dev/null') return { kind: 'device', matches: ['_KERNEL_DEVICE=c1:3'] };
      if (path.startsWith('/nonexistent')) return { errno: 'ENOTDIR' };
      return { errno: 'ENOENT' };
    },
    readFile: path => files.get(path) ?? null,
    writeFile: (path, content) => {
      files.set(path, content);
      return null;
    },
    catalog: () => systemdCatalog(),
    locale: () => ({ messages: 'C', utf8: false }),
    updateCatalog: () => null,
    diskUsageBytes: () => 25165824,
  };
}

const text = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

function canonicalJson(output: string, mode: string): unknown {
  output = output.replace(/^-- cursor: .*\n/m, '');
  if (/^\[/.test(output.replace(/^(data: |\x1e)/, ''))) return JSON.parse(output.replace(/^(data: |\x1e)/, ''));
  const body = mode === 'json-sse' ? output.split('\n\n').filter(piece => piece !== '').map(piece => piece.replace(/^data: /, ''))
    : mode === 'json-seq' ? output.split('\x1e').filter(piece => piece !== '') : mode === 'json-pretty' ? splitPretty(output) : output.split('\n').filter(piece => piece !== '');
  return body.map(piece => JSON.parse(piece));
}

function splitPretty(output: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < output.length; i++) {
    if (output[i] === '"') {
      i++;
      while (output[i] !== '"') i += output[i] === '\\' ? 2 : 1;
    } else if (output[i] === '{') depth++;
    else if (output[i] === '}' && --depth === 0) {
      pieces.push(output.slice(start, i + 1));
      start = i + 1;
    }
  }
  return pieces;
}

const jsonModes = ['json', 'json-pretty', 'json-sse', 'json-seq'];

describe('journalctl 255.4 against the real binary', () => {
  it('replays a witness set', () => {
    expect(fixture.results.length).toBeGreaterThan(900);
    expect(fixture.results.filter(r => r.exitCode !== 0).length).toBeGreaterThan(40);
    expect(fixture.results.filter(r => r.exitCode === 0 && text(r.stdout).length > 0).length).toBeGreaterThan(600);
  });
  for (const recorded of fixture.results) {
    const label = `${recorded.zone} ${recorded.args.join(' ')}`;
    it(label, () => {
      const files = new Map<string, string>();
      if (recorded.cursorFile) files.set('/cursor-file', recorded.cursorFile.before);
      const infos = recorded.args.includes('--header') ? parseHeaders(text(recorded.stdout)) : recorded.args.includes('--verify')
        ? [...text(recorded.stderr).matchAll(/^PASS: (.*)$/gm)].map(match => ({ path: match[1] } as JournalFileInfo)) : [];
      const result = runJournalctl(hostFor(recorded.zone, files, infos), [`--directory=${DIRECTORY}`, '--no-pager', ...recorded.args.map(a => a.replace('@CF@', '/cursor-file'))]);
      if (recorded.cursorFile) expect(files.get('/cursor-file')).toBe(recorded.cursorFile.after);
      const mode = recorded.args.includes('-o') ? recorded.args[recorded.args.indexOf('-o') + 1] : recorded.args.find(a => a.startsWith('--output='))?.slice(9) ?? '';
      expect(result.exitCode).toBe(recorded.exitCode);
      expect(result.stderr).toBe(recorded.args.includes('--verify') ? text(recorded.stderr).split('\n').filter(line => line.startsWith('PASS: ')).join('\n') + '\n' : text(recorded.stderr));
      if (jsonModes.includes(mode) && recorded.exitCode === 0) {
        expect(result.stdout.match(/^-- cursor: .*$/m)?.[0]).toBe(text(recorded.stdout).match(/^-- cursor: .*$/m)?.[0]);
        expect(canonicalJson(result.stdout, mode)).toEqual(canonicalJson(text(recorded.stdout), mode));
      } else if (recorded.args.includes('-N') || recorded.args.includes('--fields')) {
        expect(result.stdout.split('\n').sort()).toEqual(text(recorded.stdout).split('\n').sort());
      } else expect(result.stdout).toBe(text(recorded.stdout));
    });
  }
});
