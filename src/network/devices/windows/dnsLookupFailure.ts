import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export type DnsLookupFailure =
  | 'NODATA' | 'NXDOMAIN' | 'REFUSED' | 'SERVFAIL' | 'FORMERR' | 'NOTIMP' | 'TIMEOUT';

export interface Win32DnsError {
  readonly symbol: string;
  readonly message: string;
}

const WIN32_ERRORS: Readonly<Record<DnsLookupFailure, Win32DnsError>> = {
  NXDOMAIN: { symbol: 'DNS_ERROR_RCODE_NAME_ERROR', message: 'DNS name does not exist' },
  NODATA: { symbol: 'DNS_ERROR_RECORD_DOES_NOT_EXIST', message: 'DNS record does not exist' },
  SERVFAIL: { symbol: 'DNS_ERROR_RCODE_SERVER_FAILURE', message: 'DNS server failure' },
  REFUSED: { symbol: 'DNS_ERROR_RCODE_REFUSED', message: 'DNS operation refused' },
  FORMERR: { symbol: 'DNS_ERROR_RCODE_FORMAT_ERROR', message: 'DNS server unable to interpret format' },
  NOTIMP: { symbol: 'DNS_ERROR_RCODE_NOT_IMPLEMENTED', message: 'DNS request not supported by name server' },
  TIMEOUT: { symbol: 'ERROR_TIMEOUT', message: 'This operation returned because the timeout period expired' },
};

const MOST_INFORMATIVE_FIRST: readonly DnsLookupFailure[] =
  ['NODATA', 'NXDOMAIN', 'REFUSED', 'SERVFAIL', 'FORMERR', 'NOTIMP', 'TIMEOUT'];

export function win32ErrorOf(failure: DnsLookupFailure): Win32DnsError {
  return WIN32_ERRORS[failure];
}

function failureOfReply(reply: DnsMessage | null): DnsLookupFailure {
  if (reply === null) return 'TIMEOUT';
  switch (reply.flags.rcode) {
    case DnsRcode.NOERROR: return 'NODATA';
    case DnsRcode.NXDOMAIN: return 'NXDOMAIN';
    case DnsRcode.REFUSED: return 'REFUSED';
    case DnsRcode.FORMERR: return 'FORMERR';
    case DnsRcode.NOTIMP: return 'NOTIMP';
    default: return 'SERVFAIL';
  }
}

export class DnsFailureLedger {
  private current: DnsLookupFailure | null = null;

  reset(): void {
    this.current = null;
  }

  noteUnanswered(reply: DnsMessage | null): void {
    this.keep(failureOfReply(reply));
  }

  failure(): DnsLookupFailure | null {
    return this.current;
  }

  private keep(failure: DnsLookupFailure): void {
    if (this.current === null || MOST_INFORMATIVE_FIRST.indexOf(failure) < MOST_INFORMATIVE_FIRST.indexOf(this.current)) {
      this.current = failure;
    }
  }
}
