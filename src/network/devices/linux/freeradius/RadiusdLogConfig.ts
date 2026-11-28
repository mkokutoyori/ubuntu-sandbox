import { confBoolean, type ConfSection } from './FreeradiusConf';
import { readDetailSettings, type DetailSettings } from './DetailModule';

export interface RadiusdLogConfig {
  destination: 'files' | 'syslog' | 'stdout' | 'stderr';
  file: string;
  auth: boolean;
  authAccept: boolean;
  authReject: boolean;
  authBadpass: boolean;
  authGoodpass: boolean;
  msgDenied: string;
  msgGoodpass: string | null;
  msgBadpass: string | null;
  detail: DetailSettings | null;
}

export const DEFAULT_MSG_DENIED = 'You are already logged in - access denied';
export const DEFAULT_RADIUS_LOG_FILE = '/var/log/freeradius/radius.log';

const DESTINATIONS = new Set(['files', 'syslog', 'stdout', 'stderr']);

export function readRadiusdLogConfig(root: ConfSection): RadiusdLogConfig | { error: string } {
  const config: RadiusdLogConfig = {
    destination: 'files', file: DEFAULT_RADIUS_LOG_FILE,
    auth: false, authAccept: false, authReject: false, authBadpass: false, authGoodpass: false,
    msgDenied: DEFAULT_MSG_DENIED, msgGoodpass: null, msgBadpass: null, detail: null,
  };
  const section = root.sections.find((candidate) => candidate.name1 === 'log');
  if (!section) return withDetail(root, config);
  const flags: Record<string, 'auth' | 'authAccept' | 'authReject' | 'authBadpass' | 'authGoodpass'> = {
    auth: 'auth', auth_accept: 'authAccept', auth_reject: 'authReject', auth_badpass: 'authBadpass', auth_goodpass: 'authGoodpass',
  };
  for (const pair of section.pairs) {
    const flag = flags[pair.name];
    if (flag) {
      const value = confBoolean(pair);
      if (typeof value === 'object') return value;
      config[flag] = value;
    } else if (pair.name === 'destination') {
      if (!DESTINATIONS.has(pair.value)) return { error: `radiusd: Error: Unknown log_destination ${pair.value}` };
      config.destination = pair.value as RadiusdLogConfig['destination'];
    } else if (pair.name === 'msg_denied') {
      config.msgDenied = pair.value;
    } else if (pair.name === 'msg_goodpass') {
      config.msgGoodpass = pair.value;
    } else if (pair.name === 'msg_badpass') {
      config.msgBadpass = pair.value;
    } else if (pair.name === 'file') {
      config.file = pair.value;
    }
  }
  return withDetail(root, config);
}

function withDetail(root: ConfSection, config: RadiusdLogConfig): RadiusdLogConfig | { error: string } {
  const detail = readDetailSettings(root);
  if (detail !== null && 'error' in detail) return detail;
  return { ...config, detail: detail as DetailSettings | null };
}
