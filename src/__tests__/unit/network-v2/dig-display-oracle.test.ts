/*
 * Oracle - what dig prints, option by option, replayed against a real dig 9.18.39. scripts/oracle/record_dig_display.py answers on 127.0.0.1:5353 with three crafted replies (an alias with two name
 * servers, their glue and an OPT record; an NXDOMAIN with a SOA; an empty NOERROR with a SOA) and runs the real dig on each of 42 option combinations, three alignment names included: 126 cases, plus 7 failures (a server that stays silent, a closed port) whose messages and banner are compared too.
 * The reply bytes are in the fixture src/__tests__/support/oracle/dig-display-9.18.json, so the replay decodes the very message the real dig decoded and hands it to executeDig through its
 * transport port; what is compared is the text, line for line, with the TTLs and the data of the records as dig printed them.
 *
 * What the real dig does, as recorded: the banner (`+cmd`) starts with a blank line, names the version and, when a server was given with @, `(1 server found)`; `+comments` carries the header, the
 * flags, the OPT pseudo-section, the section titles and the blank lines between sections; the question, the three sections and the statistics each have their own flag; `+noall` clears all seven and
 * `+all` sets them; `+short` clears all but the answer and prints the data only, whatever flag follows it for the other sections, but a later `+noall` empties it; records and the question are laid out
 * on the tab stops of BIND's master style (name column 24 for a record, 32 for a question) and fall back to one space past the column; the statistics end with a blank line and name the transport
 * `(UDP)`; the date reads `Tue Nov 03 16:15:34 UTC 2026`.
 * Masked on both sides, because they are not the same machine's: the version after DiG, the message id, the query time, the date, and the size after MSG SIZE (the simulated dig measures its own
 * encoding; the crafted reply is not compressed).
 *
 * Measured first (git stash push -- src/network): 134 tests, 102 fall. The 32 that pass either way: the WITNESS on the recording, the `+short` family (data only, which the old code already did) and the
 * `+noall +answer` family (answers alone, laid out on the single tab the old code already used for names of 16 characters), on each of the three replies. All 7 failures fall: the old dig wrote
 * `;; connection timed out; no servers could be reached` (the wording of 9.11) once, with no version in the banner, and none of the per-try `;; communications error` lines.
 * Named and not compared: `+tcp` against a closed port (the real dig prints `;; Connection to ... failed: connection refused.` and no banner; the simulated transport does not tell a refusal from a
 * silence over TCP) and `+trace`; both in TODO.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { executeDig } from '@/network/devices/linux/commands/dns/DigRunner';
import { decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { rrTypeFromName } from '@/network/dns/compat/DnsWireCompat';
import { DnsClass } from '@/network/dns/wire/RRType';

interface Case { readonly name: string; readonly options: readonly string[]; readonly output: string; readonly errors: string }
interface Failure { readonly kind: string; readonly port: number; readonly options: readonly string[]; readonly output: string }
interface Fixture { readonly dig: string; readonly shapes: Readonly<Record<string, string>>; readonly cases: readonly Case[]; readonly failures: readonly Failure[] }

const fixture: Fixture = JSON.parse(readFileSync(new URL('../../support/oracle/dig-display-9.18.json', import.meta.url), 'utf8'));
const SHAPE_OF: Readonly<Record<string, string>> = { 'absent.example.org': 'nxdomain', 'nodata.example.org': 'nodata' };

function replyFor(entry: Case): DnsMessage {
  const bytes = Uint8Array.from(Buffer.from(`1234${fixture.shapes[SHAPE_OF[entry.name] ?? 'full']}`, 'hex'));
  const asked = entry.options.includes('-t') ? entry.options[entry.options.indexOf('-t') + 1] : 'A';
  return { ...decodeDnsMessage(bytes), questions: [{ qname: entry.name, qtype: rrTypeFromName(asked)!, qclass: DnsClass.IN }] };
}

function masked(text: string): string {
  return text
    .replace(/(<<>> DiG )\S+( <<>>)/, '$1VERSION$2')
    .replace(/(status: \w+, id: )\d+/, '$1ID')
    .replace(/(Query time: )\d+( msec)/, '$1N$2')
    .replace(/(WHEN: )[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} UTC \d{4}/, '$1DATE')
    .replace(/(MSG SIZE {2}rcvd: )\d+/, '$1N');
}

async function replay(entry: Case): Promise<string> {
  const reply = replyFor(entry);
  const query = async (): Promise<DnsMessage> => ({ ...reply, id: 0x1234 });
  const args = ['@127.0.0.1', '-p', '5353', entry.name, ...entry.options, '+tries=1', '+time=2'];
  const printed = await executeDig(args, query as never);
  return printed.length > 0 ? `${printed}\n` : '';
}

describe('Oracle - dig display options against the real dig 9.18', () => {
  it('WITNESS: the recording holds 126 cases and 7 failures of a real dig 9.18 and no diagnostic on stderr', () => {
    expect(fixture.dig).toContain('DiG 9.18');
    expect(fixture.cases).toHaveLength(126);
    expect(fixture.failures).toHaveLength(7);
    expect(fixture.cases.filter((entry) => entry.errors !== '')).toEqual([]);
    expect(Object.keys(fixture.shapes).sort()).toEqual(['full', 'nodata', 'nxdomain']);
  });

  it.each(fixture.failures.map((entry) => [`${entry.kind} ${entry.options.join(' ')}`.trim(), entry] as const))('failure: %s', async (_label, entry) => {
    const query = async (...asked: unknown[]): Promise<null> => {
      if (entry.kind === 'refused') (asked[4] as { onTransportFailure?: (reason: string) => void }).onTransportFailure?.('refused');
      return null;
    };
    const printed = await executeDig(['@127.0.0.1', '-p', String(entry.port), 'example.org', ...entry.options, '+time=1'], query as never);
    expect(masked(`${printed}\n`)).toBe(masked(entry.output));
  });

  it.each(fixture.cases.map((entry) => [`${entry.name} ${entry.options.join(' ')}`.trim(), entry] as const))('%s', async (_label, entry) => {
    expect(masked(await replay(entry))).toBe(masked(entry.output));
  });
});
