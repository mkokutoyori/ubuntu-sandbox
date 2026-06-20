/**
 * VtyLineConfig — immutable per-VTY-range configuration block.
 *
 * Captures the directives an operator types under `line vty 0 4` on
 * Cisco IOS or `user-interface vty 0 4` on Huawei VRP. The model is
 * vendor-neutral; per-vendor renderers (CiscoShowCommands,
 * HuaweiDisplayCommands) read the snapshot and emit the right syntax.
 *
 * Fields cover what the cross-equipment SSH suite exercises today
 * (exec-timeout / idle-timeout, access-class / acl inbound, transport
 * input, login mode, privilege level) plus the small set of related
 * keepalive/screen directives so future tests can plug in without a
 * schema change.
 */

export type VtyLoginMode = 'none' | 'local' | 'aaa' | 'password';
export type VtyTransport = 'ssh' | 'telnet' | 'all' | 'none';

export interface VtyLineConfigInit {
  readonly first: number;
  readonly last: number;
  readonly execTimeoutMinutes?: number;
  readonly execTimeoutSeconds?: number;
  readonly idleTimeoutMinutes?: number;
  readonly idleTimeoutSeconds?: number;
  readonly accessClassIn?: string;
  readonly accessClassOut?: string;
  readonly aclInbound?: string;
  readonly aclOutbound?: string;
  readonly transportInput?: VtyTransport;
  readonly login?: VtyLoginMode;
  /** `password …` configured on the line (line-local auth secret). */
  readonly linePassword?: string;
  readonly privilege?: number;
  readonly authenticationMode?: 'password' | 'aaa' | 'none';
  readonly screenLengthLines?: number;
  readonly historyCommandSize?: number;
}

export class VtyLineConfig {
  readonly first: number;
  readonly last: number;
  readonly execTimeoutMinutes: number | null;
  readonly execTimeoutSeconds: number | null;
  readonly idleTimeoutMinutes: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly accessClassIn: string | null;
  readonly accessClassOut: string | null;
  readonly aclInbound: string | null;
  readonly aclOutbound: string | null;
  readonly transportInput: VtyTransport | null;
  readonly login: VtyLoginMode | null;
  readonly linePassword: string | null;
  readonly privilege: number | null;
  readonly authenticationMode: 'password' | 'aaa' | 'none' | null;
  readonly screenLengthLines: number | null;
  readonly historyCommandSize: number | null;

  constructor(init: VtyLineConfigInit) {
    this.first              = init.first;
    this.last               = init.last;
    this.execTimeoutMinutes = init.execTimeoutMinutes ?? null;
    this.execTimeoutSeconds = init.execTimeoutSeconds ?? null;
    this.idleTimeoutMinutes = init.idleTimeoutMinutes ?? null;
    this.idleTimeoutSeconds = init.idleTimeoutSeconds ?? null;
    this.accessClassIn      = init.accessClassIn ?? null;
    this.accessClassOut     = init.accessClassOut ?? null;
    this.aclInbound         = init.aclInbound ?? null;
    this.aclOutbound        = init.aclOutbound ?? null;
    this.transportInput     = init.transportInput ?? null;
    this.login              = init.login ?? null;
    this.linePassword       = init.linePassword ?? null;
    this.privilege          = init.privilege ?? null;
    this.authenticationMode = init.authenticationMode ?? null;
    this.screenLengthLines  = init.screenLengthLines ?? null;
    this.historyCommandSize = init.historyCommandSize ?? null;
    Object.freeze(this);
  }

  withFields(patch: Partial<VtyLineConfigInit>): VtyLineConfig {
    return new VtyLineConfig({
      first: this.first, last: this.last,
      execTimeoutMinutes: patch.execTimeoutMinutes ?? this.execTimeoutMinutes ?? undefined,
      execTimeoutSeconds: patch.execTimeoutSeconds ?? this.execTimeoutSeconds ?? undefined,
      idleTimeoutMinutes: patch.idleTimeoutMinutes ?? this.idleTimeoutMinutes ?? undefined,
      idleTimeoutSeconds: patch.idleTimeoutSeconds ?? this.idleTimeoutSeconds ?? undefined,
      accessClassIn:      patch.accessClassIn      ?? this.accessClassIn      ?? undefined,
      accessClassOut:     patch.accessClassOut     ?? this.accessClassOut     ?? undefined,
      aclInbound:         patch.aclInbound         ?? this.aclInbound         ?? undefined,
      aclOutbound:        patch.aclOutbound        ?? this.aclOutbound        ?? undefined,
      transportInput:     patch.transportInput     ?? this.transportInput     ?? undefined,
      login:              patch.login              ?? this.login              ?? undefined,
      linePassword:       patch.linePassword       ?? this.linePassword       ?? undefined,
      privilege:          patch.privilege          ?? this.privilege          ?? undefined,
      authenticationMode: patch.authenticationMode ?? this.authenticationMode ?? undefined,
      screenLengthLines:  patch.screenLengthLines  ?? this.screenLengthLines  ?? undefined,
      historyCommandSize: patch.historyCommandSize ?? this.historyCommandSize ?? undefined,
    });
  }

  /** Cisco IOS `show running-config` block for `line vty <first> <last>`. */
  renderCisco(): string[] {
    const lines: string[] = [`line vty ${this.first}${this.first === this.last ? '' : ' ' + this.last}`];
    if (this.execTimeoutMinutes !== null || this.execTimeoutSeconds !== null) {
      lines.push(` exec-timeout ${this.execTimeoutMinutes ?? 0} ${this.execTimeoutSeconds ?? 0}`);
    }
    if (this.accessClassIn  !== null) lines.push(` access-class ${this.accessClassIn} in`);
    if (this.accessClassOut !== null) lines.push(` access-class ${this.accessClassOut} out`);
    if (this.linePassword) lines.push(` password ${this.linePassword}`);
    if (this.login !== null) {
      if (this.login === 'local') lines.push(' login local');
      else if (this.login === 'aaa') lines.push(' login authentication default');
      else if (this.login === 'password') lines.push(' login');
      else lines.push(' no login');
    }
    if (this.privilege !== null) lines.push(` privilege level ${this.privilege}`);
    if (this.transportInput !== null) lines.push(` transport input ${this.transportInput}`);
    return lines;
  }

  /**
   * True when the line authenticates with a line password (`login`) but none
   * has been configured — IOS then refuses incoming sessions on that line
   * ("Password required, but none set"). Drives the incoming-VTY verdict.
   */
  requiresPasswordButUnset(): boolean {
    return this.login === 'password' && !this.linePassword;
  }

  /** Huawei VRP `display current-configuration` block for the user-interface. */
  renderHuawei(): string[] {
    const lines: string[] = [`user-interface vty ${this.first}${this.first === this.last ? '' : ' ' + this.last}`];
    if (this.authenticationMode !== null) {
      lines.push(` authentication-mode ${this.authenticationMode}`);
    }
    if (this.idleTimeoutMinutes !== null || this.idleTimeoutSeconds !== null) {
      lines.push(` idle-timeout ${this.idleTimeoutMinutes ?? 0} ${this.idleTimeoutSeconds ?? 0}`);
    }
    if (this.aclInbound  !== null) lines.push(` acl ${this.aclInbound} inbound`);
    if (this.aclOutbound !== null) lines.push(` acl ${this.aclOutbound} outbound`);
    if (this.transportInput !== null && this.transportInput !== 'all') {
      lines.push(` protocol inbound ${this.transportInput}`);
    } else if (this.transportInput === 'all') {
      lines.push(' protocol inbound all');
    }
    if (this.screenLengthLines !== null)  lines.push(` screen-length ${this.screenLengthLines}`);
    if (this.historyCommandSize !== null) lines.push(` history-command max-size ${this.historyCommandSize}`);
    return lines;
  }
}
