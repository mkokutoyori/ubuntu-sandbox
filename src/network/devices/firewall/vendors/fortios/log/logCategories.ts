import type { FirewallLogType } from '../../../logging/FirewallLogStore';
import type { LogFilePrefix } from '../../../logging/LogDisk';

export interface LogCategory {
  readonly index: number;
  readonly name: string;
  readonly type: FirewallLogType;
  readonly subtype?: string;
}

export const LOG_CATEGORIES: readonly LogCategory[] = Object.freeze([
  { index: 0, name: 'traffic', type: 'traffic' },
  { index: 1, name: 'event', type: 'event' },
  { index: 2, name: 'utm-virus', type: 'utm', subtype: 'virus' },
  { index: 3, name: 'utm-webfilter', type: 'utm', subtype: 'webfilter' },
  { index: 4, name: 'utm-ips', type: 'utm', subtype: 'ips' },
  { index: 5, name: 'utm-emailfilter', type: 'utm', subtype: 'emailfilter' },
  { index: 7, name: 'utm-anomaly', type: 'utm', subtype: 'anomaly' },
  { index: 8, name: 'utm-voip', type: 'utm', subtype: 'voip' },
  { index: 9, name: 'utm-dlp', type: 'utm', subtype: 'dlp' },
  { index: 10, name: 'utm-app-ctrl', type: 'utm', subtype: 'app-ctrl' },
  { index: 12, name: 'utm-waf', type: 'utm', subtype: 'waf' },
  { index: 15, name: 'utm-dns', type: 'utm', subtype: 'dns' },
  { index: 16, name: 'utm-ssh', type: 'utm', subtype: 'ssh' },
  { index: 17, name: 'utm-ssl', type: 'utm', subtype: 'ssl' },
  { index: 19, name: 'utm-file-filter', type: 'utm', subtype: 'file-filter' },
  { index: 20, name: 'utm-icap', type: 'utm', subtype: 'icap' },
  { index: 22, name: 'utm-sctp-filter', type: 'utm', subtype: 'sctp-filter' },
  { index: 23, name: 'forti-switch', type: 'event', subtype: 'forti-switch' },
  { index: 24, name: 'utm-virtual-patch', type: 'utm', subtype: 'virtual-patch' },
  { index: 25, name: 'utm-casb', type: 'utm', subtype: 'casb' },
]);

export function resolveLogCategory(raw: string): LogCategory | undefined {
  if (/^\d+$/.test(raw)) {
    const index = Number.parseInt(raw, 10);
    return LOG_CATEGORIES.find(category => category.index === index);
  }
  const wanted = raw.toLowerCase();
  return LOG_CATEGORIES.find(category => category.name === wanted)
    ?? LOG_CATEGORIES.find(category => category.type === wanted
      && category.subtype === undefined);
}

export function describeLogCategories(): string {
  return LOG_CATEGORIES
    .map(category => `${String(category.index).padStart(2)}: ${category.name}`)
    .join('\n');
}

const LOG_TYPES: readonly FirewallLogType[] =
  Object.freeze(['traffic', 'event', 'utm']);

export function logFilePrefix(type: FirewallLogType): LogFilePrefix {
  return type === 'event' ? 'elog' : 'tlog';
}

export function typesOfLogFile(prefix: LogFilePrefix): readonly FirewallLogType[] {
  return LOG_TYPES.filter(type => logFilePrefix(type) === prefix);
}
