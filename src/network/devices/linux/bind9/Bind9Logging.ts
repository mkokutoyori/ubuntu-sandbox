import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import type { NamedConfig } from './NamedConfig';

export type AppendFileFn = (path: string, content: string) => void;

export const DEFAULT_QUERY_LOG_PATH = '/var/log/named/query.log';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function bindTimestamp(date: Date): string {
  return `${pad(date.getDate(), 2)}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ` +
    `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}` +
    `.${pad(date.getMilliseconds(), 3)}`;
}

export interface QueryLogEntry {
  readonly clientIP: string;
  readonly clientPort: number;
  readonly qname: string;
  readonly qtype: number;
  readonly serverIP: string;
}

export class Bind9Logging {
  constructor(
    private readonly appendFile: AppendFileFn,
    private readonly now: () => Date = () => new Date(),
  ) {}

  queryLogPath(config: NamedConfig): string | null {
    const channelNames = config.logging.categories.get('queries');
    if (!channelNames || channelNames.length === 0) return DEFAULT_QUERY_LOG_PATH;
    for (const name of channelNames) {
      const channel = config.logging.channels.get(name);
      if (channel?.target === 'file' && channel.path !== null) return channel.path;
    }
    return null;
  }

  logQuery(config: NamedConfig, entry: QueryLogEntry): void {
    const path = this.queryLogPath(config);
    if (path === null) return;
    const type = rrTypeName(entry.qtype);
    const line = `${bindTimestamp(this.now())} client @0x0 ` +
      `${entry.clientIP}#${entry.clientPort} (${entry.qname}): ` +
      `query: ${entry.qname} IN ${type} + (${entry.serverIP})\n`;
    this.appendFile(path, line);
  }
}
