import type { ConfSection } from './FreeradiusConf';

export interface RadiusdLogConfig {
  destination: 'files' | 'syslog' | 'stdout' | 'stderr';
  file: string;
  auth: boolean;
  authAccept: boolean;
  authReject: boolean;
  authBadpass: boolean;
  authGoodpass: boolean;
  radacctDir: string;
}

export const DEFAULT_RADACCT_DIR = '/var/log/freeradius/radacct';
export const DEFAULT_RADIUS_LOG_FILE = '/var/log/freeradius/radius.log';

const TRUE_WORDS = new Set(['yes', 'true', 'on']);
const FALSE_WORDS = new Set(['no', 'false', 'off']);
const DESTINATIONS = new Set(['files', 'syslog', 'stdout', 'stderr']);

export function readRadiusdLogConfig(root: ConfSection): RadiusdLogConfig | { error: string } {
  const config: RadiusdLogConfig = {
    destination: 'files', file: DEFAULT_RADIUS_LOG_FILE,
    auth: false, authAccept: false, authReject: false, authBadpass: false, authGoodpass: false,
    radacctDir: root.pairs.find((pair) => pair.name === 'radacctdir')?.value ?? DEFAULT_RADACCT_DIR,
  };
  const section = root.sections.find((candidate) => candidate.name1 === 'log');
  if (!section) return config;
  const flags: Record<string, 'auth' | 'authAccept' | 'authReject' | 'authBadpass' | 'authGoodpass'> = {
    auth: 'auth', auth_accept: 'authAccept', auth_reject: 'authReject', auth_badpass: 'authBadpass', auth_goodpass: 'authGoodpass',
  };
  for (const pair of section.pairs) {
    const flag = flags[pair.name];
    if (flag) {
      const word = pair.value.toLowerCase();
      if (TRUE_WORDS.has(word)) config[flag] = true;
      else if (FALSE_WORDS.has(word)) config[flag] = false;
      else return { error: `${pair.file}[${pair.line}]: Invalid value '${pair.value}' for boolean variable ${pair.name}` };
    } else if (pair.name === 'destination') {
      if (!DESTINATIONS.has(pair.value)) return { error: `radiusd: Error: Unknown log_destination ${pair.value}` };
      config.destination = pair.value as RadiusdLogConfig['destination'];
    } else if (pair.name === 'file') {
      config.file = pair.value;
    }
  }
  return config;
}
