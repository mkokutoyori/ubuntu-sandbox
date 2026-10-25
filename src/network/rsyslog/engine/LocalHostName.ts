import type { RsyslogHost } from './Host';
import type { GlobalSettings } from './Settings';

export function localHostNameOf(settings: GlobalSettings, host: RsyslogHost): string {
  if (settings.localHostNameOverride !== null) return settings.localHostNameOverride;
  const full = host.hostname();
  const domain = host.domainName();
  if (settings.preserveFqdn) return full.includes('.') || domain === null ? full : `${full}.${domain}`;
  const dot = full.indexOf('.');
  return dot < 0 ? full : full.slice(0, dot);
}
