/*
 * DnsFailureLedger keeps, for one resolution, the most informative reason a lookup produced nothing: a record
 * that is missing outranks a name that is missing, which outranks a refusal, a server failure, a format error,
 * a missing feature and a silence; a new resolution starts from nothing.
 * win32ErrorOf names each reason with the WinError.h symbol and the message FormatMessage returns for it
 * (Microsoft Learn, System Error Codes 9000-11999 and 1300-1699).
 */
import { describe, it, expect } from 'vitest';
import { DnsFailureLedger, win32ErrorOf } from '@/network/devices/windows/dnsLookupFailure';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const reply = (rcode: number): DnsMessage => ({
  id: 1,
  flags: { qr: true, opcode: 0, aa: false, tc: false, rd: true, ra: true, ad: false, cd: false, rcode },
  questions: [], answers: [], authorities: [], additionals: [],
});

describe('the ledger keeps the most informative reason', () => {
  it('maps each reply to its Win32 error, and a silence to the timeout', () => {
    const expected: Array<[DnsMessage | null, string, string]> = [
      [null, 'ERROR_TIMEOUT', 'This operation returned because the timeout period expired'],
      [reply(DnsRcode.NOERROR), 'DNS_ERROR_RECORD_DOES_NOT_EXIST', 'DNS record does not exist'],
      [reply(DnsRcode.NXDOMAIN), 'DNS_ERROR_RCODE_NAME_ERROR', 'DNS name does not exist'],
      [reply(DnsRcode.REFUSED), 'DNS_ERROR_RCODE_REFUSED', 'DNS operation refused'],
      [reply(DnsRcode.SERVFAIL), 'DNS_ERROR_RCODE_SERVER_FAILURE', 'DNS server failure'],
      [reply(DnsRcode.FORMERR), 'DNS_ERROR_RCODE_FORMAT_ERROR', 'DNS server unable to interpret format'],
      [reply(DnsRcode.NOTIMP), 'DNS_ERROR_RCODE_NOT_IMPLEMENTED', 'DNS request not supported by name server'],
    ];
    for (const [message, symbol, text] of expected) {
      const ledger = new DnsFailureLedger();
      ledger.noteUnanswered(message);
      expect(win32ErrorOf(ledger.failure()!)).toEqual({ symbol, message: text });
    }
  });

  it('keeps a reply over a silence, the record that is missing over the name that is missing, and resets between lookups', () => {
    const ledger = new DnsFailureLedger();
    ledger.noteUnanswered(null);
    ledger.noteUnanswered(reply(DnsRcode.NXDOMAIN));
    ledger.noteUnanswered(null);
    expect(ledger.failure()).toBe('NXDOMAIN');
    ledger.noteUnanswered(reply(DnsRcode.NOERROR));
    expect(ledger.failure()).toBe('NODATA');
    ledger.reset();
    expect(ledger.failure()).toBeNull();
  });
});
