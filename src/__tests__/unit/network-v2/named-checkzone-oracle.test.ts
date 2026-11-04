/*
 * named-checkzone against the real tool (BIND 9.18.39, bind9utils of Ubuntu 24.04): scripts/oracle/record_named_checkzone.py ran it on the zone file of banquehorizon.com of
 * labs/dns-agence-bancaire and on 27 variants, each broken in one way (an unknown record type, an IPv4 address with a byte of 999, a short one, a word that is no address, a record without
 * rdata, text after the rdata of an A, a CNAME and an MX, a CNAME next to another type, a CNAME at the apex, no NS, no SOA, an SOA with a field missing, an MX without exchange, an MX that is an
 * address, a bad $TTL, an SRV with a field missing, a name outside the zone, a bad AAAA, a PTR without target, an unterminated string), plus six that exercise the reading itself: three mistakes in
 * one file (the tool reports every locator, in file order, then repeats the FIRST reason in the line that names the zone), a bad value inside a parenthesised record (the line is the one of the
 * value), extra text and a missing exchange inside parentheses (the line the tool reports is the one of the word that PRECEDES the faulty one, and `near eol` the one of the last word, not the one of the closing parenthesis), an SOA over several lines that lacks a field and the same SOA written with unit TTLs (`2h`, `15m`, `2w`, `1h`), which is valid.
 * The replay writes the same files on a Linux server and compares, line by line, what `named-checkzone banquehorizon.com <file>` prints, the path of the file written <file>: the line and the
 * word where the parser stopped (`<file>:12: near '203.0.113.999': bad dotted quad`), the reason repeated in the line that names the zone, the closing `not loaded due to errors.`, the checks made
 * after the load (`has no NS records`, `has 0 SOA records`, `CNAME and other data`), the warnings that do not stop the load (`MX is an address`, `ignoring out-of-zone data`) and the final
 * `loaded serial` + `OK`.
 * The exit status is replayed too (`; echo rc=$?`: 0 for a zone that loads, 1 for one that does not).
 * Measured before the change (git stash push -- src/network): 26 of the 29 tests fall; the 3 that pass either way are the WITNESS, the valid zone and the valid SOA written over several lines with unit TTLs
 * (the old reader took `2h` for 2 and the checker prints only the serial, so the line it writes is the same: a NON-REGRESSION that does not prove the units, which the next test of dns-zone-file does).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Case { readonly zone: string; readonly rc: number; readonly stdout: string; readonly stderr: string }
interface Fixture { readonly 'named-checkzone': string; readonly cases: Readonly<Record<string, Case>> }

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/named-checkzone-9.18.json', import.meta.url), 'utf8')) as Fixture;
const FILE = '/etc/bind/db.banquehorizon.com';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function checked(zone: string): Promise<string> {
  const server = new LinuxServer('linux-server', 'NS1');
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(FILE, zone, 0, 0, 0o022);
  const output = await server.executeCommand(`named-checkzone banquehorizon.com ${FILE}; echo rc=$?`);
  return output.split(FILE).join('<file>').trimEnd();
}

describe('named-checkzone against the real tool', () => {
  it('WITNESS: the fixture holds the valid zone, a valid multi-line SOA and 26 broken variants', () => {
    expect(Object.keys(fixture.cases)).toHaveLength(28);
    expect(fixture.cases['valid'].rc).toBe(0);
    expect(fixture.cases['bad-ipv4'].rc).toBe(1);
  });

  for (const [name, entry] of Object.entries(fixture.cases)) {
    it(`${name}: prints what the real tool prints`, async () => {
      expect(await checked(entry.zone)).toBe(`${entry.stdout}${entry.stderr}`.trimEnd() + `\nrc=${entry.rc}`);
    });
  }
});
