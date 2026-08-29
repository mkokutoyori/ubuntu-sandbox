/**
 * CiscoTerminalSession — Cisco IOS terminal model.
 *
 * Defines which Cisco IOS commands require interactive prompts
 * (enable password, reload confirmation, copy confirmations, etc.)
 * via buildInteractiveFlow() → InteractiveFlowEngine.
 */

import { expandBannerTokens } from '@/network/devices/shells/cisco/ciscoBannerTokens';
import { IOS_SSH, type SshDialect } from '@/terminal/ssh/sshDialect';
import type { ICLIDevice } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType, withTimeout, DeviceOfflineError } from './TerminalSession';
import type { InteractiveStep } from '@/terminal/core/types';
import { Router } from '@/network/devices/Router';
import { testAaaAttemptLine, testAaaVerdictLine } from '@/network/devices/router/aaa/TestAaaGroup';
import { Switch } from '@/network/devices/Switch';
import { IPAddress } from '@/network/core/types';
import {
  parsePingArgs, formatCiscoPingSummary, ciscoPingMark, answerOr, isYes,
  sweepSizes, EXTENDED_PING_PROMPTS as EP, defaultExtendedPingParams, estUneAdresseLitterale,
  type CiscoPingRow, type ExtendedPingParams,
} from '@/network/devices/shells/cisco/ciscoPing';
import type { CliLineKind, CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import type { AsyncJobHandle } from '@/terminal/async';
import type { TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';
import type { LoggingMonitorSource } from '@/network/devices/inspection/config/LoggingConfig';
import { IOS_TELNET, type TelnetDialect } from '@/terminal/subshells/telnetDialect';
import { ciscoPasswordMatches } from '@/network/devices/shells/cisco/ciscoPasswordVerify';

const CISCO_THEME: TerminalTheme = {
  sessionType: 'cisco',
  backgroundColor: '#000000',
  textColor: '#4ade80',     // green-400
  errorColor: '#f87171',    // red-400
  promptColor: '#4ade80',
  fontFamily: "monospace",
  infoBarBg: 'rgba(0,0,0,0.5)',
  infoBarText: '#16a34a',   // green-600
  infoBarBorder: 'rgba(22,101,52,0.5)',
  bootColor: '#22c55e',     // green-500
  pagerColor: '#facc15',    // yellow-400
};

export class CiscoTerminalSession extends CLITerminalSession {
  /**
   * Per-terminal vty session — allocated when the underlying device is a
   * Router. Holds the mode (user/priv/config/...), the selectedInterface
   * and every other sub-mode pointer that real Cisco IOS keeps per vty.
   *
   * See terminal_gap.md §5.1.
   */
  vty: CliShellSession | null = null;

  /** Authenticated username for this line -- feeds `aaa authorization commands`. */
  private authenticatedUsername: string | null = null;

  constructor(id: string, device: ICLIDevice) {
    super(id, device);
    if (device instanceof Router || device instanceof Switch) {
      this.vty = device.openVtySession();
      this.registerTearDown(() => {
        const s = this.vty;
        if (s && (device instanceof Router || device instanceof Switch)) device.closeVtySession(s);
        this.vty = null;
      });
    }
  }

  getSessionType(): SessionType { return 'cisco'; }
  getTheme(): TerminalTheme { return CISCO_THEME; }

  /**
   * Real Cisco console login gate: when `line console 0` is configured
   * with `login local`, every new console connection (this terminal
   * window opening = plugging into the physical console) must
   * authenticate before reaching a command prompt — "User Access
   * Verification" / "Username:" / "Password:", 3 failed attempts closes
   * the line. A factory-default device (no `line console 0 / login`
   * configured at all) skips this entirely, preserving the existing
   * "double-click opens straight to a prompt" behaviour every other test
   * in the suite already depends on.
   */
  override async init(): Promise<void> {
    await super.init();
    this.startConsoleLogging();
    this.maybeStartConsoleLogin();
    this.armerLimiteAbsolue();
    this.abonnerAuxMessages();
  }

  /**
   * This terminal is the device console, and IOS ships with `logging
   * console debugging` on: %LINK/%LINEPROTO and friends appear here without
   * anyone asking for them. `terminal monitor` is the separate opt-in a vty
   * needs, and it keeps its own subscription.
   */
  private offConsoleLogging: (() => void) | null = null;

  private startConsoleLogging(): void {
    // Idempotent : un second appel REMPLACE l'abonnement au lieu de s'y
    // ajouter. Un abonnement qui s'accumule ne se voit pas — il se compte,
    // chaque message sortant une fois de plus que la fois précédente.
    this.offConsoleLogging?.();
    this.offConsoleLogging = null;
    const src = (this.device as unknown as {
      getLoggingConfig?: () => LoggingMonitorSource | null;
    }).getLoggingConfig?.();
    if (!src?.subscribeConsole) return;
    const unsubscribe = src.subscribeConsole((line) => this.addLine(line));
    this.offConsoleLogging = unsubscribe;
    this.registerTearDown(() => {
      this.offConsoleLogging?.();
      this.offConsoleLogging = null;
    });
  }

  /**
   * S'inscrire pour recevoir les messages de `send`.
   *
   * La ligne est celle de la session : la console est 0, une vty prend
   * son rang. Sans cette inscription, `send` serait une commande qui
   * annonce avoir livre un message que personne ne voit — le defaut que
   * ce depot referme partout ailleurs.
   */
  private abonnerAuxMessages(): void {
    const reg = (this.device as unknown as {
      getSshSessionRegistry?: () => {
        subscribeMessages?: (l: number, cb: (t: string) => void) => () => void;
        noteLineUse?: (k: 'con' | 'vty' | 'aux', i: number) => void;
      };
    }).getSshSessionRegistry?.();
    if (!reg?.subscribeMessages) return;
    const ligne = this.numeroDeLigne();
    const off = reg.subscribeMessages(ligne, (texte) => {
      for (const l of texte.split('\n')) this.addLine(l);
      this.notify();
    });
    this.registerTearDown(off);
  }

  private numeroDeLigne(): number {
    return this.vty?.lineKind === null ? 0 : (this.vty?.lineIndex ?? 0);
  }

  private maybeStartConsoleLogin(): void {
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => {
        login: 'password' | 'local' | 'none' | null; password: string | null;
        passwordEncrypted?: boolean;
      } | null;
    } | undefined)?._getConsoleLineConfig?.();
    if (!cfg) return;
    // `login local` demande un nom PUIS un mot de passe ; `login` seul
    // demande le mot de passe DE LA LIGNE et rien d'autre. Le second
    // etait declare hors perimetre, or c'est la toute premiere securite
    // qu'un cours fait poser : la ligne etait configuree, la
    // configuration la rendait, et la console n'invitait a rien.
    if (cfg.login === 'local') {
      this.startFlowFromSteps(this.buildConsoleLoginSteps(), '', undefined, { authGate: true });
      return;
    }
    if (cfg.login === 'password' && cfg.password != null) {
      this.startFlowFromSteps(
        this.buildLinePasswordLoginSteps(cfg.password, cfg.passwordEncrypted === true ? 'type-7' : 'plain'),
        '', undefined, { authGate: true },
      );
    }
  }

  /**
   * Ctrl+C n'ouvre pas la porte : elle recommence.
   *
   * Interrompre un flux ordinaire rend la main au prompt — c'est juste.
   * Mais pour le flux de connexion, ce prompt EST le shell authentifie,
   * donc Ctrl+C au `Username:` donnait l'acces sans mot de passe. Un
   * vrai IOS reaffiche l'invite ; on ne sort pas d'une invite de
   * connexion par une touche.
   */
  protected override restartAuthGate(): void {
    this.maybeStartConsoleLogin();
  }

  protected override onFlowComplete(): void {
    super.onFlowComplete();
    if (!this.lastFlowWasAuthGate) return;
    if (this.authGatePassed) return;
    this.maybeStartConsoleLogin();
  }

  private authGatePassed = false;

  /**
   * `login` seul : le mot de passe de la LIGNE, sans nom d'utilisateur.
   * IOS ne dit pas lequel des deux est faux (il n'y a qu'un secret ici)
   * et laisse trois essais avant de fermer la ligne, comme la variante
   * nominative.
   */
  private buildLinePasswordLoginSteps(attendu: string, algo: 'plain' | 'type-7' = 'plain'): InteractiveStep[] {
    const loginBanner = this.deviceBanner('login');
    const preLines = loginBanner.length > 0 ? [...loginBanner.split('\n'), ''] : [];
    return [
      /* 0 */ { type: 'output', outputLines: [...preLines, 'User Access Verification', ''] },
      /* 1 */ { type: 'password', prompt: 'Password: ', mask: 'hidden', storeAs: 'line_login_password' },
      /* 2 */ {
        type: 'execute',
        action: async (ctx) => {
          const saisi = ctx.values.get('line_login_password') ?? '';
          // Comparer a la forme STOCKEE refusait le bon mot de passe des
          // que `service password-encryption` etait actif ou que la
          // configuration avait fait un aller-retour : la porte se
          // fermait sur l'operateur qui venait de la poser.
          const ok = ciscoPasswordMatches(saisi, attendu, algo);
          const essais = parseInt(ctx.values.get('line_login_attempts') ?? '0', 10) + (ok ? 0 : 1);
          ctx.values.set('line_login_attempts', String(essais));
          ctx.values.set('line_login_ok', ok ? '1' : '0');
          const store = (this.device as unknown as {
            getCredentialStore?: () => {
              recordLoginSuccess: (n: string, f: string, m: 'password') => void;
              recordLoginFailure: (n: string, f: string, r: string) => void;
            };
          }).getCredentialStore?.();
          if (ok) store?.recordLoginSuccess('', 'console', 'password');
          else store?.recordLoginFailure('', 'console', 'bad password');
        },
      },
      /* 3 */ {
        type: 'branch',
        predicate: (ctx) => (ctx.values.get('line_login_ok') === '1' ? 4 : 6),
      },
      /* 4 */ {
        type: 'execute',
        action: async () => {
          // Un mot de passe de ligne n'identifie personne : la session
          // n'a pas de nom d'utilisateur, et `show users` doit le dire
          // plutot qu'inventer un compte.
          this.authenticatedUsername = null;
          this.authGatePassed = true;
          const niveau = this.consoleLinePrivilegeOverride() ?? 1;
          if (this.vty) {
            this.vty.state.mode = niveau === 15 ? 'privileged' : 'user';
            this.vty.state.privilegeLevel = niveau;
          }
          this.rearmExecTimeout();
          const execBanner = this.deviceBanner('exec');
          if (execBanner) for (const ln of execBanner.split('\n')) this.addLine(ln);
        },
      },
      /* 5 */ { type: 'branch', predicate: () => 10 },
      /* 6 */ { type: 'output', outputLines: ['% Login invalid'] },
      /* 7 */ {
        type: 'branch',
        predicate: (ctx) => (parseInt(ctx.values.get('line_login_attempts') ?? '0', 10) >= 3 ? 8 : 1),
      },
      /* 8 */ { type: 'output', outputLines: ['% Bad passwords'] },
      /* 9 */ { type: 'execute', action: async () => { this._onRequestClose?.(); } },
    ];
  }

  /**
   * La banniere telle qu'elle s'AFFICHE, jetons substitues. IOS remplace
   * `$(hostname)`, `$(domain)`, `$(line)` et `$(line-desc)` depuis la
   * 12.0(3)T ; ils sortaient litteralement, donc une banniere ecrite
   * d'apres la documentation de Cisco affichait `$(hostname)`.
   *
   * La substitution est faite ICI et non au rangement, parce que le nom
   * de la machine peut changer apres qu'on a ecrit la banniere.
   */
  private deviceBanner(kind: 'motd' | 'login' | 'exec' | 'incoming'): string {
    const dev = this.device as unknown as {
      getBanner?: (k: string) => string;
      getHostname?: () => string;
      getDomainName?: () => string | null | undefined;
      getManagementService?: () => { domainName?: string };
    };
    const brut = dev.getBanner?.(kind) ?? '';
    return expandBannerTokens(brut, {
      hostname: () => dev.getHostname?.() ?? '',
      domain: () => (dev as unknown as { _getDnsConfig?: () => { domainName: string } })
        ._getDnsConfig?.().domainName
        || dev.getManagementService?.().domainName
        || dev.getDomainName?.()
        || '',
      line: () => String(this.numeroDeLigne()),
      lineDescription: () => '',
    });
  }

  /**
   * Real IOS: console failures/successes DO feed the same AAA login
   * bookkeeping as remote lines (visible in `show login` / `show login
   * failures`) -- but console access is never itself gated by `login
   * block-for` quiet-mode (confirmed via Cisco's own documentation: quiet
   * mode denies remote logins only, precisely so an administrator always
   * retains physical access during a suspected brute-force attack). This
   * method therefore always authenticates normally regardless of any
   * device-wide quiet-mode state.
   *
   * Routes through `AaaAuthenticator` rather than the credential store
   * directly -- when `aaa new-model` + an authentication method list are
   * configured (Scénario 6 — TACACS+), this transparently tries the
   * configured server group first, silently falling back to `local` on an
   * unreachable server exactly as `authenticate()` already does; when AAA
   * isn't configured, `authenticate()` degrades to the same bare
   * credential-store check this method always performed, so existing
   * local-only logins are unaffected. `lockedOut` signals the AAA method
   * chain was fully exhausted (every method unreachable/not configured,
   * nothing left to fall back to) -- real IOS's "% Authentication failed"
   * lockout, distinct from an ordinary wrong-password reject.
   *
   * `getAaaAuthenticator` only exists on `Router` (TACACS+/RADIUS group
   * AAA is not wired into `Switch`, matching the existing disclosed gap
   * for other AAA config surfaces on switches) -- falls back to a bare
   * credential-store check, identical to this method's behaviour before
   * AAA integration existed, when it's absent.
   */
  private async verifyConsoleLogin(username: string, password: string): Promise<{ ok: boolean; privilege: number | null; lockedOut: boolean }> {
    const dev = this.device as unknown as {
      getCredentialStore?: () => {
        authenticate: (u: string, p: string) => boolean;
        recordLoginSuccess: (n: string, from: string, method: 'password', at?: number) => void;
        recordLoginFailure: (n: string, from: string, reason: string, at?: number) => void;
      };
      getAaaAuthenticator?: () => {
        authenticate: (u: string, p: string) => Promise<{ accepted: boolean; method: string; privLvl?: number | null }>;
      };
    };
    const store = dev.getCredentialStore?.();
    const authenticator = dev.getAaaAuthenticator?.();
    const outcome = authenticator
      ? await authenticator.authenticate(username, password)
      : { accepted: store?.authenticate(username, password) ?? false, method: 'local', privLvl: null as number | null };
    if (outcome.accepted) store?.recordLoginSuccess(username, 'console', 'password');
    else store?.recordLoginFailure(username, 'console', 'bad password');
    return {
      ok: outcome.accepted,
      privilege: outcome.privLvl ?? null,
      lockedOut: !outcome.accepted && outcome.method === 'exhausted',
    };
  }

  private lookupAccountPrivilege(username: string): number {
    const dev = this.device as unknown as {
      getCredentialStore?: () => { get: (u: string) => { privilege: number } | undefined };
    };
    return dev.getCredentialStore?.().get(username)?.privilege ?? 1;
  }

  /**
   * "User Access Verification" console login, real IOS semantics: prompt
   * Username: then Password:, `% Login invalid` on any mismatch (no
   * distinction between "no such user" and "wrong password" — a security
   * property, not an oversight) looping back to Username: up to 3 times,
   * then `% Bad passwords` and the line closes. Built with the richer
   * text/password/branch/execute step vocabulary (not the vendor-neutral
   * CommandInteractionPlan) because the retry loop needs real branching —
   * mirrors the existing outbound-SSH interactive flow's construction.
   */
  private buildConsoleLoginSteps(): InteractiveStep[] {
    // Real IOS order: `banner login` is shown right before the login
    // prompt (unlike `banner motd`, already shown earlier in `init()`,
    // before this flow even starts).
    const loginBanner = this.deviceBanner('login');
    const preLines = loginBanner.length > 0 ? [...loginBanner.split('\n'), ''] : [];
    return [
      /* 0 */ { type: 'output', outputLines: [...preLines, 'User Access Verification', ''] },
      /* 1 */ { type: 'text', prompt: 'Username: ', allowEmpty: true, storeAs: 'console_login_username' },
      /* 2 */ { type: 'password', prompt: 'Password: ', mask: 'hidden', storeAs: 'console_login_password' },
      /* 3 */ {
        // `InteractiveStep.validation` is synchronous only, but AAA
        // authentication (TACACS+ over the real TCP stack) is genuinely
        // async -- so, like the outbound-SSH flow, the actual credential
        // check happens here in an `execute` step (awaited properly) and
        // the following `branch` step reads its result back out of the
        // context, rather than inline in the password step's validation.
        type: 'execute',
        action: async (ctx) => {
          const username = (ctx.values.get('console_login_username') ?? '').trim();
          const password = ctx.values.get('console_login_password') ?? '';
          const result = await this.verifyConsoleLogin(username, password);
          const attempts = parseInt(ctx.values.get('console_login_attempts') ?? '0', 10) + (result.ok ? 0 : 1);
          ctx.values.set('console_login_attempts', String(attempts));
          ctx.values.set('console_login_ok', result.ok ? '1' : '0');
          ctx.values.set('console_login_lockout', result.lockedOut ? '1' : '0');
          if (result.ok) {
            ctx.values.set('console_login_account', username);
            if (result.privilege != null) ctx.values.set('console_login_privilege', String(result.privilege));
          }
        },
      },
      /* 4 */ {
        type: 'branch',
        // AAA method-chain exhaustion (unreachable server, no local
        // fallback configured) skips the retry loop entirely -- real IOS
        // shows "% Authentication failed" once and closes, it does not
        // give the attacker 3 tries against a server that was never
        // reachable. A plain reject (wrong password, whether local or via
        // a reachable AAA server) still goes through the familiar 3-strikes
        // "% Login invalid" / "% Bad passwords" loop.
        predicate: (ctx) => {
          if (ctx.values.get('console_login_lockout') === '1') return 12;
          return ctx.values.get('console_login_ok') === '1' ? 5 : 7;
        },
      },
      /* 5 */ {
        type: 'execute',
        action: async (ctx) => {
          const username = ctx.values.get('console_login_account') ?? '';
          this.authenticatedUsername = username || null;
          this.authGatePassed = true;
          const grantedPrivilege = ctx.values.get('console_login_privilege');
          // Real IOS: a `privilege level N` configured on the line
          // OVERRIDES the authenticated user's own account privilege
          // (confirmed behaviour, not just a "default when unset") --
          // only fall back to the account's privilege when the line
          // itself has no override configured. An AAA-granted privilege
          // (TACACS+ authentication reply) is authoritative over BOTH --
          // it is what the scenario's "niveau 15 direct (accordé par
          // TACACS+)" describes, and real AAA authorization is meant to
          // take priority over a line's static default.
          const linePrivilege = this.consoleLinePrivilegeOverride();
          const privilege = grantedPrivilege != null
            ? parseInt(grantedPrivilege, 10)
            : linePrivilege ?? this.lookupAccountPrivilege(username);
          if (this.vty) {
            this.vty.state.mode = privilege === 15 ? 'privileged' : 'user';
            this.vty.state.privilegeLevel = privilege;
            // L'identite voyage avec la session : c'est elle qu'AAA
            // soumet au serveur pour autoriser chaque commande.
            this.vty.state.sessionUser = username || null;
          }
          this.rearmExecTimeout();
          // Real IOS: `banner exec` is shown after a SUCCESSFUL login only,
          // right before the command prompt -- never on a failed attempt.
          const execBanner = this.deviceBanner('exec');
          if (execBanner) for (const ln of execBanner.split('\n')) this.addLine(ln);
        },
      },
      /* 6 */ { type: 'branch', predicate: () => 15 },
      /* 7 */ { type: 'output', outputLines: ['% Login invalid'] },
      /* 8 */ {
        type: 'branch',
        predicate: (ctx) => {
          const attempts = parseInt(ctx.values.get('console_login_attempts') ?? '0', 10);
          return attempts >= 3 ? 9 : 1;
        },
      },
      /* 9 */ { type: 'output', outputLines: ['% Bad passwords'] },
      /* 10 */ { type: 'execute', action: async () => { this._onRequestClose?.(); } },
      /* 11 */ { type: 'branch', predicate: () => 15 },
      /* 12 */ { type: 'output', outputLines: ['% Authentication failed'] },
      /* 13 */ { type: 'execute', action: async () => { this._onRequestClose?.(); } },
      /* 14 */ { type: 'branch', predicate: () => 15 },
      // Steps 6, 11 and 14 branch to index 15 == steps.length, ending the
      // flow immediately (InteractiveFlowEngine.isComplete is
      // currentIndex >= steps.length) without an extra no-op step.
    ];
  }

  // `banner <kind> <delim>` multi-line capture is declared by the IOS
  // shell itself (CiscoShellBase.bannerCaptureInteractionPlan, a `collect`
  // step) — the generic planner-driven buildInteractiveFlow renders it
  // here, and the SSH adapters render the SAME plan. Nothing banner-
  // specific remains in the terminal layer.

  // Set by `prepareAsRemoteUser` -- `this.isRemoteChild` (`_parent !==
  // null`) is NOT yet true at that point (`adoptRemoteChild` calls
  // `prepareAsRemoteUser` BEFORE `attachAsChildOf`), so exec-timeout
  // resolution needs its own explicit "this is a VTY line, not the
  // console" flag rather than relying on parent-attachment timing.
  private isVtyRemoteSession = false;

  override attachToVtyLine(): void {
    this.isVtyRemoteSession = true;
  }

  protected override onVtyLine(): boolean { return this.isVtyRemoteSession; }

  protected override onLineAssigned(kind: CliLineKind, index: number, recordId: string): void {
    this.vty?.assignLine(kind, index, recordId);
  }

  protected override prepareAsRemoteUser(user: string): void {
    this.isVtyRemoteSession = true;
    this.authenticatedUsername = user || null;
    this.authGatePassed = true;
    if (this.vty) {
      // Real IOS: a `privilege level N` configured on the VTY line
      // OVERRIDES the authenticated user's own account privilege (same
      // rule as the console line above) -- confirmed via Cisco's own
      // documentation, not just a default-when-unset fallback.
      const linePrivilege = this.vtyLinePrivilegeOverride();
      const privilege = linePrivilege ?? this.lookupAccountPrivilege(user);
      this.vty.state.mode = privilege === 15 ? 'privileged' : 'user';
      this.vty.state.privilegeLevel = privilege;
      this.vty.state.sessionUser = user || null;
    }
    this.isBooting = false;
    this.updatePrompt();
    this.rearmExecTimeout();
  }

  /**
   * `privilege level N` configured on `line console 0`, if any.
   *
   * Ce niveau vit sur l'EQUIPEMENT, et c'est la qu'il se lit : passer
   * par le shell le faisait transiter par `consolePrivilegeLevel()`,
   * qui interroge `deviceRef` — une reference que le shell ne tient que
   * PENDANT `execute`. Lue hors execution, elle est nulle, donc le
   * reglage de la ligne repondait « aucun » et le niveau du COMPTE
   * l'emportait : exactement l'inverse de la precedence d'IOS.
   */
  private consoleLinePrivilegeOverride(): number | null {
    return (this.device as unknown as {
      getConsoleLinePrivilege?: () => number | null;
    }).getConsoleLinePrivilege?.() ?? null;
  }

  /**
   * `privilege level N` configured on the (first) `line vty …` block, if
   * any. The simulator does not track which specific VTY slot number an
   * incoming session occupies, so — matching the common single-block
   * configuration this scenario (and real small deployments) uses — the
   * first configured VTY block's privilege applies.
   */
  private vtyLinePrivilegeOverride(): number | null {
    const dev = this.device as unknown as {
      _getVtyLineConfig?: () => { all: () => ReadonlyArray<{ privilege: number | null }> };
    };
    const block = dev._getVtyLineConfig?.().all()[0];
    return block?.privilege ?? null;
  }

  // ── exec-timeout (idle disconnect) ──────────────────────────────────

  protected override onCommandActivity(): void {
    this.rearmExecTimeout();
  }

  /** Effective exec-timeout, in milliseconds, for the line this session represents. */
  private resolveExecTimeoutMs(): number | null {
    if (this.isVtyRemoteSession) {
      const dev = this.device as unknown as {
        _getVtyLineConfig?: () => { all: () => ReadonlyArray<{ execTimeoutMinutes: number | null; execTimeoutSeconds: number | null }> };
      };
      const block = dev._getVtyLineConfig?.().all()[0];
      if (!block || (block.execTimeoutMinutes == null && block.execTimeoutSeconds == null)) return null;
      return ((block.execTimeoutMinutes ?? 0) * 60 + (block.execTimeoutSeconds ?? 0)) * 1000;
    }
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => { execTimeoutMin: number | null; execTimeoutSec: number } | null;
    } | undefined)?._getConsoleLineConfig?.();
    if (!cfg || cfg.execTimeoutMin == null) return null;
    return (cfg.execTimeoutMin * 60 + cfg.execTimeoutSec) * 1000;
  }

  private rearmExecTimeout(): void {
    const ms = this.resolveExecTimeoutMs();
    if (ms == null) { this.clearIdleTimer(); return; }
    this.armIdleTimer(ms, () => this.onExecTimeout());
  }

  /**
   * `absolute-timeout <minutes>` : la duree MAXIMALE d'une session,
   * activite comprise.
   *
   * Il ne passe deliberement PAS par `rearmExecTimeout` : ce minuteur-la
   * est reamorce a chaque commande, donc un operateur qui tape sans
   * arret ne le declenche jamais — ce qui est juste pour l'inactivite et
   * serait la negation exacte d'une limite absolue. Il est arme UNE
   * fois, a l'ouverture, et n'est jamais repousse.
   *
   * IOS previent 20 secondes avant de couper. On garde l'avertissement
   * plutot que la surprise : c'est l'unique chose qui laisse a
   * l'operateur le temps d'enregistrer son travail, donc la partie utile
   * du mecanisme.
   */
  private armerLimiteAbsolue(): void {
    const minutes = this.resolveAbsoluteTimeoutMinutes();
    if (minutes == null || minutes <= 0) { this.clearAbsoluteTimer(); return; }
    const totalMs = minutes * 60_000;
    const preavisMs = Math.max(0, totalMs - 20_000);
    this.armAbsoluteTimer(preavisMs, () => {
      if (this.disposed) return;
      this.addLine('');
      this.addLine('Line timeout expired');
      this.notify();
      this.armAbsoluteTimer(totalMs - preavisMs, () => this.onAbsoluteTimeout());
    });
  }

  private resolveAbsoluteTimeoutMinutes(): number | null {
    if (!this.isVtyRemoteSession) return null;
    const dev = this.device as unknown as {
      _getVtyLineConfig?: () => { all: () => ReadonlyArray<{ absoluteTimeoutMinutes?: number | null }> };
    };
    return dev._getVtyLineConfig?.().all()[0]?.absoluteTimeoutMinutes ?? null;
  }

  private onAbsoluteTimeout(): void {
    if (this.disposed) return;
    if (this.isRemoteChild) { this.endRemoteSession(); return; }
    if (this.vty) {
      this.vty.state.mode = 'user';
      this.vty.state.privilegeLevel = 1;
    }
    this.updatePrompt();
    this.maybeStartConsoleLogin();
  }

  private onExecTimeout(): void {
    if (this.disposed) return;
    if (this.isRemoteChild) {
      // VTY: the line drops -- the local (client) session sees the same
      // "Connection to X closed." footer any other SSH teardown produces.
      this.endRemoteSession();
      return;
    }
    // Console: the EXEC session times out and resets to an unauthenticated
    // line -- if `login local` is configured, the login banner reappears;
    // otherwise this is a silent no-op (matches real IOS: exec-timeout on
    // a line with no login configured just resets an idle session with
    // nothing to reauthenticate).
    if (this.vty) {
      this.vty.state.mode = 'user';
      this.vty.state.privilegeLevel = 1;
    }
    this.updatePrompt();
    this.addLine(this.prompt);
    this.maybeStartConsoleLogin();
  }

  /**
   * Run commands through the per-vty queue so the shared shell is swapped
   * into this session's state for the duration of the call. Concurrent
   * terminals on the same router thus observe their own mode without
   * stepping on each other's privilege level (terminal_gap.md §5.1).
   */
  protected override async executeOnDevice(
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    const dev = this.device;
    if (!dev.getIsPoweredOn()) throw new DeviceOfflineError(dev.getName());
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      const p = dev.executeCommandInVty(command, this.vty);
      return timeoutMs != null ? withTimeout(p, timeoutMs) : p;
    }
    return super.executeOnDevice(command, timeoutMs);
  }

  /**
   * `aaa authorization commands` ne vit plus ici.
   *
   * La porte etait portee par CE fichier et par lui seul : une session
   * SSH, telnet ou scriptee y echappait entierement. Elle vit desormais
   * sur `Router.executeCommand` / `Switch.executeCommand`, que tous les
   * appelants empruntent — y compris celui-ci. La garder ici en plus
   * soumettrait deux fois la meme commande au serveur, et doublerait ses
   * compteurs.
   */

  /**
   * Effective `terminal length` of this vty session.
   * Real Cisco IOS scopes this preference per line — `terminal length 0`
   * disables the pager for the current session only (terminal_gap.md §5.3).
   */
  protected override getPageSize(): number {
    return this.vty?.state.terminalLength ?? 24;
  }

  protected override resolveCliHelp(currentInput: string): string {
    const dev = this.device;
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      return dev.cliHelpForVty(currentInput, this.vty);
    }
    return super.resolveCliHelp(currentInput);
  }

  protected override resolveCliTabCandidates(input: string): string[] {
    const dev = this.device;
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      return dev.cliTabCandidatesForVty(input, this.vty);
    }
    return super.resolveCliTabCandidates(input);
  }

  /**
   * Override updatePrompt to read the prompt from the vty's swapped-in
   * shell state, not from the device's shared default state.
   */
  override updatePrompt(): void {
    const dev = this.device;
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      this.prompt = dev.getPromptForVty(this.vty);
    } else {
      this.prompt = this.cliDevice.getPrompt();
    }
    this.notify();
  }

  protected getDefaultPrompt(): string {
    return `${this.device.getHostname()}>`;
  }

  protected getCtrlZCommand(): string { return 'end'; }
  protected getPagerIndicator(): string { return ' --More-- '; }

  protected getTelnetDialect(): TelnetDialect { return IOS_TELNET; }

  protected getSshDialect(): SshDialect { return IOS_SSH; }

  protected isTopLevelExit(line: string): boolean {
    const w = line.trim().toLowerCase();
    if (w === 'logout') return true;
    if (w !== 'exit' && w !== 'quit') return false;
    const mode = this.vty?.state.mode;
    return mode === 'user' || mode === 'privileged';
  }

  getInfoBarContent() {
    const deviceType = this.device.getType();
    const isSwitch = deviceType.includes('switch');
    return {
      left: `${this.device.getHostname()} — ${isSwitch ? 'C2960 Switch' : 'C2911 Router'}`,
      right: '? = help | Tab = complete',
    };
  }

  protected getFallbackBootLines(): string[] {
    return []; // Cisco devices should always provide getBootSequence()
  }

  /**
   * `logging synchronous` on the console line: while the operator has an
   * unsubmitted command in progress, async output (syslog/monitor/debug)
   * is deferred instead of visually interrupting the in-progress line —
   * flushed once the command is submitted (`CLITerminalSession.
   * executeCommand` calls `flushDeferredAsyncQueue()` right before
   * echoing it). Without `logging synchronous` (real IOS default),
   * nothing is deferred — async lines interrupt immediately.
   */
  protected override shouldDeferAsyncOutput(): boolean {
    if (this.isRemoteChild) return false; // scoped to the console line for now
    if (this.input.length === 0) return false;
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => { loggingSynchronous: boolean } | null;
    } | undefined)?._getConsoleLineConfig?.();
    return cfg?.loggingSynchronous ?? false;
  }

  /**
   * Interactive commands (copy/reload/erase) are declared by the IOS shell
   * itself (CiscoShellBase.interactionPlanFor) — the generic planner-driven
   * buildInteractiveFlow in CLITerminalSession renders them. Only the CLI
   * mode is supplied here so plans stay privileged-EXEC-only.
   */
  protected override interactionPlanContext() {
    return {
      mode: this.vty?.state.mode ?? 'user',
      level: this.vty?.state.privilegeLevel,
      // La vue de CETTE session. Le champ existait dans le contexte et
      // n'etait rempli par personne : le planificateur jugeait donc la
      // visibilite sur la vue du SHELL, qui n'est plus celle de la
      // session depuis qu'une vue voyage avec elle. Sans cela, une
      // commande absente de la vue ouvrait quand meme son dialogue.
      view: this.vty?.state.activeParserView ?? null,
      device: this.device,
      onVtyLine: this.isVtyRemoteSession,
    };
  }

  private debugJob: AsyncJobHandle | null = null;
  private debugUnsubscribe: (() => void) | null = null;
  private monitorJob: AsyncJobHandle | null = null;
  private monitorUnsubscribe: (() => void) | null = null;

  protected override afterCommandExecuted(_command: string): void {
    this.reconcileDebugSubscription();
    this.reconcileTerminalMonitor();
  }

  protected override tryInterceptAsyncCommand(command: string): boolean {
    return this.tryStartCiscoPing(command) || this.tryStartTestAaa(command);
  }

  /**
   * `ping` with no argument, in privileged EXEC, is IOS's extended ping:
   * a question-and-answer dialog rather than an error. User EXEC keeps the
   * one-line form, exactly like real IOS.
   */
  protected override buildInteractiveFlow(command: string): InteractiveStep[] | null {
    if (command.trim() === 'ping' && this.vty?.state.mode === 'privileged'
        && this.device instanceof Router) {
      return this.buildExtendedPingSteps();
    }
    return super.buildInteractiveFlow(command);
  }

  private buildExtendedPingSteps(): InteractiveStep[] {
    const ask = (prompt: string, storeAs: string): InteractiveStep =>
      ({ type: 'text', prompt, storeAs, allowEmpty: true });
    const v = (ctx: { values: Map<string, string> }, k: string) => ctx.values.get(k) ?? '';

    const steps: InteractiveStep[] = [
      ask(EP.protocol, 'proto'),
      {
        type: 'text', prompt: EP.target, storeAs: 'target', allowEmpty: true,
        // IOS re-asks rather than carrying a bad address through the whole
        // dialog and failing at the end.
        validation: (value) => (
          value.trim() === '' || estUneAdresseLitterale(value.trim())
            ? { valid: true }
            : { valid: false, errorMessage: '% Unrecognized host or address, or protocol not running.' }
        ),
      },
      ask(EP.repeat, 'repeat'),
      ask(EP.size, 'size'),
      ask(EP.timeout, 'timeout'),
      ask(EP.extended, 'extended'),
      // Index 6: skip the extended block when the answer was no.
      { type: 'branch', predicate: (ctx) => (isYes(v(ctx, 'extended')) ? 7 : 13) },
      ask(EP.source, 'source'),
      ask(EP.tos, 'tos'),
      ask(EP.df, 'df'),
      ask(EP.validate, 'validate'),
      ask(EP.pattern, 'pattern'),
      ask(EP.routeOptions, 'routeOpts'),
      // Index 13: asked in both branches, like IOS.
      ask(EP.sweep, 'sweep'),
      { type: 'branch', predicate: (ctx) => (isYes(v(ctx, 'sweep')) ? 15 : 18) },
      ask(EP.sweepMin, 'sweepMin'),
      ask(EP.sweepMax, 'sweepMax'),
      ask(EP.sweepInterval, 'sweepInterval'),
      {
        type: 'execute',
        action: async (ctx) => {
          await this.runExtendedPing(this.collectExtendedPing(ctx.values));
        },
      },
    ];
    return steps;
  }

  /** Turn the dialog's answers into the parameters a probe actually uses. */
  private collectExtendedPing(values: Map<string, string>): ExtendedPingParams {
    const p = defaultExtendedPingParams();
    const get = (k: string) => values.get(k) ?? '';
    p.target = get('target').trim();
    p.count = parseInt(answerOr(get('repeat'), '5'), 10) || 5;
    p.sizeBytes = parseInt(answerOr(get('size'), '100'), 10) || 100;
    p.timeoutMs = (parseInt(answerOr(get('timeout'), '2'), 10) || 2) * 1000;
    if (isYes(get('extended'))) {
      p.sourceIP = get('source').trim() || null;
      p.tos = parseInt(answerOr(get('tos'), '0'), 10) || 0;
      p.df = isYes(get('df'));
      p.validateReply = isYes(get('validate'));
      p.dataPattern = answerOr(get('pattern'), '0xABCD');
      p.routeOptions = answerOr(get('routeOpts'), 'none');
    }
    if (isYes(get('sweep'))) {
      p.sweep = {
        min: parseInt(answerOr(get('sweepMin'), '36'), 10) || 36,
        max: parseInt(answerOr(get('sweepMax'), '18024'), 10) || 18024,
        interval: parseInt(answerOr(get('sweepInterval'), '1'), 10) || 1,
      };
    }
    return p;
  }

  /**
   * `test aaa group <name> <user> <password> legacy` — a genuine TACACS+/
   * RADIUS round-trip against the named server group (not a method list:
   * this bypasses `aaa authentication login` resolution entirely, exactly
   * like real IOS's diagnostic `test aaa`). Modeled as an async foreground
   * command (like `ping`) rather than a synchronous CommandTrie entry
   * because the underlying `AaaAuthenticator`/`TacacsClientAgent` call is a
   * real Promise-based TCP exchange — `CommandAction` handlers must return
   * a plain string synchronously, so they cannot await it.
   */
  private tryStartTestAaa(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof Router)) return false;
    if (this.vty?.state.mode !== 'privileged') return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'test' || toks[1] !== 'aaa' || toks[2] !== 'group') return false;
    const [, , , groupName, username, password, method] = toks;
    // `legacy` et `new-code` designent deux versions du code d'appel
    // interne d'IOS, pas deux protocoles : le dialogue sur le fil est le
    // meme. N'accepter que `legacy` refusait la moitie de la syntaxe.
    if (!groupName || !username || password === undefined) return false;
    if (method !== 'legacy' && method !== 'new-code') return false;

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      label: `test aaa group ${groupName}`,
      run: async (ctx) => {
        // Le rendu vit dans `TestAaaGroup.ts`, lu aussi par le shell de
        // l'equipement : deux copies finiraient par ne plus dire la meme
        // chose de la meme situation. Les lignes restent emises une a une
        // parce que la premiere annonce l'echange et doit paraitre AVANT
        // qu'il ait lieu — c'est ce que ce chemin apporte de plus.
        const authenticator = dev.getAaaAuthenticator();
        ctx.sink.line(testAaaAttemptLine(authenticator, groupName));
        const verdict = await authenticator.testGroupAuthentication(groupName, username, password);
        if (ctx.cancelled()) return;
        ctx.sink.line(testAaaVerdictLine(verdict));
      },
    });
    return job !== null;
  }

  /**
   * Run what the dialog asked for. A sweep is a series of runs of growing
   * datagram size — that is how an operator finds a path MTU by hand, so
   * each size is genuinely sent rather than summarised.
   */
  private async runExtendedPing(p: ExtendedPingParams): Promise<void> {
    const dev = this.device;
    if (!(dev instanceof Router)) return;

    const parsed = parsePingArgs([p.target]);
    if (parsed.error) { this.addLine(parsed.error); this.notify(); return; }

    let sourceIP = p.sourceIP;
    if (sourceIP) sourceIP = this.resolvePingSource(dev, sourceIP) ?? sourceIP;

    if (p.validateReply || p.routeOptions.toLowerCase() !== 'none') {
      // Dit franchement, plutôt qu'un transcript qui laisserait croire à
      // des contrôles qui n'ont pas eu lieu.
      this.addLine('% Reply data and IP header options were not verified on this run.');
    }

    const sizes = p.sweep ? sweepSizes(p.sweep) : [p.sizeBytes];
    this.addLine('Type escape sequence to abort.');
    if (p.sweep) {
      this.addLine(`Sweeping from ${p.sweep.min} to ${p.sweep.max}, increment by ${p.sweep.interval}`);
    }
    this.addLine(
      `Sending ${p.count * sizes.length}, ` +
      `${p.sweep ? `[${p.sweep.min}..${p.sweep.max}]` : String(p.sizeBytes)}-byte ` +
      `ICMP Echos to ${p.target}, timeout is ${p.timeoutMs / 1000} seconds:`,
    );
    if (p.df) this.addLine('Packet sent with the DF bit set');

    const all: CiscoPingRow[] = [];
    const marksBase = this.lines.length;
    this.addLine('');
    for (const size of sizes) {
      const rows = await dev.executePingSequence(
        new IPAddress(p.target), p.count, p.timeoutMs, sourceIP ?? undefined,
        { df: p.df, tos: p.tos, sizeBytes: size },
      );
      all.push(...(rows.length ? rows : Array.from({ length: p.count }, (_, i) => ({
        success: false, rttMs: 0, ttl: 0, seq: i + 1, fromIP: '', error: 'timeout' as const,
      }))));
      this.lines = this.lines.slice(0, marksBase);
      this.addLine(all.map(ciscoPingMark).join(''));
      this.notify();
    }
    this.addLine(formatCiscoPingSummary(all, p.count * sizes.length));
    this.notify();
  }

  /** `Source address or interface:` accepts either form, like IOS. */
  private resolvePingSource(dev: Router, source: string): string | null {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(source)) return source;
    for (const [name, port] of dev._getPortsInternal()) {
      if (name.toLowerCase() === source.toLowerCase()) {
        return port.getIPAddress()?.toString() ?? null;
      }
    }
    return null;
  }

  private tryStartCiscoPing(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof Router)) return false;
    const mode = this.vty?.state.mode;
    if (mode !== 'user' && mode !== 'privileged') return false;

    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'ping') return false;
    const parsed = parsePingArgs(toks.slice(1));
    if (parsed.error || parsed.sourceIP) return false;

    const targetIP = new IPAddress(parsed.target);
    const results: CiscoPingRow[] = [];
    let marksBase = this.lines.length;

    const repaintMarks = () => {
      this.lines = this.lines.slice(0, marksBase);
      this.addLine(results.map(ciscoPingMark).join(''));
      this.notify();
    };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      label: `ping ${parsed.target}`,
      run: async (ctx) => {
        ctx.sink.line('Type escape sequence to abort.');
        ctx.sink.line(`Sending ${parsed.count}, ${parsed.sizeBytes}-byte ICMP Echos to ${parsed.target}, timeout is ${parsed.timeoutMs / 1000} seconds:`);
        marksBase = this.lines.length;
        this.addLine('');
        this.notify();

        await dev.executePingSequence(targetIP, parsed.count, parsed.timeoutMs, undefined, {
          onResult: (row) => { if (ctx.cancelled()) return; results.push(row); repaintMarks(); },
          shouldStop: () => ctx.cancelled(),
        });
        if (ctx.cancelled()) return;

        if (results.length === 0) {
          this.lines = this.lines.slice(0, marksBase);
          this.addLine('.'.repeat(parsed.count));
          this.notify();
        }
        ctx.sink.line(formatCiscoPingSummary(results, parsed.count));
      },
      onInterrupt: (ctx) => { ctx.sink.line(formatCiscoPingSummary(results, parsed.count)); },
    });
    return job !== null;
  }

  /**
   * A console receives debug output without asking — IOS ships with
   * `logging console debugging`. A line that has explicitly said
   * `terminal no monitor` receives nothing, and that choice is the
   * operator's alone: silencing one session must leave every other one
   * untouched, which is exactly what a per-session subscription gives.
   */
  private receivesDebugOutput(): boolean {
    const state = this.vty?.state;
    if (!state?.terminalMonitorExplicit) return true;
    return state.terminalMonitor;
  }

  private reconcileDebugSubscription(): void {
    const svc = (this.device as unknown as { getDebugService?: () => TerminalDebugSource }).getDebugService?.();
    if (!svc) return;
    const wanted = svc.hasAnyFlag() && this.receivesDebugOutput();
    if (wanted && !this.debugJob) {
      this.startDebugSubscription(svc);
    } else if (!wanted && this.debugJob) {
      this.debugJob.cancel();
      this.debugJob = null;
    }
  }

  private reconcileTerminalMonitor(): void {
    const on = this.vty?.state.terminalMonitor ?? false;
    if (!on && !this.monitorJob) return;
    const src = (this.device as unknown as { getLoggingConfig?: () => LoggingMonitorSource | null }).getLoggingConfig?.();
    if (on && src && !this.monitorJob) {
      this.startMonitorSubscription(src);
    } else if ((!on || !src) && this.monitorJob) {
      this.monitorJob.cancel();
      this.monitorJob = null;
    }
  }

  private startMonitorSubscription(src: LoggingMonitorSource): void {
    this.monitorJob = this.startAsyncCommand({
      mode: 'background',
      kind: 'subscription',
      command: 'terminal monitor',
      label: 'syslog monitor',
      run: (ctx) => new Promise<void>((resolve) => {
        if (ctx.cancelled()) { resolve(); return; }
        this.monitorUnsubscribe = src.subscribeMonitor((line) => ctx.sink.line(line));
        ctx.onCancel(() => {
          this.monitorUnsubscribe?.();
          this.monitorUnsubscribe = null;
          resolve();
        });
      }),
    });
  }

  private startDebugSubscription(svc: TerminalDebugSource): void {
    this.debugJob = this.startAsyncCommand({
      mode: 'background',
      kind: 'subscription',
      command: 'debug',
      label: 'IOS debug output',
      run: (ctx) => new Promise<void>((resolve) => {
        if (ctx.cancelled()) { resolve(); return; }
        this.debugUnsubscribe = svc.subscribe((line) => ctx.sink.line(line));
        ctx.onCancel(() => {
          this.debugUnsubscribe?.();
          this.debugUnsubscribe = null;
          resolve();
        });
      }),
    });
  }

  /**
   * `<nom> con0 is now available` puis `Press RETURN to get started.` —
   * la formulation d'IOS, verifiee sur des transcriptions reelles et non
   * ecrite de memoire : une session qui se termine sur la console LIBERE
   * la ligne, elle ne debranche pas le cable.
   */
  protected override consoleReleasedBanner(): string[] | null {
    if (this.isRemoteChild) return null;
    const nom = this.device.getHostname?.() ?? 'Router';
    return ['', `${nom} con0 is now available`, '', 'Press RETURN to get started.', ''];
  }

  /**
   * La frappe rouvre une session EXEC. Elle repasse par la porte de la
   * ligne console : si un `login` y est configure, on redemande les
   * identifiants — sinon on aurait invente une session gratuite juste
   * apres avoir annonce qu'on en fermait une.
   */
  protected override reopenConsoleExec(): void {
    this.maybeStartConsoleLogin();
    if (!this.isFlowActive) this.updatePrompt();
    this.notify();
  }
}
