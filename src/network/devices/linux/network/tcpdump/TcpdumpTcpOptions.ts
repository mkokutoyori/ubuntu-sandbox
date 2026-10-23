const TCP_FIXED_HEADER_BYTES = 20;
const SIGNATURE_BYTES = 16;

const OPTION_NAMES: Readonly<Record<number, string>> = {
  0: 'eol', 1: 'nop', 2: 'mss', 3: 'wscale', 4: 'sackOK', 5: 'sack', 6: 'echo', 7: 'echoreply', 8: 'TS',
  11: 'cc', 12: 'ccnew', 13: '', 19: 'md5', 20: 'scps', 28: 'uto', 29: 'tcp-ao', 30: 'mptcp', 34: 'tfo', 254: 'exp',
};

export interface RelativeSequenceBase {
  readonly reverse: boolean;
  readonly sequence: number;
  readonly acknowledgement: number;
}

class BadOption extends Error {}

function be16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function be32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function hex(bytes: readonly number[], from: number, to: number): string {
  let text = '';
  for (let i = from; i < to; i++) text += bytes[i].toString(16).padStart(2, '0');
  return text;
}

function zeroLength(kind: number): boolean {
  return kind === 0 || kind === 1;
}

export interface TcpOptionsText {
  readonly text: string;
  readonly bad: boolean;
}

export function tcpOptionsText(header: readonly number[], relative: RelativeSequenceBase): TcpOptionsText {
  const headerBytes = (header[12] >> 4) * 4;
  if (headerBytes <= TCP_FIXED_HEADER_BYTES) return { text: '', bad: false };
  const available = Math.min(headerBytes, header.length);
  let text = ', options [';
  let remaining = headerBytes - TCP_FIXED_HEADER_BYTES;
  let cursor = TCP_FIXED_HEADER_BYTES;
  let separator = '';
  try {
    while (remaining > 0) {
      text += separator;
      if (cursor >= available) throw new BadOption();
      const kind = header[cursor++];
      let length = 1;
      if (!zeroLength(kind)) {
        if (cursor >= available) throw new BadOption();
        length = header[cursor++];
        if (length < 2 || length > remaining) throw new BadOption();
        remaining--;
      }
      remaining--;
      let dataLength = 0;
      const need = (count: number): void => {
        if (count > remaining || cursor + count > available) throw new BadOption();
      };
      text += OPTION_NAMES[kind] ?? `unknown-${kind}`;
      switch (kind) {
        case 2: dataLength = 2; need(dataLength); text += ` ${be16(header, cursor)}`; break;
        case 3: dataLength = 1; need(dataLength); text += ` ${header[cursor]}`; break;
        case 5: {
          dataLength = length - 2;
          if (dataLength % 8 !== 0) {
            text += ' invalid sack';
            break;
          }
          text += ` ${dataLength / 8} `;
          const base = relative.reverse ? relative.sequence : relative.acknowledgement;
          for (let i = 0; i < dataLength; i += 8) {
            need(i + 8);
            text += `{${(be32(header, cursor + i) - base) >>> 0}:${(be32(header, cursor + i + 4) - base) >>> 0}}`;
          }
          break;
        }
        case 11: case 12: case 13: case 6: case 7: dataLength = 4; need(dataLength); text += ` ${be32(header, cursor)}`; break;
        case 8: dataLength = 8; need(dataLength); text += ` val ${be32(header, cursor)} ecr ${be32(header, cursor + 4)}`; break;
        case 19: dataLength = SIGNATURE_BYTES; need(dataLength); text += ` ${hex(header, cursor, cursor + dataLength)}`; break;
        case 20: dataLength = 2; need(dataLength); text += ` cap ${header[cursor].toString(16).padStart(2, '0')} id ${header[cursor + 1]}`; break;
        case 29: {
          dataLength = length - 2;
          if (dataLength < 2) {
            text += ' INVALID';
            break;
          }
          need(1);
          text += ` keyid ${header[cursor]}`;
          need(2);
          text += ` rnextkeyid ${header[cursor + 1]}`;
          if (dataLength > 2) {
            text += ' mac 0x';
            for (let i = 2; i < dataLength; i++) {
              need(i + 1);
              text += header[cursor + i].toString(16).padStart(2, '0');
            }
          }
          break;
        }
        case 0: case 1: case 4: break;
        case 28: {
          dataLength = 2;
          need(dataLength);
          const raw = be16(header, cursor);
          text += ` 0x${raw.toString(16)} ${(raw & 1) !== 0 ? (raw >> 1) * 60 : raw >> 1}`;
          break;
        }
        case 34: {
          dataLength = length - 2;
          need(dataLength);
          text += ' ';
          text += dataLength === 0 ? 'cookiereq' : `cookie ${hex(header, cursor, cursor + dataLength)}`;
          break;
        }
        case 254: {
          dataLength = length - 2;
          need(dataLength);
          if (dataLength < 2) throw new BadOption();
          const magic = be16(header, cursor);
          text += '-';
          text += magic === 0xf989
            ? (dataLength - 2 === 0 ? 'tfo cookiereq' : `tfo cookie ${hex(header, cursor + 2, cursor + dataLength)}`)
            : magic.toString(16).padStart(4, '0');
          break;
        }
        default:
          dataLength = length - 2;
          if (dataLength > 0) text += ' 0x';
          for (let i = 0; i < dataLength; i++) {
            need(i + 1);
            text += header[cursor + i].toString(16).padStart(2, '0');
          }
          break;
      }
      cursor += dataLength;
      remaining -= dataLength;
      const consumed = dataLength + 1 + (zeroLength(kind) ? 0 : 1);
      if (consumed !== length) text += `[len ${length}]`;
      separator = ',';
      if (kind === 0) break;
    }
  } catch (error) {
    if (!(error instanceof BadOption)) throw error;
    return { text: `${text}[bad opt]${separator === '' ? '' : ']'}`, bad: true };
  }
  return { text: `${text}]`, bad: false };
}
