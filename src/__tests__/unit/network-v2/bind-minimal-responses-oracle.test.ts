/**
 * `minimal-responses` against a real BIND 9.18 (9.18.39, Ubuntu 24.04): scripts/oracle/record_bind_minimal_responses.py started a named authoritative for example.test on 127.0.0.1 once per pair
 * (recursion yes|no) x (minimal-responses no|yes|no-auth|no-auth-recursive) and had the real dig ask six questions (A of the apex, MX with its glue, NS, a CNAME, an NXDOMAIN, a NODATA), each with and without the RD
 * flag, printing the header comments and the three record sections. The replay builds a LinuxPC and a LinuxServer, gives the server the same zone and the same options, asks the same questions with dig and compares
 * the flags line (the counts) and the records of each section; the order of the records inside a section is not compared (BIND rotates a set, the real answer for the same question came in both orders).
 * Measured: `no` writes the apex NS in the authority and the addresses of the targets of the answer AND of those name servers in the additional section; `yes` keeps the answer alone (and the SOA of a negative
 * answer); `no-auth` drops the authority and keeps the additional addresses the answer needs (not those of the omitted name servers); `no-auth-recursive` does the same when the RD flag is set, whether or not the
 * server recurses, and nothing otherwise.
 * Also measured: an NS question is answered with the apex NS in the answer section and never again in the authority section, and its addresses stay in the additional section under every value including `yes`; the
 * OPT of the answer advertises 1232 bytes (`edns-udp-size`), where the simulator said 4096.
 * Measured before the change (git stash push -- src/network): 9 of the 10 tests fall, each at its first wrong question (the server wrote no authority section, advertised 4096 and kept the additional
 * addresses of the answer only); the one that passes either way is the WITNESS that the fixture holds the four values for both recursion settings and both RD settings.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Case {
  readonly recursion: boolean;
  readonly setting: string;
  readonly question: readonly string[];
  readonly recurse: boolean;
  readonly output: string;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bind-minimal-responses-9.18.json', import.meta.url), 'utf8')) as { readonly zone: string; readonly cases: readonly Case[] };

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function writeRoot(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

function namedConf(recursion: boolean, setting: string): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    `  recursion ${recursion ? 'yes' : 'no'};`,
    '  allow-query { any; };',
    '  allow-recursion { any; };',
    '  dnssec-validation no;',
    '  empty-zones-enable no;',
    `  minimal-responses ${setting};`,
    '};',
    'zone "example.test" { type primary; file "/etc/bind/db.example"; };',
    '',
  ].join('\n');
}

async function lab(recursion: boolean, setting: string): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const server = new LinuxServer('linux-server', 'NS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  server.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
  writeRoot(server, '/etc/bind/named.conf', namedConf(recursion, setting));
  writeRoot(server, '/etc/bind/db.example', fixture.zone);
  await server.executeCommand('systemctl start named');
  return pc;
}

const NOISE = /^(;; ->>HEADER<<-|; COOKIE:)/;

function normalised(output: string): string[] {
  const lines: string[] = [];
  let records: string[] = [];
  const flush = () => { lines.push(...records.sort()); records = []; };
  for (const line of output.split('\n')) {
    if (NOISE.test(line) || line.trim() === '') continue;
    if (line.startsWith(';')) { flush(); lines.push(line); } else records.push(line.replace(/\s+/g, ' '));
  }
  flush();
  return lines;
}

describe('minimal-responses against the real BIND', () => {
  it('WITNESS: the fixture holds the four values for both recursion settings and both RD settings', () => {
    expect(fixture.cases).toHaveLength(96);
    expect(new Set(fixture.cases.map((entry) => entry.setting))).toEqual(new Set(['no', 'yes', 'no-auth', 'no-auth-recursive']));
  });

  it('WITNESS: the default (no) writes the name servers and their addresses next to the answer', async () => {
    const pc = await lab(false, 'no');
    const text = await pc.executeCommand('dig @10.0.1.10 example.test MX +noall +comments +answer +authority +additional');
    expect(text).toContain('AUTHORITY SECTION');
    expect(text).toMatch(/ns1\.example\.test\.\s+3600\s+IN\s+A\s+192\.0\.2\.1/);
  });

  for (const recursion of [true, false]) {
    for (const setting of ['no', 'yes', 'no-auth', 'no-auth-recursive']) {
      it(`recursion ${recursion ? 'yes' : 'no'}, minimal-responses ${setting}: every question gets the sections the real server writes`, async () => {
        const pc = await lab(recursion, setting);
        for (const entry of fixture.cases.filter((candidate) => candidate.recursion === recursion && candidate.setting === setting)) {
          const asked = `dig @10.0.1.10 ${entry.question.join(' ')} +noall +comments +answer +authority +additional ${entry.recurse ? '+recurse' : '+norecurse'}`;
          const text = await pc.executeCommand(asked);
          expect(normalised(text), asked).toEqual(normalised(entry.output));
        }
      });
    }
  }
});
