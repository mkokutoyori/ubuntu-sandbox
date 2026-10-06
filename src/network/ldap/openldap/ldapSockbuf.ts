import { LdapDebug, type LdapLog, berBprint } from './ldapLog';
import type { LdapChannel, ChannelRead } from './ldapChannel';
import { BerElement, LBER_DEFAULT } from './libber';

export const EWOULDBLOCK_MESSAGE = 'Resource temporarily unavailable';
export const ERANGE_MESSAGE = 'Numerical result out of range';

export class Sockbuf {
  lastError: 'none' | 'eagain' | 'erange' | 'eof' = 'none';

  constructor(readonly channel: LdapChannel, private readonly log: LdapLog) {}

  read(want: number): ChannelRead {
    const result = this.channel.read(want);
    if (this.log.enabled(LdapDebug.PACKETS)) {
      if (result.kind === 'data') {
        this.log.debug(LdapDebug.PACKETS, `ldap_read: want=${want}, got=${result.bytes.length}\n`);
        this.log.debug(LdapDebug.PACKETS, berBprint(result.bytes));
      } else if (result.kind === 'eof') {
        this.log.debug(LdapDebug.PACKETS, `ldap_read: want=${want}, got=0\n`);
        this.log.debug(LdapDebug.PACKETS, berBprint(new Uint8Array(0)));
      } else {
        this.log.debug(LdapDebug.PACKETS, `ldap_read: want=${want} error=${EWOULDBLOCK_MESSAGE}\n`);
      }
    }
    return result;
  }

  write(bytes: Uint8Array): boolean {
    const ok = this.channel.write(bytes);
    if (this.log.enabled(LdapDebug.PACKETS)) {
      if (ok) {
        this.log.debug(LdapDebug.PACKETS, `ldap_write: want=${bytes.length}, written=${bytes.length}\n`);
        this.log.debug(LdapDebug.PACKETS, berBprint(bytes));
      } else {
        this.log.debug(LdapDebug.PACKETS, `ldap_write: want=${bytes.length} error=Broken pipe\n`);
      }
    }
    return ok;
  }

  flush(bytes: Uint8Array): boolean {
    this.log.debug(LdapDebug.TRACE, `ber_flush2: ${bytes.length} bytes to sd ${this.descriptor}\n`);
    if (this.log.enabled(LdapDebug.BER)) this.log.debug(LdapDebug.BER, berBprint(bytes));
    return this.write(bytes);
  }

  descriptor = 3;
}

export interface BerGetNextState {
  head: number[];
  tag: number;
  length: number;
  headerLength: number;
  body: Uint8Array | null;
  filled: number;
}

export function newBerGetNextState(): BerGetNextState {
  return { head: [], tag: 0, length: 0, headerLength: 0, body: null, filled: 0 };
}

export type BerGetNextResult =
  | { readonly kind: 'message'; readonly tag: number; readonly length: number; readonly ber: BerElement; readonly pdu: Uint8Array }
  | { readonly kind: 'again' }
  | { readonly kind: 'failed' };

function parseHeader(head: readonly number[]): { tag: number; length: number; headerLength: number } | 'more' | 'bad' {
  if (head.length === 0) return 'more';
  let tag = head[0];
  let index = 1;
  if ((tag & 0x1f) === 0x1f) {
    for (let i = 1; ; i++) {
      if (index >= head.length) return 'more';
      tag = tag * 256 + head[index++];
      if ((tag & 0x80) === 0) break;
      if (i === 7) return 'bad';
    }
  }
  if (index >= head.length) return 'more';
  let length: number;
  if ((head[index] & 0x80) !== 0) {
    const lengthBytes = head[index++] & 0x7f;
    if (lengthBytes > 4) return 'bad';
    if (head.length - index < lengthBytes) return 'more';
    length = 0;
    for (let i = 0; i < lengthBytes; i++) length = length * 256 + head[index++];
  } else {
    length = head[index++];
  }
  return { tag, length, headerLength: index };
}

export function berGetNext(
  sb: Sockbuf, state: BerGetNextState, log: LdapLog, allocate: (length: number) => number,
): BerGetNextResult {
  log.debug(LdapDebug.TRACE, 'ber_get_next\n');
  if (state.body === null) {
    for (;;) {
      const want = Math.max(1, 8 - state.head.length);
      const read = sb.read(want);
      if (read.kind === 'eof') {
        sb.lastError = 'eof';
        return { kind: 'failed' };
      }
      if (read.kind === 'again') {
        sb.lastError = 'eagain';
        return { kind: 'again' };
      }
      for (const byte of read.bytes) state.head.push(byte);
      const header = parseHeader(state.head);
      if (header === 'bad') {
        sb.lastError = 'erange';
        return { kind: 'failed' };
      }
      if (header === 'more') {
        if (state.head.length >= 8) {
          sb.lastError = 'erange';
          return { kind: 'failed' };
        }
        continue;
      }
      const leftover = state.head.length - header.headerLength;
      state.tag = header.tag;
      state.length = header.length;
      state.headerLength = header.headerLength;
      if (header.length === 0) {
        sb.lastError = 'erange';
        return { kind: 'failed' };
      }
      if (header.length < leftover) {
        sb.lastError = 'erange';
        return { kind: 'failed' };
      }
      state.body = new Uint8Array(header.length);
      state.body.set(state.head.slice(header.headerLength), 0);
      state.filled = leftover;
      break;
    }
  }
  if (state.filled < state.length) {
    const read = sb.read(state.length - state.filled);
    if (read.kind === 'eof') {
      sb.lastError = 'eof';
      return { kind: 'failed' };
    }
    if (read.kind === 'again') {
      sb.lastError = 'eagain';
      return { kind: 'again' };
    }
    state.body!.set(read.bytes, state.filled);
    state.filled += read.bytes.length;
    if (state.filled < state.length) {
      sb.lastError = 'eagain';
      return { kind: 'again' };
    }
  }
  const ber = new BerElement(state.body!, allocate(state.length + 1), log);
  log.debug(LdapDebug.TRACE, `ber_get_next: tag 0x${state.tag.toString(16)} len ${state.length} contents:\n`);
  if (log.enabled(LdapDebug.BER)) ber.dump();
  const header = Uint8Array.from(state.head.slice(0, state.headerLength));
  const pdu = new Uint8Array(header.length + state.length);
  pdu.set(header, 0);
  pdu.set(state.body!, header.length);
  const result: BerGetNextResult = { kind: 'message', tag: state.tag, length: state.length, ber, pdu };
  Object.assign(state, newBerGetNextState());
  return result;
}

export { LBER_DEFAULT };
