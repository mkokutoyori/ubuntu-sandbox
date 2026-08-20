import type { FirewallLogType } from '../../../logging/FirewallLogStore';

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
  { index: 11, name: 'utm-waf', type: 'utm', subtype: 'waf' },
  { index: 12, name: 'utm-dns', type: 'utm', subtype: 'dns' },
  { index: 13, name: 'utm-ssh', type: 'utm', subtype: 'ssh' },
  { index: 14, name: 'utm-ssl', type: 'utm', subtype: 'ssl' },
  { index: 15, name: 'utm-file-filter', type: 'utm', subtype: 'file-filter' },
  { index: 16, name: 'utm-icap', type: 'utm', subtype: 'icap' },
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
