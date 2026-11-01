/*
 * Structure — the text of dns.log, line by line, for the writer alone (no network): the stamp in the machine's zone in the
 * 12-hour form the transcripts show (month, day and hour without a leading zero, minutes and seconds with one, AM at
 * midnight is 12), the thread, the packet marker, the packet identifier shared by the two directions of an exchange, the
 * route (UDP/TCP, Snd/Rcv, the remote address padded to 15), the Xid, the response mark, the opcode letter, the flags in
 * the Windows internal order (the wire word with its bytes swapped) and their letters, the response code, the question
 * type padded to 6 and the name in length-prefixed labels; the four filters of DNS_LOG_LEVELS; the restart at the maximum
 * size, taken at the byte. Discrimination (run on the tree before the change): every case falls, the writer did not
 * exist.
 */
import { describe, it, expect } from 'vitest';
import { DnsDebugLog, type DnsLogFileSink } from '@/network/devices/windows/server/dns/DnsDebugLog';
import type { DnsDebugLogSettings } from '@/network/devices/windows/server/dns/DnsServerDiagnostics';
import type { DnsPacketEvent } from '@/network/dns/transport/DnsPacketObserver';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const EVERYTHING = 0x1 | 0x10 | 0x20 | 0x100 | 0x200 | 0x1000 | 0x2000 | 0x4000 | 0x8000;
const PATH = 'C:\\Windows\\System32\\dns\\dns.log';

class MemoryFiles implements DnsLogFileSink {
  readonly files = new Map<string, string>();
  size(path: string): number | null { return this.files.get(path)?.length ?? null; }
  append(path: string, text: string): void { this.files.set(path, (this.files.get(path) ?? '') + text); }
  replace(path: string, text: string): void { this.files.set(path, text); }
  lines(): string[] { return (this.files.get(PATH) ?? '').split('\r\n').filter((line) => line.includes(' PACKET  ')); }
}

function message(over: Partial<DnsMessage['flags']> & { id?: number; qname?: string; qtype?: number } = {}): DnsMessage {
  const { id, qname, qtype, ...flags } = over;
  return {
    id: id ?? 0xd8dd,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR, ...flags },
    questions: [{ qname: qname ?? 'www.example.com', qtype: qtype ?? RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function event(
  msg: DnsMessage, direction: DnsPacketEvent['direction'] = 'receive', transport: 'udp' | 'tcp' = 'udp',
  remote = '192.0.2.7', exchange: object = {},
): DnsPacketEvent {
  return { direction, transport, remote, message: msg, exchange };
}

function writer(options: { at?: number; zone?: string; level?: number; remotes?: string[]; maxBytes?: number } = {}) {
  const files = new MemoryFiles();
  const clock = { at: options.at ?? Date.UTC(2027, 0, 2, 0, 5, 9) };
  const settings = {
    level: options.level ?? EVERYTHING,
    current: { path: '', maxBytes: options.maxBytes ?? 500000000, remotes: options.remotes ?? [] } as DnsDebugLogSettings,
  };
  const log = new DnsDebugLog({
    level: () => settings.level, settings: () => settings.current, files, now: () => clock.at,
    timeZone: () => options.zone ?? 'UTC', threadId: 0xb2c,
  });
  return { log, files, clock, settings };
}

describe('a query that timed out', () => {
  it('is not a packet and is never logged, whatever the level', () => {
    const { log, files } = writer({ level: 0xFFFFFFFF });
    log.observe(event(message(), 'timeout'));
    log.observe(event(message({ qr: true }), 'timeout', 'tcp'));
    expect(files.lines()).toEqual([]);
    expect(files.files.size).toBe(0);
  });
});

describe('the text of a packet line', () => {
  it('a recursive query received over UDP, exactly as in the transcripts', () => {
    const { log, files } = writer();
    log.observe(event(message()));
    expect(files.lines()).toHaveLength(1);
    expect(files.lines()[0]).toMatch(/^1\/2\/2027 12:05:09 AM 0B2C PACKET {2}[0-9A-F]{16} UDP Rcv 192\.0\.2\.7 {7}d8dd {3}Q \[0001 {3}D {3}NOERROR\] A {6}\(3\)www\(7\)example\(3\)com\(0\)$/);
  });

  it('an authoritative recursive answer carries the flags word 8085 and the letters A, D, R', () => {
    const { log, files } = writer();
    log.observe(event(message({ qr: true, aa: true, rd: true, ra: true }), 'send'));
    expect(files.lines()[0]).toMatch(/ UDP Snd 192\.0\.2\.7 {7}d8dd R Q \[8085 A DR {2}NOERROR\] A {6}\(3\)www/);
  });

  it('a truncated answer carries the T letter, a checking-disabled query the bit 0x1000 of the word', () => {
    const { log, files } = writer();
    log.observe(event(message({ qr: true, tc: true, rd: false }), 'send'));
    log.observe(event(message({ cd: true })));
    expect(files.lines()[0]).toMatch(/\[0082 {2}T {4}NOERROR\]/);
    expect(files.lines()[1]).toMatch(/\[1001 {3}D {3}NOERROR\]/);
  });

  it.each([
    [DnsRcode.NXDOMAIN, 'NXDOMAIN'], [DnsRcode.SERVFAIL, 'SERVFAIL'], [DnsRcode.REFUSED, 'REFUSED'],
    [DnsRcode.FORMERR, 'FORMERR'], [DnsRcode.NOTIMP, 'NOTIMP'],
  ])('the response code %i is written %s, in the high nibble of the second flags byte', (rcode, name) => {
    const { log, files } = writer();
    log.observe(event(message({ qr: true, rcode }), 'send'));
    expect(files.lines()[0]).toContain(`${name}]`);
    expect(files.lines()[0]).toContain(`[${(0x0081 | (rcode << 8)).toString(16).padStart(4, '0')} `);
  });

  it.each([
    [DnsOpcode.QUERY, 'Q', 0x1], [DnsOpcode.NOTIFY, 'N', 0x10], [DnsOpcode.UPDATE, 'U', 0x20],
  ])('the opcode %i is the letter %s, and it takes its own bit of the content filter', (opcode, letter, bit) => {
    const only = writer({ level: bit | 0x100 | 0x2000 | 0x4000 });
    only.log.observe(event(message({ opcode })));
    expect(only.files.lines()).toHaveLength(1);
    expect(only.files.lines()[0]).toMatch(new RegExp(` ${letter} \\[`));
    const others = writer({ level: (EVERYTHING & ~bit) });
    others.log.observe(event(message({ opcode })));
    expect(others.files.lines()).toHaveLength(0);
  });

  it('an inverse query has no content bit: it is never logged', () => {
    const { log, files } = writer();
    log.observe(event(message({ opcode: DnsOpcode.IQUERY })));
    expect(files.lines()).toHaveLength(0);
  });

  it('a remote address of 15 characters or more is not padded, and the question type is padded to 6', () => {
    const { log, files } = writer();
    log.observe(event(message({ qtype: RRType.AAAA }), 'receive', 'tcp', '2001:db8:85a3::8a2e:370:7334'));
    expect(files.lines()[0]).toContain(' TCP Rcv 2001:db8:85a3::8a2e:370:7334 d8dd ');
    expect(files.lines()[0]).toMatch(/\] AAAA {3}\(3\)www/);
  });

  it('the root name is (0) and the question of a message that has none is left out', () => {
    const { log, files } = writer();
    log.observe(event(message({ qname: '.', qtype: RRType.NS })));
    log.observe(event({ ...message(), questions: [] }));
    expect(files.lines()[0]).toMatch(/\] NS {5}\(0\)$/);
    expect(files.lines()[1]).toMatch(/NOERROR\]$/);
  });

  it('the two directions of an exchange share a packet identifier, a new exchange has a new one', () => {
    const { log, files } = writer();
    const first = {};
    log.observe(event(message(), 'receive', 'udp', '192.0.2.7', first));
    log.observe(event(message({ qr: true }), 'send', 'udp', '192.0.2.7', first));
    log.observe(event(message(), 'receive', 'udp', '192.0.2.7', {}));
    const identifiers = files.lines().map((line) => /PACKET {2}([0-9A-F]{16})/.exec(line)![1]);
    expect(identifiers[0]).toBe(identifiers[1]);
    expect(identifiers[2]).not.toBe(identifiers[0]);
  });
});

describe('the stamp of a line', () => {
  it.each([
    [Date.UTC(2027, 0, 2, 0, 5, 9), '1/2/2027 12:05:09 AM'],
    [Date.UTC(2027, 11, 31, 12, 0, 0), '12/31/2027 12:00:00 PM'],
    [Date.UTC(2027, 5, 9, 13, 7, 5), '6/9/2027 1:07:05 PM'],
    [Date.UTC(2027, 5, 9, 23, 59, 59), '6/9/2027 11:59:59 PM'],
    [Date.UTC(2027, 5, 9, 9, 30, 0), '6/9/2027 9:30:00 AM'],
  ])('%i is written %s', (at, expected) => {
    const { log, files } = writer({ at });
    log.observe(event(message()));
    expect(files.lines()[0].startsWith(`${expected} 0B2C PACKET`)).toBe(true);
  });

  it('is the time of the machine zone', () => {
    const { log, files } = writer({ at: Date.UTC(2027, 0, 2, 0, 5, 9), zone: 'Asia/Tokyo' });
    log.observe(event(message()));
    expect(files.lines()[0].startsWith('1/2/2027 9:05:09 AM ')).toBe(true);
  });
});

describe('the header of the file', () => {
  it('is written once, with the time of the first packet, before it', () => {
    const { log, files } = writer({ at: Date.UTC(2027, 0, 2, 15, 4, 5) });
    log.observe(event(message()));
    log.observe(event(message()));
    const text = files.files.get(PATH)!;
    expect(text.startsWith('DNS Server log file creation at 1/2/2027 3:04:05 PM\r\nLog file wrap at 1/2/2027 3:04:05 PM\r\nMessage logging key (for packets - other items use a subset of these fields):\r\n')).toBe(true);
    expect(text.match(/Message logging key/g)).toHaveLength(1);
    expect(text.split('\r\n')[3]).toBe('\tField #  Information         Values');
    expect(text.split('\r\n')[4]).toBe('\t-------  -----------         ------');
    expect(text.split('\r\n')[5]).toBe('\t   1     Date');
    expect(text.split('\r\n')[13]).toBe('\t   9     Xid (hex)');
  });
});

describe('the filters', () => {
  it('a packet is logged only when all four layers allow it', () => {
    const cases: Array<[string, number]> = [
      ['no content', EVERYTHING & ~(0x1 | 0x10 | 0x20)], ['no type', EVERYTHING & ~(0x100 | 0x200)],
      ['no direction', EVERYTHING & ~(0x1000 | 0x2000)], ['no transport', EVERYTHING & ~(0x4000 | 0x8000)],
    ];
    for (const [, level] of cases) {
      const { log, files } = writer({ level });
      log.observe(event(message()));
      expect(files.lines()).toHaveLength(0);
    }
    const { log, files } = writer({ level: EVERYTHING });
    log.observe(event(message()));
    expect(files.lines()).toHaveLength(1);
  });

  it('a question needs the question bit, an answer the answer bit', () => {
    const questionsOnly = writer({ level: 0x1 | 0x100 | 0x1000 | 0x2000 | 0x4000 });
    questionsOnly.log.observe(event(message()));
    questionsOnly.log.observe(event(message({ qr: true }), 'send'));
    expect(questionsOnly.files.lines()).toHaveLength(1);
    const answersOnly = writer({ level: 0x1 | 0x200 | 0x1000 | 0x2000 | 0x4000 });
    answersOnly.log.observe(event(message()));
    answersOnly.log.observe(event(message({ qr: true }), 'send'));
    expect(answersOnly.files.lines()).toHaveLength(1);
    expect(answersOnly.files.lines()[0]).toContain(' Snd ');
  });

  it('send and receive, UDP and TCP, each need their bit', () => {
    const sendOnly = writer({ level: 0x1 | 0x100 | 0x200 | 0x1000 | 0x4000 });
    sendOnly.log.observe(event(message(), 'receive'));
    sendOnly.log.observe(event(message(), 'send'));
    expect(sendOnly.files.lines().map((line) => line.includes(' Snd '))).toEqual([true]);
    const udpOnly = writer({ level: 0x1 | 0x100 | 0x200 | 0x1000 | 0x2000 | 0x4000 });
    udpOnly.log.observe(event(message(), 'receive', 'tcp'));
    udpOnly.log.observe(event(message(), 'receive', 'udp'));
    expect(udpOnly.files.lines().map((line) => line.includes(' UDP '))).toEqual([true]);
  });

  it('the remote filter lets the listed addresses through and holds the others back', () => {
    const { log, files } = writer({ remotes: ['192.0.2.9', '192.0.2.7'] });
    log.observe(event(message(), 'receive', 'udp', '192.0.2.7'));
    log.observe(event(message(), 'receive', 'udp', '192.0.2.8'));
    log.observe(event(message(), 'receive', 'udp', '192.0.2.9'));
    expect(files.lines().map((line) => / (192\.0\.2\.\d)/.exec(line)![1])).toEqual(['192.0.2.7', '192.0.2.9']);
  });

  it('the settings are read for every packet', () => {
    const { log, files, settings } = writer();
    log.observe(event(message()));
    settings.level = 0;
    log.observe(event(message()));
    settings.level = EVERYTHING;
    settings.current = { ...settings.current, path: 'other.log' };
    log.observe(event(message()));
    expect(files.lines()).toHaveLength(1);
    expect(files.files.get('C:\\Windows\\System32\\dns\\other.log')).toContain('PACKET');
  });
});

function measured(): { header: number; line: number } {
  const probe = writer();
  probe.log.observe(event(message()));
  const text = probe.files.files.get(PATH)!;
  const line = text.length - text.lastIndexOf('\r\n', text.length - 3) - 2;
  return { header: text.length - line, line };
}

describe('the maximum size', () => {
  it('a file grows to exactly the limit and is created again with the next byte', () => {
    const { header, line } = measured();
    const limit = header + 2 * line;
    const { log, files } = writer({ maxBytes: limit });
    log.observe(event(message()));
    log.observe(event(message()));
    expect(files.files.get(PATH)!.length).toBe(limit);
    expect(files.lines()).toHaveLength(2);
    log.observe(event(message()));
    expect(files.files.get(PATH)!.length).toBe(header + line);
    expect(files.lines()).toHaveLength(1);
  });

  it('a file one byte short of the limit is already created again', () => {
    const { header, line } = measured();
    const { log, files } = writer({ maxBytes: header + 2 * line - 1 });
    log.observe(event(message()));
    log.observe(event(message()));
    expect(files.lines()).toHaveLength(1);
  });

  it('a line that cannot fit in a new file is not written, the header is', () => {
    const { log, files } = writer({ maxBytes: 10 });
    log.observe(event(message()));
    expect(files.files.get(PATH)).toContain('Message logging key');
    expect(files.lines()).toHaveLength(0);
  });

  it('the restart carries the time of the restart, and the lines before it are gone', () => {
    const { header, line } = measured();
    const { log, files, clock } = writer({ at: Date.UTC(2027, 0, 2, 15, 4, 5), maxBytes: header + 2 * line });
    log.observe(event(message({ qname: 'old.example.com' })));
    log.observe(event(message({ qname: 'old.example.com' })));
    clock.at = Date.UTC(2027, 0, 2, 16, 0, 0);
    log.observe(event(message({ qname: 'new.example.com' })));
    const text = files.files.get(PATH)!;
    expect(text.split('\r\n')[1]).toBe('Log file wrap at 1/2/2027 4:00:00 PM');
    expect(text).not.toContain('(3)old');
    expect(text).toContain('(3)new');
  });
});

describe('without a file system', () => {
  it('nothing is written and nothing fails', () => {
    const log = new DnsDebugLog({
      level: () => EVERYTHING, settings: () => ({ path: '', maxBytes: 100000, remotes: [] }),
      files: null, now: () => 0, timeZone: () => 'UTC', threadId: 1,
    });
    expect(() => log.observe(event(message()))).not.toThrow();
  });
});
