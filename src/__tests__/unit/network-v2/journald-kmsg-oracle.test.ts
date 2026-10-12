/*
 * Oracle: the kernel-message half of systemd-journald 255.4 (Ubuntu 24.04 binary).  scripts/oracle/record_journald_kmsg.py writes
 * probes to the real /dev/kmsg (prefixes, facilities, identifiers with and without pid, escapes, a long line), reads the whole ring back
 * in the kernel's own record format, then runs the real daemon with ReadKMsg=yes and stores the entries it made.  Every ring record is
 * replayed through JournaldServer.processKmsg into a JournalFileSet and compared with its entry, field by field, in order.  The
 * monotonic and realtime stamps are taken from the recording because the daemon derives them from the boot clock.
 * Measured before the port (processKmsg absent, git stash push -u -- src/network): every record falls except the case-count witness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { JournaldServer, type JournaldHost, DEFAULT_JOURNALD_SETTINGS } from '@/network/devices/linux/journal/JournaldServer';
import { JournalFileSet } from '@/network/devices/linux/journal/JournalFileSet';

interface Entry { realtime: number; monotonic: number; bootId: string; fields: Array<[string, string]> }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/journald-kmsg-255.4.json', 'utf8')) as { machineId: string; bootId: string; ring: string[]; entries: Entry[] };

describe('journald kmsg ingestion 255.4 oracle', () => {
  it('stores every kernel record exactly as the real daemon did', () => {
    const set = new JournalFileSet(() => ({ path: '/x/system.journal', fileId: '0', seqnumId: '0', machineId: fixture.machineId }), 1);
    let index = 0;
    const failures: string[] = [];
    const host: JournaldHost = {
      probe: () => null,
      identity: () => ({ bootId: fixture.bootId, machineId: fixture.machineId, hostname: 'vm' }),
      cgroupRoot: () => '/',
      newStreamId: () => '0'.repeat(32),
      write: items => {
        const expected = fixture.entries[index];
        const record = set.append(items, expected.realtime, expected.monotonic, fixture.bootId);
        const produced = record.fields.map(([name, value]) => [name, Buffer.from(value).toString('base64')]);
        if (JSON.stringify(produced) !== JSON.stringify(expected.fields)) {
          const show = (fields: Array<[string, string]> | string[][]): string => JSON.stringify(fields.map(([n, v]) => [n, Buffer.from(v, 'base64').toString('latin1').slice(0, 60)]));
          failures.push(`#${index} ${JSON.stringify(Buffer.from(fixture.ring[index], 'base64').toString('latin1').slice(0, 100))}\n got ${show(produced as string[][])}\nwant ${show(expected.fields)}`);
        }
        index++;
      },
    };
    const server = new JournaldServer(host, DEFAULT_JOURNALD_SETTINGS);
    for (const record of fixture.ring) server.processKmsg(Uint8Array.from(Buffer.from(record, 'base64')));
    expect(index).toBe(fixture.ring.length);
    expect(failures.length, failures.slice(0, 4).join('\n')).toBe(0);
  });

  it('WITNESS -- the fixture carries probes of every shape', () => {
    expect(fixture.ring.length).toBeGreaterThan(400);
    const text = fixture.ring.map(r => Buffer.from(r, 'base64').toString('latin1')).join('');
    expect(text).toContain('#kt15');
    expect(text).toContain('SUBSYSTEM=');
  });
});
