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

/**
 * VtyLineRange — value object for the `<first> <last>` line span of a
 * `line vty` / `user-interface vty` block. Encapsulates the range
 * arithmetic (membership, overlap, size) that shells and the store would
 * otherwise reimplement ad hoc.
 */
import { renderPasswordField } from '../../shells/cisco/ciscoPasswordRender';
import { huaweiCipher } from '@/crypto/passwords/huawei';

export function transportAdmet(reglage: VtyTransport, kind: 'ssh' | 'telnet'): boolean {
  return reglage === 'all' || reglage === kind;
}

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
  /**
   * La FORME sous laquelle `linePassword` est range. Elle manquait, et
   * son absence coutait deux fois : `password 7 <chiffre>` etait range
   * comme s'il etait en clair, donc rechiffre une seconde fois par le
   * rendu quand `service password-encryption` est actif, et compare tel
   * quel au mot de passe tape — donc refuse pour toujours. Comme la
   * configuration rendue est REJOUEE a l'import d'une topologie, un
   * simple aller-retour suffisait a produire ce cas.
   */
  readonly linePasswordAlgo?: 'plain' | 'type-7';
  readonly privilege?: number;
  readonly authenticationMode?: 'password' | 'aaa' | 'none';
  readonly screenLengthLines?: number;
  readonly historyCommandSize?: number;
  readonly loggingSynchronous?: boolean;
  /**
   * `login-timeout <secondes>` : le delai laisse a l'operateur pour
   * saisir ses identifiants, distinct de `exec-timeout` qui compte
   * l'inactivite APRES la connexion. La commande etait refusee.
   */
  readonly loginTimeoutSeconds?: number;
  /**
   * `session-timeout <minutes>` et `history size <n>`, cote Cisco.
   *
   * Les deux etaient ACCEPTEES par la CLI, qui posait
   * `update.sessionTimeoutMinutes` et `update.historySize` — deux noms
   * qui n'existaient dans AUCUN champ de cette classe, donc `withFields`
   * les laissait tomber sans un mot. Rien ne les rangeait, rien ne les
   * rendait, rien ne les lisait : la commande repondait `` et ne faisait
   * rien du tout. (`historyCommandSize`, lui, existe mais se rend
   * ` history-command max-size N`, qui est l'orthographe VRP.)
   */
  readonly sessionTimeoutMinutes?: number;
  readonly historySize?: number;
  /** `no history` — distinct de `history size 0`, qui est une taille nulle. */
  readonly historyEnabled?: boolean;
  /**
   * `absolute-timeout <minutes>` : la duree MAXIMALE d'une session, quelle
   * que soit l'activite. `exec-timeout` ne compte que l'inactivite, donc
   * un operateur qui tape sans arret reste connecte indefiniment — c'est
   * exactement ce que cette commande existe pour borner. Elle etait
   * refusee.
   */
  readonly absoluteTimeoutMinutes?: number;
  /**
   * `escape-character {break | <ascii> | default | none | soft}`.
   * Stockee telle qu'ecrite : `none` supprime la suspension de session,
   * un nombre designe un code ASCII.
   */
  readonly escapeCharacter?: string;
  /**
   * La MEME famille de defauts que `sessionTimeoutMinutes` plus haut, et
   * pour la meme raison : la CLI posait `update.autocommand`,
   * `update.authorizationList`, `update.accountingList`,
   * `update.terminalLength`, `update.terminalWidth`, `update.speedBaud`,
   * `update.stopbits`, `update.rotaryGroup`, `update.motdBannerSuppressed`
   * et `update.execBannerSuppressed` — dix noms qui n'existaient dans
   * AUCUN champ, donc `withFields` les laissait tomber sans un mot. La
   * commande repondait `` et ne faisait rien : `autocommand show status`
   * etait acceptee, absente de la configuration, donc perdue au
   * rechargement de la topologie.
   */
  readonly autocommand?: string;
  readonly authorizationList?: string;
  readonly accountingList?: string;
  readonly loginAuthList?: string;
  readonly terminalLength?: number;
  readonly terminalWidth?: number;
  readonly speedBaud?: number;
  readonly stopbits?: number;
  readonly rotaryGroup?: number;
  readonly motdBannerSuppressed?: boolean;
  readonly execBannerSuppressed?: boolean;
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
  readonly linePasswordAlgo: 'plain' | 'type-7';
  readonly privilege: number | null;
  readonly authenticationMode: 'password' | 'aaa' | 'none' | null;
  readonly screenLengthLines: number | null;
  readonly historyCommandSize: number | null;
  readonly loggingSynchronous: boolean;
  readonly loginTimeoutSeconds: number | null;
  readonly sessionTimeoutMinutes: number | null;
  readonly historySize: number | null;
  readonly historyEnabled: boolean;
  readonly absoluteTimeoutMinutes: number | null;
  readonly escapeCharacter: string | null;
  readonly autocommand: string | null;
  readonly authorizationList: string | null;
  readonly accountingList: string | null;
  readonly loginAuthList: string | null;
  readonly terminalLength: number | null;
  readonly terminalWidth: number | null;
  readonly speedBaud: number | null;
  readonly stopbits: number | null;
  readonly rotaryGroup: number | null;
  readonly motdBannerSuppressed: boolean;
  readonly execBannerSuppressed: boolean;

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
    this.linePasswordAlgo   = init.linePasswordAlgo ?? 'plain';
    this.privilege          = init.privilege ?? null;
    this.authenticationMode = init.authenticationMode ?? null;
    this.screenLengthLines  = init.screenLengthLines ?? null;
    this.historyCommandSize = init.historyCommandSize ?? null;
    this.loggingSynchronous = init.loggingSynchronous ?? false;
    this.loginTimeoutSeconds = init.loginTimeoutSeconds ?? null;
    this.sessionTimeoutMinutes = init.sessionTimeoutMinutes ?? null;
    this.historySize = init.historySize ?? null;
    this.historyEnabled = init.historyEnabled ?? true;
    this.absoluteTimeoutMinutes = init.absoluteTimeoutMinutes ?? null;
    this.escapeCharacter = init.escapeCharacter ?? null;
    this.autocommand = init.autocommand ?? null;
    this.authorizationList = init.authorizationList ?? null;
    this.accountingList = init.accountingList ?? null;
    this.loginAuthList = init.loginAuthList ?? null;
    this.terminalLength = init.terminalLength ?? null;
    this.terminalWidth = init.terminalWidth ?? null;
    this.speedBaud = init.speedBaud ?? null;
    this.stopbits = init.stopbits ?? null;
    this.rotaryGroup = init.rotaryGroup ?? null;
    this.motdBannerSuppressed = init.motdBannerSuppressed ?? false;
    this.execBannerSuppressed = init.execBannerSuppressed ?? false;
    Object.freeze(this);
  }

  /** Convenience factory from a {@link VtyLineRange} value object. */
  static forRange(range: VtyLineRange, init: Omit<VtyLineConfigInit, 'first' | 'last'> = {}): VtyLineConfig {
    return new VtyLineConfig({ ...init, first: range.first, last: range.last });
  }

  /** The line span as a value object (membership / overlap / size helpers). */
  get range(): VtyLineRange {
    return new VtyLineRange(this.first, this.last);
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
      linePasswordAlgo:   patch.linePasswordAlgo   ?? this.linePasswordAlgo   ?? undefined,
      privilege:          patch.privilege          ?? this.privilege          ?? undefined,
      authenticationMode: patch.authenticationMode ?? this.authenticationMode ?? undefined,
      screenLengthLines:  patch.screenLengthLines  ?? this.screenLengthLines  ?? undefined,
      historyCommandSize: patch.historyCommandSize ?? this.historyCommandSize ?? undefined,
      loggingSynchronous: patch.loggingSynchronous ?? this.loggingSynchronous ?? undefined,
      loginTimeoutSeconds: patch.loginTimeoutSeconds ?? this.loginTimeoutSeconds ?? undefined,
      sessionTimeoutMinutes: patch.sessionTimeoutMinutes ?? this.sessionTimeoutMinutes ?? undefined,
      historySize:        patch.historySize        ?? this.historySize        ?? undefined,
      // Un booleen ne peut pas passer par `??` : `false` est une valeur,
      // pas une absence, et `no history` serait perdu a chaque retouche
      // ulterieure de la ligne.
      historyEnabled:     patch.historyEnabled     ?? this.historyEnabled,
      absoluteTimeoutMinutes: patch.absoluteTimeoutMinutes ?? this.absoluteTimeoutMinutes ?? undefined,
      escapeCharacter:    patch.escapeCharacter    ?? this.escapeCharacter    ?? undefined,
      autocommand:        patch.autocommand        ?? this.autocommand        ?? undefined,
      authorizationList:  patch.authorizationList  ?? this.authorizationList  ?? undefined,
      accountingList:     patch.accountingList     ?? this.accountingList     ?? undefined,
      loginAuthList:      patch.loginAuthList      ?? this.loginAuthList      ?? undefined,
      terminalLength:     patch.terminalLength     ?? this.terminalLength     ?? undefined,
      terminalWidth:      patch.terminalWidth      ?? this.terminalWidth      ?? undefined,
      speedBaud:          patch.speedBaud          ?? this.speedBaud          ?? undefined,
      stopbits:           patch.stopbits           ?? this.stopbits           ?? undefined,
      rotaryGroup:        patch.rotaryGroup        ?? this.rotaryGroup        ?? undefined,
      motdBannerSuppressed: patch.motdBannerSuppressed ?? this.motdBannerSuppressed,
      execBannerSuppressed: patch.execBannerSuppressed ?? this.execBannerSuppressed,
    });
  }

  /**
   * Cisco IOS `show running-config` block for `line vty <first> <last>`.
   *
   * `serviceEncryption` est le drapeau `service password-encryption` de
   * la machine. Il n'etait consulte NULLE PART pour un mot de passe de
   * ligne : la commande etait acceptee, annoncee, et le mot de passe
   * restait en clair dans la configuration — c'est-a-dire que la
   * commande ne faisait rien de ce qu'elle promet, sur la seule chose
   * qu'elle existe pour couvrir.
   */
  renderCisco(serviceEncryption = false): string[] {
    const lines: string[] = [`line vty ${this.first}${this.first === this.last ? '' : ' ' + this.last}`];
    if (this.execTimeoutMinutes !== null || this.execTimeoutSeconds !== null) {
      lines.push(` exec-timeout ${this.execTimeoutMinutes ?? 0} ${this.execTimeoutSeconds ?? 0}`);
    }
    if (this.absoluteTimeoutMinutes !== null) lines.push(` absolute-timeout ${this.absoluteTimeoutMinutes}`);
    if (this.loginTimeoutSeconds !== null) lines.push(` login-timeout ${this.loginTimeoutSeconds}`);
    if (this.sessionTimeoutMinutes !== null) lines.push(` session-timeout ${this.sessionTimeoutMinutes}`);
    if (this.escapeCharacter !== null) lines.push(` escape-character ${this.escapeCharacter}`);
    if (!this.historyEnabled) lines.push(' no history');
    else if (this.historySize !== null) lines.push(` history size ${this.historySize}`);
    if (this.accessClassIn  !== null) lines.push(` access-class ${this.accessClassIn} in`);
    if (this.accessClassOut !== null) lines.push(` access-class ${this.accessClassOut} out`);
    if (this.authorizationList !== null) lines.push(` authorization ${this.authorizationList}`);
    if (this.accountingList !== null) lines.push(` accounting ${this.accountingList}`);
    if (this.linePassword) {
      lines.push(` password ${renderPasswordField(this.linePassword, this.linePasswordAlgo === 'type-7' ? 'type-7' : 'plain-password', serviceEncryption, false, `line-vty:${this.first}`)}`);
    }
    if (this.login !== null) {
      if (this.login === 'local') lines.push(' login local');
      else if (this.login === 'aaa') {
        lines.push(` login authentication ${this.loginAuthList ?? 'default'}`);
      }
      else if (this.login === 'password') lines.push(' login');
      else lines.push(' no login');
    }
    if (this.autocommand) lines.push(` autocommand ${this.autocommand}`);
    if (this.execBannerSuppressed) lines.push(' no exec-banner');
    if (this.motdBannerSuppressed) lines.push(' no motd-banner');
    if (this.privilege !== null) lines.push(` privilege level ${this.privilege}`);
    if (this.terminalLength !== null) lines.push(` length ${this.terminalLength}`);
    if (this.terminalWidth !== null) lines.push(` width ${this.terminalWidth}`);
    if (this.speedBaud !== null) lines.push(` speed ${this.speedBaud}`);
    if (this.stopbits !== null) lines.push(` stopbits ${this.stopbits}`);
    if (this.rotaryGroup !== null) lines.push(` rotary ${this.rotaryGroup}`);
    if (this.transportInput !== null) lines.push(` transport input ${this.transportInput}`);
    if (this.loggingSynchronous) lines.push(' logging synchronous');
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

  admetTransport(kind: 'ssh' | 'telnet', defaut: VtyTransport = 'all'): boolean {
    return transportAdmet(this.transportInput ?? defaut, kind);
  }

  /** Huawei VRP `display current-configuration` block for the user-interface. */
  renderHuawei(): string[] {
    const lines: string[] = [`user-interface vty ${this.first}${this.first === this.last ? '' : ' ' + this.last}`];
    if (this.authenticationMode !== null) {
      lines.push(` authentication-mode ${this.authenticationMode}`);
    }
    if (this.privilege !== null) lines.push(` user privilege level ${this.privilege}`);
    if (this.linePassword !== null) {
      lines.push(` set authentication password cipher ${huaweiCipher(this.linePassword)}`);
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
