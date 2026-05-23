export type VtyTransport = 'ssh' | 'telnet' | 'http' | 'console' | 'rlogin';
export type VtyLoginMode = 'none' | 'password' | 'local' | 'authentication' | 'aaa';

export class VtyLineRange {
  constructor(public readonly first: number, public readonly last: number) {
    if (last < first) throw new Error(`Invalid vty range: ${first} ${last}`);
  }
  equals(other: VtyLineRange): boolean { return this.first === other.first && this.last === other.last; }
  contains(idx: number): boolean { return idx >= this.first && idx <= this.last; }
  size(): number { return this.last - this.first + 1; }
  overlaps(other: VtyLineRange): boolean { return !(this.last < other.first || other.last < this.first); }
  toString(): string { return `${this.first} ${this.last}`; }
}

export interface VtyLineConfigSnapshot {
  readonly range: VtyLineRange;
  readonly transportInput: readonly VtyTransport[];
  readonly transportOutput: readonly VtyTransport[];
  readonly transportPreferred: VtyTransport | null;
  readonly loginMode: VtyLoginMode;
  readonly aaaAuthenticationList: string | null;
  readonly aaaAuthorizationList: string | null;
  readonly aaaAccountingList: string | null;
  readonly execTimeoutMinutes: number;
  readonly execTimeoutSeconds: number;
  readonly sessionTimeoutMinutes: number;
  readonly absoluteTimeoutMinutes: number;
  readonly privilegeLevel: number;
  readonly history: number;
  readonly terminalLength: number;
  readonly terminalWidth: number;
  readonly accessClassIn: number | null;
  readonly accessClassOut: number | null;
  readonly accessClassNamedIn: string | null;
  readonly accessClassNamedOut: string | null;
  readonly password: string | null;
  readonly passwordEncryption: 0 | 7;
  readonly autocommand: string | null;
  readonly motdBannerEnabled: boolean;
  readonly escapeChar: number;
  readonly location: string | null;
  readonly rotaryGroup: number | null;
  readonly speed: number;
  readonly stopbits: 1 | 2;
  readonly noExec: boolean;
  readonly loggingSynchronous: boolean;
  readonly ipv6AccessClassIn: string | null;
  readonly ipv6AccessClassOut: string | null;
}

export class VtyLineConfig implements VtyLineConfigSnapshot {
  readonly range: VtyLineRange;
  readonly transportInput: readonly VtyTransport[];
  readonly transportOutput: readonly VtyTransport[];
  readonly transportPreferred: VtyTransport | null;
  readonly loginMode: VtyLoginMode;
  readonly aaaAuthenticationList: string | null;
  readonly aaaAuthorizationList: string | null;
  readonly aaaAccountingList: string | null;
  readonly execTimeoutMinutes: number;
  readonly execTimeoutSeconds: number;
  readonly sessionTimeoutMinutes: number;
  readonly absoluteTimeoutMinutes: number;
  readonly privilegeLevel: number;
  readonly history: number;
  readonly terminalLength: number;
  readonly terminalWidth: number;
  readonly accessClassIn: number | null;
  readonly accessClassOut: number | null;
  readonly accessClassNamedIn: string | null;
  readonly accessClassNamedOut: string | null;
  readonly password: string | null;
  readonly passwordEncryption: 0 | 7;
  readonly autocommand: string | null;
  readonly motdBannerEnabled: boolean;
  readonly escapeChar: number;
  readonly location: string | null;
  readonly rotaryGroup: number | null;
  readonly speed: number;
  readonly stopbits: 1 | 2;
  readonly noExec: boolean;
  readonly loggingSynchronous: boolean;
  readonly ipv6AccessClassIn: string | null;
  readonly ipv6AccessClassOut: string | null;

  private constructor(s: VtyLineConfigSnapshot) {
    this.range = s.range;
    this.transportInput = s.transportInput;
    this.transportOutput = s.transportOutput;
    this.transportPreferred = s.transportPreferred;
    this.loginMode = s.loginMode;
    this.aaaAuthenticationList = s.aaaAuthenticationList;
    this.aaaAuthorizationList = s.aaaAuthorizationList;
    this.aaaAccountingList = s.aaaAccountingList;
    this.execTimeoutMinutes = s.execTimeoutMinutes;
    this.execTimeoutSeconds = s.execTimeoutSeconds;
    this.sessionTimeoutMinutes = s.sessionTimeoutMinutes;
    this.absoluteTimeoutMinutes = s.absoluteTimeoutMinutes;
    this.privilegeLevel = s.privilegeLevel;
    this.history = s.history;
    this.terminalLength = s.terminalLength;
    this.terminalWidth = s.terminalWidth;
    this.accessClassIn = s.accessClassIn;
    this.accessClassOut = s.accessClassOut;
    this.accessClassNamedIn = s.accessClassNamedIn;
    this.accessClassNamedOut = s.accessClassNamedOut;
    this.password = s.password;
    this.passwordEncryption = s.passwordEncryption;
    this.autocommand = s.autocommand;
    this.motdBannerEnabled = s.motdBannerEnabled;
    this.escapeChar = s.escapeChar;
    this.location = s.location;
    this.rotaryGroup = s.rotaryGroup;
    this.speed = s.speed;
    this.stopbits = s.stopbits;
    this.noExec = s.noExec;
    this.loggingSynchronous = s.loggingSynchronous;
    this.ipv6AccessClassIn = s.ipv6AccessClassIn;
    this.ipv6AccessClassOut = s.ipv6AccessClassOut;
  }

  static forRange(range: VtyLineRange): VtyLineConfig {
    return new VtyLineConfig({
      range,
      transportInput: Object.freeze(['ssh'] as VtyTransport[]),
      transportOutput: Object.freeze(['ssh'] as VtyTransport[]),
      transportPreferred: null,
      loginMode: 'none',
      aaaAuthenticationList: null,
      aaaAuthorizationList: null,
      aaaAccountingList: null,
      execTimeoutMinutes: 10,
      execTimeoutSeconds: 0,
      sessionTimeoutMinutes: 0,
      absoluteTimeoutMinutes: 0,
      privilegeLevel: 1,
      history: 20,
      terminalLength: 24,
      terminalWidth: 80,
      accessClassIn: null,
      accessClassOut: null,
      accessClassNamedIn: null,
      accessClassNamedOut: null,
      password: null,
      passwordEncryption: 0,
      autocommand: null,
      motdBannerEnabled: true,
      escapeChar: 30,
      location: null,
      rotaryGroup: null,
      speed: 9600,
      stopbits: 1,
      noExec: false,
      loggingSynchronous: false,
      ipv6AccessClassIn: null,
      ipv6AccessClassOut: null,
    });
  }

  snapshot(): VtyLineConfigSnapshot { return { ...this }; }

  private mutate(patch: Partial<VtyLineConfigSnapshot>): VtyLineConfig {
    return new VtyLineConfig({ ...this.snapshot(), ...patch });
  }

  withTransportInput(transports: VtyTransport[]): VtyLineConfig {
    return this.mutate({ transportInput: Object.freeze([...transports]) });
  }
  withTransportOutput(transports: VtyTransport[]): VtyLineConfig {
    return this.mutate({ transportOutput: Object.freeze([...transports]) });
  }
  withTransportPreferred(transport: VtyTransport | null): VtyLineConfig {
    return this.mutate({ transportPreferred: transport });
  }
  withLoginMode(mode: VtyLoginMode, listName?: string): VtyLineConfig {
    return this.mutate({ loginMode: mode, aaaAuthenticationList: mode === 'aaa' ? (listName ?? null) : this.aaaAuthenticationList });
  }
  withExecTimeout(minutes: number, seconds = 0): VtyLineConfig {
    return this.mutate({ execTimeoutMinutes: minutes, execTimeoutSeconds: seconds });
  }
  withSessionTimeout(minutes: number): VtyLineConfig {
    return this.mutate({ sessionTimeoutMinutes: minutes });
  }
  withAbsoluteTimeout(minutes: number): VtyLineConfig {
    return this.mutate({ absoluteTimeoutMinutes: minutes });
  }
  withPrivilege(level: number): VtyLineConfig { return this.mutate({ privilegeLevel: level }); }
  withHistory(n: number): VtyLineConfig { return this.mutate({ history: n }); }
  withTerminalSize(length: number, width: number): VtyLineConfig {
    return this.mutate({ terminalLength: length, terminalWidth: width });
  }
  withAccessClass(direction: 'in' | 'out', acl: number | string | null): VtyLineConfig {
    if (direction === 'in') {
      return typeof acl === 'string'
        ? this.mutate({ accessClassNamedIn: acl, accessClassIn: null })
        : this.mutate({ accessClassIn: acl, accessClassNamedIn: null });
    }
    return typeof acl === 'string'
      ? this.mutate({ accessClassNamedOut: acl, accessClassOut: null })
      : this.mutate({ accessClassOut: acl, accessClassNamedOut: null });
  }
  withIpv6AccessClass(direction: 'in' | 'out', acl: string | null): VtyLineConfig {
    return direction === 'in' ? this.mutate({ ipv6AccessClassIn: acl }) : this.mutate({ ipv6AccessClassOut: acl });
  }
  withPassword(password: string, encryption: 0 | 7 = 0): VtyLineConfig {
    return this.mutate({ password, passwordEncryption: encryption });
  }
  withAutocommand(cmd: string | null): VtyLineConfig { return this.mutate({ autocommand: cmd }); }
  withMotdBanner(enabled: boolean): VtyLineConfig { return this.mutate({ motdBannerEnabled: enabled }); }
  withEscapeChar(code: number): VtyLineConfig { return this.mutate({ escapeChar: code }); }
  withLocation(location: string | null): VtyLineConfig { return this.mutate({ location }); }
  withRotaryGroup(group: number | null): VtyLineConfig { return this.mutate({ rotaryGroup: group }); }
  withSpeed(bps: number): VtyLineConfig { return this.mutate({ speed: bps }); }
  withStopbits(b: 1 | 2): VtyLineConfig { return this.mutate({ stopbits: b }); }
  withNoExec(noExec: boolean): VtyLineConfig { return this.mutate({ noExec }); }
  withLoggingSynchronous(enabled: boolean): VtyLineConfig { return this.mutate({ loggingSynchronous: enabled }); }

  allowsTransport(t: VtyTransport): boolean {
    return this.transportInput.includes(t);
  }

  toRunningConfig(): string {
    const lines: string[] = [];
    lines.push(`line vty ${this.range.first} ${this.range.last}`);
    if (this.privilegeLevel !== 1) lines.push(` privilege level ${this.privilegeLevel}`);
    if (this.password !== null) lines.push(this.passwordEncryption === 7 ? ` password 7 ${this.password}` : ` password ${this.password}`);
    if (this.loginMode === 'local') lines.push(' login local');
    else if (this.loginMode === 'password') lines.push(' login');
    else if (this.loginMode === 'aaa' || this.loginMode === 'authentication') {
      lines.push(this.aaaAuthenticationList ? ` login authentication ${this.aaaAuthenticationList}` : ' login authentication default');
    }
    if (this.execTimeoutMinutes !== 10 || this.execTimeoutSeconds !== 0) {
      lines.push(` exec-timeout ${this.execTimeoutMinutes} ${this.execTimeoutSeconds}`);
    }
    if (this.sessionTimeoutMinutes > 0) lines.push(` session-timeout ${this.sessionTimeoutMinutes}`);
    if (this.absoluteTimeoutMinutes > 0) lines.push(` absolute-timeout ${this.absoluteTimeoutMinutes}`);
    if (this.history !== 20) lines.push(` history size ${this.history}`);
    if (this.terminalLength !== 24) lines.push(` length ${this.terminalLength}`);
    if (this.terminalWidth !== 80) lines.push(` width ${this.terminalWidth}`);
    if (this.accessClassIn !== null) lines.push(` access-class ${this.accessClassIn} in`);
    if (this.accessClassOut !== null) lines.push(` access-class ${this.accessClassOut} out`);
    if (this.accessClassNamedIn) lines.push(` access-class ${this.accessClassNamedIn} in`);
    if (this.accessClassNamedOut) lines.push(` access-class ${this.accessClassNamedOut} out`);
    if (this.ipv6AccessClassIn) lines.push(` ipv6 access-class ${this.ipv6AccessClassIn} in`);
    if (this.ipv6AccessClassOut) lines.push(` ipv6 access-class ${this.ipv6AccessClassOut} out`);
    if (this.autocommand) lines.push(` autocommand ${this.autocommand}`);
    if (!this.motdBannerEnabled) lines.push(' no exec-banner');
    if (this.location) lines.push(` location ${this.location}`);
    if (this.rotaryGroup !== null) lines.push(` rotary ${this.rotaryGroup}`);
    if (this.noExec) lines.push(' no exec');
    if (this.loggingSynchronous) lines.push(' logging synchronous');
    lines.push(this.transportInput.length === 0
      ? ' transport input none'
      : ` transport input ${this.transportInput.join(' ')}`);
    lines.push(this.transportOutput.length === 0
      ? ' transport output none'
      : ` transport output ${this.transportOutput.join(' ')}`);
    if (this.transportPreferred) lines.push(` transport preferred ${this.transportPreferred}`);
    return lines.join('\n');
  }
}
