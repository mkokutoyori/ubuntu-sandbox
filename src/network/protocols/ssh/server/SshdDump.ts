import {
  OPENSSH_CIPHERS, OPENSSH_HOST_KEY_ALGORITHMS, OPENSSH_KEX_ALGORITHMS, OPENSSH_MACS, assembleAlgorithmList,
} from '../transport/SshAlgorithms';
import { SshdServerConfig } from './SshdServerConfig';

export interface SshdPlatformProfile {
  readonly hostKeyPaths: readonly string[];
  readonly authorizedKeysFile: string;
  readonly sftpServer: string;
  readonly pidFile: string;
  readonly moduliFile: string;
  readonly usePam: boolean;
  readonly hybridKex: boolean;
}

export const LINUX_SSHD_PROFILE: SshdPlatformProfile = {
  hostKeyPaths: ['/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ecdsa_key', '/etc/ssh/ssh_host_ed25519_key'],
  authorizedKeysFile: '.ssh/authorized_keys .ssh/authorized_keys2',
  sftpServer: '/usr/lib/openssh/sftp-server',
  pidFile: '/run/sshd.pid',
  moduliFile: '/etc/ssh/moduli',
  usePam: true,
  hybridKex: true,
};

export const WINDOWS_SSHD_PROFILE: SshdPlatformProfile = {
  hostKeyPaths: [
    'C:/ProgramData/ssh/ssh_host_rsa_key', 'C:/ProgramData/ssh/ssh_host_ecdsa_key',
    'C:/ProgramData/ssh/ssh_host_ed25519_key',
  ],
  authorizedKeysFile: '.ssh/authorized_keys .ssh/authorized_keys2',
  sftpServer: 'sftp-server.exe',
  pidFile: 'C:/ProgramData/ssh/logs/sshd.pid',
  moduliFile: 'C:/ProgramData/ssh/moduli',
  usePam: false,
  hybridKex: false,
};

export interface SshdConnectionSpec {
  readonly user?: string;
  readonly host?: string;
  readonly addr?: string;
  readonly laddr?: string;
  readonly lport?: number;
}

const ACCUMULATING: ReadonlySet<string> = new Set([
  'port', 'listenaddress', 'hostkey', 'hostcertificate', 'allowusers', 'denyusers', 'allowgroups', 'denygroups',
  'acceptenv', 'setenv', 'permitopen', 'permitlisten',
]);

const REPLACED_BY_MATCH: ReadonlySet<string> = new Set([
  'allowusers', 'denyusers', 'allowgroups', 'denygroups', 'permitopen', 'permitlisten',
]);

const CERT_TYPES = [
  'ssh-ed25519-cert-v01@openssh.com', 'ecdsa-sha2-nistp256-cert-v01@openssh.com',
  'ecdsa-sha2-nistp384-cert-v01@openssh.com', 'ecdsa-sha2-nistp521-cert-v01@openssh.com',
  'sk-ssh-ed25519-cert-v01@openssh.com', 'sk-ecdsa-sha2-nistp256-cert-v01@openssh.com',
  'rsa-sha2-512-cert-v01@openssh.com', 'rsa-sha2-256-cert-v01@openssh.com',
];

const FLAGS: ReadonlyArray<readonly [string, boolean]> = [
  ['ignorerhosts', true], ['ignoreuserknownhosts', false], ['hostbasedauthentication', false],
  ['hostbasedusesnamefrompacketonly', false], ['pubkeyauthentication', true], ['kerberosauthentication', false],
  ['kerberosorlocalpasswd', true], ['kerberosticketcleanup', true], ['gssapiauthentication', false],
  ['gssapicleanupcredentials', true], ['gssapikeyexchange', false], ['gssapistrictacceptorcheck', true],
  ['gssapistorecredentialsonrekey', false], ['passwordauthentication', true], ['kbdinteractiveauthentication', false],
  ['printmotd', true], ['printlastlog', true], ['x11forwarding', false], ['x11uselocalhost', true],
  ['permittty', true], ['permituserrc', true], ['strictmodes', true], ['tcpkeepalive', true],
  ['permitemptypasswords', false], ['compression', true], ['gatewayports', false], ['usedns', false],
  ['allowtcpforwarding', true], ['allowagentforwarding', true], ['disableforwarding', false],
  ['allowstreamlocalforwarding', true], ['streamlocalbindunlink', false],
];

const NONE_KEYWORDS = [
  'banner', 'forcecommand', 'chrootdirectory', 'trustedusercakeys', 'revokedkeys',
];
const NONE_KEYWORDS_AFTER = [
  'authorizedprincipalsfile', 'versionaddendum', 'authorizedkeyscommand', 'authorizedkeyscommanduser',
  'authorizedprincipalscommand', 'authorizedprincipalscommanduser', 'hostkeyagent',
];

function durationSeconds(value: string): string {
  const match = /^(\d+)([smhdw]?)$/i.exec(value);
  if (match === null) return value;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }[match[2].toLowerCase() as '' | 's' | 'm' | 'h' | 'd' | 'w'];
  return String(Number(match[1]) * unit);
}

function yesNo(value: string): string {
  const lowered = value.toLowerCase();
  return lowered === 'yes' || lowered === 'true' ? 'yes' : 'no';
}

function listenLine(address: string, port: number): string {
  const bare = address.replace(/^\[|\]$/g, '');
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

export function dumpSshdConfig(
  effectiveText: string, profile: SshdPlatformProfile, connection: SshdConnectionSpec = {},
): string {
  const cfg = SshdServerConfig.parse(effectiveText);
  const scopes: Array<{ matchIndex: number; lines: string[] }> = [{ matchIndex: -1, lines: [] }];
  let matchCount = 0;
  for (const raw of effectiveText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^match\s/i.test(line)) {
      scopes.push({ matchIndex: matchCount, lines: [] });
      matchCount += 1;
      continue;
    }
    scopes[scopes.length - 1].lines.push(line);
  }
  const groupsOfConnection: readonly string[] = [];
  const values = new Map<string, string[]>();
  const apply = (lines: readonly string[]): void => {
    const touched = new Set<string>();
    for (const line of lines) {
      const split = /^(\S+)\s*(.*)$/.exec(line);
      if (split === null) continue;
      const keyword = split[1].toLowerCase() === 'challengeresponseauthentication' ? 'kbdinteractiveauthentication' : split[1].toLowerCase();
      const argument = split[2].trim();
      const identity = keyword === 'subsystem' ? `subsystem ${argument.split(/\s+/)[0]}` : keyword;
      if (ACCUMULATING.has(keyword)) {
        const replaced = REPLACED_BY_MATCH.has(keyword) && !touched.has(identity);
        const list = replaced ? [] : values.get(identity) ?? [];
        list.push(argument);
        values.set(identity, list);
        touched.add(identity);
      } else {
        values.set(identity, [argument]);
      }
    }
  };
  apply(scopes[0].lines);
  for (const scope of scopes.slice(1)) {
    const block = cfg.matchBlocks[scope.matchIndex];
    if (block === undefined) continue;
    const ctx = {
      user: connection.user ?? '', groups: groupsOfConnection, host: connection.host, address: connection.addr,
      localPort: connection.lport,
    };
    if (connection.user === undefined && block.criteria.some((c) => c.keyword === 'User' || c.keyword === 'Group')) continue;
    if (cfg.matchApplies(block.criteria, ctx)) apply(scope.lines);
  }

  const one = (keyword: string): string | undefined => values.get(keyword)?.[0];
  const out: string[] = [];
  const ports = (values.get('port') ?? ['22']).map((entry) => Number(entry.split(/\s+/)[0]));
  for (const port of ports) out.push(`port ${port}`);
  out.push(`addressfamily ${one('addressfamily') ?? 'any'}`);
  const listen = values.get('listenaddress') ?? ['[::]', '0.0.0.0'];
  for (const port of ports) for (const address of listen) out.push(`listenaddress ${listenLine(address.split(/\s+/)[0], port)}`);
  if (profile.usePam) out.push(`usepam ${yesNo(one('usepam') ?? 'no')}`);
  out.push(`logingracetime ${durationSeconds(one('logingracetime') ?? '120')}`);
  out.push(`x11displayoffset ${one('x11displayoffset') ?? '10'}`);
  out.push(`maxauthtries ${one('maxauthtries') ?? '6'}`);
  out.push(`maxsessions ${one('maxsessions') ?? '10'}`);
  out.push(`clientaliveinterval ${one('clientaliveinterval') ?? '0'}`);
  out.push(`clientalivecountmax ${one('clientalivecountmax') ?? '3'}`);
  out.push(`streamlocalbindmask ${one('streamlocalbindmask') ?? '0177'}`);
  const root = one('permitrootlogin') ?? 'prohibit-password';
  out.push(`permitrootlogin ${root === 'prohibit-password' ? 'without-password' : root}`);
  for (const [keyword, fallback] of FLAGS) {
    const raw = one(keyword);
    if (keyword === 'compression') out.push(`compression ${raw ?? 'yes'}`);
    else if (keyword === 'gatewayports') out.push(`gatewayports ${raw ?? 'no'}`);
    else if (keyword === 'allowtcpforwarding') out.push(`allowtcpforwarding ${raw ?? 'yes'}`);
    else out.push(`${keyword} ${raw === undefined ? (fallback ? 'yes' : 'no') : yesNo(raw)}`);
  }
  out.push(`fingerprinthash ${one('fingerprinthash') ?? 'SHA256'}`);
  out.push(`exposeauthinfo ${yesNo(one('exposeauthinfo') ?? 'no')}`);
  out.push(`pidfile ${one('pidfile') ?? profile.pidFile}`);
  out.push(`modulifile ${one('modulifile') ?? profile.moduliFile}`);
  const algorithm = (keyword: string, defaults: readonly string[]): string => {
    const spec = one(keyword);
    return (spec === undefined ? defaults : assembleAlgorithmList(defaults, spec)).join(',');
  };
  out.push(`ciphers ${algorithm('ciphers', OPENSSH_CIPHERS)}`);
  out.push(`macs ${algorithm('macs', OPENSSH_MACS)}`);
  for (const keyword of NONE_KEYWORDS) out.push(`${keyword} ${one(keyword) ?? 'none'}`);
  out.push(`securitykeyprovider ${one('securitykeyprovider') ?? 'internal'}`);
  for (const keyword of NONE_KEYWORDS_AFTER) out.push(`${keyword} ${one(keyword) ?? 'none'}`);
  const kexDefaults = profile.hybridKex ? OPENSSH_KEX_ALGORITHMS : OPENSSH_KEX_ALGORITHMS.filter((name) => !name.startsWith('sntrup'));
  out.push(`kexalgorithms ${algorithm('kexalgorithms', kexDefaults)}`);
  const keyTypes = [...CERT_TYPES, ...OPENSSH_HOST_KEY_ALGORITHMS];
  out.push(`hostbasedacceptedalgorithms ${algorithm('hostbasedacceptedalgorithms', keyTypes)}`);
  out.push(`hostkeyalgorithms ${algorithm('hostkeyalgorithms', keyTypes)}`);
  out.push(`pubkeyacceptedalgorithms ${algorithm('pubkeyacceptedalgorithms', keyTypes)}`);
  out.push(`loglevel ${(one('loglevel') ?? 'INFO').toUpperCase()}`);
  out.push(`syslogfacility ${(one('syslogfacility') ?? 'AUTH').toUpperCase()}`);
  out.push(`authorizedkeysfile ${one('authorizedkeysfile') ?? profile.authorizedKeysFile}`);
  for (const key of values.get('hostkey') ?? profile.hostKeyPaths) out.push(`hostkey ${key}`);
  for (const certificate of values.get('hostcertificate') ?? []) out.push(`hostcertificate ${certificate}`);
  for (const keyword of ['allowgroups', 'allowusers', 'denygroups', 'denyusers']) {
    for (const entry of values.get(keyword) ?? []) for (const pattern of entry.split(/\s+/)) out.push(`${keyword} ${pattern}`);
  }
  for (const entry of values.get('acceptenv') ?? []) for (const pattern of entry.split(/\s+/)) out.push(`acceptenv ${pattern}`);
  for (const entry of values.get('setenv') ?? []) out.push(`setenv ${entry}`);
  const sftp = values.get('subsystem sftp');
  out.push(`subsystem sftp ${sftp === undefined ? profile.sftpServer : sftp[0].replace(/^sftp\s+/, '')}`);
  for (const [identity, entries] of values) {
    if (!identity.startsWith('subsystem ') || identity === 'subsystem sftp') continue;
    out.push(`subsystem ${entries[0]}`);
  }
  const startups = (one('maxstartups') ?? '10:30:100').split(':');
  out.push(`maxstartups ${startups.length === 1 ? `${startups[0]}:30:100` : startups.join(':')}`);
  out.push(`permittunnel ${one('permittunnel') ?? 'no'}`);
  out.push(`ipqos ${one('ipqos') ?? 'af21 cs1'}`);
  out.push(`rekeylimit ${(one('rekeylimit') ?? 'default none').replace(/^default none$/, '0 0')}`);
  for (const entry of values.get('permitopen') ?? ['any']) out.push(`permitopen ${entry}`);
  for (const entry of values.get('permitlisten') ?? ['any']) out.push(`permitlisten ${entry}`);
  out.push(`permituserenvironment ${yesNo(one('permituserenvironment') ?? 'no')}`);
  out.push(`pubkeyauthoptions ${one('pubkeyauthoptions') ?? 'none'}`);
  return `${out.join('\n')}\n`;
}
