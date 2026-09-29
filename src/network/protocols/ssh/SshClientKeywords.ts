export interface SshClientKeyword {
  readonly name: string;
  readonly values?: readonly string[];
  readonly valuesBefore89?: readonly string[];
  readonly hidden?: true;
  readonly refusal?: string;
  readonly from?: '8.9';
  readonly until?: '8.6';
}

export type SshClientRelease = '8.9' | '8.6';

const FLAG = ['true', 'false', 'yes', 'no'] as const;
const PUBKEY_AUTH = [...FLAG, 'unbound', 'host-bound'] as const;
const STRICT_HOSTKEY = ['true', 'false', 'yes', 'no', 'ask', 'off', 'accept-new'] as const;
const COMPRESSION = ['yes', 'no'] as const;
const YESNOASK = [...FLAG, 'ask'] as const;
const ADDRESSFAMILY = ['inet', 'inet6', 'any'] as const;
const CONTROLMASTER = ['true', 'yes', 'false', 'no', 'auto', 'ask', 'autoask'] as const;
const TUNNEL = ['ethernet', 'point-to-point', 'true', 'yes', 'false', 'no'] as const;
const REQUESTTTY = ['true', 'yes', 'false', 'no', 'force', 'auto'] as const;
const SESSIONTYPE = ['none', 'subsystem', 'default'] as const;
const CANONICALIZEHOSTNAME = [...FLAG, 'always'] as const;

const SSH_CLIENT_KEYWORD_TABLE: readonly SshClientKeyword[] = [
  { name: 'protocol', hidden: true },
  { name: 'cipher', hidden: true },
  { name: 'fallbacktorsh', hidden: true },
  { name: 'globalknownhostsfile2', hidden: true },
  { name: 'rhostsauthentication', hidden: true },
  { name: 'userknownhostsfile2', hidden: true },
  { name: 'useroaming', hidden: true },
  { name: 'usersh', hidden: true },
  { name: 'useprivilegedport', hidden: true },
  { name: 'afstokenpassing', hidden: true },
  { name: 'kerberosauthentication', hidden: true },
  { name: 'kerberostgtpassing', hidden: true },
  { name: 'rsaauthentication', hidden: true },
  { name: 'rhostsrsaauthentication', hidden: true },
  { name: 'compressionlevel', hidden: true },
  { name: 'GSSAPIAuthentication', values: FLAG },
  { name: 'GSSAPIDelegateCredentials', values: FLAG },
  { name: 'PKCS11Provider' },
  { name: 'smartcarddevice', hidden: true },
  { name: 'ForwardAgent' },
  { name: 'ForwardX11' },
  { name: 'ForwardX11Trusted', values: FLAG },
  { name: 'ForwardX11Timeout' },
  { name: 'ExitOnForwardFailure', values: FLAG },
  { name: 'XAuthLocation' },
  { name: 'GatewayPorts', values: FLAG },
  { name: 'PasswordAuthentication', values: FLAG },
  { name: 'KbdInteractiveAuthentication', values: FLAG },
  { name: 'KbdInteractiveDevices' },
  { name: 'challengeresponseauthentication', values: FLAG, hidden: true },
  { name: 'skeyauthentication', values: FLAG, hidden: true },
  { name: 'tisauthentication', values: FLAG, hidden: true },
  { name: 'PubkeyAuthentication', values: PUBKEY_AUTH, valuesBefore89: FLAG },
  { name: 'dsaauthentication', values: PUBKEY_AUTH, valuesBefore89: FLAG, hidden: true },
  { name: 'HostbasedAuthentication', values: FLAG },
  { name: 'IdentityFile' },
  { name: 'identityfile2', hidden: true },
  { name: 'IdentitiesOnly', values: FLAG },
  { name: 'CertificateFile' },
  { name: 'AddKeysToAgent' },
  { name: 'IdentityAgent' },
  { name: 'Hostname' },
  { name: 'HostKeyAlias' },
  { name: 'ProxyCommand' },
  { name: 'Port' },
  { name: 'Ciphers' },
  { name: 'MACs' },
  { name: 'RemoteForward' },
  { name: 'LocalForward' },
  { name: 'PermitRemoteOpen' },
  { name: 'User' },
  { name: 'Host', hidden: true, refusal: 'Host directive not supported as a command-line option' },
  { name: 'Match', hidden: true, refusal: 'Host directive not supported as a command-line option' },
  { name: 'EscapeChar' },
  { name: 'GlobalKnownHostsFile' },
  { name: 'UserKnownHostsFile' },
  { name: 'ConnectionAttempts' },
  { name: 'BatchMode', values: FLAG },
  { name: 'CheckHostIP', values: FLAG },
  { name: 'StrictHostKeyChecking', values: STRICT_HOSTKEY },
  { name: 'Compression', values: COMPRESSION },
  { name: 'TCPKeepAlive', values: FLAG },
  { name: 'keepalive', values: FLAG, hidden: true },
  { name: 'NumberOfPasswordPrompts' },
  { name: 'SyslogFacility' },
  { name: 'LogLevel' },
  { name: 'LogVerbose' },
  { name: 'DynamicForward' },
  { name: 'PreferredAuthentications' },
  { name: 'HostKeyAlgorithms' },
  { name: 'CASignatureAlgorithms' },
  { name: 'BindAddress' },
  { name: 'BindInterface' },
  { name: 'ClearAllForwardings', values: FLAG },
  { name: 'EnableSSHKeysign', values: FLAG },
  { name: 'VerifyHostKeyDNS', values: YESNOASK },
  { name: 'NoHostAuthenticationForLocalhost', values: FLAG },
  { name: 'RekeyLimit' },
  { name: 'ConnectTimeout' },
  { name: 'AddressFamily', values: ADDRESSFAMILY },
  { name: 'ServerAliveInterval' },
  { name: 'ServerAliveCountMax' },
  { name: 'SendEnv' },
  { name: 'SetEnv' },
  { name: 'ControlPath' },
  { name: 'ControlMaster', values: CONTROLMASTER },
  { name: 'ControlPersist' },
  { name: 'HashKnownHosts', values: FLAG },
  { name: 'Include', hidden: true, refusal: 'Include directive not supported as a command-line option' },
  { name: 'Tunnel', values: TUNNEL },
  { name: 'TunnelDevice' },
  { name: 'LocalCommand' },
  { name: 'PermitLocalCommand', values: FLAG },
  { name: 'RemoteCommand' },
  { name: 'VisualHostKey', values: FLAG },
  { name: 'KexAlgorithms' },
  { name: 'IPQoS' },
  { name: 'RequestTTY', values: REQUESTTTY },
  { name: 'SessionType', values: SESSIONTYPE, from: '8.9' },
  { name: 'StdinNull', values: FLAG, from: '8.9' },
  { name: 'ForkAfterAuthentication', values: FLAG, from: '8.9' },
  { name: 'ProxyUseFdpass', values: FLAG },
  { name: 'CanonicalDomains' },
  { name: 'CanonicalizeFallbackLocal', values: FLAG },
  { name: 'CanonicalizeHostname', values: CANONICALIZEHOSTNAME },
  { name: 'CanonicalizeMaxDots' },
  { name: 'CanonicalizePermittedCNAMEs' },
  { name: 'StreamLocalBindMask' },
  { name: 'StreamLocalBindUnlink', values: FLAG },
  { name: 'RevokedHostKeys' },
  { name: 'FingerprintHash' },
  { name: 'UpdateHostKeys', values: YESNOASK },
  { name: 'HostbasedAcceptedAlgorithms', from: '8.9' },
  { name: 'hostbasedkeytypes', hidden: true },
  { name: 'PubkeyAcceptedAlgorithms' },
  { name: 'pubkeyacceptedkeytypes', hidden: true },
  { name: 'IgnoreUnknown' },
  { name: 'ProxyJump' },
  { name: 'SecurityKeyProvider' },
  { name: 'KnownHostsCommand' },
  { name: 'hostbasedalgorithms', hidden: true, until: '8.6' },
];

export function sshClientKeywords(release: SshClientRelease): readonly SshClientKeyword[] {
  return SSH_CLIENT_KEYWORD_TABLE
    .filter(keyword => release === '8.9' ? keyword.until === undefined : keyword.from === undefined)
    .map(keyword => release === '8.6' && keyword.valuesBefore89 !== undefined
      ? { ...keyword, values: keyword.valuesBefore89 }
      : keyword);
}
