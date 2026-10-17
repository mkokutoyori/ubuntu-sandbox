import type { SshServerConfig } from './ISshServerContext';
import { addressListMatches, globMatch, permitOpenAllows } from '../SshPureUtils';
export type SshdAddressFamily = 'any' | 'inet' | 'inet6';
export type SshdPermitRootLogin = 'yes' | 'no' | 'prohibit-password' | 'forced-commands-only';
export type SshdLogLevel = 'QUIET' | 'FATAL' | 'ERROR' | 'INFO' | 'VERBOSE' | 'DEBUG' | 'DEBUG1' | 'DEBUG2' | 'DEBUG3';
export type SshdSyslogFacility = 'AUTH' | 'AUTHPRIV' | 'DAEMON' | 'USER' | 'LOCAL0' | 'LOCAL1' | 'LOCAL2' | 'LOCAL3' | 'LOCAL4' | 'LOCAL5' | 'LOCAL6' | 'LOCAL7';
export type SshdAllowTcpForwarding = 'yes' | 'no' | 'local' | 'remote' | 'all';
export type SshdGatewayPorts = 'yes' | 'no' | 'clientspecified';
export type SshdCompression = 'yes' | 'no' | 'delayed';

export interface SshdMaxStartups {
  readonly start: number;
  readonly rate: number;
  readonly full: number;
}

export interface SshdMatchCriterion {
  readonly keyword: 'User' | 'Group' | 'Host' | 'LocalPort' | 'Address' | 'LocalAddress';
  readonly value: string;
}

export interface SshdMatchOverrides {
  permitRootLogin?: SshdPermitRootLogin;
  passwordAuthentication?: boolean;
  pubkeyAuthentication?: boolean;
  kbdInteractiveAuthentication?: boolean;
  challengeResponseAuthentication?: boolean;
  maxAuthTries?: number;
  maxSessions?: number;
  allowTcpForwarding?: SshdAllowTcpForwarding;
  x11Forwarding?: boolean;
  permitEmptyPasswords?: boolean;
  banner?: string | null;
  forceCommand?: string;
  chrootDirectory?: string;
  acceptEnv?: readonly string[];
  allowAgentForwarding?: boolean;
  permitTty?: boolean;
  gatewayPorts?: SshdGatewayPorts;
  clientAliveIntervalSeconds?: number;
  clientAliveCountMax?: number;
  printMotd?: boolean;
  allowUsers?: readonly string[];
  denyUsers?: readonly string[];
  allowGroups?: readonly string[];
  denyGroups?: readonly string[];
  authorizedKeysFile?: readonly string[];
  authorizedPrincipalsFile?: string | null;
  trustedUserCaKeys?: string | null;
  revokedKeys?: string | null;
  caSignatureAlgorithms?: readonly string[];
}

export interface SshdMatchBlock {
  readonly criteria: readonly SshdMatchCriterion[];
  readonly overrides: SshdMatchOverrides;
}

export interface SshdEffectiveView {
  readonly permitRootLogin: SshdPermitRootLogin;
  readonly passwordAuthentication: boolean;
  readonly pubkeyAuthentication: boolean;
  readonly kbdInteractiveAuthentication: boolean;
  readonly challengeResponseAuthentication: boolean;
  readonly maxAuthTries: number;
  readonly maxSessions: number;
  readonly allowTcpForwarding: SshdAllowTcpForwarding;
  readonly x11Forwarding: boolean;
  readonly permitEmptyPasswords: boolean;
  readonly banner: string | null;
  readonly forceCommand: string | null;
  readonly acceptEnv: readonly string[];
  readonly allowAgentForwarding: boolean;
  readonly permitTty: boolean;
  readonly gatewayPorts: SshdGatewayPorts;
  readonly clientAliveIntervalSeconds: number;
  readonly clientAliveCountMax: number;
  readonly printMotd: boolean;
  readonly authorizedKeysFile: readonly string[];
  readonly authorizedPrincipalsFile: string | null;
  readonly trustedUserCaKeys: string | null;
  readonly revokedKeys: string | null;
  readonly caSignatureAlgorithms: readonly string[];
}

const DEFAULT_CA_SIGNATURE_ALGORITHMS = [
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256',
];

export interface SshdSubsystems {
  readonly sftp: string | null;
  readonly extras: ReadonlyMap<string, string>;
}

export interface SshdServerConfigSnapshot {
  readonly ports: readonly number[];
  readonly listenAddresses: readonly string[];
  readonly addressFamily: SshdAddressFamily;
  readonly permitRootLogin: SshdPermitRootLogin;
  readonly passwordAuthentication: boolean;
  readonly pubkeyAuthentication: boolean;
  readonly kbdInteractiveAuthentication: boolean;
  readonly challengeResponseAuthentication: boolean;
  readonly gssapiAuthentication: boolean;
  readonly hostbasedAuthentication: boolean;
  readonly maxAuthTries: number;
  readonly maxSessions: number;
  readonly maxStartups: SshdMaxStartups;
  readonly loginGraceTimeSeconds: number;
  readonly rekeyLimit: string;
  readonly permitEmptyPasswords: boolean;
  readonly allowTcpForwarding: SshdAllowTcpForwarding;
  readonly allowAgentForwarding: boolean;
  readonly permitTty: boolean;
  readonly allowStreamLocalForwarding: boolean;
  readonly x11Forwarding: boolean;
  readonly x11DisplayOffset: number;
  readonly gatewayPorts: SshdGatewayPorts;
  readonly tcpKeepAlive: boolean;
  readonly clientAliveIntervalSeconds: number;
  readonly clientAliveCountMax: number;
  readonly printMotd: boolean;
  readonly printLastLog: boolean;
  readonly useDns: boolean;
  readonly useLogin: boolean;
  readonly usePam: boolean;
  readonly permitUserEnvironment: boolean;
  readonly strictModes: boolean;
  readonly compression: SshdCompression;
  readonly logLevel: SshdLogLevel;
  readonly syslogFacility: SshdSyslogFacility;
  readonly bannerPath: string | null;
  readonly motdPath: string;
  readonly subsystems: SshdSubsystems;
  readonly allowUsers: readonly string[];
  readonly denyUsers: readonly string[];
  readonly allowGroups: readonly string[];
  readonly denyGroups: readonly string[];
  readonly acceptEnv: readonly string[];
  readonly ciphers: readonly string[];
  readonly macs: readonly string[];
  readonly kexAlgorithms: readonly string[];
  readonly hostKeyAlgorithms: readonly string[];
  readonly forceCommand: string | null;
  readonly chrootDirectory: string | null;
  readonly permitOpen: readonly string[];
  readonly authorizedKeysFile: readonly string[];
  readonly authorizedPrincipalsFile: string | null;
  readonly trustedUserCaKeys: string | null;
  readonly hostCertificates: readonly string[];
  readonly revokedKeys: string | null;
  readonly caSignatureAlgorithms: readonly string[];
  readonly matchBlocks: readonly SshdMatchBlock[];
}

const DEFAULT_CIPHERS = [
  '[email protected]',
  '[email protected]',
  '[email protected]',
  'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
];
const DEFAULT_MACS = [
  '[email protected]',
  '[email protected]',
  '[email protected]',
  'hmac-sha2-256', 'hmac-sha2-512',
];
const DEFAULT_KEX = [
  'sntrup761x25519-sha512',
  'curve25519-sha256',
  '[email protected]',
  'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
  'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
];
const DEFAULT_HOSTKEY_ALGOS = [
  'ssh-ed25519',
  '[email protected]',
  'rsa-sha2-512', 'rsa-sha2-256',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
];

const YES_NO = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  const lo = v.toLowerCase();
  if (lo === 'yes' || lo === 'true' || lo === '1') return true;
  if (lo === 'no'  || lo === 'false' || lo === '0') return false;
  return fallback;
};

function userPatternMatches(pattern: string, user: string, address: string): boolean {
  const at = pattern.indexOf('@');
  if (at < 0) return globMatch(pattern, user);
  return globMatch(pattern.slice(0, at), user) && address !== '' && addressListMatches(pattern.slice(at + 1), address);
}

export function handlerConfigOf(cfg: SshdServerConfig): SshServerConfig {
  return {
    listenPort: cfg.ports[0] ?? 22,
    maxAuthTries: cfg.maxAuthTries,
    maxSessions: cfg.maxSessions,
    permitRootLogin: cfg.permitRootLogin !== 'no',
    passwordAuthentication: cfg.passwordAuthentication,
    pubkeyAuthentication: cfg.pubkeyAuthentication,
    kbdInteractiveAuthentication: cfg.kbdInteractiveAuthentication,
    clientAliveInterval: cfg.clientAliveIntervalSeconds,
    clientAliveCountMax: cfg.clientAliveCountMax,
    loginGraceTime: cfg.loginGraceTimeSeconds,
    maxStartups: cfg.maxStartups,
  };
}

export class SshdServerConfig implements SshdServerConfigSnapshot {
  readonly ports: readonly number[];
  readonly listenAddresses: readonly string[];
  readonly addressFamily: SshdAddressFamily;
  readonly permitRootLogin: SshdPermitRootLogin;
  readonly passwordAuthentication: boolean;
  readonly pubkeyAuthentication: boolean;
  readonly kbdInteractiveAuthentication: boolean;
  readonly challengeResponseAuthentication: boolean;
  readonly gssapiAuthentication: boolean;
  readonly hostbasedAuthentication: boolean;
  readonly maxAuthTries: number;
  readonly maxSessions: number;
  readonly maxStartups: SshdMaxStartups;
  readonly loginGraceTimeSeconds: number;
  readonly rekeyLimit: string;
  readonly permitEmptyPasswords: boolean;
  readonly allowTcpForwarding: SshdAllowTcpForwarding;
  readonly allowAgentForwarding: boolean;
  readonly permitTty: boolean;
  readonly allowStreamLocalForwarding: boolean;
  readonly x11Forwarding: boolean;
  readonly x11DisplayOffset: number;
  readonly gatewayPorts: SshdGatewayPorts;
  readonly tcpKeepAlive: boolean;
  readonly clientAliveIntervalSeconds: number;
  readonly clientAliveCountMax: number;
  readonly printMotd: boolean;
  readonly printLastLog: boolean;
  readonly useDns: boolean;
  readonly useLogin: boolean;
  readonly usePam: boolean;
  readonly permitUserEnvironment: boolean;
  readonly strictModes: boolean;
  readonly compression: SshdCompression;
  readonly logLevel: SshdLogLevel;
  readonly syslogFacility: SshdSyslogFacility;
  readonly bannerPath: string | null;
  readonly motdPath: string;
  readonly subsystems: SshdSubsystems;
  readonly allowUsers: readonly string[];
  readonly denyUsers: readonly string[];
  readonly allowGroups: readonly string[];
  readonly denyGroups: readonly string[];
  readonly acceptEnv: readonly string[];
  readonly ciphers: readonly string[];
  readonly macs: readonly string[];
  readonly kexAlgorithms: readonly string[];
  readonly hostKeyAlgorithms: readonly string[];
  readonly forceCommand: string | null;
  readonly chrootDirectory: string | null;
  readonly permitOpen: readonly string[];
  readonly authorizedKeysFile: readonly string[];
  readonly authorizedPrincipalsFile: string | null;
  readonly trustedUserCaKeys: string | null;
  readonly hostCertificates: readonly string[];
  readonly revokedKeys: string | null;
  readonly caSignatureAlgorithms: readonly string[];
  readonly matchBlocks: readonly SshdMatchBlock[];

  private constructor(s: SshdServerConfigSnapshot) {
    this.ports = s.ports;
    this.listenAddresses = s.listenAddresses;
    this.addressFamily = s.addressFamily;
    this.permitRootLogin = s.permitRootLogin;
    this.passwordAuthentication = s.passwordAuthentication;
    this.pubkeyAuthentication = s.pubkeyAuthentication;
    this.kbdInteractiveAuthentication = s.kbdInteractiveAuthentication;
    this.challengeResponseAuthentication = s.challengeResponseAuthentication;
    this.gssapiAuthentication = s.gssapiAuthentication;
    this.hostbasedAuthentication = s.hostbasedAuthentication;
    this.maxAuthTries = s.maxAuthTries;
    this.maxSessions = s.maxSessions;
    this.maxStartups = s.maxStartups;
    this.loginGraceTimeSeconds = s.loginGraceTimeSeconds;
    this.rekeyLimit = s.rekeyLimit;
    this.permitEmptyPasswords = s.permitEmptyPasswords;
    this.allowTcpForwarding = s.allowTcpForwarding;
    this.allowAgentForwarding = s.allowAgentForwarding;
    this.permitTty = s.permitTty;
    this.allowStreamLocalForwarding = s.allowStreamLocalForwarding;
    this.x11Forwarding = s.x11Forwarding;
    this.x11DisplayOffset = s.x11DisplayOffset;
    this.gatewayPorts = s.gatewayPorts;
    this.tcpKeepAlive = s.tcpKeepAlive;
    this.clientAliveIntervalSeconds = s.clientAliveIntervalSeconds;
    this.clientAliveCountMax = s.clientAliveCountMax;
    this.printMotd = s.printMotd;
    this.printLastLog = s.printLastLog;
    this.useDns = s.useDns;
    this.useLogin = s.useLogin;
    this.usePam = s.usePam;
    this.permitUserEnvironment = s.permitUserEnvironment;
    this.strictModes = s.strictModes;
    this.compression = s.compression;
    this.logLevel = s.logLevel;
    this.syslogFacility = s.syslogFacility;
    this.bannerPath = s.bannerPath;
    this.motdPath = s.motdPath;
    this.subsystems = s.subsystems;
    this.allowUsers = s.allowUsers;
    this.denyUsers = s.denyUsers;
    this.allowGroups = s.allowGroups;
    this.denyGroups = s.denyGroups;
    this.acceptEnv = s.acceptEnv;
    this.ciphers = s.ciphers;
    this.macs = s.macs;
    this.kexAlgorithms = s.kexAlgorithms;
    this.hostKeyAlgorithms = s.hostKeyAlgorithms;
    this.forceCommand = s.forceCommand;
    this.chrootDirectory = s.chrootDirectory;
    this.permitOpen = s.permitOpen;
    this.authorizedKeysFile = s.authorizedKeysFile;
    this.authorizedPrincipalsFile = s.authorizedPrincipalsFile;
    this.trustedUserCaKeys = s.trustedUserCaKeys;
    this.hostCertificates = s.hostCertificates;
    this.revokedKeys = s.revokedKeys;
    this.caSignatureAlgorithms = s.caSignatureAlgorithms;
    this.matchBlocks = s.matchBlocks;
  }

  static defaults(): SshdServerConfig {
    return new SshdServerConfig({
      ports: Object.freeze([22]),
      listenAddresses: Object.freeze(['0.0.0.0', '::']),
      addressFamily: 'any',
      permitRootLogin: 'prohibit-password',
      passwordAuthentication: true,
      pubkeyAuthentication: true,
      kbdInteractiveAuthentication: false,
      challengeResponseAuthentication: false,
      gssapiAuthentication: false,
      hostbasedAuthentication: false,
      maxAuthTries: 6,
      maxSessions: 10,
      maxStartups: { start: 10, rate: 30, full: 100 },
      loginGraceTimeSeconds: 120,
      rekeyLimit: 'default none',
      permitEmptyPasswords: false,
      allowTcpForwarding: 'yes',
      allowAgentForwarding: true,
      permitTty: true,
      allowStreamLocalForwarding: true,
      x11Forwarding: false,
      x11DisplayOffset: 10,
      gatewayPorts: 'no',
      tcpKeepAlive: true,
      clientAliveIntervalSeconds: 0,
      clientAliveCountMax: 3,
      printMotd: true,
      printLastLog: true,
      useDns: false,
      useLogin: false,
      usePam: false,
      permitUserEnvironment: false,
      strictModes: true,
      compression: 'delayed',
      logLevel: 'INFO',
      syslogFacility: 'AUTH',
      bannerPath: null,
      motdPath: '/etc/motd',
      subsystems: { sftp: null, extras: new Map() },
      allowUsers: Object.freeze([]),
      denyUsers: Object.freeze([]),
      allowGroups: Object.freeze([]),
      denyGroups: Object.freeze([]),
      acceptEnv: Object.freeze([]),
      ciphers: Object.freeze([...DEFAULT_CIPHERS]),
      macs: Object.freeze([...DEFAULT_MACS]),
      kexAlgorithms: Object.freeze([...DEFAULT_KEX]),
      hostKeyAlgorithms: Object.freeze([...DEFAULT_HOSTKEY_ALGOS]),
      forceCommand: null,
      chrootDirectory: null,
      permitOpen: Object.freeze(['any']),
      authorizedKeysFile: Object.freeze(['.ssh/authorized_keys', '.ssh/authorized_keys2']),
      authorizedPrincipalsFile: null,
      trustedUserCaKeys: null,
      hostCertificates: Object.freeze([]),
      revokedKeys: null,
      caSignatureAlgorithms: Object.freeze([...DEFAULT_CA_SIGNATURE_ALGORITHMS]),
      matchBlocks: Object.freeze([]),
    });
  }

  snapshot(): SshdServerConfigSnapshot { return { ...this }; }
  /** @internal shared by the module-level directive parser. */
  mutate(patch: Partial<SshdServerConfigSnapshot>): SshdServerConfig {
    return new SshdServerConfig({ ...this.snapshot(), ...patch });
  }

  withPort(port: number): SshdServerConfig {
    const set = new Set([...this.ports, port]);
    return this.mutate({ ports: Object.freeze([...set].sort((a, b) => a - b)) });
  }
  withPorts(ports: number[]): SshdServerConfig {
    return this.mutate({ ports: Object.freeze([...new Set(ports)].sort((a, b) => a - b)) });
  }
  withListenAddress(addr: string): SshdServerConfig {
    return this.mutate({ listenAddresses: Object.freeze([...new Set([...this.listenAddresses, addr])]) });
  }
  withAddressFamily(family: SshdAddressFamily): SshdServerConfig { return this.mutate({ addressFamily: family }); }
  withPermitRootLogin(v: SshdPermitRootLogin): SshdServerConfig { return this.mutate({ permitRootLogin: v }); }
  withPasswordAuth(v: boolean): SshdServerConfig { return this.mutate({ passwordAuthentication: v }); }
  withPubkeyAuth(v: boolean): SshdServerConfig { return this.mutate({ pubkeyAuthentication: v }); }
  withKbdInteractive(v: boolean): SshdServerConfig { return this.mutate({ kbdInteractiveAuthentication: v }); }
  withMaxAuthTries(n: number): SshdServerConfig { return this.mutate({ maxAuthTries: n }); }
  withMaxSessions(n: number): SshdServerConfig { return this.mutate({ maxSessions: n }); }
  withMaxStartups(s: SshdMaxStartups): SshdServerConfig { return this.mutate({ maxStartups: s }); }
  withLoginGraceTime(seconds: number): SshdServerConfig { return this.mutate({ loginGraceTimeSeconds: seconds }); }
  withPermitEmptyPasswords(v: boolean): SshdServerConfig { return this.mutate({ permitEmptyPasswords: v }); }
  withAllowTcpForwarding(v: SshdAllowTcpForwarding): SshdServerConfig { return this.mutate({ allowTcpForwarding: v }); }
  withAllowAgentForwarding(v: boolean): SshdServerConfig { return this.mutate({ allowAgentForwarding: v }); }
  withPermitTty(v: boolean): SshdServerConfig { return this.mutate({ permitTty: v }); }
  withX11Forwarding(v: boolean): SshdServerConfig { return this.mutate({ x11Forwarding: v }); }
  withGatewayPorts(v: SshdGatewayPorts): SshdServerConfig { return this.mutate({ gatewayPorts: v }); }
  withClientAlive(intervalSeconds: number, countMax: number): SshdServerConfig {
    return this.mutate({ clientAliveIntervalSeconds: intervalSeconds, clientAliveCountMax: countMax });
  }
  withPrintMotd(v: boolean): SshdServerConfig { return this.mutate({ printMotd: v }); }
  withUseDns(v: boolean): SshdServerConfig { return this.mutate({ useDns: v }); }
  withUsePam(v: boolean): SshdServerConfig { return this.mutate({ usePam: v }); }

  get showsMotd(): boolean { return this.printMotd || this.usePam; }
  withStrictModes(v: boolean): SshdServerConfig { return this.mutate({ strictModes: v }); }
  withCompression(v: SshdCompression): SshdServerConfig { return this.mutate({ compression: v }); }
  withLogLevel(v: SshdLogLevel): SshdServerConfig { return this.mutate({ logLevel: v }); }
  withSyslogFacility(v: SshdSyslogFacility): SshdServerConfig { return this.mutate({ syslogFacility: v }); }
  withBannerPath(path: string | null): SshdServerConfig { return this.mutate({ bannerPath: path }); }
  withMotdPath(path: string): SshdServerConfig { return this.mutate({ motdPath: path }); }
  withAllowUsers(users: string[]): SshdServerConfig { return this.mutate({ allowUsers: Object.freeze([...users]) }); }
  withDenyUsers(users: string[]): SshdServerConfig { return this.mutate({ denyUsers: Object.freeze([...users]) }); }
  withAllowGroups(groups: string[]): SshdServerConfig { return this.mutate({ allowGroups: Object.freeze([...groups]) }); }
  withDenyGroups(groups: string[]): SshdServerConfig { return this.mutate({ denyGroups: Object.freeze([...groups]) }); }
  withAcceptEnv(patterns: string[]): SshdServerConfig { return this.mutate({ acceptEnv: Object.freeze([...patterns]) }); }
  withCiphers(c: string[]): SshdServerConfig { return this.mutate({ ciphers: Object.freeze([...c]) }); }
  withMacs(c: string[]): SshdServerConfig { return this.mutate({ macs: Object.freeze([...c]) }); }
  withKexAlgorithms(c: string[]): SshdServerConfig { return this.mutate({ kexAlgorithms: Object.freeze([...c]) }); }
  withHostKeyAlgorithms(c: string[]): SshdServerConfig { return this.mutate({ hostKeyAlgorithms: Object.freeze([...c]) }); }
  withSubsystem(name: string, command: string): SshdServerConfig {
    const extras = new Map(this.subsystems.extras);
    if (name === 'sftp') return this.mutate({ subsystems: { sftp: command, extras } });
    extras.set(name, command);
    return this.mutate({ subsystems: { sftp: this.subsystems.sftp, extras } });
  }
  withMatchBlock(block: SshdMatchBlock): SshdServerConfig {
    return this.mutate({ matchBlocks: Object.freeze([...this.matchBlocks, block]) });
  }

  isUserAllowed(user: string, groups: readonly string[], ctx?: { address?: string; host?: string }): boolean {
    return this.userRefusal(user, groups, ctx) === null;
  }

  userRefusal(
    user: string, groups: readonly string[], ctx?: { address?: string; host?: string },
  ): 'DenyUsers' | 'DenyGroups' | 'AllowUsers' | 'AllowGroups' | null {
    let denyUsers = this.denyUsers;
    let denyGroups = this.denyGroups;
    let allowUsers = this.allowUsers;
    let allowGroups = this.allowGroups;
    for (const block of this.matchBlocks) {
      if (!this.matchApplies(block.criteria, { user, groups, host: ctx?.host, address: ctx?.address })) continue;
      if (block.overrides.denyUsers)   denyUsers   = block.overrides.denyUsers;
      if (block.overrides.denyGroups)  denyGroups  = block.overrides.denyGroups;
      if (block.overrides.allowUsers)  allowUsers  = block.overrides.allowUsers;
      if (block.overrides.allowGroups) allowGroups = block.overrides.allowGroups;
    }
    const address = ctx?.address ?? '';
    if (denyUsers.some(p => userPatternMatches(p, user, address))) return 'DenyUsers';
    if (allowUsers.length > 0 && !allowUsers.some(p => userPatternMatches(p, user, address))) return 'AllowUsers';
    if (denyGroups.some(p => groups.some(g => globMatch(p, g)))) return 'DenyGroups';
    if (allowGroups.length > 0 && !allowGroups.some(p => groups.some(g => globMatch(p, g)))) return 'AllowGroups';
    return null;
  }

  effectiveFor(ctx: { user: string; groups?: readonly string[]; host?: string; address?: string; localPort?: number }): SshdEffectiveView {
    let view: SshdEffectiveView = {
      permitRootLogin: this.permitRootLogin,
      passwordAuthentication: this.passwordAuthentication,
      pubkeyAuthentication: this.pubkeyAuthentication,
      kbdInteractiveAuthentication: this.kbdInteractiveAuthentication,
      challengeResponseAuthentication: this.challengeResponseAuthentication,
      maxAuthTries: this.maxAuthTries,
      maxSessions: this.maxSessions,
      allowTcpForwarding: this.allowTcpForwarding,
      x11Forwarding: this.x11Forwarding,
      permitEmptyPasswords: this.permitEmptyPasswords,
      banner: this.bannerPath,
      forceCommand: this.forceCommand,
      acceptEnv: this.acceptEnv,
      allowAgentForwarding: this.allowAgentForwarding,
      permitTty: this.permitTty,
      gatewayPorts: this.gatewayPorts,
      clientAliveIntervalSeconds: this.clientAliveIntervalSeconds,
      clientAliveCountMax: this.clientAliveCountMax,
      printMotd: this.printMotd,
      authorizedKeysFile: this.authorizedKeysFile,
      authorizedPrincipalsFile: this.authorizedPrincipalsFile,
      trustedUserCaKeys: this.trustedUserCaKeys,
      revokedKeys: this.revokedKeys,
      caSignatureAlgorithms: this.caSignatureAlgorithms,
    };
    for (const block of this.matchBlocks) {
      if (!this.matchApplies(block.criteria, ctx)) continue;
      view = { ...view, ...block.overrides } as SshdEffectiveView;
    }
    return view;
  }

  permitOpenAllows(destHost: string, destPort: number): boolean {
    return permitOpenAllows(this.permitOpen, destHost, destPort);
  }

  permitsLocalForward(
    ctx: { user: string; groups?: readonly string[]; host?: string; address?: string },
    destHost: string, destPort: number,
  ): boolean {
    const allowed = this.effectiveFor(ctx).allowTcpForwarding;
    return allowed !== 'no' && allowed !== 'remote' && this.permitOpenAllows(destHost, destPort);
  }

  permitsRemoteForward(ctx: { user: string; groups?: readonly string[]; host?: string; address?: string }): boolean {
    const allowed = this.effectiveFor(ctx).allowTcpForwarding;
    return allowed !== 'no' && allowed !== 'local';
  }

  remoteForwardBindAddress(
    ctx: { user: string; groups?: readonly string[]; host?: string; address?: string }, requested: string,
  ): string {
    const mode = this.effectiveFor(ctx).gatewayPorts;
    const wildcard = requested === '' || requested === '*' || requested === '0.0.0.0';
    if (mode === 'no') return '127.0.0.1';
    if (mode === 'yes' || wildcard) return '0.0.0.0';
    return requested === 'localhost' ? '127.0.0.1' : requested;
  }

  matchApplies(criteria: readonly SshdMatchCriterion[], ctx: { user: string; groups?: readonly string[]; host?: string; address?: string; localPort?: number }): boolean {
    for (const c of criteria) {
      switch (c.keyword) {
        case 'User':       if (!globMatch(c.value, ctx.user)) return false; break;
        case 'Group':      if (!(ctx.groups ?? []).some(g => globMatch(c.value, g))) return false; break;
        case 'Host':       if (!ctx.host || !globMatch(c.value, ctx.host)) return false; break;
        case 'Address':
        case 'LocalAddress': if (!ctx.address || !addressListMatches(c.value, ctx.address)) return false; break;
        case 'LocalPort':  if (ctx.localPort === undefined || String(ctx.localPort) !== c.value) return false; break;
      }
    }
    return true;
  }

  static parse(content: string): SshdServerConfig {
    let cfg = SshdServerConfig.defaults();
    cfg = cfg.mutate({ ports: Object.freeze([]) });
    let pendingMatch: { criteria: SshdMatchCriterion[]; overrides: SshdMatchOverrides } | null = null;
    const lines = content.split('\n');
    const commit = () => {
      if (pendingMatch) {
        cfg = cfg.withMatchBlock({ criteria: pendingMatch.criteria, overrides: pendingMatch.overrides });
        pendingMatch = null;
      }
    };
    for (const raw of lines) {
      const line = raw.replace(/^\s+|\s+$/g, '');
      if (!line || line.startsWith('#')) continue;
      const m = /^(\S+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = m[2].trim();
      const lower = key.toLowerCase();
      if (lower === 'match') {
        commit();
        const criteria: SshdMatchCriterion[] = [];
        const tokens = value.split(/\s+/);
        for (let i = 0; i + 1 < tokens.length; i += 2) {
          criteria.push({ keyword: tokens[i] as SshdMatchCriterion['keyword'], value: tokens[i + 1] });
        }
        pendingMatch = { criteria, overrides: {} };
        continue;
      }
      if (pendingMatch) {
        applyMatchDirective(pendingMatch.overrides, lower, value);
        continue;
      }
      cfg = applyTopLevelDirective(cfg, lower, value);
    }
    commit();
    if (cfg.ports.length === 0) cfg = cfg.withPort(22);
    return cfg;
  }

  serialize(): string {
    const lines: string[] = [];
    for (const p of this.ports) lines.push(`Port ${p}`);
    for (const a of this.listenAddresses) lines.push(`ListenAddress ${a}`);
    if (this.addressFamily !== 'any') lines.push(`AddressFamily ${this.addressFamily}`);
    lines.push(`PermitRootLogin ${this.permitRootLogin}`);
    lines.push(`PasswordAuthentication ${this.passwordAuthentication ? 'yes' : 'no'}`);
    lines.push(`PubkeyAuthentication ${this.pubkeyAuthentication ? 'yes' : 'no'}`);
    lines.push(`KbdInteractiveAuthentication ${this.kbdInteractiveAuthentication ? 'yes' : 'no'}`);
    lines.push(`MaxAuthTries ${this.maxAuthTries}`);
    lines.push(`MaxSessions ${this.maxSessions}`);
    lines.push(`MaxStartups ${this.maxStartups.start}:${this.maxStartups.rate}:${this.maxStartups.full}`);
    lines.push(`LoginGraceTime ${this.loginGraceTimeSeconds}`);
    if (this.rekeyLimit !== 'default none') lines.push(`RekeyLimit ${this.rekeyLimit}`);
    lines.push(`PermitEmptyPasswords ${this.permitEmptyPasswords ? 'yes' : 'no'}`);
    lines.push(`AllowTcpForwarding ${this.allowTcpForwarding}`);
    lines.push(`AllowAgentForwarding ${this.allowAgentForwarding ? 'yes' : 'no'}`);
    lines.push(`PermitTTY ${this.permitTty ? 'yes' : 'no'}`);
    lines.push(`X11Forwarding ${this.x11Forwarding ? 'yes' : 'no'}`);
    lines.push(`GatewayPorts ${this.gatewayPorts}`);
    lines.push(`ClientAliveInterval ${this.clientAliveIntervalSeconds}`);
    lines.push(`ClientAliveCountMax ${this.clientAliveCountMax}`);
    lines.push(`PrintMotd ${this.printMotd ? 'yes' : 'no'}`);
    lines.push(`PermitUserEnvironment ${this.permitUserEnvironment ? 'yes' : 'no'}`);
    lines.push(`UseDNS ${this.useDns ? 'yes' : 'no'}`);
    lines.push(`StrictModes ${this.strictModes ? 'yes' : 'no'}`);
    lines.push(`Compression ${this.compression}`);
    lines.push(`LogLevel ${this.logLevel}`);
    lines.push(`SyslogFacility ${this.syslogFacility}`);
    if (this.bannerPath) lines.push(`Banner ${this.bannerPath}`);
    if (this.allowUsers.length) lines.push(`AllowUsers ${this.allowUsers.join(' ')}`);
    if (this.denyUsers.length)  lines.push(`DenyUsers ${this.denyUsers.join(' ')}`);
    if (this.allowGroups.length) lines.push(`AllowGroups ${this.allowGroups.join(' ')}`);
    if (this.denyGroups.length)  lines.push(`DenyGroups ${this.denyGroups.join(' ')}`);
    if (this.acceptEnv.length)   lines.push(`AcceptEnv ${this.acceptEnv.join(' ')}`);
    if (this.subsystems.sftp !== null) lines.push(`Subsystem sftp ${this.subsystems.sftp}`);
    for (const [name, cmd] of this.subsystems.extras) lines.push(`Subsystem ${name} ${cmd}`);
    for (const block of this.matchBlocks) {
      lines.push(`Match ${block.criteria.map(c => `${c.keyword} ${c.value}`).join(' ')}`);
      for (const [k, v] of Object.entries(block.overrides)) {
        if (v === undefined) continue;
        lines.push(`    ${matchKey(k)} ${matchValue(v)}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

function applyTopLevelDirective(cfg: SshdServerConfig, key: string, value: string): SshdServerConfig {
  switch (key) {
    case 'port': return cfg.withPort(parseInt(value, 10) || 22);
    case 'listenaddress': return cfg.withListenAddress(value);
    case 'addressfamily': return cfg.withAddressFamily(value as SshdAddressFamily);
    case 'permitrootlogin': return cfg.withPermitRootLogin(value as SshdPermitRootLogin);
    case 'passwordauthentication': return cfg.withPasswordAuth(YES_NO(value, true));
    case 'pubkeyauthentication': return cfg.withPubkeyAuth(YES_NO(value, true));
    case 'kbdinteractiveauthentication':
    case 'challengeresponseauthentication': {
      const enabled = YES_NO(value, false);
      return cfg.mutate({ kbdInteractiveAuthentication: enabled, challengeResponseAuthentication: enabled });
    }
    case 'gssapiauthentication': return cfg.mutate({ gssapiAuthentication: YES_NO(value, false) });
    case 'hostbasedauthentication': return cfg.mutate({ hostbasedAuthentication: YES_NO(value, false) });
    case 'maxauthtries': return cfg.withMaxAuthTries(parseInt(value, 10) || 6);
    case 'maxsessions': return cfg.withMaxSessions(parseInt(value, 10) || 10);
    case 'maxstartups': {
      const [a, b, c] = value.split(':').map(n => parseInt(n, 10));
      return cfg.withMaxStartups({ start: a || 10, rate: b || 30, full: c || 100 });
    }
    case 'logingracetime': return cfg.withLoginGraceTime(parseDuration(value, 120));
    case 'permitemptypasswords': return cfg.withPermitEmptyPasswords(YES_NO(value, false));
    case 'allowtcpforwarding': return cfg.withAllowTcpForwarding(value as SshdAllowTcpForwarding);
    case 'allowagentforwarding': return cfg.withAllowAgentForwarding(YES_NO(value, true));
    case 'permittty': return cfg.withPermitTty(YES_NO(value, true));
    case 'allowstreamlocalforwarding': return cfg.mutate({ allowStreamLocalForwarding: YES_NO(value, true) });
    case 'x11forwarding': return cfg.withX11Forwarding(YES_NO(value, false));
    case 'x11displayoffset': return cfg.mutate({ x11DisplayOffset: parseInt(value, 10) || 10 });
    case 'gatewayports': return cfg.withGatewayPorts(value as SshdGatewayPorts);
    case 'tcpkeepalive': return cfg.mutate({ tcpKeepAlive: YES_NO(value, true) });
    case 'clientaliveinterval': return cfg.withClientAlive(parseInt(value, 10) || 0, cfg.clientAliveCountMax);
    case 'clientalivecountmax': return cfg.withClientAlive(cfg.clientAliveIntervalSeconds, parseInt(value, 10) || 3);
    case 'printmotd': return cfg.withPrintMotd(YES_NO(value, true));
    case 'rekeylimit': return cfg.mutate({ rekeyLimit: value.trim() });
    case 'printlastlog': return cfg.mutate({ printLastLog: YES_NO(value, true) });
    case 'usedns': return cfg.withUseDns(YES_NO(value, false));
    case 'uselogin': return cfg.mutate({ useLogin: YES_NO(value, false) });
    case 'usepam': return cfg.withUsePam(YES_NO(value, true));
    case 'permituserenvironment': return cfg.mutate({ permitUserEnvironment: YES_NO(value, false) });
    case 'strictmodes': return cfg.withStrictModes(YES_NO(value, true));
    case 'compression': return cfg.withCompression(value as SshdCompression);
    case 'loglevel': return cfg.withLogLevel(value.toUpperCase() as SshdLogLevel);
    case 'syslogfacility': return cfg.withSyslogFacility(value.toUpperCase() as SshdSyslogFacility);
    case 'banner': return cfg.withBannerPath(value === 'none' ? null : value);
    case 'forcecommand': return cfg.mutate({ forceCommand: value });
    case 'chrootdirectory': return cfg.mutate({ chrootDirectory: value === 'none' ? null : value });
    case 'motdpath': return cfg.withMotdPath(value);
    case 'allowusers':  return cfg.withAllowUsers(value.split(/\s+/));
    case 'denyusers':   return cfg.withDenyUsers(value.split(/\s+/));
    case 'allowgroups': return cfg.withAllowGroups(value.split(/\s+/));
    case 'denygroups':  return cfg.withDenyGroups(value.split(/\s+/));
    case 'acceptenv':   return cfg.withAcceptEnv([...cfg.acceptEnv, ...value.split(/\s+/)]);
    case 'ciphers':     return cfg.withCiphers(value.split(','));
    case 'macs':        return cfg.withMacs(value.split(','));
    case 'kexalgorithms': return cfg.withKexAlgorithms(value.split(','));
    case 'hostkeyalgorithms': return cfg.withHostKeyAlgorithms(value.split(','));
    case 'subsystem': {
      const [name, ...rest] = value.split(/\s+/);
      return cfg.withSubsystem(name, rest.join(' '));
    }
    case 'permitopen': return cfg.mutate({ permitOpen: Object.freeze(value.split(/\s+/).filter(Boolean)) });
    case 'authorizedkeysfile': return cfg.mutate({ authorizedKeysFile: Object.freeze(value.split(/\s+/).filter(Boolean)) });
    case 'authorizedprincipalsfile': return cfg.mutate({ authorizedPrincipalsFile: value === 'none' ? null : value });
    case 'hostcertificate': return cfg.mutate({ hostCertificates: Object.freeze([...cfg.hostCertificates, value]) });
    case 'trustedusercakeys': return cfg.mutate({ trustedUserCaKeys: value === 'none' ? null : value });
    case 'revokedkeys': return cfg.mutate({ revokedKeys: value === 'none' ? null : value });
    case 'casignaturealgorithms': return cfg.mutate({ caSignatureAlgorithms: parseCaSignatureAlgorithms(value) });
    default: return cfg;
  }
}

function parseCaSignatureAlgorithms(value: string): readonly string[] {
  return Object.freeze(value.split(',').map((name) => name.trim()).filter(Boolean));
}

function applyMatchDirective(o: SshdMatchOverrides, key: string, value: string): void {
  switch (key) {
    case 'permitrootlogin': o.permitRootLogin = value as SshdPermitRootLogin; break;
    case 'passwordauthentication': o.passwordAuthentication = YES_NO(value, true); break;
    case 'pubkeyauthentication': o.pubkeyAuthentication = YES_NO(value, true); break;
    case 'kbdinteractiveauthentication': o.kbdInteractiveAuthentication = YES_NO(value, false); o.challengeResponseAuthentication = o.kbdInteractiveAuthentication; break;
    case 'challengeresponseauthentication': o.kbdInteractiveAuthentication = YES_NO(value, false); o.challengeResponseAuthentication = o.kbdInteractiveAuthentication; break;
    case 'maxauthtries': o.maxAuthTries = parseInt(value, 10) || 6; break;
    case 'maxsessions': o.maxSessions = parseInt(value, 10) || 10; break;
    case 'allowtcpforwarding': o.allowTcpForwarding = value as SshdAllowTcpForwarding; break;
    case 'x11forwarding': o.x11Forwarding = YES_NO(value, false); break;
    case 'permitemptypasswords': o.permitEmptyPasswords = YES_NO(value, false); break;
    case 'banner': o.banner = value === 'none' ? null : value; break;
    case 'forcecommand': o.forceCommand = value; break;
    case 'chrootdirectory': o.chrootDirectory = value; break;
    case 'acceptenv': o.acceptEnv = Object.freeze(value.split(/\s+/)); break;
    case 'allowagentforwarding': o.allowAgentForwarding = YES_NO(value, true); break;
    case 'permittty': o.permitTty = YES_NO(value, true); break;
    case 'gatewayports': o.gatewayPorts = value as SshdGatewayPorts; break;
    case 'clientaliveinterval': o.clientAliveIntervalSeconds = parseInt(value, 10) || 0; break;
    case 'clientalivecountmax': o.clientAliveCountMax = parseInt(value, 10) || 3; break;
    case 'printmotd': o.printMotd = YES_NO(value, true); break;
    case 'allowusers':  o.allowUsers = Object.freeze(value.split(/\s+/)); break;
    case 'denyusers':   o.denyUsers  = Object.freeze(value.split(/\s+/)); break;
    case 'allowgroups': o.allowGroups = Object.freeze(value.split(/\s+/)); break;
    case 'denygroups':  o.denyGroups  = Object.freeze(value.split(/\s+/)); break;
    case 'authorizedkeysfile': o.authorizedKeysFile = Object.freeze(value.split(/\s+/).filter(Boolean)); break;
    case 'authorizedprincipalsfile': o.authorizedPrincipalsFile = value === 'none' ? null : value; break;
    case 'trustedusercakeys': o.trustedUserCaKeys = value === 'none' ? null : value; break;
    case 'revokedkeys': o.revokedKeys = value === 'none' ? null : value; break;
    case 'casignaturealgorithms': o.caSignatureAlgorithms = parseCaSignatureAlgorithms(value); break;
  }
}

function matchKey(prop: string): string {
  return prop.charAt(0).toUpperCase() + prop.slice(1);
}
function matchValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}
function parseDuration(value: string, fallback: number): number {
  const m = /^(\d+)(s|m|h|d)?$/.exec(value);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86_400;
    default:  return n;
  }
}
