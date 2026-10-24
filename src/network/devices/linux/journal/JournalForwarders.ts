export interface ForwardedMessage {
  readonly priority: number;
  readonly facility: number;
  readonly identifier: string;
  readonly pid: number;
  readonly message: string;
  readonly monotonicUsec: number;
}

const LOG_KERN = 0;
const LOG_USER = 1;
const USEC_PER_SEC = 1_000_000;

function header(identifier: string, pid: number): string {
  if (pid > 0) return `${identifier}[${pid}]: `;
  return identifier === '' ? '' : `${identifier}: `;
}

export function kmsgLine(message: ForwardedMessage): string {
  const facility = message.facility === LOG_KERN ? LOG_USER : message.facility;
  return `<${(facility << 3) | message.priority}>${header(message.identifier, message.pid)}${message.message}\n`;
}

export function consoleLine(message: ForwardedMessage, printkTime: boolean): string {
  const seconds = Math.floor(message.monotonicUsec / USEC_PER_SEC);
  const micro = String(Math.floor(message.monotonicUsec % USEC_PER_SEC)).padStart(6, '0');
  const stamp = printkTime ? `[${String(seconds).padStart(5)}.${micro}] ` : '';
  return `${stamp}${header(message.identifier, message.pid)}${message.message}\n`;
}

export function wallText(message: ForwardedMessage, hostname: string, timestamp: string): string {
  return `\r\nBroadcast message from systemd-journald@${hostname} (${timestamp}):\r\n\r\n${header(message.identifier, message.pid)}${message.message}\r\n\r\n`;
}
