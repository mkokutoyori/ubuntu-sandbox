import { SSHD_CONFIG_KEYWORDS } from './SshdConfigKeywords';
import type { SshdConfigSource } from './SshdConfigText';

export interface SshdConfigDiagnosis {
  readonly lines: readonly string[];
  readonly fatal: boolean;
}

const FLAG_KEYWORDS: ReadonlySet<string> = new Set([
  'allowagentforwarding', 'allowstreamlocalforwarding', 'challengeresponseauthentication', 'disableforwarding',
  'exposeauthinfo', 'gssapiauthentication', 'gssapicleanupcredentials', 'gssapistrictacceptorcheck',
  'hostbasedauthentication', 'hostbasedusesnamefrompacketonly', 'ignorerhosts', 'ignoreuserknownhosts',
  'kbdinteractiveauthentication', 'kerberosauthentication', 'kerberosorlocalpasswd', 'kerberosticketcleanup',
  'passwordauthentication', 'permitemptypasswords', 'permittty', 'permituserrc', 'printlastlog', 'printmotd',
  'pubkeyauthentication', 'streamlocalbindunlink', 'strictmodes', 'tcpkeepalive', 'usedns', 'uselogin', 'usepam',
  'x11forwarding', 'x11uselocalhost',
]);

const INTEGER_KEYWORDS: ReadonlySet<string> = new Set([
  'clientalivecountmax', 'clientaliveinterval', 'maxauthtries', 'maxsessions', 'x11displayoffset',
]);

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  permitrootlogin: ['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only'],
  allowtcpforwarding: ['yes', 'no', 'local', 'remote', 'all'],
  gatewayports: ['yes', 'no', 'clientspecified'],
  compression: ['yes', 'no', 'delayed'],
  addressfamily: ['any', 'inet', 'inet6'],
  loglevel: ['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE', 'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3'],
  syslogfacility: ['DAEMON', 'USER', 'AUTH', 'LOCAL0', 'LOCAL1', 'LOCAL2', 'LOCAL3', 'LOCAL4', 'LOCAL5', 'LOCAL6', 'LOCAL7'],
};

const ENUM_CASE_INSENSITIVE: ReadonlySet<string> = new Set(['loglevel', 'syslogfacility']);

const MATCH_CRITERIA: ReadonlySet<string> = new Set([
  'user', 'group', 'host', 'localaddress', 'localport', 'rdomain', 'address', 'all',
]);

const INCLUDE_DEPTH_LIMIT = 16;

export function diagnoseSshdConfig(
  source: SshdConfigSource, path: string, includeBase = '/etc/ssh',
): SshdConfigDiagnosis {
  const lines: string[] = [];
  let bad = 0;
  let fatal: string | null = null;

  const visit = (file: string, depth: number): void => {
    if (depth > INCLUDE_DEPTH_LIMIT || fatal !== null) return;
    const content = source.readFile(file);
    if (content === null) return;
    const rows = content.split('\n');
    for (let index = 0; index < rows.length && fatal === null; index += 1) {
      const row = rows[index].trim();
      if (row === '' || row.startsWith('#')) continue;
      const split = /^(\S+)\s*(.*)$/.exec(row);
      if (split === null) continue;
      const keyword = split[1].toLowerCase();
      const argument = split[2].trim();
      const where = `${file} line ${index + 1}`;
      if (!SSHD_CONFIG_KEYWORDS.has(keyword)) {
        lines.push(`${where}: Bad configuration option: ${split[1]}`);
        bad += 1;
        continue;
      }
      if (keyword === 'include') {
        for (const word of argument.split(/\s+/).filter((entry) => entry !== '')) {
          const pattern = word.startsWith('/') ? word : `${includeBase}/${word}`;
          for (const target of source.globExpand?.(pattern, '/') ?? []) visit(target, depth + 1);
        }
        continue;
      }
      if (keyword === 'match') {
        const failure = diagnoseMatch(argument);
        if (failure !== null) fatal = `${where}: ${failure}`;
        continue;
      }
      const failure = diagnoseArgument(keyword, argument);
      if (failure !== null) fatal = `${where}: ${failure}`;
    }
  };

  visit(path, 0);
  if (fatal !== null) return { lines: [...lines, fatal], fatal: true };
  if (bad > 0) return { lines: [...lines, `${path}: terminating, ${bad} bad configuration options`], fatal: true };
  return { lines, fatal: false };
}

function diagnoseArgument(keyword: string, argument: string): string | null {
  if (FLAG_KEYWORDS.has(keyword)) {
    if (argument === '') return 'missing yes/no argument.';
    const first = argument.split(/\s+/)[0].toLowerCase();
    return first === 'yes' || first === 'no' ? null : `Bad yes/no argument: ${argument.split(/\s+/)[0]}`;
  }
  if (INTEGER_KEYWORDS.has(keyword)) return argument === '' ? 'missing integer value.' : null;
  if (keyword === 'port') {
    if (argument === '') return 'missing port number.';
    const value = argument.split(/\s+/)[0];
    return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : 'Badly formatted port number.';
  }
  const allowed = ENUM_VALUES[keyword];
  if (allowed !== undefined) {
    if (argument === '') return 'missing argument.';
    const value = argument.split(/\s+/)[0];
    const known = ENUM_CASE_INSENSITIVE.has(keyword)
      ? allowed.includes(value.toUpperCase()) : allowed.includes(value);
    return known ? null : `unsupported option "${value}".`;
  }
  return null;
}

function diagnoseMatch(argument: string): string | null {
  const tokens = argument.split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return 'Missing Match criteria';
  for (let index = 0; index < tokens.length; index += 1) {
    const criterion = tokens[index].toLowerCase();
    if (!MATCH_CRITERIA.has(criterion)) return `Unsupported Match attribute ${tokens[index]}`;
    if (criterion === 'all') return tokens.length === 1 ? null : '"all" cannot be combined with other Match attributes';
    if (index + 1 >= tokens.length) return `Missing Match criteria for ${tokens[index]}`;
    index += 1;
  }
  return null;
}
