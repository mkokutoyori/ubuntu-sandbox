const HTTP_COMMANDS = new Set([
  'GET', 'PUT', 'COPY', 'HEAD', 'LOCK', 'MOVE', 'POLL', 'POST', 'BCOPY', 'BMOVE', 'MKCOL', 'TRACE', 'LABEL', 'MERGE', 'DELETE',
  'SEARCH', 'UNLOCK', 'REPORT', 'UPDATE', 'NOTIFY', 'BDELETE', 'CONNECT', 'OPTIONS', 'CHECKIN', 'PROPFIND', 'CHECKOUT', 'CCM_POST',
  'SUBSCRIBE', 'PROPPATCH', 'BPROPFIND', 'BPROPPATCH', 'UNCHECKOUT', 'MKACTIVITY', 'MKWORKSPACE', 'UNSUBSCRIBE', 'RPC_CONNECT',
  'VERSION-CONTROL', 'BASELINE-CONTROL',
]);

const RTSP_COMMANDS = new Set([
  'DESCRIBE', 'ANNOUNCE', 'GET_PARAMETER', 'OPTIONS', 'PAUSE', 'PLAY', 'RECORD', 'REDIRECT', 'SETUP', 'SET_PARAMETER', 'TEARDOWN',
]);

const MAXIMUM_TOKEN = 128;
const MAXIMUM_RESET_DATA = 100;

function printable(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

function fetchToken(bytes: readonly number[], start: number, length: number): { token: string; next: number } | null {
  let at = start;
  let token = '';
  for (; at < length; at++) {
    if (at >= bytes.length) return null;
    const c = bytes[at];
    if (c >= 0x80) return null;
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) break;
    if (!printable(c)) return null;
    if (token.length + 2 > MAXIMUM_TOKEN) return null;
    token += String.fromCharCode(c);
  }
  if (token.length === 0) return null;
  for (; at < length; at++) {
    if (at >= bytes.length) break;
    const c = bytes[at];
    if (c === 0x0d || c === 0x0a || !printable(c)) break;
    if (c !== 0x20 && c !== 0x09) break;
  }
  return { token, next: at };
}

function textLine(name: string, bytes: readonly number[], prefix: string, start: number, length: number): { text: string; next: number } {
  let at = start;
  while (at < length) {
    const c = bytes[at];
    if (c === 0x0a) return { text: prefix + latin(bytes, start, at), next: at + 1 };
    if (c === 0x0d) {
      if (at + 1 >= length) return { text: '', next: 0 };
      if (bytes[at + 1] === 0x0a) return { text: prefix + latin(bytes, start, at), next: at + 2 };
      return { text: '', next: 0 };
    }
    if (!printable(c) && c !== 0x09) return { text: '', next: 0 };
    at++;
  }
  return { text: `${prefix}${latin(bytes, start, at)} [|${name.toLowerCase()}]`, next: 0 };
}

function latin(bytes: readonly number[], from: number, to: number): string {
  return bytes.slice(from, to).map(b => String.fromCharCode(b)).join('');
}

function textProtocol(
  name: string, bytes: readonly number[], length: number, commands: ReadonlySet<string> | null, verbose: number,
): string {
  let printThis = false;
  if (commands !== null) {
    const first = fetchToken(bytes, 0, length);
    if (first !== null) {
      if (commands.has(first.token.toUpperCase())) printThis = true;
      const second = fetchToken(bytes, first.next, length);
      if (second !== null && /^\d{3}$/.test(second.token)) printThis = true;
    }
  } else {
    printThis = true;
  }
  let text = name;
  if (!printThis) return text;
  if (verbose > 0) {
    text += `, length: ${length}`;
    for (let at = 0; at < length;) {
      const line = textLine(name, bytes, '\n\t', at, length);
      text += line.text;
      if (line.next === 0) break;
      at = line.next;
    }
  } else {
    text += textLine(name, bytes, ': ', 0, length).text;
  }
  return text;
}

function sshVersion(bytes: readonly number[], length: number): string {
  if (!(bytes[0] === 0x53 && bytes[1] === 0x53 && bytes[2] === 0x48 && bytes[3] === 0x2d)) return '';
  for (let at = 4; at < length; at++) {
    const c = bytes[at];
    if (c === 0x0a || (c === 0x0d && at + 1 < length && bytes[at + 1] === 0x0a)) return `: SSH: ${latin(bytes, 0, at)}`;
    if (c === 0x0d || !printable(c)) return '';
  }
  return '';
}

export function resetDataText(bytes: readonly number[], length: number): string {
  let text = length <= bytes.length ? ' [RST' : ' [!RST';
  let count = length;
  if (count > MAXIMUM_RESET_DATA) {
    count = MAXIMUM_RESET_DATA;
    text += '+';
  }
  text += ' ';
  for (let at = 0; at < count && at < bytes.length; at++) {
    let c = bytes[at];
    if (c >= 0x80) {
      c &= 0x7f;
      text += 'M-';
    }
    if (!printable(c)) {
      c ^= 0x40;
      text += '^';
    }
    text += String.fromCharCode(c);
  }
  return `${text}]`;
}

export function tcpApplicationText(
  sourcePort: number, destinationPort: number, bytes: readonly number[], length: number, verbose: number,
): string | null {
  const on = (port: number): boolean => sourcePort === port || destinationPort === port;
  if (on(25)) return `: ${textProtocol('SMTP', bytes, length, null, verbose)}`;
  if (on(22)) return sshVersion(bytes, length);
  if (on(21)) return `: ${textProtocol('FTP', bytes, length, null, verbose)}`;
  if (on(80) || on(8080)) return `: ${textProtocol('HTTP', bytes, length, HTTP_COMMANDS, verbose)}`;
  if (on(554) || on(8554)) return `: ${textProtocol('RTSP', bytes, length, RTSP_COMMANDS, verbose)}`;
  return null;
}
