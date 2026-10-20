/**
 * Probe — codec syslog partage (RFC 5424, RFC 3164, RFC 6587 et heuristiques de reception de rsyslog) :
 * les exemples des §6.2.3.1 et §6.5 de la RFC 5424 et des §5.4 de la RFC 3164 sont les vecteurs,
 * l'analyse suit pmrfc3164.c / pmrfc5424.c / datetime.c (horodatage 3164 sans annee, annee devant ou derriere,
 * sous-secondes de Cisco, fuseau a defaut) et le decoupage de flux accepte comptage d'octets ET saut de ligne.
 * Discrimination : module nouveau, aucun cas n'existait ; temoins : les formats PRI (`<165>`, `<0>`) et le
 * decoupage a saut de ligne, que l'ancien SyslogStreamFraming faisait deja.
 */
import { describe, it, expect } from 'vitest';
import {
  formatTimestamp3164, formatTimestamp3339, parseTimestamp3164, parseTimestamp3339, syslogTimeFromEpochMs,
  syslogTimeToEpochMs, type SyslogTime,
} from '@/network/syslog/codec/SyslogTime';
import { parsePri, facilityNumber, severityNumber } from '@/network/syslog/codec/SyslogPriority';
import { formatStructuredData, parseStructuredData } from '@/network/syslog/codec/StructuredData';
import { formatRfc5424, parseRfc5424Body, UTF8_BOM } from '@/network/syslog/codec/Rfc5424';
import { DEFAULT_LEGACY_OPTIONS, formatRfc3164, parseLegacyBody } from '@/network/syslog/codec/Rfc3164';
import { SyslogStreamDecoder, frameOctetCounted } from '@/network/syslog/codec/Framing';

const RECEIVED: SyslogTime = syslogTimeFromEpochMs(Date.UTC(2026, 9, 19, 12, 0, 0), 120, 0, 1);

function legacy(afterPri: string, overrides: Partial<typeof DEFAULT_LEGACY_OPTIONS> = {}) {
  return parseLegacyBody({
    afterPri, receivedAt: RECEIVED, fromHost: '10.0.0.9', internal: false, ignoreDate: false, parseHostname: true, invalidFacility: false,
  }, { ...DEFAULT_LEGACY_OPTIONS, ...overrides });
}

describe('RFC 5424 §6.2.3.1 — horodatage', () => {
  it.each([
    ['1985-04-12T23:20:50.52Z', Date.UTC(1985, 3, 12, 23, 20, 50, 520)],
    ['1985-04-12T19:20:50.52-04:00', Date.UTC(1985, 3, 12, 23, 20, 50, 520)],
    ['2003-10-11T22:14:15.003Z', Date.UTC(2003, 9, 11, 22, 14, 15, 3)],
    ['2003-08-24T05:14:15.000003-07:00', Date.UTC(2003, 7, 24, 12, 14, 15, 0)],
  ])('%s', (text, epoch) => {
    const parsed = parseTimestamp3339(text);
    expect(parsed).not.toBeNull();
    expect(Math.floor(syslogTimeToEpochMs(parsed!.time) / 1000)).toBe(Math.floor(epoch / 1000));
    expect(formatTimestamp3339(parsed!.time)).toBe(text);
  });

  it('rejects a timestamp without zone, with a lowercase T, or a month out of range', () => {
    expect(parseTimestamp3339('2003-10-11T22:14:15')).toBeNull();
    expect(parseTimestamp3339('2003-10-11t22:14:15Z')).toBeNull();
    expect(parseTimestamp3339('2003-13-11T22:14:15Z')).toBeNull();
  });

  it('accepts the 9-digit fraction of example 5 as rsyslog does, and writes it back on its low 6 digits', () => {
    const parsed = parseTimestamp3339('2003-08-24T05:14:15.000000003-07:00');
    expect(parsed).not.toBeNull();
    expect(formatTimestamp3339(parsed!.time)).toBe('2003-08-24T05:14:15.000003-07:00');
  });
});

describe('PRI', () => {
  it.each([['<34>x', 34, 4], ['<165>x', 165, 5], ['<0>x', 0, 3], ['<13>x', 13, 4]])('%s', (text, pri, offset) => {
    expect(parsePri(text)).toEqual({ pri, offset });
  });
  it.each(['<192>x', '<>x', '<a>x', '34>x', '<1234>x'])('%s is not a PRI', (text) => {
    expect(parsePri(text)).toBeNull();
  });
  it('names follow the rsyslog tables', () => {
    expect(facilityNumber('local7')).toBe(23);
    expect(facilityNumber('authpriv')).toBe(10);
    expect(facilityNumber('security')).toBe(4);
    expect(severityNumber('err')).toBe(3);
    expect(severityNumber('panic')).toBe(0);
    expect(severityNumber('zorglub')).toBeNull();
  });
});

describe('STRUCTURED-DATA', () => {
  it('parses RFC 5424 example 4 and writes it back identically', () => {
    const text = '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"][examplePriority@32473 class="high"]';
    const parsed = parseStructuredData(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.elements).toHaveLength(2);
    expect(formatStructuredData(parsed!.elements)).toBe(text);
  });
  it('escapes quote, backslash and bracket in a value and reads them back', () => {
    const text = formatStructuredData([{ id: 'a@1', params: [['k', 'x"y\\z]w']] }]);
    expect(text).toBe('[a@1 k="x\\"y\\\\z\\]w"]');
    expect(parseStructuredData(text)!.elements[0].params[0][1]).toBe('x"y\\z]w');
  });
  it('refuses a repeated SD-ID', () => {
    expect(parseStructuredData('[a@1 k="v"][a@1 k="w"]')).toBeNull();
  });
  it('nil value', () => {
    expect(parseStructuredData('-')!.elements).toEqual([]);
    expect(formatStructuredData([])).toBe('-');
  });
});

describe('RFC 5424 §6.5 — messages complets', () => {
  it('example 1 round trip', () => {
    const wire = `<34>1 2003-10-11T22:14:15.003Z mymachine.example.com su - ID47 - ${UTF8_BOM}'su root' failed for lonvick on /dev/pts/8`;
    const body = wire.slice(parsePri(wire)!.offset);
    const parsed = parseRfc5424Body(body, RECEIVED)!;
    expect(parsed.hostname).toBe('mymachine.example.com');
    expect(parsed.appName).toBe('su');
    expect(parsed.procId).toBe('-');
    expect(parsed.msgId).toBe('ID47');
    expect(parsed.structuredData).toBe('-');
    expect(parsed.message).toBe(`${UTF8_BOM}'su root' failed for lonvick on /dev/pts/8`);
    expect(formatRfc5424({
      pri: 34, timestamp: parsed.timestamp, hostname: parsed.hostname, appName: parsed.appName, procId: null, msgId: parsed.msgId,
      structuredData: [], message: parsed.message,
    })).toBe(wire);
  });
  it('example 3 carries structured data and a message', () => {
    const body = '1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] An application event log entry...';
    const parsed = parseRfc5424Body(body, RECEIVED)!;
    expect(parsed.structuredData).toBe('[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"]');
    expect(parsed.message).toBe('An application event log entry...');
  });
  it('example 4 is structured data only', () => {
    const body = '1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut="3"][examplePriority@32473 class="high"]';
    const parsed = parseRfc5424Body(body, RECEIVED)!;
    expect(parsed.structuredData).toBe('[exampleSDID@32473 iut="3"][examplePriority@32473 class="high"]');
    expect(parsed.message).toBe('');
  });
  it('nil timestamp takes the reception time', () => {
    const parsed = parseRfc5424Body('1 - host app - - - hello', RECEIVED)!;
    expect(parsed.timestamp).toBe(RECEIVED);
    expect(parsed.message).toBe('hello');
  });
  it('is not RFC 5424 without the version 1 and a space', () => {
    expect(parseRfc5424Body('2 - host', RECEIVED)).toBeNull();
    expect(parseRfc5424Body('Oct 11 22:14:15 host', RECEIVED)).toBeNull();
  });
  it('refuses a HOSTNAME over 255 characters when writing', () => {
    expect(() => formatRfc5424({ pri: 13, timestamp: null, hostname: 'h'.repeat(256), appName: null, procId: null, msgId: null, structuredData: [], message: null })).toThrow(RangeError);
  });
});

describe('RFC 3164 §5.4 et heuristiques de rsyslog', () => {
  it('the classical su message', () => {
    const parsed = legacy("Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8");
    expect(parsed.hostname).toBe('mymachine');
    expect(parsed.tag).toBe('su:');
    expect(parsed.message).toBe(" 'su root' failed for lonvick on /dev/pts/8");
    expect(formatTimestamp3164(parsed.timestamp)).toBe('Oct 11 22:14:15');
    expect(parsed.timestamp.year).toBe(RECEIVED.year);
    expect(parsed.timestamp.offsetHour).toBe(RECEIVED.offsetHour);
  });
  it('a timestamp with a one-digit day padded by a space', () => {
    const parsed = legacy('Feb  5 17:32:18 10.0.0.99 Use the BFG!');
    expect(parsed.hostname).toBe('10.0.0.99');
    expect(parsed.timestamp.day).toBe(5);
    expect(formatTimestamp3164(parsed.timestamp)).toBe('Feb  5 17:32:18');
  });
  it('Cisco style: sub-second fraction and a colon after the timestamp', () => {
    const parsed = legacy('Oct 19 12:00:01.123: %SYS-5-CONFIG_I: Configured from console by console');
    expect(parsed.timestamp.secfracPrecision).toBe(3);
    expect(parsed.timestamp.secfrac).toBe(123);
    expect(parsed.hostname).toBeNull();
    expect(parsed.tag).toBe('%SYS-5-CONFIG_I:');
    expect(parsed.message).toBe(' Configured from console by console');
  });
  it('year before the month, and a year after the clock when the option is on', () => {
    expect(legacy('2025 Oct 11 22:14:15 host app: x').timestamp.year).toBe(2025);
    expect(legacy('Oct 11 22:14:15 2024 host app: x').timestamp.year).toBe(RECEIVED.year);
    const detected = legacy('Oct 11 22:14:15 2024 host app: x', { detectYearAfterTimestamp: true });
    expect(detected.timestamp.year).toBe(2024);
    expect(detected.hostname).toBe('host');
  });
  it('no timestamp keeps the reception time and the host is not guessed from the tag', () => {
    const parsed = legacy('sshd[123]: Accepted password for root');
    expect(parsed.timestamp).toBe(RECEIVED);
    expect(parsed.hostname).toBeNull();
    expect(parsed.tag).toBe('sshd[123]:');
    expect(parsed.message).toBe(' Accepted password for root');
  });
  it('an apparent hostname that is really a tag (it contains a colon) stays a tag', () => {
    expect(legacy('Oct 11 22:14:15 app: message').hostname).toBeNull();
  });
  it('a message starting with a brace or a bracket is headerless', () => {
    const parsed = legacy('  {"a":1}');
    expect(parsed.tag).toBeNull();
    expect(parsed.message).toBe('  {"a":1}');
  });
  it('force.tagEndingByColon turns a colonless first word into message', () => {
    const parsed = legacy('Oct 11 22:14:15 host fail now', { forceTagEndingByColon: true });
    expect(parsed.tag).toBe('-');
    expect(parsed.message).toBe(' fail now');
  });
  it('remove.msgFirstSpace strips the space after the tag', () => {
    expect(legacy('Oct 11 22:14:15 host app: hello', { removeMsgFirstSpace: true }).message).toBe('hello');
  });
  it('permit.squareBracketsInHostname keeps an IPv6 style [name]', () => {
    expect(legacy('Oct 11 22:14:15 [fe80] app: x').hostname).toBeNull();
    expect(legacy('Oct 11 22:14:15 [fe80] app: x', { permitSquareBracketsInHostname: true }).hostname).toBe('[fe80]');
  });
  it('headerless detection drops or routes messages without timestamp', () => {
    const parsed = legacy('plain text', { detectHeaderless: true, dropHeaderless: true });
    expect(parsed.discard).toBe(true);
    expect(parsed.headerless).toBe(true);
    expect(legacy('<not syslog>', { detectHeaderless: true }).headerless).toBe(true);
    expect(legacy('Oct 11 22:14:15 host app: x', { detectHeaderless: true }).headerless).toBe(false);
  });
  it('formats what a sender writes', () => {
    const time = syslogTimeFromEpochMs(Date.UTC(2026, 9, 19, 12, 0, 5), 0, 0, 1);
    expect(formatRfc3164({ pri: 189, timestamp: time, hostname: 'R1', tag: '%SYS-5-CONFIG_I', content: 'ok' }))
      .toBe('<189>Oct 19 12:00:05 R1 %SYS-5-CONFIG_I: ok');
    expect(formatRfc3164({ pri: 38, timestamp: time, hostname: 'srv', tag: 'sshd', pid: 77, content: 'x' }))
      .toBe('<38>Oct 19 12:00:05 srv sshd[77]: x');
  });
  it('parseTimestamp3164 refuses an unknown month', () => {
    expect(parseTimestamp3164('Foo 11 22:14:15 x', RECEIVED)).toBeNull();
  });
});

describe('RFC 6587 — découpage de flux', () => {
  it('octet counting, even split across pushes and with multibyte characters', () => {
    const received: string[] = [];
    const decoder = new SyslogStreamDecoder((message) => received.push(message));
    const first = '<34>1 - h a - - - é';
    const second = '<13>Oct 11 22:14:15 h t: two';
    const wire = frameOctetCounted(first) + frameOctetCounted(second);
    decoder.push(wire.slice(0, 7));
    decoder.push(wire.slice(7, 30));
    decoder.push(wire.slice(30));
    expect(received).toEqual([first, second]);
  });
  it('non-transparent framing on LF, with an empty line ignored', () => {
    const received: string[] = [];
    const decoder = new SyslogStreamDecoder((message) => received.push(message));
    decoder.push('<13>one\n\n<13>tw');
    decoder.push('o\n');
    expect(received).toEqual(['<13>one', '<13>two']);
  });
  it('a message starting with < is never read as a count', () => {
    const received: string[] = [];
    new SyslogStreamDecoder((message) => received.push(message)).push('<34>1 2003 x\n');
    expect(received).toEqual(['<34>1 2003 x']);
  });
});
