/**
 * CiscoShellBase — Abstract base class for Cisco IOS CLI shells.
 *
 * Factorizes the execute loop, FSM transitions, prompt generation,
 * help/tab-complete, and shared command registration that were previously
 * duplicated between CiscoIOSShell (Router) and CiscoSwitchShell (Switch).
 *
 * Template Method pattern: subclasses override hooks to provide
 * device-specific behavior (mode tries, prompt maps, etc.)
 *
 * @typeParam TDevice  The concrete device type (Router or Switch).
 *                     Subclasses use this for typed access to device-specific APIs.
 */

import { CiscoFileSystem } from './cisco/CiscoFileSystem';
import { CommandTrie } from './CommandTrie';
import { EquipmentParamResolver } from './EquipmentParamResolver';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { runSshClient } from '../linux/network/LinuxSshClient';
import { findHostByAddress } from '../linux/network/HostLookup';
import type { Router } from '../Router';
import { getSecurityConfig } from './cisco/CiscoSecurityCommands';
import type { CiscoDevice } from './CiscoDevice';
import type { PromptMap } from './PromptBuilder';
import { buildPrompt } from './PromptBuilder';
import { CLIStateMachine, type ModeHierarchy } from './CLIStateMachine';
import { estGenreAcces } from '../../ntp/accessGroups';

/**
 * Les sous-commandes de `ntp` en configuration globale, avec la
 * description qu'IOS en donne.
 *
 * Elles sont declarees plutot qu'extraites : la liste que `?` proposait
 * etait scrapee du code source du gestionnaire, d'ou `md5`, `prefer` et
 * `mode` — trois arguments ou fuites d'autres commandes, jamais des
 * sous-commandes de `ntp`. Ce qui n'est pas ici est refuse.
 */
const NTP_SOUS_COMMANDES: ReadonlyArray<{
  mot: string;
  desc: string;
  /**
   * Une sous-commande SANS argument se declare non gloutonne : sinon
   * `ntp authenticate ?` propose un `WORD` qui recopie la description de
   * son parent, exactement le defaut que ce lot ferme.
   */
  args?: false;
}> = [
  { mot: 'access-group', desc: 'Control NTP access' },
  { mot: 'allow', desc: 'Allow processing of packets' },
  { mot: 'authenticate', desc: 'Authenticate time sources', args: false },
  { mot: 'authentication-key', desc: 'Authentication key for trusted time sources' },
  { mot: 'master', desc: 'Act as NTP master clock' },
  { mot: 'peer', desc: 'Configure NTP peer' },
  { mot: 'server', desc: 'Configure NTP server' },
  { mot: 'source', desc: 'Configure interface for source address' },
  { mot: 'trusted-key', desc: 'Key numbers for trusted time sources' },
  { mot: 'update-calendar', desc: 'Periodically update calendar from NTP', args: false },
];
import { CISCO_ERRORS, parsePipeFilter, applyPipeFilter, PIPE_WRITERS, PIPE_MODIFIERS, type PipeFilter } from './cli-utils';
import { isValidIPv4 } from '../../core/ip';
import {
  registerArpShowCommands, registerArpPrivilegedCommands, registerArpConfigCommands,
} from './cisco/CiscoArpCommands';
import {
  showClock, showUsers, showInventory, showProcessesCpu, showProcessesMemory,
  showMemoryStatistics, showPrivilege,
  showCdp, showLldp, showSnmp, showSnmpCommunity, showSnmpHost,
  showSnmpGroup, showSnmpUser, showSnmpView, showSnmpEngineId,
  showNtpStatus, showNtpAssociations, showNtpAssociationsDetail, showNtpAuthenticationKeys,
  showNtpPackets,
  showLine, showIpSsh, showSshSessions, showHosts, showVrf,
  showVrfDetail, showVrfInterfaces, showAdjacency,
  showRedundancy, showFileSystems, showCalendar, showTerminal,
  showBuffers, showTcpBrief, showSockets,
  showStacks, showReload, showAaa, showEnvironment, showControllers,
  type ShowStateDevice,
} from './cisco/CiscoCommonShow';
import { CiscoConfigState } from '../inspection/config/CiscoConfigState';
import { AliasRepository, type AliasMode } from '../inspection/config/AliasRepository';
import { LoggingConfig, disabledTimestampSpec, bareTimestampSpec, deviceClockSource } from '../inspection/config/LoggingConfig';
import type { TimestampSpec } from '../inspection/config/LoggingConfig';
import { isPathReachable } from '../linux/network/HostLookup';
import { OutgoingSessionRegistry, renderSessions } from './OutgoingSessionRegistry';
import { registerArchiveExecCommands, archiveOnWriteMemory } from './cisco/CiscoArchiveCommands';
import {
  registerLoggingConfigCommands, registerLoggingShowCommands,
  registerSequenceNumbersCommand, registerLoggingClearCommands,
} from './cisco/CiscoLoggingCommands';
import type { LoggingCommandContext } from './cisco/CiscoLoggingCommands';
import { encryptType7 as _encryptType7, md5Hex as _md5Hex } from '@/crypto';
import {
  getManagementService, getSnmpService, getSnmpAgent, getNtpAgent, getHttpService,
} from '../../equipment/RouterServiceCapabilities';
import {
  HTTP_AUTH_METHODS, HTTP_MAX_CONNECTIONS_MIN, HTTP_MAX_CONNECTIONS_MAX,
  type HttpAuthMethod,
} from '../router/management/CiscoHttpService';
import { runTestAaaGroup } from '../router/aaa/TestAaaGroup';
import type { AaaAuthenticator } from '../router/aaa/AaaAuthenticator';
import type {
  CommandInteractionPlan,
  InteractionPlanContext,
} from '@/shell/interaction/CommandInteraction';
import {
  CliInvalidInput, CliIncomplete, renderCliDiagnostic, offsetForInvalidInput, argumentOffset,
  tokenSpans, INVALID_INPUT_MESSAGE,
} from './cli/CliDiagnostic';

/**
 * Ce qu'IOS affiche pendant qu'il écrit : un `!` par tranche envoyée.
 * `tee` affiche EN PLUS la sortie, `redirect` et `append` seulement
 * ceci — c'est ce qui distingue les trois.
 */
const PIPE_WRITE_BANNER = '!!';

/** Le texte que `help` imprime sur IOS, mot pour mot. */
const HELP_SYSTEM_TEXT = [
  'Help may be requested at any point in a command by entering',
  'a question mark \'?\'.  If nothing matches, the help list will',
  'be empty and you must backup until entering a \'?\' shows the',
  'available options.',
  'Two styles of help are provided:',
  '1. Full help is available when you are ready to enter a',
  '   command argument (e.g. \'show ?\') and describes each possible',
  '   argument.',
  '2. Partial help is provided when an abbreviated argument is entered',
  '   and you want to know what arguments match the input',
  '   (e.g. \'show pr?\'.)',
].join('\n');

const PRIVILEGED_ONLY_SHOW: ReadonlySet<string> = new Set([
  'running-config', 'startup-config', 'tech-support', 'archive',
  'debugging', 'debug',
]);

export abstract class CiscoShellBase<TDevice extends CiscoDevice> {
  // ─── State ───────────────────────────────────────────────────────
  protected mode: string = 'user';
  /**
   * Real 0-15 privilege level (real IOS model). `mode` stays a simpler
   * user/privileged/config-* FSM for trie selection and prompt rendering
   * (`#` iff level 15, `>` otherwise — matching real IOS exactly, where
   * even privilege 7 still shows `>`), but this field is the single
   * source of truth for `show privilege`, `enable`/`enable N` escalation,
   * and `privilege exec level N <command>` gating.
   */
  protected currentPrivilegeLevel: number = 1;
  /** Recent commands for `show history` (shared switch + router). */
  protected cmdHistory: string[] = [];
  protected deviceRef: TDevice | null = null;

  /**
   * Config-driven global feature state (cdp/lldp/ip routing…) — a real
   * Repository the CLI mutates and `show` projects (no silent no-ops).
   */
  protected readonly configState = new CiscoConfigState();

  /** Config-driven CLI aliases — real, working, projected by show. */
  protected readonly aliases = new AliasRepository();

  /** Config-driven syslog/logging state, projected by `show logging`. */
  protected readonly logging = new LoggingConfig();
  protected readonly outgoingSessions = new OutgoingSessionRegistry();
  private reloadTimer: TimerHandle | null = null;
  private scheduledReloadAtMs: number | null = null;

  private schedulerFor(device: TDevice): IScheduler {
    const dev = device as unknown as { getScheduler?: () => IScheduler };
    return dev.getScheduler?.() ?? getDefaultScheduler();
  }

  private armReloadTimer(ms: number): void {
    const device = this.d();
    const scheduler = this.schedulerFor(device);
    if (this.reloadTimer !== null) scheduler.clear(this.reloadTimer);
    this.scheduledReloadAtMs = Date.now() + ms;
    this.reloadTimer = scheduler.setTimeout(() => {
      this.reloadTimer = null;
      this.scheduledReloadAtMs = null;
      this.performScheduledReload(device);
    }, ms);
  }

  protected getScheduledReloadMs(): number | null {
    return this.scheduledReloadAtMs;
  }

  protected performImmediateReload(): string {
    // Le tampon est en mémoire vive : il part avec le redémarrage, et
    // `logging reload` décide de ce qui est journalisé pendant celui-ci.
    this.attachLoggingToDevice(this.d());
    this.logging.startReload();
    this.d().powerOff();
    this.d().powerOn();
    this.logging.noteRestart();
    this.mode = 'user';
    this.terminalMonitor = false;
    this.cmdHistory = [];
    this.aliases.reset();
    this.debugConsole.length = 0;
    (this.d() as unknown as { getDebugService?: () => { disableAll?: () => void } }).getDebugService?.().disableAll?.();
    return 'Proceed with reload? [confirm]\nReload requested.\nSystem restarting...';
  }

  protected performScheduledReload(device: TDevice): void {
    this.attachLoggingToDevice(device);
    this.logging.startReload();
    device.powerOff();
    device.powerOn();
    this.logging.noteRestart();
    this.mode = 'user';
    this.terminalMonitor = false;
    this.cmdHistory = [];
    this.debugConsole.length = 0;
    (device as unknown as { getDebugService?: () => { disableAll?: () => void } }).getDebugService?.().disableAll?.();
  }

  protected attachLoggingToDevice(device: TDevice): void {
    (device as unknown as { _loggingConfig?: LoggingConfig })._loggingConfig = this.logging;
    // A timestamp has to come from the machine it dates: its own boot
    // counter, its own `clock set` clock, its own `clock timezone`, and
    // its own NTP state for the `*` marker. A switch carries none of the
    // last three and takes the defaults.
    this.logging.attachClockSource(deviceClockSource(device));
  }

  attachLoggingToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): void {
    this.logging.attachToBus(bus, deviceId);
  }

  getLoggingConfig(): LoggingConfig {
    return this.logging;
  }

  /**
   * Ce dont les commandes `logging` ont besoin de la coquille, et rien de
   * plus : la configuration, son rattachement à l'horloge de la machine,
   * et le reprovisionnement de l'agent syslog. Le même contexte sert au
   * routeur et au commutateur, qui ne peuvent donc pas diverger sur ce
   * que la même commande fait.
   */
  protected loggingCommandContext(): LoggingCommandContext {
    return {
      config: () => this.logging,
      beforeApply: () => {
        this.attachLoggingToDevice(this.d());
        // Le journal persistant écrit dans le `flash:` de l'équipement —
        // le MÊME objet que `dir` et `more` lisent, pas une copie, sinon
        // `logging persistent` produirait des fichiers que nul ne voit.
        this.logging.attachFileStore({
          write: (name, content) => { this.fs().write(name, content); },
          read: (name) => this.fs().get(name)?.content ?? null,
          remove: (name) => this.fs().remove(name),
          list: (prefix) => this.fs().list()
            .map(f => f.name).filter(n => n.startsWith(prefix)),
        });
      },
      afterApply: () => { this.syncSyslogAgent(); },
    };
  }

  /** Async escape hatch: commands that return a Promise (e.g. ping on routers) */
  protected _pendingAsync: Promise<string> | null = null;

  /**
   * Per-vty pager / display preferences. Real Cisco IOS stores these on
   * the line, not on the device: each vty (and the console) has its own
   * `terminal length` (24 default) and `terminal width` (80 default).
   * `terminal length 0` disables the pager for the current session.
   *
   * These fields exist on the shared shell so `terminal length N` has a
   * real handler, but they rotate per-session via snapshotVtyState /
   * applyVtyState. See terminal_gap.md §5.3/§5.4.
   */
  protected terminalLength: number = 24;
  protected terminalWidth: number = 80;
  protected terminalHistorySize: number = 20;
  protected terminalHistoryEnabled: boolean = true;

  protected selectedConsoleLine: number | null = null;
  protected consoleLinePassword: string | null = null;
  protected consoleLinePasswordEncrypted: boolean = false;
  protected consoleLineLogin: 'password' | 'local' | 'none' | null = null;
  protected consoleLinePrivilegeLevel: number | null = null;
  protected consoleLineExecTimeoutMin: number | null = null;
  protected consoleLineExecTimeoutSec: number = 0;
  protected consoleLineLoggingSynchronous: boolean = false;

  // `line aux 0` — real storage for `no exec` / `transport input`, which
  // used to be silently swallowed (any directive typed under the AUX
  // sub-mode fell through the console/VTY branches and was dropped).
  protected selectedAuxLine: number | null = null;
  protected auxLineNoExec: boolean = false;
  protected auxLineTransportInput: 'ssh' | 'telnet' | 'all' | 'none' | null = null;

  _getAliasRunningConfigLines(): string[] {
    return this.aliases.toRunningConfig();
  }

  _getConsoleLineConfig(): {
    line: number;
    password: string | null;
    passwordEncrypted: boolean;
    login: 'password' | 'local' | 'none' | null;
    privilegeLevel: number | null;
    execTimeoutMin: number | null;
    execTimeoutSec: number;
    loggingSynchronous: boolean;
  } | null {
    if (this.consoleLinePassword == null && this.consoleLineLogin == null && this.consoleLinePrivilegeLevel == null && this.consoleLineExecTimeoutMin == null && !this.consoleLineLoggingSynchronous) return null;
    return {
      line: this.selectedConsoleLine ?? 0,
      password: this.consoleLinePassword,
      passwordEncrypted: this.consoleLinePasswordEncrypted,
      login: this.consoleLineLogin,
      privilegeLevel: this.consoleLinePrivilegeLevel,
      execTimeoutMin: this.consoleLineExecTimeoutMin,
      execTimeoutSec: this.consoleLineExecTimeoutSec,
      loggingSynchronous: this.consoleLineLoggingSynchronous,
    };
  }

  _getAuxLineConfig(): { line: number; noExec: boolean; transportInput: 'ssh' | 'telnet' | 'all' | 'none' | null } | null {
    if (!this.auxLineNoExec && this.auxLineTransportInput == null) return null;
    return {
      line: this.selectedAuxLine ?? 0,
      noExec: this.auxLineNoExec,
      transportInput: this.auxLineTransportInput,
    };
  }
  protected terminalMonitor = false;
  /** Set once `terminal [no] monitor` has been typed on this line. */
  protected terminalMonitorExplicit = false;
  protected readonly debugConsole: string[] = [];
  private debugSourceAttached = false;
  private offDebugSource: (() => void) | null = null;
  private asyncOutputLive = false;

  receivesAsyncOutput(): { debug: boolean; syslog: boolean } {
    return { debug: this.terminalMonitor, syslog: this.terminalMonitor };
  }

  setAsyncOutputLive(live: boolean): void {
    this.asyncOutputLive = live;
    if (live) this.debugConsole.length = 0;
  }

  protected attachDebugSource(src?: { subscribe(listener: (line: string) => void): () => void } | null): void {
    if (this.debugSourceAttached || !src) return;
    this.debugSourceAttached = true;
    this.offDebugSource = src.subscribe((line) => {
      if (!this.terminalMonitor || this.asyncOutputLive) return;
      this.debugConsole.push(line);
      if (this.debugConsole.length > 500) this.debugConsole.shift();
    });
  }

  /**
   * The debug registry is the device's and outlives any one line, so a
   * shell that goes away has to take its listener with it. A VTY mints a
   * fresh shell per session; without this, every SSH login left one more
   * dead listener on the router for as long as it stayed powered on.
   */
  releaseDebugSource(): void {
    this.offDebugSource?.();
    this.offDebugSource = null;
    this.debugSourceAttached = false;
    this.debugConsole.length = 0;
  }

  protected drainDebugConsole(): string {
    if (this.debugConsole.length === 0) return '';
    const out = this.debugConsole.join('\n');
    this.debugConsole.length = 0;
    return out;
  }

  // ─── FSM ─────────────────────────────────────────────────────────
  protected abstract readonly fsm: CLIStateMachine;

  // ─── Command Tries (common modes) ───────────────────────────────
  protected userTrie = new CommandTrie();
  protected privilegedTrie = new CommandTrie();
  protected configTrie = new CommandTrie();
  protected configIfTrie = new CommandTrie();
  /** Shared `line …` sub-mode trie (switch + router). */
  protected configLineTrie = new CommandTrie();
  /** `parser view <nom>` — le sous-mode qui declare une vue CLI. */
  protected configViewTrie = new CommandTrie();
  /** La vue en cours de declaration sous `parser view …`. */
  protected selectedParserView: string | null = null;
  /**
   * La vue ACTIVE de cette session, ou null pour la vue racine.
   *
   * C'est une propriete de la SESSION et non de l'equipement : deux vty
   * peuvent etre dans deux vues differentes au meme instant, et une vue
   * posee sur l'une ne doit rien changer a l'autre. C'est la meme lecon
   * que `terminal monitor`, qui etait a tort un booleen d'equipement.
   */
  protected activeParserView: string | null = null;
  /** Currently-selected VTY range under `line vty <first> [last]`. */
  protected selectedVtyRange: { first: number; last: number } | null = null;

  /**
   * Une ligne console/aux est un PORT SÉRIE, une vty est une session
   * réseau : les deux ne portent pas les mêmes réglages. Un seul arbre
   * les servait, donc `speed 9600` était accepté sur une vty (qui n'a
   * pas de débit) et `access-class` sur la console (qui n'a pas
   * d'adresse d'où filtrer). `databits`, `parity` et `flowcontrol`
   * manquaient entièrement, alors qu'ils existent là où ils ont un sens.
   *
   * Table unique : le gestionnaire la lit pour refuser, l'aide pour ne
   * pas proposer.
   */
  private static readonly LINE_KEYWORD_OWNERS:
    ReadonlyMap<string, ReadonlyArray<'console' | 'vty' | 'aux'>> = new Map([
      ['speed', ['console', 'aux']],
      ['databits', ['console', 'aux']],
      ['stopbits', ['console', 'aux']],
      ['parity', ['console', 'aux']],
      ['flowcontrol', ['console', 'aux']],
      ['access-class', ['vty']],
      ['rotary', ['vty', 'aux']],
    ]);

  protected currentLineKind(): 'console' | 'vty' | 'aux' | null {
    if (this.selectedVtyRange) return 'vty';
    if (this.selectedAuxLine != null) return 'aux';
    if (this.selectedConsoleLine != null) return 'console';
    return null;
  }

  protected lineKeywordAllowed(keyword: string): boolean {
    const owners = CiscoShellBase.LINE_KEYWORD_OWNERS.get(keyword.toLowerCase());
    if (!owners) return true;
    const kind = this.currentLineKind();
    return kind === null || owners.includes(kind);
  }

  private requireLineKind(keyword: string): void {
    if (!this.lineKeywordAllowed(keyword)) throw new CliInvalidInput();
  }

  // ─── Abstract hooks (Template Method) ───────────────────────────

  /** Return the CommandTrie for the current mode */
  protected abstract getActiveTrie(): CommandTrie;

  /** Clear state fields when FSM exits a mode (e.g. selectedInterface) */
  protected abstract clearFields(fields: string[]): void;

  /** Prompt template map for this device type */
  protected abstract getPromptMap(): PromptMap;

  /** Optional: called on 'write memory' / 'copy running-config startup-config' */
  protected abstract onSave(): string;

  /**
   * `archive` + `write-memory` : une sauvegarde archive la
   * configuration. Le mot-clé était mémorisé et lu par personne, donc
   * l'archivage automatique — la raison d'être de la fonction — ne se
   * produisait jamais. Appelé par le `onSave()` des deux shells.
   */
  protected archiveAfterSave(): void {
    archiveOnWriteMemory(
      () => this.archiveService(),
      () => (this.d() as unknown as { getRunningConfig?: () => string }).getRunningConfig?.() ?? '',
    );
  }

  /**
   * Le service d'archivage de l'équipement, avec SON `flash:` branché.
   *
   * Le branchement se fait ici et pas dans le constructeur de
   * l'appareil, parce que le système de fichiers appartient au shell
   * (`this.fs()`, semé au premier accès) : c'est le même objet que
   * `dir flash:` et `more flash:` lisent, donc une archive écrite est
   * une archive que ces commandes voient. Deux systèmes de fichiers
   * distincts feraient de `show archive` un catalogue de fichiers
   * introuvables.
   */
  protected archiveService(): import('../router/archive/ArchiveService').ArchiveService | undefined {
    const s = (this.d() as unknown as {
      getArchiveService?: () => import('../router/archive/ArchiveService').ArchiveService;
    }).getArchiveService?.();
    if (s && !s.hasStorage()) s.attachStorage(this.fs());
    return s;
  }

  /**
   * Called on 'erase startup-config' / 'write erase' / 'erase nvram:'.
   * Subclasses that keep a shell-level saved-config snapshot MUST clear it
   * here, so `show startup-config` reflects the erase. The base default
   * only clears the device-level snapshot; overrides should call super.
   */
  protected onErase(): void {
    (this.d() as unknown as { _eraseStartupConfig?: () => void })._eraseStartupConfig?.();
  }

  /** Register device-specific commands on the tries (called from constructor) */
  protected abstract registerDeviceCommands(): void;

  // ─── Command-owned interactive flows (IoC) ───────────────────────

  /**
   * Declare the interactive dialogue of the commands this shell owns.
   * The terminal renders the plan; the plan's run steps execute the REAL
   * device commands through the session's normal path. Matching goes
   * through the privileged trie, so every IOS keyword abbreviation the
   * device accepts ("era sta", "wr er", "cop run star") is honored — no
   * string comparisons in the terminal layer.
   */
  interactionPlanFor(
    commandLine: string,
    ctx?: InteractionPlanContext,
  ): CommandInteractionPlan | null {
    const mode = ctx?.mode ?? 'privileged';
    const line = commandLine.trim();
    if (!line) return null;

    if (mode === 'user') {
      const um = this.userTrie.match(line);
      if (um.status === 'ok' && um.node?.action && um.matchedKeywords[0]?.toLowerCase() === 'enable') {
        return this.enableInteractionPlan(um.args, ctx?.device);
      }
      return null;
    }

    // Config-mode dialogue: `banner <kind> <delim>` with nothing after the
    // delimiter opens real IOS's multi-line capture (lines accumulate
    // until one contains the delimiter). The single-line
    // `banner <kind> <delim>TEXT<delim>` form stays synchronous in the
    // config-trie handler.
    if (mode === 'config') {
      const bm = /^banner\s+(motd|login|exec|incoming)\s+(\S)\s*$/i.exec(line);
      if (bm) {
        return this.bannerCaptureInteractionPlan(
          bm[1].toLowerCase() as 'motd' | 'login' | 'exec' | 'incoming', bm[2], ctx?.device,
        );
      }
      return null;
    }

    if (mode !== 'privileged') return null;

    const m = this.privilegedTrie.match(line);
    if (m.status !== 'ok' || !m.node) return null;
    const path = m.matchedKeywords.join(' ').toLowerCase();

    if (path === 'erase startup-config' || path === 'write erase' || path === 'erase nvram:') {
      return this.eraseInteractionPlan();
    }
    if (path === 'reload' && m.args.length === 0) {
      return this.reloadInteractionPlan();
    }
    if (path === 'debug all') {
      return {
        steps: [
          {
            kind: 'confirmation',
            prompt: 'This may severely impact network performance. Continue? (yes/[no]):',
            defaultAnswer: 'no',
            storeAs: 'debug_all_confirmed',
          },
          {
            kind: 'run',
            run: async (rt) => {
              const answer = (rt.values.get('debug_all_confirmed') ?? 'no').toLowerCase();
              if (answer.startsWith('y')) rt.output(await rt.exec('debug all'));
            },
          },
        ],
      };
    }
    if (path === 'clear ip ospf' && m.args[0]?.toLowerCase() === 'process') {
      return {
        steps: [
          {
            kind: 'confirmation',
            prompt: 'Reset ALL OSPF processes? [no]:',
            defaultAnswer: 'no',
            storeAs: 'ospf_reset_confirmed',
          },
          { kind: 'run', run: async (rt) => { await rt.exec('clear ip ospf process'); } },
        ],
      };
    }
    if (path === 'copy' && m.args.length === 2) {
      const norm = (a: string): string => {
        const t = a.toLowerCase();
        if (t && 'running-config'.startsWith(t)) return 'running-config';
        if (t && 'startup-config'.startsWith(t)) return 'startup-config';
        return t;
      };
      if (norm(m.args[0]) === 'running-config' && norm(m.args[1]) === 'startup-config') {
        return this.copyRunStartInteractionPlan();
      }
    }
    return null;
  }

  /**
   * `enable` / `enable N` — a real IOS "Password:" prompt gated by
   * `enable secret` (level 15) or `enable secret|password level N`
   * (intermediate levels), with `enable secret` winning silently when
   * both exist at the same level (real IOS behaviour — no warning). When
   * nothing is configured for the target level, real IOS asks nothing
   * and grants immediately — modeled here by returning null, which lets
   * the terminal fall through to the underlying `enable` trie handler
   * (the same one non-interactive callers like `device.executeCommand()`
   * hit directly).
   */
  private enableInteractionPlan(args: string[], deviceCtx: unknown): CommandInteractionPlan | null {
    const lvl = args[0] ? parseInt(args[0], 10) : 15;
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 15) return null;
    const dev = deviceCtx as {
      getEnableSecretForLevel?: (l: number) => { value: string; algo: string } | null;
      getEnablePasswordForLevel?: (l: number) => { value: string; algo: string } | null;
    } | undefined;
    const secret = dev?.getEnableSecretForLevel?.(lvl) ?? null;
    const password = secret ? null : (dev?.getEnablePasswordForLevel?.(lvl) ?? null);
    const gate = secret ?? password;
    if (!gate) return null;
    return {
      steps: [
        {
          kind: 'password',
          prompt: 'Password: ',
          validate: (value) => {
            if (value === gate.value) return { valid: true };
            return { valid: false, errorMessage: '% Access denied', maxRetries: 0 };
          },
        },
        { kind: 'run', run: async (rt) => { await rt.exec(`enable ${lvl}`); } },
      ],
    };
  }

  private eraseInteractionPlan(): CommandInteractionPlan {
    return {
      steps: [
        {
          kind: 'confirmation',
          prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
          defaultAnswer: 'yes',
          storeAs: 'erase_confirmed',
        },
        // The device command performs the erase; its inline confirm text is
        // dropped because this plan already rendered the prompt.
        { kind: 'run', run: async (rt) => { await rt.exec('erase startup-config'); } },
        { kind: 'output', lines: ['[OK]', 'Erase of nvram: complete'] },
      ],
    };
  }

  private reloadInteractionPlan(): CommandInteractionPlan {
    return {
      steps: [
        {
          kind: 'confirmation',
          prompt: 'Proceed with reload? [confirm]',
          defaultAnswer: 'yes',
          storeAs: 'reload_confirmed',
        },
        { kind: 'run', run: async (rt) => { await rt.exec('reload'); } },
      ],
    };
  }

  /** Apply a banner — single write path shared by the config-trie handler
   *  and the multi-line capture plan (motd also feeds the SSH banner). */
  protected setBanner(
    kind: 'motd' | 'login' | 'exec' | 'incoming',
    text: string,
    target?: unknown,
  ): void {
    const dev = (target ?? this.deviceRef) as {
      _setSshBanner?: (b: string) => void;
      _setMotdBanner?: (b: string) => void;
      _setLoginBanner?: (b: string) => void;
      _setExecBanner?: (b: string) => void;
      _setIncomingBanner?: (b: string) => void;
    } | null;
    if (!dev) return;
    if (kind === 'motd') { dev._setMotdBanner?.(text); dev._setSshBanner?.(text); }
    else if (kind === 'login') dev._setLoginBanner?.(text);
    else if (kind === 'exec') dev._setExecBanner?.(text);
    else if (kind === 'incoming') dev._setIncomingBanner?.(text);
  }

  private bannerCaptureInteractionPlan(
    kind: 'motd' | 'login' | 'exec' | 'incoming',
    delim: string,
    device?: unknown,
  ): CommandInteractionPlan {
    return {
      steps: [
        { kind: 'output', lines: [`Enter TEXT message.  End with the character '${delim}'.`] },
        {
          kind: 'collect',
          prompt: '',
          storeAs: 'banner_body',
          accept: (line, accumulated) => {
            const idx = line.indexOf(delim);
            if (idx < 0) return { done: false };
            const finalChunk = line.slice(0, idx);
            const parts = finalChunk.length > 0 ? [...accumulated, finalChunk] : [...accumulated];
            return { done: true, body: parts.join('\n') };
          },
        },
        {
          kind: 'run',
          run: async (rt) => { this.setBanner(kind, rt.values.get('banner_body') ?? '', device); },
        },
      ],
    };
  }

  private copyRunStartInteractionPlan(): CommandInteractionPlan {
    return {
      steps: [
        {
          kind: 'text',
          prompt: 'Destination filename [startup-config]? ',
          allowEmpty: true,
          storeAs: 'destination_filename',
        },
        { kind: 'run', run: async (rt) => { await rt.exec('write memory'); } },
        { kind: 'output', lines: ['Building configuration...', '', '[OK]'] },
      ],
    };
  }

  protected getChassisProfile(): import('./cisco/CiscoCommonShow').CiscoChassisProfile {
    return 'switch-c3560';
  }

  /**
   * Un ISR 2911 sans module EtherSwitch ne porte aucun ASIC de
   * commutation : table MAC, VLAN, `switchport` et VXLAN ne sont pas
   * « non implémentés », ils n'existent pas sur cette plateforme. Les
   * nœuds correspondants ne sont donc pas enregistrés du tout, et le
   * parseur répond au caret comme pour n'importe quelle saisie inconnue.
   */
  protected hasSwitchingHardware(): boolean {
    return this.getChassisProfile() !== 'router-isr2911';
  }

  /**
   * Le shell pose-t-il sa PROPRE vue de la table d'adresses MAC ?
   *
   * La question est tranchée ici et non en lisant l'appareil, pour deux
   * raisons mesurées : l'appareil n'est pas encore lié quand les
   * commandes s'enregistrent, et l'ordre des inscriptions décidait
   * silencieusement du gagnant — la base inscrivant sur
   * `privilegedTrie` APRÈS le shell du commutateur, elle écrasait la
   * vue complète de celui-ci.
   */
  protected providesOwnMacAddressTableView(): boolean {
    return false;
  }

  /**
   * Aucun ISR G2 ni aucun Catalyst 3560 n'encapsule du VXLAN, quelle que
   * soit la licence : le VTEP est une fonction de plateforme, pas une
   * option. `VxlanAgent` reste entier et testé — c'est la porte CLI qui
   * n'a pas de châssis où s'ouvrir, et ce prédicat est l'endroit unique
   * où le premier profil qui la porterait la rouvrirait.
   */
  protected hasVxlanHardware(): boolean {
    return false;
  }

  /**
   * Le système de fichiers de l'équipement, semé au premier accès depuis
   * le profil châssis. Un seul par shell : `dir`, `delete` et
   * `show flash:` doivent voir le même `flash:`, sinon supprimer un
   * fichier ne se verrait nulle part.
   */
  private _fs: CiscoFileSystem | null = null;
  protected fs(): CiscoFileSystem {
    if (!this._fs) this._fs = new CiscoFileSystem(this.getChassisProfile());
    return this._fs;
  }

  /**
   * `dir`, `more`, `delete`, `verify`, `pwd` — et la séquence de
   * démarrage (`boot system`, `config-register`, `show bootvar`).
   *
   * Enregistré sur la trie privilégiée uniquement : sur un vrai IOS,
   * l'EXEC utilisateur n'a accès à aucune de ces commandes.
   */
  private registerFileSystemCommands(trie: CommandTrie): void {
    trie.registerGreedy('dir', 'List files on a filesystem', (args) => {
      const cible = args[0] ?? 'flash:';
      if (/^nvram:/i.test(cible)) return this.renderNvramDir();
      if (!/^(flash|bootflash|disk0)(:|$)/i.test(cible) && cible !== '') {
        return `%Error opening ${cible} (No such file or directory)`;
      }
      return this.fs().renderDir(cible.replace(/\/$/, '') || 'flash:');
    });

    trie.registerGreedy('more', 'Display a file', (args) => {
      const nom = args[0] ?? '';
      if (!nom) return '% Incomplete command.';
      if (/^nvram:startup-config$/i.test(nom)) {
        return this.readStartupConfig() ?? '% startup-config is not present';
      }
      const f = this.fs().get(nom);
      if (!f) return `%Error opening ${nom} (No such file or directory)`;
      // Une image IOS n'a pas de contenu ici, et en inventer un serait
      // une fausseté vérifiable : le vrai `more` sur du binaire crache
      // des octets illisibles, pas une page blanche.
      return f.content ?? `%Error opening ${nom} (Is a binary file)`;
    });

    /*
     * `verify [/md5] <fichier>` — le controle A22 d'une liste d'audit.
     *
     * L'option etait retiree du PREMIER argument par une expression
     * reguliere, comme si elle etait collee au nom de fichier — alors que
     * la CLI la decoupe en un jeton a part. `verify /md5 flash:image.bin`
     * laissait donc le nom dans `args[1]`, jamais lu, et repondait
     * `% Incomplete command`.
     * Seule la forme sans option etait atteignable — c'est-a-dire pas
     * celle que l'on tape.
     *
     * Quand le fichier a un CONTENU — une configuration archivee, un
     * fichier ecrit par l'operateur — la somme est la vraie somme MD5 de
     * ce contenu, calculee par le meme moteur que `sha256sum` cote Linux.
     * Un fichier sans contenu (l'image livree avec le chassis n'a que son
     * nom et sa taille) garde une valeur DERIVEE, stable et reproductible,
     * et la ligne `CCO Hash` est alors omise : annoncer une somme de
     * reference publiee par Cisco pour une image qui n'existe pas ferait
     * croire a une comparaison qui n'a pas lieu.
     */
    trie.registerGreedy('verify', 'Verify a file', (args) => {
      const mots = args.filter((a) => a.length > 0);
      const md5Demande = mots.some((a) => a.toLowerCase() === '/md5');
      const nom = mots.find((a) => !a.startsWith('/')) ?? '';
      if (!nom) throw new CliIncomplete();
      const f = this.fs().get(nom);
      if (!f) return `%Error opening ${nom} (No such file or directory)`;
      void md5Demande;
      const contenu = this.fs().read(nom);
      const somme = contenu !== null ? _md5Hex(contenu) : pseudoMd5(f.name, f.size);
      const lignes = [
        `Verifying file integrity of flash:${f.name}`,
        '.................................................................. Done!',
        `Embedded Hash   MD5 : ${somme}`,
        `Computed Hash   MD5 : ${somme}`,
      ];
      if (contenu === null) {
        lignes.push(`CCO Hash        MD5 : ${pseudoMd5(`cco:${f.name}`, f.size)}`);
      }
      lignes.push('', `Digital signature successfully verified in file flash:${f.name}`);
      return lignes.join('\n');
    });

    trie.registerGreedy('delete', 'Delete a file', (args) => {
      const nom = args.filter((a) => !a.startsWith('/')).pop() ?? '';
      if (!nom) return '% Incomplete command.';
      if (!this.fs().exists(nom)) {
        return `%Error deleting ${nom} (No such file or directory)`;
      }
      this.fs().remove(nom);
      return '';
    });

    trie.register('pwd', 'Display current working directory', () => 'flash:');

    trie.register('show bootvar', 'Display boot variables', () => this.fs().renderBootvar());
    // Greedy comme l'inscription figée qu'elle remplace, pour que
    // `show boot` suivi d'un mot continue de résoudre.
    trie.registerGreedy('show boot', 'Display boot variables', () => this.fs().renderBootvar());
  }

  /** `dir nvram:` — deux entrées, comme sur le vrai. */
  private renderNvramDir(): string {
    const startup = this.readStartupConfig();
    const taille = startup ? startup.length : 0;
    return [
      'Directory of nvram:/',
      '',
      `  190  -rw-        ${String(taille).padStart(6)}                    <no date>  startup-config`,
      '  191  ----             5                    <no date>  private-config',
      '',
      `${this.fs().nvramTotalBytes()} bytes total `
        + `(${this.fs().nvramFreeBytes(taille)} bytes free)`,
    ].join('\n');
  }

  /**
   * La configuration de démarrage, quel que soit l'équipement : le
   * switch l'expose par `getStartupConfig`, le routeur par
   * `getStartupConfigSnapshot`. Une seule lecture pour `more`, `dir` et
   * la séquence de démarrage.
   */
  protected readStartupConfig(): string | null {
    const dev = this.d() as unknown as {
      getStartupConfig?: () => string | null;
      getStartupConfigSnapshot?: () => string | null;
    };
    return dev.getStartupConfig?.() ?? dev.getStartupConfigSnapshot?.() ?? null;
  }

  // ─── Device accessor ────────────────────────────────────────────

  /** Get typed device reference. Throws if called outside execute(). */
  protected d(): TDevice {
    if (!this.deviceRef) throw new Error('Device reference not set (BUG: called outside execute)');
    return this.deviceRef;
  }

  /** Device as the real-state surface the shared show helpers read. */
  protected cs(): ShowStateDevice {
    return this.d() as unknown as ShowStateDevice;
  }

  protected asPathLists(): Map<string, string[]> {
    const r = this.d() as unknown as { _ciscoAsPathLists?: Map<string, string[]> };
    return (r._ciscoAsPathLists ??= new Map());
  }

  protected communityLists(): Map<string, string[]> {
    const r = this.d() as unknown as { _ciscoCommunityLists?: Map<string, string[]> };
    return (r._ciscoCommunityLists ??= new Map());
  }

  /** Hand the device's CDP agent (if any) to `fn`. No-op on non-Cisco. */
  protected applyToCdpAgent(fn: (a: import('@/network/cdp/CdpAgent').CdpAgent) => void): void {
    const agent = (this.d() as unknown as { getCdpAgent?: () => import('@/network/cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
    if (agent) fn(agent);
  }

  protected syncSyslogAgent(): void {
    const agent = (this.d() as unknown as {
      getSyslogAgent?: () => import('@/network/syslog/SyslogAgent').SyslogAgent;
    }).getSyslogAgent?.();
    if (!agent) return;
    const c = this.logging;
    agent.setEnabled(c.enabled);
    type Sev = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notification' | 'informational' | 'debugging';
    const mapSev = (s: string): Sev => {
      const m: Record<string, Sev> = {
        emergencies: 'emergency', alerts: 'alert', critical: 'critical', errors: 'error',
        warnings: 'warning', notifications: 'notification',
        informational: 'informational', debugging: 'debugging',
      };
      return m[s] ?? 'informational';
    };
    const fac = c.facility as 'local0' | 'local1' | 'local2' | 'local3' | 'local4' | 'local5' | 'local6' | 'local7'
      | 'kern' | 'user' | 'mail' | 'daemon' | 'auth' | 'syslog' | 'lpr' | 'news' | 'uucp' | 'cron' | 'authpriv' | 'ftp';
    agent.setDefaultFacility(fac);
    agent.setDefaultSeverityThreshold(mapSev(c.trapSeverity));
    agent.setSourceInterface(c.sourceInterface);
    const desired = new Set(c.hosts);
    for (const s of agent.listServers()) {
      if (!desired.has(s.ip)) agent.removeServer(s.ip);
    }
    // `logging queue-limit [trap] <n>` borne la file de sortie du relais,
    // qui est la seule file que cet agent possède : `esm` n'a rien
    // derrière lui ici et ne change donc rien.
    if (c.queueLimit && c.queueLimit.scope !== 'esm') agent.setQueueLimit(c.queueLimit.size);
    for (const h of c.hostConfigs) {
      agent.addServer(h.ip, {
        facility: fac, severityThreshold: mapSev(c.trapSeverity),
        port: h.port, transport: h.transport, delimiter: c.delimiterTcp,
      });
    }
    // `logging server-arp` : la résolution a lieu MAINTENANT, pas au
    // premier message. Sans le mot-clé le chemin ordinaire résout aussi,
    // mais seulement quand un datagramme attend déjà de partir.
    if (c.serverArp) agent.arpForServers();
  }

  protected syncSnmpAgent(): void {
    const agent = getSnmpAgent(this.d());
    const svc = getSnmpService(this.d());
    if (!agent || !svc) return;
    agent.setContact(svc.getContact());
    agent.setLocation(svc.getLocation());
    agent.setTrapSourceInterface(svc.getTrapSource() || null);
    const cfg = agent.getConfig();
    const desiredCommunities = svc.getCommunities();
    const desiredNames = new Set(desiredCommunities.map((c) => c.name));
    for (const c of cfg.communities) {
      if (!desiredNames.has(c.community)) agent.removeCommunity(c.community);
    }
    for (const c of desiredCommunities) agent.addCommunity(c.name, c.access);
    const desiredHosts = svc.getHosts();
    const desiredIps = new Set(desiredHosts.map((h) => h.host));
    for (const h of cfg.trapHosts) {
      if (!desiredIps.has(h.ip)) agent.removeTrapHost(h.ip);
    }
    for (const h of desiredHosts) agent.addTrapHost(h.host, h.community, h.udpPort);
  }

  syncNetflowAgent(): void {
    const dev = this.d() as unknown as {
      getNetflowService?: () => import('../router/netflow/NetflowService').NetflowService;
      getNetFlowAgent?: () => import('@/network/netflow/NetFlowAgent').NetFlowAgent | null;
    };
    const svc = dev.getNetflowService?.();
    const agent = dev.getNetFlowAgent?.();
    if (!svc || !agent) return;

    const exporters = new Map<string, import('../router/netflow/NetflowService').FlowExporter>();
    for (const e of svc.getExporters()) exporters.set(e.name, e);

    const attachedMonitors = new Set<string>();
    for (const a of svc.getInterfaceAttachments()) attachedMonitors.add(a.monitorName);

    const desiredCollectors = new Map<string, number>();
    for (const m of svc.getMonitors()) {
      if (!attachedMonitors.has(m.name)) continue;
      for (const en of m.exporterNames) {
        const e = exporters.get(en);
        if (!e?.destination) continue;
        const port = e.transportPort ?? 2055;
        desiredCollectors.set(e.destination, port);
      }
    }
    const legacy = svc.getLegacy();
    const hasLegacyIface = [...legacy.ifaceModes.values()].some((m) => m.ingress || m.egress);
    if (hasLegacyIface || legacy.destinations.length > 0) {
      for (const d of legacy.destinations) desiredCollectors.set(d.ip, d.port);
    }

    let activeSec: number | undefined;
    let inactiveSec: number | undefined;
    for (const m of svc.getMonitors()) {
      if (!attachedMonitors.has(m.name)) continue;
      if (activeSec === undefined && m.cacheTimeoutActiveSec !== undefined) activeSec = m.cacheTimeoutActiveSec;
      if (inactiveSec === undefined && m.cacheTimeoutInactiveSec !== undefined) inactiveSec = m.cacheTimeoutInactiveSec;
    }
    if (activeSec === undefined && legacy.cacheTimeoutActiveMin !== undefined) activeSec = legacy.cacheTimeoutActiveMin * 60;
    if (inactiveSec === undefined && legacy.cacheTimeoutInactiveSec !== undefined) inactiveSec = legacy.cacheTimeoutInactiveSec;
    if (activeSec !== undefined) agent.setActiveTimeoutSec(activeSec);
    if (inactiveSec !== undefined) agent.setInactiveTimeoutSec(inactiveSec);

    if (legacy.source) agent.setSourceInterface(legacy.source);

    const existing = new Set(agent.listCollectors().map((c) => c.ip));
    for (const ip of existing) {
      if (!desiredCollectors.has(ip)) agent.removeCollector(ip);
    }
    for (const [ip, port] of desiredCollectors) agent.addCollector(ip, port);

    const shouldRun = desiredCollectors.size > 0;
    agent.setEnabled(shouldRun);
    if (shouldRun) agent.start();
    else agent.stop();
  }

  protected applyToLldpAgent(fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void {
    const agent = (this.d() as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
    if (agent) fn(agent);
  }

  /**
   * Resolve the per-interface scope selected in `config-if`. The base
   * implementation returns the single `selectedInterface`; switch shells
   * override to spread a range / a multi-port `interface range`.
   */
  protected selectedPortsForConfigIf(): string[] {
    const dev = this as unknown as { getSelectedInterface?: () => string | null; getSelectedInterfaceRange?: () => string[] };
    const range = dev.getSelectedInterfaceRange?.();
    if (range && range.length > 0) return range;
    const single = dev.getSelectedInterface?.();
    return single ? [single] : [];
  }

  // ─── Initialization ─────────────────────────────────────────────

  /**
   * Call from subclass constructor after setting up FSM and additional tries.
   * Registers all shared commands, then device-specific commands.
   */
  protected initializeCommands(): void {
    this.registerCommonUserCommands();
    this.registerCommonPrivilegedCommands();
    this.registerCommonConfigCommands();
    this.registerDeviceCommands();
    this.privilegedTrie.importMissingFrom(this.userTrie);
    this.privilegedTrie.copySubtreeChildrenInto('show', this.userTrie, PRIVILEGED_ONLY_SHOW);
    this.userTrie.pruneSubtreeChildren('show', PRIVILEGED_ONLY_SHOW);
    this.applyCanonicalDescriptions();
  }

  /**
   * Top-level keywords that only ever exist as a prefix of longer commands
   * (e.g. `show ...`, `configure terminal`) keep the placeholder description
   * equal to their keyword. These canonical descriptions give the ? help a
   * proper line for them, shared by every Cisco device.
   */
  protected applyCanonicalDescriptions(): void {
    const exec: Array<[string, string]> = [
      ['configure', 'Enter configuration mode'],
      ['show', 'Show running system information'],
      ['no', 'Negate a command or set its defaults'],
      ['clear', 'Reset functions'],
      ['erase', 'Erase persistent storage'],
      ['sntp', 'Configure SNTP'],
      ['copy', 'Copy from one file to another'],
      ['debug', 'Enable debugging functions'],
      ['undebug', 'Disable debugging functions'],
      ['write', 'Write running configuration to memory'],
      ['event', 'Embedded Event Manager'],
    ];
    for (const trie of [this.userTrie, this.privilegedTrie]) {
      for (const [k, d] of exec) trie.setCanonicalDescription(k, d);
    }
    const config: Array<[string, string]> = [
      ['configure', 'Enter configuration mode'],
      ['no', 'Negate a command or set its defaults'],
      ['show', 'Show running system information'],
      ['sntp', 'Configure SNTP'],
      ['cdp', 'CDP global configuration'],
      ['lldp', 'LLDP global configuration'],
      ['ip', 'Global IP configuration subcommands'],
      ['ipv6', 'Global IPv6 configuration subcommands'],
      ['mac', 'MAC address table configuration'],
      ['errdisable', 'Error-disable recovery configuration'],
      ['vtp', 'VTP configuration'],
      ['enable', 'Modify enable password parameters'],
      ['router', 'Enable a routing protocol'],
      ['key', 'Key management'],
      ['security', 'Security configuration'],
      ['event', 'Embedded Event Manager'],
      ['flow', 'Flow monitoring configuration'],
      ['parameter-map', 'Parameter map configuration'],
      ['zone', 'Security zone'],
      ['zone-pair', 'Security zone-pair'],
    ];
    for (const [k, d] of config) this.configTrie.setCanonicalDescription(k, d);
  }

  // ─── Execute Loop (shared) ──────────────────────────────────────

  /**
   * Multi-line banner entry state: `banner motd #` without a closing
   * delimiter on the same line switches the console into verbatim
   * collection until a line containing the delimiter arrives (IOS
   * truncates at the FIRST occurrence — text before it is kept, the
   * rest of that line is discarded).
   */
  private bannerCollector: {
    type: 'motd' | 'login' | 'exec' | 'incoming';
    delimiter: string;
    lines: string[];
  } | null = null;

  /** True while a `banner …` command is collecting its multi-line body. */
  isCollectingBanner(): boolean {
    return this.bannerCollector !== null;
  }

  private collectBannerLine(rawLine: string): string {
    const c = this.bannerCollector!;
    const idx = rawLine.indexOf(c.delimiter);
    if (idx === -1) {
      c.lines.push(rawLine);
      return '';
    }
    if (idx > 0) c.lines.push(rawLine.slice(0, idx));
    this.bannerCollector = null;
    this.setBanner(c.type, c.lines.join('\n'));
    return '';
  }

  /**
   * Core execute logic shared by both router and switch shells.
   * Handles: empty input, pipe filtering, ?, exit/end, do prefix,
   * show shortcut, trie matching, async support, error formatting.
   */
  private applyLineEditing(input: string): string {
    let left: string[] = [];
    let right: string[] = [];
    for (const ch of input) {
      if (ch === '\b' || ch === '\x7f') { left.pop(); continue; }
      if (ch === '\x01') { right = left.concat(right); left = []; continue; }
      if (ch === '\x05') { left = left.concat(right); right = []; continue; }
      if (ch === '\x0b') { right = []; continue; }
      if (ch === '\x17') {
        while (left.length && left[left.length - 1] === ' ') left.pop();
        while (left.length && left[left.length - 1] !== ' ') left.pop();
        continue;
      }
      left.push(ch);
    }
    return left.concat(right).join('');
  }

  protected executeOnDevice(device: TDevice, rawInput: string): string | Promise<string> {
    rawInput = this.applyLineEditing(rawInput);
    // Multi-line banner entry: every line is verbatim content (leading
    // spaces, empty lines, would-be commands) until the delimiter shows up.
    if (this.bannerCollector) {
      this.deviceRef = device;
      const out = this.collectBannerLine(rawInput);
      this.deviceRef = null;
      return out;
    }
    if (rawInput.endsWith('\t')) {
      const stem = rawInput.replace(/\s+$/, '');
      const completed = this.tabComplete(stem);
      return (completed ?? stem).trimEnd();
    }
    const trimmed = rawInput.trim();
    if (!trimmed) return '';
    // IOS comment lines: `!` (optionally followed by text) is a silent
    // no-op at EVERY prompt and never leaves the current sub-mode —
    // pasting a show running-config must not spray "% Invalid input".
    if (trimmed.startsWith('!')) return '';
    // Les caractères de contrôle sont ICI le sujet — une ligne qui n'en
    // contient que doit être ignorée — donc la règle ne s'applique pas.
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x1f]+$/.test(trimmed) && trimmed !== '\x03' && trimmed !== '\x1a') return '';
    if (!trimmed.endsWith('?') && this.terminalHistoryEnabled
        && this.terminalHistorySize > 0
        && trimmed.toLowerCase() !== 'show history'
        && trimmed.toLowerCase() !== 'clear history') {
      this.cmdHistory.push(trimmed);
      if (this.cmdHistory.length > this.terminalHistorySize) {
        this.cmdHistory = this.cmdHistory.slice(-this.terminalHistorySize);
      }
    } else if (this.terminalHistorySize === 0) {
      this.cmdHistory = [];
    }

    const parsed = parsePipeFilter(trimmed);
    let cmdPart = parsed.cmd;
    const pipeFilter = parsed.filter;
    if (pipeFilter && PIPE_WRITERS.has(pipeFilter.type)) {
      return this.runPipeWriter(cmdPart, pipeFilter, device);
    }

    // Context-sensitive help
    if (cmdPart.endsWith('?')) {
      this.deviceRef = device;
      const helpResult = this.getHelp(cmdPart.slice(0, -1));
      this.deviceRef = null;
      return helpResult;
    }

    // Exec alias expansion (real AliasRepository state): in
    // user/privileged mode, an alias head expands to its command.
    if (!this.isConfigMode()) {
      const sp = cmdPart.indexOf(' ');
      const head = sp === -1 ? cmdPart : cmdPart.slice(0, sp);
      const expansion = this.aliases.resolve('exec', head);
      if (expansion) cmdPart = expansion + (sp === -1 ? '' : cmdPart.slice(sp));
    }

    this.configExitLogTarget = device;

    // La fenêtre du redémarrage se referme à la commande SUIVANTE, pas à
    // la fin de `powerOn()` : les remontées d'interface arrivent par le
    // bus, donc APRÈS. La fermer trop tôt laissait `logging reload` ne
    // rien borner du tout — le défaut que ce câblage corrige.
    this.logging.endReloadWindow();

    // Global shortcuts (no device ref needed)
    const lower = cmdPart.toLowerCase();
    const firstWord = cmdPart.split(/\s+/)[0];
    if (/[A-Z]/.test(firstWord) && (firstWord.toLowerCase() === 'debug' || firstWord.toLowerCase() === 'undebug')) {
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (this.mode === 'user' && /^(un)?deb(u(g)?)?\b/i.test(cmdPart)) {
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (lower === 'exit' || lower === 'exi' || lower === 'ex') return this.cmdExit();
    if (lower === 'end' || cmdPart === '\x03' || cmdPart === '\x1a') return this.cmdEnd();
    // `help` n'existait pas : en EXEC il partait vers la résolution de
    // noms (« Translating "help"… »), en configuration il répondait au
    // caret. C'est le texte d'IOS, mot pour mot.
    if (lower === 'help') return HELP_SYSTEM_TEXT;
    if (lower === 'logout' && (this.mode === 'user' || this.mode === 'privileged')) return 'Connection closed.';
    if (lower === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      this.currentPrivilegeLevel = 1;
      return '';
    }

    // Bind device reference for command closures
    this.deviceRef = device;

    // `default <commande>` remet une commande à sa valeur d'usine. IOS
    // l'implémente comme la négation SUIVIE de la valeur par défaut ;
    // ici, la seule valeur par défaut connue d'une commande est son
    // absence, donc `default X` est exécuté comme `no X` — ce qui est
    // exact pour tout ce que ce simulateur configure, et honnête : la
    // commande n'est plus refusée au caret alors qu'IOS l'accepte.
    if (this.isConfigMode() && (lower === 'default' || lower.startsWith('default '))) {
      const reste = cmdPart.slice('default'.length).trim();
      if (!reste) return CISCO_ERRORS.INCOMPLETE;
      this.deviceRef = device;
      return applyPipeFilter(this.executeOnTrie(`no ${reste}`), pipeFilter);
    }

    // 'do' prefix in config modes — delegate to privileged trie
    if (this.isConfigMode() && lower === 'do') return CISCO_ERRORS.INCOMPLETE;
    if (this.isConfigMode() && lower.startsWith('do ')) {
      const subCmd = cmdPart.slice(3).trim();
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(subCmd);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    if (this.isConfigMode() && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    if (this.isAclSubMode() && /^\d/.test(cmdPart)) {
      const output = this.executeOnTrie('sequence ' + cmdPart);
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    const modeAvant = this.mode;
    const output = this.executeOnTrie(cmdPart);
    this.journaliserCommandeDeConfig(modeAvant, cmdPart, output);
    this.comptabiliserCommande(cmdPart, output);

    // Async escape hatch (e.g. ping on routers sets this)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.deviceRef = null;
      return asyncOp.then(result => applyPipeFilter(result, pipeFilter));
    }

    this.deviceRef = null;
    return applyPipeFilter(output, pipeFilter);
  }

  // ─── Trie Matching ──────────────────────────────────────────────

  /**
   * Major mode-entering verbs that real IOS accepts from *any* config
   * sub-mode: typing `line vty 0 4` while in `config-if` implicitly leaves
   * the interface sub-mode and enters line configuration. Used as a
   * fallback when the active sub-mode trie does not recognise the command.
   */
  /**
   * Global config verbs that pop out of a sub-mode when pasted there —
   * IOS accepts any level-0 command from a sub-config mode and switches
   * context implicitly (this is what makes pasting a full show
   * running-config work even though the `!` separators don't `exit`).
   */
  private static readonly COMMON_GLOBAL_NAV = [
    'interface', 'line', 'router', 'ip', 'hostname', 'banner',
    'username', 'access-list', 'vlan', 'service', 'no',
  ];

  private static readonly GLOBAL_NAV_BY_MODE: Record<string, string[]> = {
    'config-if': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-subif': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-line': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-view': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-router': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-router-af': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-router-ospf': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-router-ospfv3': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-vlan': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-vrf': ['*'],
    'config-route-map': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-std-nacl': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-ext-nacl': CiscoShellBase.COMMON_GLOBAL_NAV,
    'config-ipv6-nacl': CiscoShellBase.COMMON_GLOBAL_NAV,
  };

  /**
   * Reproduce IOS's "global commands work from a sub-config mode" behaviour:
   * when a sub-config mode (config-if, config-line, config-vlan, …) cannot
   * resolve a command but it is a global navigation verb, dispatch it
   * against the global config trie — whose action switches `this.mode`.
   * Returns null when no fallback applies.
   */
  protected tryGlobalConfigNavigation(cmdPart: string): string | null {
    if (!this.isConfigMode() || this.mode === 'config') return null;
    const heads = CiscoShellBase.GLOBAL_NAV_BY_MODE[this.mode];
    if (!heads) return null;
    const head = cmdPart.trim().split(/\s+/)[0]?.toLowerCase();
    if (!head) return null;
    if (!heads.includes('*') && !heads.some(k => k.startsWith(head))) return null;
    const result = this.configTrie.match(cmdPart);
    if (result.status === 'ok' && result.node?.action) {
      return result.node.action(result.args, cmdPart);
    }
    return null;
  }

  /**
   * `privilege exec level N <command>` — an intermediate-level session
   * (mode stays 'user' for levels 1-14, real IOS never shows '#' below
   * 15) additionally gets the exact privileged commands explicitly
   * granted at or below its level. Dispatches through the privileged
   * trie (the only one with the full parsing/behaviour for that
   * command) so a granted command works identically to how level 15
   * runs it — not a stub. Returns null when nothing is granted, so the
   * caller falls back to the normal "command not found" error, exactly
   * matching real IOS: a command outside your privilege level simply
   * isn't in your visible command tree.
   */
  /**
   * `enable view [<nom>]` — basculer dans une vue, ou revenir a la racine.
   *
   * Sans nom, on entre dans la vue RACINE : c'est la condition qu'IOS
   * pose pour declarer ou modifier une vue, et c'est aussi la sortie
   * d'une vue restreinte. Avec un nom, la vue doit exister — sinon on
   * annoncerait un role qui n'a jamais ete decrit.
   *
   * Le mot de passe de la vue n'est PAS demande ici : comme pour
   * `enable`, l'authentification interactive se joue dans le plan
   * d'interaction, et un appelant non interactif (un test, un script)
   * ne pourrait de toute facon pas y repondre.
   */
  protected entrerDansUneVue(args: string[]): string {
    const sec = getSecurityConfig(this.d());
    if (args.length === 0) {
      this.activeParserView = null;
      this.mode = 'privileged';
      this.currentPrivilegeLevel = 15;
      return '';
    }
    const nom = args[0];
    if (!sec.parserViews.has(nom)) {
      return `%Error: View ${nom} is not present in the system`;
    }
    this.activeParserView = nom;
    this.mode = 'privileged';
    this.currentPrivilegeLevel = 15;
    return '';
  }

  /** La vue que `parser view <nom>` est en train de declarer. */
  protected vueEnCours(): import('../router/security/CiscoSecurityConfig').ParserView | undefined {
    if (!this.selectedParserView) return undefined;
    return getSecurityConfig(this.d()).parserViews.get(this.selectedParserView);
  }

  /**
   * La porte d'une vue CLI : une commande exec passe-t-elle ?
   *
   * La difference avec les niveaux de privilege est le tout du
   * mecanisme : un niveau AJOUTE des commandes au socle du niveau 1, une
   * vue REMPLACE l'arbre visible. Hors d'une vue (le cas courant, et le
   * seul jusqu'ici), cette fonction rend `true` sans rien consulter.
   *
   * Trois commandes passent toujours, et ce n'est pas une commodite :
   * sans elles on ne pourrait plus ni quitter la vue, ni savoir dans
   * laquelle on est — une vue dont on ne peut pas sortir n'est plus un
   * role, c'est une souriciere.
   */
  private readonly VUE_TOUJOURS_PERMIS = ['exit', 'end', 'logout', 'disable', 'enable', 'show parser view'];

  protected commandeAutoriseeParLaVue(cmdPart: string): boolean {
    if (this.activeParserView === null) return true;
    const vue = getSecurityConfig(this.d()).parserViews.get(this.activeParserView);
    if (!vue) return true;
    const ligne = cmdPart.trim().toLowerCase();
    if (this.VUE_TOUJOURS_PERMIS.some((c) => ligne === c || ligne.startsWith(c + ' '))) return true;
    // `exclude` l'emporte : il sert precisement a retirer une commande
    // d'un prefixe qu'on vient d'inclure.
    if (vue.execExclude.some((c) => ligne === c || ligne.startsWith(c + ' '))) return false;
    return vue.execInclude.some((c) => ligne === c || ligne.startsWith(c + ' ')
      // Un prefixe inclus autorise ce qui le complete (`show ip` couvre
      // `show ip route`), et une commande incluse plus longue que ce qui
      // est tape reste invisible : c'est l'arbre d'IOS, pas une egalite.
      || c.startsWith(ligne + ' '));
  }

  private tryGrantedPrivilegeCommand(cmdPart: string): string | null {
    if (this.mode !== 'user' || this.currentPrivilegeLevel <= 1 || this.currentPrivilegeLevel >= 15) return null;
    const rules = (this.d() as unknown as { _ciscoPrivilegeRules?: Map<string, number> })._ciscoPrivilegeRules;
    if (!rules || rules.size === 0) return null;
    const lower = cmdPart.trim().toLowerCase();
    let matched = false;
    for (const [key, level] of rules) {
      if (!key.startsWith('exec ')) continue;
      if (level > this.currentPrivilegeLevel) continue;
      const target = key.slice(5);
      if (lower === target || lower.startsWith(target + ' ')) { matched = true; break; }
    }
    if (!matched) return null;
    const privResult = this.privilegedTrie.match(cmdPart);
    if (privResult.status === 'ok') {
      return privResult.node?.action ? privResult.node.action(privResult.args, cmdPart) : '';
    }
    return null;
  }

  /**
   * `show running-config`/`show startup-config`/`show tech-support`/
   * `show archive` are privileged-only by design (`PRIVILEGED_ONLY_SHOW`)
   * — deliberately never copied into the user trie. At level 1 that's
   * fine (the user trie's own "not a real subcommand" handling already
   * covers it), but at an intermediate level the user trie's generic
   * `show <unrecognized>` fallback answers "% Incomplete command." (it
   * assumes any unmatched show argument is just not-yet-fully-typed),
   * which would leak the *existence* of the command. Real IOS shows the
   * identical "unknown command" response for a privilege-gated command as
   * for one that plain doesn't exist — this makes the simulator match.
   */
  private isPrivilegedOnlyShowCommand(cmdPart: string): boolean {
    const m = /^show\s+(\S+)/i.exec(cmdPart.trim());
    if (!m) return false;
    const sub = m[1].toLowerCase();
    for (const k of PRIVILEGED_ONLY_SHOW) {
      if (k.startsWith(sub) || sub.startsWith(k)) return true;
    }
    return false;
  }

  runShowCommandSync(device: TDevice, cmdPart: string): string {
    const previousMode = this.mode;
    const previousLevel = this.currentPrivilegeLevel;
    const previousDevice = this.deviceRef;
    this.mode = 'privileged';
    this.currentPrivilegeLevel = 15;
    this.deviceRef = device;
    try {
      return this.executeOnTrie(cmdPart);
    } finally {
      this.mode = previousMode;
      this.currentPrivilegeLevel = previousLevel;
      this.deviceRef = previousDevice;
    }
  }

  /**
   * `undebug X` is `no debug X`, and IOS accepts every abbreviation down
   * to `u X`. Registering both spellings for each debug family would
   * guarantee the two drift apart the first time one gains an option, so
   * the synonym is resolved once, here, before the trie ever sees it.
   * `undebug all` keeps its own registration — it does more than clear
   * the flag registry.
   */
  private static undebugAsNoDebug(cmdPart: string): string | null {
    const m = /^\s*(u|un|und|unde|undeb|undebu|undebug)\s+(\S.*)$/i.exec(cmdPart);
    if (!m) return null;
    const rest = m[2].trim();
    if (/^all\b/i.test(rest)) return null;
    return `no debug ${rest}`;
  }

  /** Best-effort canonical interface name, for `debug condition interface`. */
  protected resolveInterfaceNameForDebug(raw: string): string | null {
    const dev = this.d() as unknown as { getPortNames?: () => string[] };
    const names = dev.getPortNames?.() ?? [];
    const flat = raw.replace(/\s+/g, '').toLowerCase();
    return names.find((n) => n.toLowerCase() === flat)
      ?? names.find((n) => n.toLowerCase().replace(/[a-z]/g, '') === flat.replace(/[a-z]/g, '')
        && n.toLowerCase().startsWith(flat.slice(0, 2)))
      ?? null;
  }

  /**
   * True for an exception a CALLER handles by name — a control-flow
   * signal, not a bug. Those must keep travelling: swallowing them here
   * would defeat the point of them being a named type (see
   * `CiscoSwitchShell`'s `UnsupportedOnThisSwitchError`, which is what
   * lets a generic switch refuse a command it cannot honestly answer).
   */
  protected isControlFlowError(_err: unknown): boolean { return false; }

  /** A handler threw something unforeseen: keep the trace for a developer. */
  private reportHandlerCrash(cmdPart: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[CLI] handler crashed on "${cmdPart}":`, detail);
  }

  protected executeOnTrie(cmdPart: string): string {
    const asNoDebug = CiscoShellBase.undebugAsNoDebug(cmdPart);
    if (asNoDebug !== null) cmdPart = asNoDebug;
    if (this.mode === 'user' && this.currentPrivilegeLevel > 1 && this.currentPrivilegeLevel < 15) {
      const granted = this.tryGrantedPrivilegeCommand(cmdPart);
      if (granted !== null) return granted;
      if (this.isPrivilegedOnlyShowCommand(cmdPart)) return CISCO_ERRORS.INVALID_INPUT;
    }

    // Une vue active remplace l'arbre visible : ce qu'elle n'inclut pas
    // repond comme une commande qui n'existe pas, ce qui est exactement
    // ce que fait IOS -- une commande hors de votre vue n'est pas
    // "refusee", elle est absente.
    if ((this.mode === 'user' || this.mode === 'privileged')
      && !this.commandeAutoriseeParLaVue(cmdPart)) {
      return CISCO_ERRORS.INVALID_INPUT;
    }

    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    const keywordCount = result.matchedKeywords.length;

    switch (result.status) {
      case 'ok': {
        if (!result.node?.action) return '';
        let output: string;
        try {
          output = result.node.action(result.args, cmdPart);
        } catch (err) {
          if (this.isControlFlowError(err)) throw err;
          if (err instanceof CliInvalidInput) {
            return renderCliDiagnostic('invalid', {
              line: cmdPart,
              tokenOffset: offsetForInvalidInput(cmdPart, keywordCount, err),
            });
          }
          if (err instanceof CliIncomplete) {
            return renderCliDiagnostic('incomplete', { line: cmdPart });
          }
          // Anything else is a bug in a handler, and it must not reach the
          // terminal: an exception surfacing as `% Error: ReferenceError…`
          // also aborts the command mid-way, so the shell stays in whatever
          // mode the handler was leaving — the next pasted lines are then
          // interpreted in the wrong mode and the whole paste derails. IOS
          // answers an unusable command with the caret; do that, and leave
          // the trace where a developer looks for it.
          this.reportHandlerCrash(cmdPart, err);
          // `argumentOffset`, pas `offsetForInvalidInput` : ce dernier
          // veut un CliInvalidInput pour lire son `token`/`argIndex`, et
          // il n'y en a pas ici — l'appeler sans lui faisait planter le
          // filet lui-même, ce qui remplaçait une exception par une autre.
          return renderCliDiagnostic('invalid', {
            line: cmdPart,
            tokenOffset: argumentOffset(cmdPart, keywordCount, 0),
          });
        }
        return this.attachCaretIfBare(output, cmdPart, keywordCount);
      }
      case 'ambiguous':
        return renderCliDiagnostic('ambiguous', { line: cmdPart });
      case 'incomplete':
        return renderCliDiagnostic('incomplete', { line: cmdPart });
      case 'invalid': {
        const nav = this.tryGlobalConfigNavigation(cmdPart);
        if (nav !== null) return nav;
        const unknownExec = this.unknownExecCommand(cmdPart, result.errorPos);
        return unknownExec ?? (result.error || CISCO_ERRORS.INVALID_INPUT);
      }
      default: {
        const nav = this.tryGlobalConfigNavigation(cmdPart);
        return nav !== null ? nav : CISCO_ERRORS.INVALID_INPUT;
      }
    }
  }

  private attachCaretIfBare(output: string, line: string, keywordCount: number): string {
    if (output !== INVALID_INPUT_MESSAGE) return output;
    return renderCliDiagnostic('invalid', {
      line,
      tokenOffset: argumentOffset(line, keywordCount),
    });
  }

  private unknownExecCommand(line: string, errorPos: number | undefined): string | null {
    if (this.mode !== 'user' && this.mode !== 'privileged') return null;
    const spans = tokenSpans(line);
    const first = spans[0];
    if (!first || errorPos !== first.offset) return null;
    if (this.privilegedTrie.getCompletions(first.text).length > 0) return null;
    return renderCliDiagnostic('unknown-exec', { line, token: first.text });
  }

  // ─── FSM Transitions ───────────────────────────────────────────

  protected configSessionLabel = 'console';

  protected announceConfigExit(wasConfig: boolean): void {
    if (!wasConfig || this.isConfigMode()) return;
    const device = this.configExitLogTarget as {
      _loggingConfig?: LoggingConfig;
      getLoggingConfig?: () => LoggingConfig | undefined;
    } | null;
    const target = device?._loggingConfig ?? device?.getLoggingConfig?.() ?? this.logging;
    target.append('notifications', 'sys',
      `Configured from console by ${this.configSessionLabel}`, true, 'CONFIG_I');
  }

  protected configExitLogTarget: unknown = null;

  /**
   * `archive log config` — retient la commande de configuration qui
   * vient d'être tapée, et l'annonce en syslog
   * (`docs/PRD-Pistes-Audit-Cisco.md` §3).
   *
   * C'est la seule trace de « qui a tapé quoi » qui n'exige AUCUN
   * serveur : elle vit sur la machine, et c'est ce qui la rend utilisable
   * dans un laboratoire comme dans un réseau dont le TACACS+ est tombé.
   * Le sous-mode était accepté, ses réglages rangés — et rien n'était
   * jamais retenu ni annoncé.
   *
   * On journalise sur le mode d'AVANT la commande, ce qui est ce que
   * fait IOS : `configure terminal` n'est pas une commande de
   * configuration (on n'y est pas encore), tandis qu'`interface Gi0/0`
   * en est une bien qu'elle change de mode.
   */
  private journaliserCommandeDeConfig(modeAvant: string, commande: string, sortie: string): void {
    if (!modeAvant.startsWith('config')) return;
    // Une commande refusée n'a rien changé : la retenir ferait lire au
    // journal d'audit une modification qui n'a pas eu lieu.
    if (/^%|Invalid input|Incomplete command/m.test(sortie)) return;
    const service = this.archiveService();
    if (!service) return;
    const record = service.logCommand(
      this.configSessionLabel, this.configSessionLabel === 'console' ? 'console' : 'vty0',
      commande, Date.now());
    if (!record) return;
    if (service.getConfigLogger().notifySyslogContent === undefined) return;
    const device = this.configExitLogTarget as {
      _loggingConfig?: LoggingConfig;
      getLoggingConfig?: () => LoggingConfig | undefined;
    } | null;
    const cible = device?._loggingConfig ?? device?.getLoggingConfig?.() ?? this.logging;
    cible.append('notifications', 'parser',
      `User:${record.user} logged command:${record.command}`, true, 'CFGLOG_LOGGEDCMD');
  }

  /**
   * `aaa accounting commands <niveau>` — envoie la commande au collecteur
   * (`docs/PRD-Pistes-Audit-Cisco.md` §5).
   *
   * L'émission est délibérément « au fil de l'eau » et non attendue : un
   * opérateur ne doit pas voir sa CLI se figer parce qu'un serveur
   * TACACS+ est lent, et c'est ce que fait `start-stop` sur une vraie
   * machine — `wait-start`, qui bloque, n'est pas modélisé ici.
   *
   * Une commande refusée n'est pas comptabilisée, pour la même raison
   * qu'elle n'entre pas au journal : elle n'a rien changé.
   */
  private comptabiliserCommande(commande: string, sortie: string): void {
    if (/^%|Invalid input|Incomplete command/m.test(sortie)) return;
    const texte = commande.trim();
    if (texte.length === 0) return;
    const dev = this.d() as unknown as { getAaaAuthenticator?: () => AaaAuthenticator };
    const authenticator = dev.getAaaAuthenticator?.();
    if (!authenticator) return;
    const niveau = this.mode === 'user' ? 1 : 15;
    void authenticator.accountCommand(this.configSessionLabel, texte, niveau)
      .catch(() => undefined);
  }

  protected cmdExit(): string {
    if (this.mode === 'user') { this.terminalMonitor = false; return 'Connection closed.'; }
    if (this.mode === 'privileged') this.terminalMonitor = false;
    const wasConfig = this.isConfigMode();
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.exit();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    this.announceConfigExit(wasConfig);
    return '';
  }

  protected cmdEnd(): string {
    const wasConfig = this.isConfigMode();
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.end();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    this.announceConfigExit(wasConfig);
    return '';
  }

  protected isConfigMode(): boolean {
    return this.mode !== 'user' && this.mode !== 'privileged';
  }

  protected isAclSubMode(): boolean {
    return this.mode === 'config-std-nacl'
      || this.mode === 'config-ext-nacl'
      || this.mode === 'config-ipv6-nacl';
  }

  private static readonly IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

  private static readonly MONTH_MAP: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };

  /**
   * `clock set 10:30:00 3 June 2026` — rend l'instant en millisecondes,
   * ou le message de refus d'IOS.
   *
   * Le seuil était `args.length < 5` alors que la forme normale d'IOS en
   * compte QUATRE (`hh:mm:ss <jour> <Mois> <année>`) : mesuré, la
   * commande était acceptée et ne posait rien, et ne marchait qu'avec un
   * cinquième mot parasite. Un `clock set` qui rend la main sans rien
   * changer est pire qu'un refus.
   *
   * IOS accepte aussi les deux ordres (`<jour> <Mois> <année>` et
   * `<Mois> <jour> <année>`) et abrège les mois sur trois lettres ; les
   * deux sont acceptés ici pour la raison qui les fait accepter sur un
   * vrai routeur — c'est ce que les gens tapent.
   */
  protected parseClockSetArgs(args: string[]): number | string {
    if (args.length < 4) return '% Incomplete command.';
    const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(args[0]);
    if (!hm) return "% Invalid input detected at '^' marker.";
    const [h, mn, sec] = [+hm[1], +hm[2], hm[3] ? +hm[3] : 0];
    if (h > 23 || mn > 59 || sec > 59) return "% Invalid input detected at '^' marker.";

    const moisDe = (mot: string): number => {
      const bas = (mot ?? '').toLowerCase();
      if (!bas) return 0;
      const nom = Object.keys(CiscoShellBase.MONTH_MAP).find((m) => m.startsWith(bas));
      return nom ? CiscoShellBase.MONTH_MAP[nom] : 0;
    };

    let jour = parseInt(args[1], 10);
    let mois = moisDe(args[2]);
    const annee = parseInt(args[3], 10);
    if (isNaN(jour) || !mois) {
      // L'autre ordre : `clock set 10:30:00 June 3 2026`.
      mois = moisDe(args[1]);
      jour = parseInt(args[2], 10);
    }
    if (!mois || isNaN(jour) || isNaN(annee)) return "% Invalid input detected at '^' marker.";
    if (jour < 1 || jour > 31 || annee < 1993 || annee > 2035) {
      return "% Invalid input detected at '^' marker.";
    }
    return Date.UTC(annee, mois - 1, jour, h, mn, sec);
  }

  /** Le seul point qui pose l'horloge, partagé par les deux modes. */
  protected applyClockSet(args: string[]): string {
    const q = this.parseClockSetArgs(args);
    if (typeof q === 'string') return q;
    const dev = this.d() as unknown as { _setSystemClock?: (ms: number) => void };
    dev._setSystemClock?.(q);
    return '';
  }

  /**
   * Ce que fait une commande `ntp …`, une fois son mot-cle retrouve.
   *
   * Le corps est partage par toutes les sous-commandes declarees dans
   * l'arbre : un analyseur par mot-cle finirait par diverger sur ce que
   * `ntp server` et `ntp peer` ont en commun.
   */
  private appliquerNtp(args: string[]): string {
      const a = args.map(s => s.toLowerCase());
      if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
      if ((a[0] === 'server' || a[0] === 'peer') && !a[1]) return CISCO_ERRORS.INCOMPLETE;
      const agent = getNtpAgent(this.d());
      if (!agent) return '';
      if (a[0] === 'server' && a[1]) {
        const target = a[1];
        const resolved = this.resolveNtpTarget(target);
        if (!resolved) {
          return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
        }
        agent.addServer(resolved, a.includes('prefer'), this.parseNtpKeyId(a));
      } else if (a[0] === 'peer' && a[1]) {
        const resolved = this.resolveNtpTarget(a[1]);
        if (!resolved) {
          return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
        }
        agent.addPeer(resolved, a.includes('prefer'), this.parseNtpKeyId(a));
      } else if (a[0] === 'master') {
        agent.setServerMode(true);
        if (a[1] && /^\d+$/.test(a[1])) agent.setLocalStratum(parseInt(a[1], 10));
      } else if (a[0] === 'source' && a[1]) {
        // `args` et non `a` : un nom d'interface et un mot de passe sont
        // des DONNEES, pas des mots-cles. La ligne du dessus met toute la
        // commande en minuscules pour comparer, et ce qui en sortait
        // etait rangé tel quel -- `Loopback0` devenait `loopback0`, et
        // `ClefNTP2024Secret` devenait `clefntp2024secret`, donc une
        // AUTRE clé. Une configuration relue ne refaisait pas la machine.
        agent.setSourceInterface(args[1]);
      } else if (a[0] === 'authenticate') {
        agent.setAuthenticate(true);
      } else if (a[0] === 'authentication-key' && a[1] && a[2] === 'md5' && args[3]) {
        agent.addAuthKey(parseInt(a[1], 10), 'md5', args[3]);
      } else if (a[0] === 'trusted-key' && a[1]) {
        agent.addTrustedKey(parseInt(a[1], 10));
      } else if (a[0] === 'access-group' && a[1] && a[2]) {
        // IOS ne connait QUE ces quatre familles. Le tutoriel ecrit
        // `ntp access-group nomodify 10`, qui est la syntaxe de `ntpd`
        // et de `chrony` : l'accepter apprendrait une commande que la
        // vraie machine refuse (lot N6).
        if (!estGenreAcces(a[1])) return CISCO_ERRORS.INVALID_INPUT;
        agent.setAccessGroup(a[1], a[2]);
      } else if (a[0] === 'update-calendar') {
        agent.setUpdateCalendar(true);
      } else if (a[0] === 'allow' && a[1] === 'mode' && a[2] === 'control') {
        agent.setAllowModeControl(true);
      }
      return '';
  }

  /** Ce qu'une forme `no ntp …` retire. */
  private retirerNtp(args: string[]): string {
      const a = args.map(s => s.toLowerCase());
      const agent = getNtpAgent(this.d());
      if (!agent) return '';
      if ((a[0] === 'server' || a[0] === 'peer') && a[1]) agent.removeServer(a[1]);
      else if (a[0] === 'master') { agent.setServerMode(false); agent.setLocalStratum(16); }
      else if (a[0] === 'authenticate') agent.setAuthenticate(false);
      else if (a[0] === 'authentication-key' && a[1]) agent.removeAuthKey(parseInt(a[1], 10));
      else if (a[0] === 'trusted-key' && a[1]) agent.removeTrustedKey(parseInt(a[1], 10));
      else if (a[0] === 'access-group' && a[1]) agent.removeAccessGroup(a[1]);
      else if (a[0] === 'source') agent.setSourceInterface('');
      else if (a[0] === 'update-calendar') agent.setUpdateCalendar(false);
      // Le durcissement du §9 : fermer le mode 6, celui de `monlist`.
      else if (a[0] === 'allow' && a[1] === 'mode' && a[2] === 'control') {
        agent.setAllowModeControl(false);
      }
      return '';
  }

  protected resolveNtpTarget(target: string): string | null {
    if (CiscoShellBase.IPV4_RE.test(target)) return target;
    const dev = this.d() as unknown as { _getHostsTable?: () => { resolve?: (n: string) => string | null } };
    const fromHosts = dev._getHostsTable?.().resolve?.(target);
    if (fromHosts && CiscoShellBase.IPV4_RE.test(fromHosts)) return fromHosts;
    return null;
  }

  protected parseNtpKeyId(args: string[]): number | undefined {
    const idx = args.indexOf('key');
    if (idx < 0 || !args[idx + 1] || !/^\d+$/.test(args[idx + 1])) return undefined;
    return parseInt(args[idx + 1], 10);
  }

  // ─── Help / Tab-Complete ────────────────────────────────────────

  /**
   * `exit`, `end`, `help`, `do` et `default` ne sont enregistrés dans
   * AUCUN arbre : ils sont traités par le shell, avant l'arbre, parce
   * qu'ils existent dans tous les modes. C'est précisément pour cela
   * qu'aucun `?` ne les listait — l'aide ne lit que l'arbre.
   *
   * Cette liste est le point unique : le répartiteur l'applique, l'aide
   * la rend, et un mot-clé ne peut donc plus être exécutable sans être
   * proposé (ni l'inverse).
   */
  protected universalCommands(): Array<{ keyword: string; description: string }> {
    // `end` n'existe QUE dans les modes de configuration : il n'y a rien
    // à terminer depuis un EXEC, et IOS ne le propose pas là.
    const out = [
      { keyword: 'exit', description: 'Exit from the EXEC' },
      { keyword: 'help', description: 'Description of the interactive help system' },
    ];
    if (this.isConfigMode()) {
      out.push({ keyword: 'end', description: 'Exit from configure mode' });
      out.push({ keyword: 'default', description: 'Set a command to its defaults' });
      out.push({ keyword: 'do', description: 'To run exec commands in config mode' });
      out[0].description = this.mode === 'config'
        ? 'Exit from configure mode' : 'Exit from this submode';
    }
    return out.sort((a, b) => a.keyword.localeCompare(b.keyword));
  }

  /**
   * `| redirect`, `| append` et `| tee` ÉCRIVENT. Ils étaient acceptés
   * et ne créaient aucun fichier : la sortie partait au terminal comme
   * si le modificateur n'avait pas été tapé, et `dir flash:` ne montrait
   * rien de nouveau. Une commande qui promet d'écrire doit écrire.
   *
   * L'écriture est faite ICI et pas dans `applyPipeFilter`, parce que
   * seul le shell tient le système de fichiers de l'équipement — le
   * même objet que `dir` et `more` lisent, pas une copie.
   */
  private runPipeWriter(cmdPart: string, filter: PipeFilter, device: TDevice): string {
    const cible = filter.pattern.trim();
    if (!cible) return CISCO_ERRORS.INCOMPLETE;
    const fs = this.fs();
    const nom = cible.replace(/^[a-z]+:\/?/i, '');
    if (!nom) return `%Error opening ${cible} (No such file or directory)`;

    this.deviceRef = device;
    const sortie = this.executeOnTrie(cmdPart);
    this.deviceRef = null;

    const ancien = filter.type === 'append' ? (fs.get(nom)?.content ?? '') : '';
    const contenu = ancien ? `${ancien}\n${sortie}` : sortie;
    if (contenu.length - ancien.length > fs.freeBytes()) {
      return `%Error opening ${cible} (No space left on device)`;
    }
    fs.write(nom, contenu);
    return filter.type === 'tee' ? `${sortie}\n${PIPE_WRITE_BANNER}` : PIPE_WRITE_BANNER;
  }

  getHelp(input: string, device?: TDevice): string {
    // `show running-config | ?` n'était le nœud d'aucun arbre : le `|`
    // est retiré de la ligne avant l'analyse, donc l'aide répondait au
    // caret là où IOS liste ses modificateurs. Le cas est traité ici et
    // pas dans le répartiteur, pour que le terminal et `cliHelp` — les
    // deux portes de l'aide — ne puissent pas répondre différemment.
    const barre = input.lastIndexOf('|');
    if (barre >= 0) {
      const partiel = input.slice(barre + 1).trim().toLowerCase();
      const offerts = PIPE_MODIFIERS.filter((m) => m.keyword.startsWith(partiel));
      if (offerts.length === 0) return CISCO_ERRORS.UNRECOGNIZED_HELP;
      const large = Math.max(...offerts.map((m) => m.keyword.length));
      return offerts.map((m) => `  ${m.keyword.padEnd(large + 2)}${m.description}`).join('\n');
    }
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(device ? new EquipmentParamResolver(device) : null);
    try {
      const completions = trie.getCompletions(input);
      if (completions.length === 0) {
        return CISCO_ERRORS.UNRECOGNIZED_HELP;
      }
      // Seul le menu RACINE d'un mode porte les commandes universelles :
      // elles ne sont pas des continuations de `show` ou de `ip`.
      if (input.trim() === '') {
        const deja = new Set(completions.map((c) => c.keyword.toLowerCase()));
        for (const u of this.universalCommands()) {
          if (!deja.has(u.keyword)) completions.push(u);
        }
        completions.sort((a, b) => a.keyword.localeCompare(b.keyword));
      }
      const maxKw = Math.max(...completions.map(c => c.keyword.length));
      return completions
        .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
        .join('\n');
    } finally {
      trie.setDynamicResolver(null);
    }
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  tabCandidates(input: string, device: TDevice): string[] {
    const viaDo = this.doTabCandidates(input, device);
    if (viaDo !== null) return viaDo;
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(new EquipmentParamResolver(device));
    try {
      return this.withUniversalCandidates(input, trie.tabCandidates(input));
    } finally {
      trie.setDynamicResolver(null);
    }
  }

  /**
   * `do <commande>` se complète dans l'arbre EXEC, comme il s'y exécute.
   *
   * Le répartiteur bascule `this.mode` sur `privileged` le temps de la
   * sous-commande ; la complétion fait exactement la même bascule et
   * réutilise sa propre méthode, plutôt que d'aller lire le trie
   * privilégié à la main — ainsi les commandes universelles et le
   * résolveur dynamique s'appliquent après `do` comme avant, sans second
   * chemin à tenir à jour.
   *
   * Rend `null` quand la ligne ne commence pas par `do` : l'appelant
   * poursuit normalement. Rend `[]` pour `do ` seul, une espace finale ne
   * proposant jamais rien sur un vrai IOS.
   */
  private doTabCandidates(input: string, device: TDevice): string[] | null {
    if (!this.isConfigMode()) return null;
    const m = /^\s*do\s+(.*)$/i.exec(input);
    if (!m) return null;
    const reste = m[1];
    if (reste.trim().length === 0) return [];
    const modeSauve = this.mode;
    this.mode = 'privileged';
    try {
      return this.tabCandidates(reste, device).map((c) => `do ${c}`);
    } finally {
      this.mode = modeSauve;
    }
  }

  /**
   * Les commandes universelles complétées comme les autres.
   *
   * `exit`, `help`, et en configuration `end`, `do` et `default` vivent
   * dans {@link universalCommands} et non dans le trie — c'est ce qui
   * leur permet d'exister dans TOUS les modes sans être réenregistrées
   * quinze fois. L'aide les rendait donc, et la complétion les ignorait :
   * `ex` ne donnait rien là où `?` annonçait `exit`, dans chaque mode des
   * deux plateformes. Elles sont ajoutées ICI, à partir de la MÊME
   * méthode que l'aide, pour que les deux ne puissent pas diverger — une
   * seconde liste aurait recréé exactement l'écart qu'on ferme.
   *
   * Elles ne valent que pour le PREMIER mot de la ligne : `exit` n'est
   * pas une continuation de `show`, et `show ex` ne doit rien proposer.
   */
  private withUniversalCandidates(input: string, candidates: string[]): string[] {
    if (/\s/.test(input.trim()) || input.endsWith(' ')) return candidates;
    const partiel = input.trim().toLowerCase();
    if (partiel.length === 0) return candidates;
    const deja = new Set(candidates.map((c) => c.toLowerCase()));
    const out = [...candidates];
    for (const u of this.universalCommands()) {
      if (u.keyword.startsWith(partiel) && !deja.has(u.keyword)) out.push(u.keyword);
    }
    return out;
  }

  // ─── Prompt ─────────────────────────────────────────────────────

  getMode(): string { return this.mode; }

  protected buildDevicePrompt(device: TDevice): string {
    return buildPrompt(this.mode, device._getHostnameInternal(), this.getPromptMap());
  }

  // ─── Shared Command Registration ───────────────────────────────

  /** IOS show/util commands common to every Cisco device + mode (DRY). */
  private registerCommonShowCommands(trie: CommandTrie): void {
    trie.register('show clock', 'Display the system clock', () => showClock(this.cs()));
    trie.register('show users', 'Display active lines', () => showUsers());
    // `show who` est le SYNONYME historique de `show users` sur IOS, et
    // la sequence de collecte de preuves d'un auditeur les enchaine.
    // Elle repondait `% Invalid input`. Le rendu est le meme parce que
    // c'est la meme question : deux textes pour une question feraient
    // douter de la machine.
    trie.register('show who', 'Display active lines', () => showUsers());
    trie.register('show sessions', 'Display open outgoing connections', () => renderSessions(this.outgoingSessions));
    trie.register('where', 'List open outgoing connections', () => renderSessions(this.outgoingSessions));
    trie.registerGreedy('disconnect', 'Close an outgoing connection', (args) => {
      if (!args[0]) {
        const last = this.outgoingSessions.list().slice(-1)[0];
        if (!last) return '% No connections open';
        this.outgoingSessions.close(last.conn);
        return '';
      }
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || !this.outgoingSessions.get(n)) return '% No information for this connection';
      const target = this.outgoingSessions.get(n)!;
      this.outgoingSessions.close(n);
      return `Closing connection to ${target.host} [confirm]`;
    });
    trie.registerGreedy('resume', 'Resume an outgoing connection', (args) => {
      const list = this.outgoingSessions.list();
      const n = args[0] ? parseInt(args[0], 10) : (list.slice(-1)[0]?.conn ?? NaN);
      const s = this.outgoingSessions.get(n);
      if (!s) return '% No connection open';
      this.outgoingSessions.touch(n);
      return `[Resuming connection ${n} to ${s.host} ... ]`;
    });
    trie.register('show inventory', 'Display hardware inventory', () =>
      showInventory(this.d().getHostname(), this.getChassisProfile()));
    trie.register('show processes', 'Display active processes', () =>
      showProcessesCpu());
    trie.register('show processes cpu', 'Display CPU utilisation', () =>
      showProcessesCpu());
    trie.registerGreedy('show processes cpu sorted', 'Display CPU utilisation sorted', () =>
      showProcessesCpu());
    trie.registerGreedy('show processes cpu history', 'Display CPU history', () =>
      showProcessesCpu());
    trie.registerGreedy('show processes memory', 'Display per-process memory', () =>
      showProcessesMemory());
    trie.registerGreedy('show interfaces counters errors', 'Display interface error counters', () => {
      const rows = ['Port           Align-Err   FCS-Err  Xmit-Err   Rcv-Err UnderSize OutDiscards'];
      for (const name of this.d().getPortNames()) {
        const c = this.d().getPort(name)?.getCounters();
        const inErr = c?.errorsIn ?? 0;
        const outErr = c?.errorsOut ?? 0;
        rows.push(
          `${name.padEnd(15)}` +
          `${String(0).padStart(9)}${String(inErr).padStart(10)}` +
          `${String(outErr).padStart(10)}${String(inErr).padStart(10)}` +
          `${String(0).padStart(10)}${String(0).padStart(12)}`,
        );
      }
      return rows.join('\n');
    });
    trie.register('show clock detail', 'Display clock with source', () => {
      const ntp = getNtpAgent(this.cs());
      const synced = ntp?.isSynced() ?? false;
      const source = synced ? `NTP (${ntp?.getConfig().refIdentifier})` : 'No time source';
      return [
        showClock(this.cs()),
        `Time source is ${source}`,
      ].join('\n');
    });
    trie.registerGreedy('show memory', 'Display memory statistics', () =>
      showMemoryStatistics(this.getChassisProfile()));
    trie.registerGreedy('show flash:', 'Display flash filesystem', () => this.fs().renderShowFlash());
    this.registerFileSystemCommands(trie);
    trie.register('show platform', 'Display platform information', () => {
      const profile = this.getChassisProfile();
      return profile === 'router-isr2911'
        ? 'Cisco ISR 2911\n  PID: CISCO2911/K9\n  S/N: FTX1234567A'
        : 'Cisco Catalyst 2960\n  PID: WS-C2960-24TT-L\n  S/N: FOC1234X56Y';
    });
    trie.register('show license', 'Display licenses', () => {
      const head = 'Index Feature                  Period left    Period Used    License Type    License State    License Count    License Priority';
      const row = (i: number, feat: string) =>
        `${i}     ${feat.padEnd(25)}Lifetime       0              Permanent       Active, In Use   N/A              Medium`;
      if (this.getChassisProfile() !== 'router-isr2911') return `${head}\n${row(1, 'ipbasek9')}`;
      return [head, row(1, 'ipbasek9'), row(2, 'securityk9')].join('\n');
    });
    trie.register('show license udi', 'Display Unique Device Identifier', () => {
      const profile = this.getChassisProfile();
      const sn = profile === 'router-isr2911' ? 'FTX1234567A' : 'FOC1234X56Y';
      const pid = profile === 'router-isr2911' ? 'CISCO2911/K9' : 'WS-C2960-24TT-L';
      return `Device#   PID                   SN\n*0        ${pid.padEnd(22)}${sn}`;
    });
    trie.register('show diag', 'Display chassis diagnostics', () => {
      const profile = this.getChassisProfile();
      const pid = profile === 'router-isr2911' ? 'CISCO2911/K9' : 'WS-C2960-24TT-L';
      const sn = profile === 'router-isr2911' ? 'FTX1234567A' : 'FOC1234X56Y';
      return [
        'Slot 0:',
        `        ${pid} Motherboard Port adapter, 3 ports`,
        '        Port adapter is analyzed',
        '        Port adapter insertion time unknown',
        `        Hardware Revision        : 1.0`,
        `        Part Number              : ${pid}`,
        `        Board Revision           : 1.0`,
        `        PCB Serial Number        : ${sn}`,
      ].join('\n');
    });
    // `getMacTable` — minuscule — n'est défini sur AUCUN appareil : celui
    // que `Switch` porte s'appelle `getMACTable()`. Le lecteur rendait
    // donc `undefined`, et cette vue répondait « No entries » quoi que le
    // commutateur ait appris — y compris après un DORA et un ping
    // réussis, avec deux entrées bien présentes dans sa table. Exactement
    // le défaut de `_getRunningConfigText` décrit trois lignes plus bas,
    // dans ce même fichier.
    //
    // Pire : cette inscription MASQUAIT celle de `CiscoSwitchShell`, qui
    // est complète (filtres `dynamic`/`static`/`vlan`/`interface`, tri,
    // colonnes). Un commutateur avait donc une vue juste que personne
    // n'atteignait. Elle n'est désormais posée que si l'appareil n'en
    // fournit pas de meilleure.
    if (this.hasSwitchingHardware() && !this.providesOwnMacAddressTableView()) {
      trie.registerGreedy('show mac address-table', 'Display MAC address table', () =>
        ['Mac Address Table', '--------------------------------', 'No entries'].join('\n'));
    }
    // `_getRunningConfigText` n'est défini sur AUCUN appareil : il n'est
    // que lu, ici et à deux autres endroits. Mesuré avant correction,
    // `show running-config all` rendait donc « Building configuration... »
    // et rien d'autre, pendant que `show running-config` rendait ses 17
    // lignes sur la même machine. La méthode réellement portée par
    // `Router` comme par `Switch` est `getRunningConfig()`.
    trie.registerGreedy('show running-config all', 'Show running-config with defaults', () => {
      const dev = this.d() as unknown as { getRunningConfig?: () => string };
      const cfg = dev.getRunningConfig?.() ?? '';
      return cfg.length > 0 ? `Building configuration...\n${cfg}` : 'Building configuration...';
    });
    trie.register('show privilege', 'Display current privilege level', () =>
      showPrivilege(this.currentPrivilegeLevel));
    trie.register('show history', 'Display command history', () =>
      this.cmdHistory.slice(-this.terminalHistorySize).join('\n'));
    // Un compteur qu'on ne peut pas remettre a zero ne sert qu'a moitie :
    // un diagnostic commence par effacer, provoquer, relire.
    trie.register('clear ntp statistics', 'Clear NTP packet statistics', () => {
      getNtpAgent(this.d())?.clearCounters();
      return '';
    });
    trie.register('clear history', 'Clear command history buffer', () => {
      this.cmdHistory = [];
      return '';
    });
    trie.registerGreedy('terminal', 'Set terminal parameters', (args) =>
      this.handleTerminalCommand(args), [
      { keyword: 'length',  description: 'Set number of lines on a screen' },
      { keyword: 'width',   description: 'Set width of the display terminal' },
      { keyword: 'monitor', description: 'Copy debug output to the current terminal line' },
      { keyword: 'history', description: 'Enable and control the command history function' },
      { keyword: 'no',      description: 'Negate a command or set its defaults' },
    ]);

    // NOTE: `copy` is a privileged-EXEC command — it is registered once, with
    // full file-system semantics, in registerPrivilegedExtras (the rich
    // handler). Registering a simple stub here too (this method runs for both
    // the user and privileged tries) used to shadow it AND leak `copy` into
    // user EXEC; that has been removed.

    // Generic device-info show family — missing on BOTH the Cisco
    // router and switch, so it lives here in the shared base (DRY).
    // Un greedy sur `show ntp` AVALAIT toute sa queue : `show ntp
    // associations detail`, `show ntp authentication-keys`, `show ntp
    // config` et meme `show ntp packets` -- qui n'existe pas -- rendaient
    // tous le tableau des associations. Chaque sous-commande est
    // desormais un chemin reel, et ce que la plateforme n'a pas est
    // refuse comme IOS refuse (meme defaut que `display vrrp`, lot V15).
    trie.register('show ntp status', 'Display NTP status', () => showNtpStatus(this.cs()));
    trie.register('show ntp authentication-keys', 'Display NTP authentication keys',
      () => showNtpAuthenticationKeys(this.cs()));
    trie.register('show ntp associations detail', 'Detailed NTP association state',
      () => showNtpAssociationsDetail(this.cs()));
    trie.register('show ntp associations', 'NTP associations',
      () => showNtpAssociations(this.cs()));
    // Refusee au lot N1 faute de compteurs : ils existent (lot N8).
    trie.registerGreedy('show ntp packets', 'NTP packet statistics', (a) => {
      if (a.length === 0) return showNtpPackets(this.cs());
      if (a[0].toLowerCase() !== 'mode') return CISCO_ERRORS.INVALID_INPUT;
      if (!a[1]) return CISCO_ERRORS.INCOMPLETE;
      return showNtpPackets(this.cs(), a[1]);
    }, [{ keyword: 'mode', description: 'Display packets by NTP mode' }]);
    // Pas de greedy de repli : sans lui, l'arbre lui-meme refuse
    // `show ntp packets` avec le curseur d'IOS, ce qu'un repli maison
    // ne saurait pas placer aussi bien.
    trie.registerGreedy('show cdp', 'Display CDP information', (a) =>
      showCdp(this.cs(), a.join(' '), this.configState.isEnabled('cdp')), [
      { keyword: 'neighbors', description: 'CDP neighbor entries' },
      { keyword: 'entry',     description: 'Information for specific neighbor entry' },
      { keyword: 'interface', description: 'CDP interface status and configuration' },
      { keyword: 'traffic',   description: 'CDP statistics' },
    ]);
    trie.registerGreedy('show lldp', 'Display LLDP information', (a) =>
      showLldp(this.cs(), a.join(' '), this.configState.isEnabled('lldp')), [
      { keyword: 'neighbors', description: 'LLDP neighbor entries' },
      { keyword: 'interface', description: 'LLDP interface status and configuration' },
    ]);
    trie.register('show snmp community', 'Display SNMP communities', () => showSnmpCommunity(this.cs()));
    trie.register('show snmp host', 'Display SNMP hosts', () => showSnmpHost(this.cs()));
    trie.register('show snmp group', 'Display SNMP groups', () => showSnmpGroup(this.cs()));
    trie.register('show snmp user', 'Display SNMP users', () => showSnmpUser(this.cs()));
    trie.register('show snmp view', 'Display SNMP views', () => showSnmpView(this.cs()));
    trie.register('show snmp engineID', 'Display SNMP engine ID', () => showSnmpEngineId(this.cs()));
    trie.registerGreedy('show snmp', 'Display SNMP status', () => showSnmp(this.cs(), this.getChassisProfile()));
    trie.registerGreedy('show controllers', 'Display controller status', (a) =>
      showControllers(this.cs(), a.join(' ')));
    trie.registerGreedy('show environment', 'Display environment', () =>
      showEnvironment());
    trie.registerGreedy('show line', 'Display TTY lines', (a) =>
      showLine(this.cs(), a));
    /**
     * `show parser view [all]`.
     *
     * Sans argument : la vue COURANTE de cette session. Avec `all` : les
     * vues declarees sur l'equipement. Deux questions differentes, deux
     * reponses -- c'est le defaut qu'on vient de refermer sur `show aaa`.
     */
    trie.registerGreedy('show parser view', 'Display CLI view information', (args) => {
      const sec = getSecurityConfig(this.d());
      if (args.length === 0) {
        return `Current view is '${this.activeParserView ?? 'root'}'`;
      }
      if (args[0].toLowerCase() !== 'all') throw new CliInvalidInput({ token: args[0] });
      if (sec.parserViews.size === 0) return 'No views are configured';
      const lignes = ['Views/Superviews Present in System:'];
      for (const v of sec.parserViews.values()) lignes.push(`  ${v.name}  `);
      return lignes.join('\n');
    });
    // Le nœud intermédiaire porte sa description, APRÈS l'enregistrement
    // qui le crée : `describeNode` sort en silence sur un nœud absent.
    trie.describeNode('show parser', 'Display parser information');

    trie.register('show ip ssh', 'Display SSH server status', () => {
      const sec = getSecurityConfig(this.d());
      return showIpSsh(sec.ssh, sec.cryptoKeys.length > 0 ? sec.cryptoKeys[0].modulus : null);
    });

    /*
     * `show ip http server status` et `... all` LISENT le service, elles
     * ne récitent pas un texte : le port, la méthode d'authentification
     * et les limites affichées sont ceux que la machine applique. Sur
     * IOS, `all` est la réunion des vues de la famille ; ici les deux
     * autres (`connection`, `session-module`) n'ont pas de matière —
     * aucune connexion n'est retenue, aucun module n'est déclaré — donc
     * `all` rend l'état et le dit, plutôt que d'inventer deux tableaux.
     */
    trie.register('show ip http server status', 'Display HTTP server status', () =>
      getHttpService(this.d())?.statusLines().join('\n') ?? '');
    trie.register('show ip http server all', 'Display all HTTP server information', () =>
      getHttpService(this.d())?.statusLines().join('\n') ?? '');
    trie.register('show ip ssh known-hosts', 'Display learned SSH host keys', () => {
      const dev = this.d() as unknown as { _getSshKnownHosts?: () => { renderCisco: () => string } };
      return dev._getSshKnownHosts?.().renderCisco() ?? '';
    });
    trie.registerGreedy('show ssh', 'Display SSH sessions', () =>
      showSshSessions());
    trie.registerGreedy('show hosts', 'Display host cache', () => showHosts(this.d() as unknown as Parameters<typeof showHosts>[0]));
    trie.registerGreedy('show ip vrf', 'Display VRFs', (args) => {
      const sub = args[0]?.toLowerCase();
      if (sub === 'detail') return showVrfDetail(this.d(), args[1]);
      if (sub === 'interfaces') return showVrfInterfaces(this.d());
      return showVrf(this.d());
    }, [
      { keyword: 'detail', description: 'Detailed VRF information' },
      { keyword: 'interfaces', description: 'Interfaces bound to a VRF' },
    ]);
    trie.registerGreedy('show vrf', 'Display VRFs', (args) => {
      const sub = args[0]?.toLowerCase();
      if (sub === 'detail') return showVrfDetail(this.d(), args[1]);
      if (sub === 'interfaces') return showVrfInterfaces(this.d());
      return showVrf(this.d());
    }, [
      { keyword: 'detail', description: 'Detailed VRF information' },
      { keyword: 'interfaces', description: 'Interfaces bound to a VRF' },
    ]);
    trie.registerGreedy('show adjacency', 'Display CEF adjacency table', () =>
      showAdjacency(this.d() as unknown as Parameters<typeof showAdjacency>[0]));
    trie.registerGreedy('show ip as-path-access-list', 'Display AS-path filters', (args) => {
      const store = this.asPathLists();
      const wanted = args[0];
      const keys = wanted ? [wanted] : [...store.keys()];
      const out: string[] = [];
      for (const k of keys) {
        const rules = store.get(k);
        if (!rules) continue;
        out.push(`AS path access list ${k}`);
        for (const rule of rules) out.push(`    ${rule}`);
      }
      return out.join('\n');
    });
    trie.registerGreedy('show ip community-list', 'Display BGP community lists', (args) => {
      const store = this.communityLists();
      const wanted = args[0];
      const out: string[] = [];
      for (const [key, rules] of store) {
        const [kind, name] = key.split(' ');
        if (wanted && wanted !== name) continue;
        out.push(`Community ${kind} list ${name}`);
        for (const rule of rules) out.push(`    ${rule}`);
      }
      return out.join('\n');
    });
    if (this.hasSwitchingHardware()) {
      trie.registerGreedy('show redundancy', 'Display redundancy state', () =>
        showRedundancy());
    }
    trie.registerGreedy('show file', 'Display file systems', () =>
      showFileSystems(this.fs(), this.readStartupConfig()?.length ?? 0), [
      { keyword: 'systems', description: 'File system information' },
    ]);
    trie.register('show calendar', 'Display hardware calendar', () =>
      showCalendar(this.cs()));
    trie.registerGreedy('show terminal', 'Display terminal parameters', () =>
      `${showTerminal(this.terminalLength, this.terminalWidth, this.terminalHistorySize)}\n`
      + `Monitor parameter: ${this.terminalMonitor ? 'enabled' : 'disabled'}`);
    trie.registerGreedy('show buffers', 'Display buffer pools', () =>
      showBuffers());
    trie.registerGreedy('show tcp', 'Display TCP connections', () =>
      showTcpBrief(), [
      { keyword: 'brief', description: 'Brief display of TCP connection status' },
    ]);
    trie.registerGreedy('show sockets', 'Display open sockets', () =>
      showSockets());
    trie.registerGreedy('show stacks', 'Display process stacks', () =>
      showStacks());
    trie.registerGreedy('show reload', 'Display reload schedule', () =>
      showReload(this.getScheduledReloadMs()));
    trie.registerGreedy('show aaa', 'Display AAA state', (a) => {
      const dev = this.d() as unknown as Router;
      return showAaa(getSecurityConfig(dev), a.join(' '));
    });
    trie.register('show aliases', 'Display command aliases', () =>
      this.aliases.render());
  }

  /** Map a CLI alias mode keyword to the repository's AliasMode. */
  private aliasMode(token: string): AliasMode {
    switch (token) {
      case 'configure': return 'configure';
      case 'interface': return 'interface';
      case 'router': return 'router';
      default: return 'exec';
    }
  }

  /**
   * Handle `terminal length <n>` / `terminal width <n>` / `terminal no length`
   * (Cisco IOS exec preference, per-session).
   *
   * Recognised forms:
   *   terminal length <0-512>   — set pager rows (0 = pager off)
   *   terminal no length        — restore default (24)
   *   terminal width <0-512>    — set column hint
   *   terminal no width         — restore default (80)
   *   terminal history size <n> — display-history ring length (no-op stored)
   *   terminal monitor          — accept silently (logging redirect to vty)
   *   terminal no monitor       — accept silently
   *
   * Returns CISCO_ERRORS.INVALID_INPUT on unknown sub-commands so an
   * operator typo doesn't look like a silent success.
   */
  protected handleTerminalCommand(args: string[]): string {
    if (args.length === 0) {
      return CISCO_ERRORS.INCOMPLETE;
    }
    const head = args[0].toLowerCase();
    const rest = args.slice(1);

    if (head === 'length') {
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const n = parseInt(rest[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > 512) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.terminalLength = n;
      return '';
    }
    if (head === 'width') {
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const n = parseInt(rest[0], 10);
      if (!Number.isFinite(n) || n < 40 || n > 512) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.terminalWidth = n;
      return '';
    }
    if (head === 'no') {
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub === 'length') { this.terminalLength = 24; return ''; }
      if (sub === 'width')  { this.terminalWidth  = 80; return ''; }
      if (sub === 'history') { this.terminalHistoryEnabled = false; return ''; }
      if (sub === 'monitor' || (sub.length >= 3 && 'monitor'.startsWith(sub))) { this.terminalMonitor = false; this.terminalMonitorExplicit = true; return ''; }
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (head === 'monitor' || (head.length >= 3 && 'monitor'.startsWith(head))) { this.terminalMonitor = true; this.terminalMonitorExplicit = true; return ''; }
    if (head === 'exec') return '';
    if (head === 'history') {
      if ((rest[0] ?? '').toLowerCase() === 'size') {
        const n = parseInt(rest[1] ?? '', 10);
        if (!Number.isFinite(n) || n < 0 || n > 256) return CISCO_ERRORS.INVALID_INPUT;
        this.terminalHistorySize = n;
        this.terminalHistoryEnabled = true;
        return '';
      }
      if (rest.length === 0) { this.terminalHistoryEnabled = true; return ''; }
      return '';
    }
    return CISCO_ERRORS.INVALID_INPUT;
  }

  /**
   * `[no] service timestamps [debug|log] [uptime | datetime [msec]
   * [localtime] [show-timezone] [year]]`.
   *
   * The bare form is legal on IOS and means `service timestamps debug
   * uptime` — refusing it (the state this replaced) rejected a command a
   * real router accepts. Bare `no service timestamps` turns BOTH channels
   * off, since with no channel named there is nothing to restrict it to.
   */
  private applyServiceTimestamps(args: string[], negate: boolean): string {
    const mots = args.map(s => s.toLowerCase());
    this.attachLoggingToDevice(this.d());
    const canaux: Array<'debug' | 'log'> = mots[0] === 'debug' || mots[0] === 'log'
      ? [mots[0] as 'debug' | 'log']
      : ['debug', 'log'];
    const nomme = canaux.length === 1;
    const reste = mots.slice(nomme ? 1 : 0);

    if (negate) {
      if (reste.length > 0 && !this.horodatageOptionsValides(reste)) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      for (const c of canaux) this.logging.setTimestampSpec(c, disabledTimestampSpec());
      return '';
    }

    if (!nomme && reste.length > 0) return CISCO_ERRORS.INVALID_INPUT;
    const spec = this.parseHorodatage(reste);
    if (!spec) return CISCO_ERRORS.INVALID_INPUT;
    for (const c of canaux) this.logging.setTimestampSpec(c, { ...spec });
    return '';
  }

  private horodatageOptionsValides(mots: string[]): boolean {
    return this.parseHorodatage(mots) !== null;
  }

  /**
   * `uptime` takes no modifier of its own on IOS beyond `msec`; the rest
   * only mean something for a real date, so accepting them after `uptime`
   * would store a flag nothing can read.
   */
  private parseHorodatage(mots: string[]): TimestampSpec | null {
    const spec = bareTimestampSpec();
    if (mots.length === 0) return spec;
    if (mots[0] !== 'uptime' && mots[0] !== 'datetime') return null;
    spec.format = mots[0];
    for (const m of mots.slice(1)) {
      if (m === 'msec') { spec.msec = true; continue; }
      if (spec.format !== 'datetime') return null;
      if (m === 'localtime') { spec.localtime = true; continue; }
      if (m === 'show-timezone') { spec.showTimezone = true; continue; }
      if (m === 'year') { spec.year = true; continue; }
      return null;
    }
    return spec;
  }

  /** Public read accessor — used by CLITerminalSession to size the pager. */
  getTerminalLength(): number { return this.terminalLength; }
  /** Public read accessor — symmetric with getTerminalLength. */
  getTerminalWidth(): number { return this.terminalWidth; }

  private registerCommonUserCommands(): void {
    this.userTrie.registerGreedy('enable', 'Enter privileged EXEC at a specific level', (args) => {
      if (args[0]?.toLowerCase() === 'view') return this.entrerDansUneVue(args.slice(1));
      const lvl = args[0] ? parseInt(args[0], 10) : 15;
      if (!Number.isFinite(lvl) || lvl < 0 || lvl > 15) {
        return "% Invalid input detected at '^' marker.";
      }
      // Authentication itself (real IOS "Password:" prompt against
      // `enable secret` / `enable password level N`) happens BEFORE this
      // handler runs, via interactionPlanFor()'s `enable` plan — this is
      // only ever reached once the password has already been verified
      // (or none was configured for the target level, matching real IOS's
      // "no password set = no gate" behaviour). Direct, non-interactive
      // callers (device.executeCommand('enable') in tests) go straight
      // here too, which is correct: nothing could have prompted them.
      this.currentPrivilegeLevel = lvl;
      this.mode = lvl === 15 ? 'privileged' : 'user';
      // `logging userinfo` : c'est ICI que la commande a un sens, et
      // c'est le seul endroit où elle peut en avoir. Une console sans
      // authentification n'a pas d'utilisateur à nommer, et IOS écrit
      // alors `unknown` plutôt que d'en inventer un.
      if (this.logging.userInfo) {
        this.attachLoggingToDevice(this.d());
        const console = this.configSessionLabel === 'console';
        this.logging.append('notifications', 'sys',
          `Privilege level set to ${lvl} by ${console ? 'unknown' : this.configSessionLabel}`
          + ` on ${console ? 'console' : 'vty'}`,
          true, 'PRIV_AUTH_PASS');
      }
      return '';
    });

    this.registerCommonShowCommands(this.userTrie);
    // ARP show commands (shared between router and switch)
    registerArpShowCommands(this.userTrie, () => this.d());
  }

  private registerCommonPrivilegedCommands(): void {
    this.registerTestAaaCommand();
    this.privilegedTrie.register('enable', 'Turn on privileged commands', () => '');
    this.privilegedTrie.registerGreedy('enable view', 'Enter a CLI view', (args) =>
      this.entrerDansUneVue(args));

    this.privilegedTrie.register('configure terminal', 'Enter configuration mode', () => {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    });

    this.privilegedTrie.register('disable', 'Return to user EXEC mode', () => {
      this.mode = 'user';
      this.currentPrivilegeLevel = 1;
      return '';
    });

    const saveRunningToStartup = () =>
      `Destination filename [startup-config]?\n${this.onSave()}`;

    this.privilegedTrie.register('write memory', 'Save configuration', () => this.onSave());

    // `archive config` / `show archive` — enregistrées ici, donc pour le
    // routeur ET le switch, parce qu'un Catalyst connaît cette famille
    // tout autant qu'un routeur et qu'elle était refusée en bloc sur le
    // switch. Un équipement sans service d'archivage rend le message de
    // table vide plutôt que de planter.
    registerArchiveExecCommands(
      this.privilegedTrie,
      () => this.archiveService(),
      () => (this.d() as unknown as { getRunningConfig?: () => string }).getRunningConfig?.() ?? '',
    );

    const eraseNvram = () => {
      this.onErase();
      return 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete';
    };
    this.privilegedTrie.register('write erase', 'Erase saved configuration', eraseNvram);
    this.privilegedTrie.register('erase startup-config', 'Erase saved configuration', eraseNvram);
    this.privilegedTrie.register('erase nvram:', 'Erase NVRAM', eraseNvram);

    // Single greedy `copy` handler so any source/destination pair is consumed
    // as arguments (an exact `copy running-config startup-config` registration
    // would create an intermediate node that hides other destinations from the
    // greedy match). IOS keyword abbreviations (`copy run start`) are expanded.
    const norm = (a: string): string => {
      const t = a.toLowerCase();
      if (t && 'running-config'.startsWith(t)) return 'running-config';
      if (t && 'startup-config'.startsWith(t)) return 'startup-config';
      return t;
    };
    this.privilegedTrie.registerSuggestions('copy', [
      { keyword: 'running-config', description: 'Current running configuration' },
      { keyword: 'startup-config', description: 'Saved startup configuration' },
      { keyword: 'tftp:',          description: 'Trivial File Transfer Protocol' },
      { keyword: 'flash:',         description: 'Local flash filesystem' },
      { keyword: 'scp:',           description: 'Secure Copy' },
    ]);
    this.privilegedTrie.registerSuggestions('copy running-config', [
      { keyword: 'startup-config', description: 'Save to NVRAM startup-config' },
      { keyword: 'tftp:',          description: 'Upload to TFTP server' },
      { keyword: 'scp:',           description: 'Upload over SCP' },
      { keyword: 'flash:',         description: 'Save to flash filesystem' },
    ]);
    this.privilegedTrie.registerSuggestions('debug', [
      { keyword: 'all',      description: 'Enable all debugging' },
      { keyword: 'ip',       description: 'Debug IP subsystem' },
      { keyword: 'ipv6',     description: 'Debug IPv6 subsystem' },
      { keyword: 'crypto',   description: 'Debug crypto subsystem' },
      { keyword: 'dhcp',     description: 'Debug DHCP' },
    ]);
    this.privilegedTrie.registerSuggestions('debug ip', [
      { keyword: 'icmp',     description: 'Debug ICMP packets' },
      { keyword: 'packet',   description: 'Debug all IP packets' },
      { keyword: 'ospf',     description: 'Debug OSPF' },
      { keyword: 'routing',  description: 'Debug routing table changes' },
      { keyword: 'nat',      description: 'Debug NAT' },
      { keyword: 'dhcp',     description: 'Debug DHCP' },
    ]);
    this.privilegedTrie.registerSuggestions('write', [
      { keyword: 'memory',   description: 'Write to NVRAM' },
      { keyword: 'terminal', description: 'Write to terminal (display running-config)' },
      { keyword: 'erase',    description: 'Erase NVRAM' },
    ]);
    this.privilegedTrie.registerSuggestions('clear', [
      { keyword: 'arp-cache', description: 'Clear ARP cache' },
      { keyword: 'counters',  description: 'Clear interface counters' },
      { keyword: 'ip',        description: 'Clear an IP subsystem' },
      { keyword: 'mac',       description: 'Clear MAC address tables' },
      { keyword: 'logging',   description: 'Clear logging buffer' },
    ]);
    const showIpRouteHints = [
      { keyword: 'static',    description: 'Static routes' },
      { keyword: 'connected', description: 'Directly connected networks' },
      { keyword: 'ospf',      description: 'OSPF-learned routes' },
      { keyword: 'rip',       description: 'RIP-learned routes' },
      { keyword: 'eigrp',     description: 'EIGRP-learned routes' },
      { keyword: 'bgp',       description: 'BGP-learned routes' },
    ];
    this.privilegedTrie.registerSuggestions('show ip route', showIpRouteHints);
    this.userTrie.registerSuggestions('show ip route', showIpRouteHints);
    this.privilegedTrie.registerGreedy('copy', 'Copy a file', (args) => {
      if (!args[0] || !args[1]) return '% Incomplete command.';
      const src = norm(args[0]);
      const dst = norm(args[1]);
      const dev = this.d() as unknown as {
        _restoreStartupConfig?: () => boolean;
        _readFlashFile?: (name: string) => string | null;
        _writeFlashFile?: (name: string, content: string) => void;
        _applyConfigText?: (text: string) => void;
        getRunningConfig?: () => string;
      };

      if (src === 'running-config' && dst === 'startup-config') return saveRunningToStartup();

      if (dst === 'running-config' && (src === 'startup-config' || src === 'nvram:')) {
        // Devices that model NVRAM (the switch) report an empty NVRAM; the
        // router keeps its shell-level snapshot, so preserve the OK path.
        if (typeof dev._restoreStartupConfig === 'function' && !dev._restoreStartupConfig()) {
          return '%% Non-volatile configuration memory is not present';
        }
        return 'Destination filename [running-config]?\n[OK]';
      }

      const fileSrc = src.startsWith('flash:') || src.startsWith('tftp:') || src.startsWith('ftp:');
      const fileDst = dst.startsWith('flash:') || dst.startsWith('tftp:') || dst.startsWith('ftp:') || dst.startsWith('nvram:');

      if (dst === 'running-config' && fileSrc) {
        if (typeof dev._readFlashFile === 'function') {
          const content = dev._readFlashFile(args[0]);
          if (content == null) return `%Error opening ${args[0]} (No such file or directory)`;
          dev._applyConfigText?.(content);
        }
        return 'Destination filename [running-config]?\n[OK]';
      }

      if (src === 'running-config' && fileDst) {
        dev._writeFlashFile?.(args[1], dev.getRunningConfig?.() ?? '');
        return `Destination filename [${args[1]}]?\nWriting ${args[1]} ... [OK]`;
      }

      return `[OK]`;
    });
    this.privilegedTrie.registerGreedy('reload', 'Reload the device', (args) => {
      if (args[0]?.toLowerCase() === 'cancel') {
        if (this.reloadTimer !== null) { this.schedulerFor(this.d()).clear(this.reloadTimer); this.reloadTimer = null; }
        this.scheduledReloadAtMs = null;
        return 'Reload cancelled.';
      }
      if (args[0]?.toLowerCase() === 'in') {
        if (!args[1]) return '% Incomplete command.';
        if (!/^\d+$/.test(args[1])) return "% Invalid input detected at '^' marker.";
        const min = parseInt(args[1], 10);
        this.armReloadTimer(min * 60_000);
        return `Reload scheduled in ${min} minute${min === 1 ? '' : 's'}`;
      }
      if (args[0]?.toLowerCase() === 'at') {
        if (!args[1]) return '% Incomplete command.';
        return `Reload scheduled for ${args[1]}`;
      }
      return this.performImmediateReload();
    });
    this.privilegedTrie.register('debug arp', 'Enable ARP debug', () => {
      const svc = (this.d() as unknown as { getDebugService?: () => { enable: (c: string, scope?: string) => string } }).getDebugService?.();
      return svc ? svc.enable('ip.arp') : 'ARP packet debugging is on';
    });
    this.privilegedTrie.register('no debug arp', 'Disable ARP debug', () => {
      const svc = (this.d() as unknown as { getDebugService?: () => { disable: (c: string) => string } }).getDebugService?.();
      return svc ? svc.disable('ip.arp') : 'ARP packet debugging is off';
    });
    this.privilegedTrie.registerGreedy('debug ip', 'Enable IP debug', (args) => {
      const sub = args.join(' ').toLowerCase();
      const dev = this.d() as unknown as { getDebugService?: () => { enable: (c: 'ip.icmp' | 'ip.packet' | 'ip.tcp' | 'ip.udp' | 'ip.nat' | 'ip.arp' | 'ip.routing' | 'ip.dhcp.server' | 'ip.ssh' | 'ip.rip' | 'ip.eigrp' | 'ip.bgp' | 'ip.nhrp' | 'ip.pim', scope?: string, detail?: boolean) => string } };
      const svc = dev.getDebugService?.();
      if (!svc) return 'IP debugging is on';
      if (sub === 'packet') return svc.enable('ip.packet');
      if (sub.startsWith('packet ')) {
        const detail = args.some((a) => /^detail$/i.test(a));
        const aclName = args.slice(1).find((a) => !/^detail$/i.test(a));
        if (!aclName) return svc.enable('ip.packet', undefined, detail);
        svc.enable('ip.packet', aclName, detail);
        return `IP packet debugging is on for access list ${aclName}${detail ? ' (detailed)' : ''}`;
      }
      if (sub === 'icmp') return svc.enable('ip.icmp');
      if (sub === 'tcp' || sub.startsWith('tcp ')) {
        const reste = args.slice(1).filter(a => !/^transactions$/i.test(a));
        const acl = reste[0];
        svc.enable('ip.tcp', acl);
        return acl
          ? `TCP special event debugging is on for access list ${acl}`
          : 'TCP special event debugging is on';
      }
      if (sub === 'udp' || sub.startsWith('udp ')) {
        const acl = args.slice(1)[0];
        svc.enable('ip.udp', acl);
        return acl
          ? `UDP packet debugging is on for access list ${acl}`
          : 'UDP packet debugging is on';
      }
      if (sub === 'nat') return svc.enable('ip.nat');
      if (sub === 'arp') return svc.enable('ip.arp');
      if (sub === 'routing') return svc.enable('ip.routing');
      if (sub.startsWith('dhcp server')) return svc.enable('ip.dhcp.server');
      if (sub === 'ssh') return svc.enable('ip.ssh');
      if (sub === 'rip') return svc.enable('ip.rip');
      if (sub === 'eigrp') return svc.enable('ip.eigrp');
      if (sub === 'bgp') return svc.enable('ip.bgp');
      if (sub === 'nhrp') return svc.enable('ip.nhrp');
      if (sub === 'pim') return svc.enable('ip.pim');
      throw new CliInvalidInput({ token: args[0] });
    });
    this.privilegedTrie.registerGreedy('no debug ip', 'Disable IP debug', (args) => {
      const sub = args.join(' ').toLowerCase();
      const dev = this.d() as unknown as { getDebugService?: () => { disable: (c: 'ip.icmp' | 'ip.packet' | 'ip.tcp' | 'ip.udp' | 'ip.nat' | 'ip.arp' | 'ip.routing' | 'ip.dhcp.server' | 'ip.ssh' | 'ip.rip' | 'ip.eigrp' | 'ip.bgp' | 'ip.nhrp' | 'ip.pim') => string } };
      const svc = dev.getDebugService?.();
      if (!svc) return 'IP debugging is off';
      if (sub === 'packet' || sub.startsWith('packet ')) return svc.disable('ip.packet');
      if (sub === 'icmp') return svc.disable('ip.icmp');
      if (sub === 'tcp' || sub.startsWith('tcp ')) return svc.disable('ip.tcp');
      if (sub === 'udp' || sub.startsWith('udp ')) return svc.disable('ip.udp');
      if (sub === 'nat') return svc.disable('ip.nat');
      if (sub === 'arp') return svc.disable('ip.arp');
      if (sub === 'routing') return svc.disable('ip.routing');
      if (sub.startsWith('dhcp server')) return svc.disable('ip.dhcp.server');
      if (sub === 'ssh') return svc.disable('ip.ssh');
      if (sub === 'rip') return svc.disable('ip.rip');
      if (sub === 'eigrp') return svc.disable('ip.eigrp');
      if (sub === 'bgp') return svc.disable('ip.bgp');
      if (sub === 'nhrp') return svc.disable('ip.nhrp');
      if (sub === 'pim') return svc.disable('ip.pim');
      throw new CliInvalidInput({ token: args[0] });
    });
    const debugSvc = () => {
      const dev = this.d() as unknown as { getDebugService?: () => { enable: (c: 'standby' | 'ip.eigrp' | 'ip.bgp') => string; disable: (c: 'standby' | 'ip.eigrp' | 'ip.bgp') => string } };
      return dev.getDebugService?.();
    };
    this.privilegedTrie.registerGreedy('debug standby', 'Debug HSRP', (_args) =>
      debugSvc()?.enable('standby') ?? '');
    this.privilegedTrie.registerGreedy('debug eigrp', 'Debug EIGRP', (_args) =>
      debugSvc()?.enable('ip.eigrp') ?? '');
    this.privilegedTrie.registerGreedy('no debug standby', 'Disable HSRP debug', (_args) =>
      debugSvc()?.disable('standby') ?? '');
    this.privilegedTrie.registerGreedy('no debug eigrp', 'Disable EIGRP debug', (_args) =>
      debugSvc()?.disable('ip.eigrp') ?? '');
    const genericDebug = () => (this.d() as unknown as {
      getDebugService?: () => {
        enable(c: string, scope?: string): string;
        disable(c: string): string;
        addCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string;
        removeCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string;
        clearConditions(): void;
      };
    }).getDebugService?.();
    this.privilegedTrie.registerGreedy('debug interface', 'Debug interface state changes', (args) => {
      const svc = genericDebug();
      const iface = args.join(' ').trim();
      if (!svc) return 'Interface debugging is on';
      return svc.enable('interface', iface || undefined);
    });
    this.privilegedTrie.registerGreedy('no debug interface', 'Disable interface debug', () =>
      genericDebug()?.disable('interface') ?? '');
    this.privilegedTrie.registerGreedy('debug lldp', 'Debug LLDP', () => genericDebug()?.enable('lldp.packets') ?? 'LLDP packets debugging is on');
    this.privilegedTrie.registerGreedy('debug cdp', 'Debug CDP', () => genericDebug()?.enable('cdp.packets') ?? 'CDP packets debugging is on');
    this.privilegedTrie.registerGreedy('no debug lldp', 'Disable LLDP debug', () => genericDebug()?.disable('lldp.packets') ?? '');
    this.privilegedTrie.registerGreedy('no debug cdp', 'Disable CDP debug', () => genericDebug()?.disable('cdp.packets') ?? '');
    // `nd`, `icmp` and `packet` are three DIFFERENT IOS commands. Taking
    // the sub-keyword for an access-list name answered `debugging is on
    // for access list nd` — a filter on a list nobody declared.
    const ipv6DebugCategory = (mot: string): 'ipv6.packet' | 'ipv6.nd' | 'ipv6.icmp' | null => {
      if (mot === '' || mot.startsWith('packet')) return 'ipv6.packet';
      if ('nd'.startsWith(mot) || mot === 'nd') return 'ipv6.nd';
      if ('icmp'.startsWith(mot)) return 'ipv6.icmp';
      return null;
    };
    this.privilegedTrie.registerGreedy('debug ipv6', 'Debug IPv6', (args) => {
      const svc = genericDebug();
      const mots = args.map((a) => a.toLowerCase());
      const category = ipv6DebugCategory(mots[0] ?? '');
      if (!category) throw new CliInvalidInput({ token: args[0] });
      if (!svc) return 'IPv6 packet debugging is on';
      // Only `packet` takes an access list; the other two filter nothing.
      // The keyword matches case-insensitively, the LIST NAME does not —
      // an ACL name is case-sensitive on IOS, and lowercasing it made
      // the filter name a list nobody declared.
      const acl = category === 'ipv6.packet' ? args.slice(1).join(' ') : '';
      return acl ? svc.enable(category, acl) : svc.enable(category);
    });
    this.privilegedTrie.addCompletionKeywords('debug ipv6', [
      { keyword: 'icmp', description: 'ICMPv6 messages' },
      { keyword: 'nd', description: 'ICMPv6 Neighbor Discovery' },
      { keyword: 'packet', description: 'IPv6 packets' },
    ]);
    this.privilegedTrie.registerGreedy('no debug ipv6', 'Disable IPv6 debug', (args) => {
      const svc = genericDebug();
      const category = ipv6DebugCategory((args[0] ?? '').toLowerCase());
      if (!category) throw new CliInvalidInput({ token: args[0] });
      return svc?.disable(category) ?? '';
    });
    this.privilegedTrie.registerGreedy('debug condition', 'Restrict every debug to a condition', (args) => {
      const svc = genericDebug();
      if (!svc) return '';
      const kind = (args[0] ?? '').toLowerCase();
      const value = args.slice(1).join(' ').trim();
      if (kind !== 'interface' && kind !== 'vrf' && kind !== 'ip') return CISCO_ERRORS.INVALID_INPUT;
      if (!value) return CISCO_ERRORS.INCOMPLETE;
      const resolved = kind === 'interface'
        ? (this.resolveInterfaceNameForDebug(value) ?? value)
        : value;
      return svc.addCondition(kind, resolved);
    });
    this.privilegedTrie.registerGreedy('no debug condition', 'Remove a debug condition', (args) => {
      const svc = genericDebug();
      if (!svc) return '';
      const kind = (args[0] ?? '').toLowerCase();
      if (kind === 'all') { svc.clearConditions(); return 'All conditions have been removed'; }
      // `no debug condition <n>` : la forme par NUMÉRO, celle qu'IOS
      // annonce lui-même en posant la condition (`Condition 1 set`) et
      // la seule qui soit praticable — retirer par valeur oblige à
      // retaper l'ACL ou l'interface au caractère près.
      if (/^\d+$/.test(kind)) return svc.removeConditionById(parseInt(kind, 10));
      const value = args.slice(1).join(' ').trim();
      if (kind !== 'interface' && kind !== 'vrf' && kind !== 'ip') return CISCO_ERRORS.INVALID_INPUT;
      if (!value) return CISCO_ERRORS.INCOMPLETE;
      const resolved = kind === 'interface'
        ? (this.resolveInterfaceNameForDebug(value) ?? value)
        : value;
      return svc.removeCondition(kind, resolved);
    });
    const SIMPLE_DEBUG: ReadonlyArray<readonly [string, string, string]> = [
      ['debug vrrp', 'vrrp', 'Debug VRRP'],
      ['debug glbp', 'glbp', 'Debug GLBP'],
      ['debug radius', 'radius', 'Debug RADIUS'],
      ['debug tacacs', 'tacacs', 'Debug TACACS+'],
    ];
    for (const [path, category, description] of SIMPLE_DEBUG) {
      this.privilegedTrie.registerGreedy(path, description, () =>
        genericDebug()?.enable(category) ?? '');
      this.privilegedTrie.registerGreedy(`no ${path}`, `Disable ${description}`, () =>
        genericDebug()?.disable(category) ?? '');
    }
    this.privilegedTrie.registerGreedy('debug ntp', 'Debug NTP', (args) => {
      const svc = genericDebug();
      if (!svc) return '';
      const sub = (args[0] ?? 'events').toLowerCase();
      if ('events'.startsWith(sub)) return svc.enable('ntp.events');
      if ('packets'.startsWith(sub)) return svc.enable('ntp.packets');
      throw new CliInvalidInput({ token: args[0] });
    });
    this.privilegedTrie.registerGreedy('no debug ntp', 'Disable NTP debug', (args) => {
      const svc = genericDebug();
      if (!svc) return '';
      const sub = (args[0] ?? 'events').toLowerCase();
      if ('events'.startsWith(sub)) return svc.disable('ntp.events');
      if ('packets'.startsWith(sub)) return svc.disable('ntp.packets');
      throw new CliInvalidInput({ token: args[0] });
    });
    this.privilegedTrie.registerGreedy('debug aaa', 'Debug AAA', (args) => {
      const svc = genericDebug();
      if (!svc) return '';
      const sub = (args[0] ?? '').toLowerCase();
      if (sub && 'authentication'.startsWith(sub)) return svc.enable('aaa.authentication');
      if (sub && 'authorization'.startsWith(sub)) return svc.enable('aaa.authorization');
      if (sub && 'accounting'.startsWith(sub)) return svc.enable('aaa.accounting');
      throw new CliInvalidInput({ token: args[0] });
    });
    this.privilegedTrie.registerGreedy('no debug aaa', 'Disable AAA debug', (args) => {
      const svc = genericDebug();
      if (!svc) return '';
      const sub = (args[0] ?? '').toLowerCase();
      if (sub && 'authentication'.startsWith(sub)) return svc.disable('aaa.authentication');
      if (sub && 'authorization'.startsWith(sub)) return svc.disable('aaa.authorization');
      if (sub && 'accounting'.startsWith(sub)) return svc.disable('aaa.accounting');
      throw new CliInvalidInput({ token: args[0] });
    });
    if (this.hasVxlanHardware()) {
      this.privilegedTrie.registerGreedy('debug vxlan', 'Debug VXLAN', () => genericDebug()?.enable('vxlan') ?? 'VXLAN debugging is on');
      this.privilegedTrie.registerGreedy('no debug vxlan', 'Disable VXLAN debug', () => genericDebug()?.disable('vxlan') ?? '');
    }
    if (this.hasSwitchingHardware()) {
      this.privilegedTrie.registerGreedy('debug port-security', 'Debug port security', () => genericDebug()?.enable('port-security') ?? 'Port security debugging is on');
      this.privilegedTrie.registerGreedy('no debug port-security', 'Disable port-security debug', () => genericDebug()?.disable('port-security') ?? '');
    }
    this.privilegedTrie.registerGreedy('clear ip bgp', 'Clear BGP sessions', (_args) => '');
    // `clear ip eigrp neighbors` : la commande promet de rejeter les
    // adjacences, elle doit donc vraiment les rejeter — sinon elle serait
    // acceptée sans rien faire, ce qui est pire que refusée.
    this.privilegedTrie.registerGreedy('clear ip eigrp', 'Clear EIGRP neighbours/counters', (args) => {
      const dev = this.d() as unknown as {
        getEIGRPEngine?: () => { clearNeighbors?: () => void; resetTraffic?: () => void };
      };
      const e = dev.getEIGRPEngine?.();
      if (!e) return '';
      const quoi = (args[0] ?? 'neighbors').toLowerCase();
      if (quoi === 'traffic') e.resetTraffic?.();
      else e.clearNeighbors?.();
      return '';
    });
    this.privilegedTrie.registerGreedy('clear logging', 'Clear the syslog buffer', () => {
      this.attachLoggingToDevice(this.d());
      (this.logging as unknown as { clearBuffer?: () => void }).clearBuffer?.();
      return '';
    });
    registerLoggingClearCommands(this.privilegedTrie, this.loggingCommandContext());
    this.privilegedTrie.registerGreedy('clear counters', 'Clear interface counters', (args) => {
      const ports = this.d()._getPortsInternal();
      const target = args[0] && !/^\s*$/.test(args[0]) ? args.join(' ') : null;
      let count = 0;
      for (const [name, port] of ports) {
        if (target && name.toLowerCase() !== target.toLowerCase()) continue;
        (port as unknown as { resetCounters?: () => void }).resetCounters?.();
        count++;
      }
      if (count === 0) return '% No matching interface';
      const scope = target ? `interface ${target}` : 'all interfaces';
      return `Clear "show interface" counters on ${scope} [confirm]`;
    });
    this.privilegedTrie.registerGreedy('clear ip arp', 'Clear ARP cache', (args) => {
      const dev = this.d() as unknown as { _clearArpEntry?: (ip?: string) => number; arpTable?: Map<string, unknown> };
      if (args[0]) {
        const n = dev._clearArpEntry?.(args[0]) ?? 0;
        return n === 0 ? '% No matching ARP entry' : '';
      }
      dev.arpTable?.clear();
      return '';
    });
    this.privilegedTrie.registerGreedy('clear ip route', 'Clear routes (dynamic)', () => {
      const dev = this.d() as unknown as { _clearDynamicRoutes?: () => void };
      dev._clearDynamicRoutes?.();
      return '';
    });
    this.privilegedTrie.registerGreedy('clear line', 'Terminate a vty session', (args) => {
      const dev = this.d() as unknown as {
        getSshSessionRegistry?: () => {
          closeWhere: (p: (s: { lineIndex: number }) => boolean, reason?: string) => number;
        };
      };
      const registry = dev.getSshSessionRegistry?.();
      if (!registry) return '% Invalid input detected';
      const index = args[0]?.toLowerCase() === 'vty'
        ? Number.parseInt(args[1] ?? '', 10)
        : Number.parseInt(args[0] ?? '', 10);
      if (!Number.isInteger(index) || index < 0) return '% Incomplete command.';
      const closed = registry.closeWhere(s => s.lineIndex === index, 'admin');
      return closed > 0 ? '[confirm]\n [OK]' : '% Not allowed to clear that line';
    });
    this.privilegedTrie.registerGreedy('sntp server', 'SNTP server (alias for ntp server)', (args) => {
      if (!args[0]) return '% Incomplete command.';
      const target = this.resolveNtpTarget(args[0]);
      if (!target) return `Translating "${args[0]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
      const agent = getNtpAgent(this.d());
      agent?.addServer(target, args[1]?.toLowerCase() === 'prefer');
      return '';
    });
    this.configTrie.registerGreedy('sntp server', 'SNTP server (alias for ntp server)', (args) => {
      if (!args[0]) return '% Incomplete command.';
      const target = this.resolveNtpTarget(args[0]);
      if (!target) return `Translating "${args[0]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (line: string) => void };
      const agent = getNtpAgent(this.d());
      if (agent) agent.addServer(target, args[1]?.toLowerCase() === 'prefer');
      else dev._recordUnhandledConfigLine?.(`sntp server ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('sntp unicast', 'SNTP unicast client', (_args) => {
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (line: string) => void };
      dev._recordUnhandledConfigLine?.('sntp unicast client');
      return '';
    });
    this.configTrie.registerGreedy('no sntp server', 'Remove SNTP server', (args) => {
      const dev = this.d() as unknown as { _removeUnhandledConfigLine?: (l: string) => void };
      const agent = getNtpAgent(this.d());
      if (agent?.removeServer && args[0]) agent.removeServer(args[0]);
      dev._removeUnhandledConfigLine?.(`sntp server ${args.join(' ')}`);
      return '';
    });
    this.privilegedTrie.register('show sntp', 'Show SNTP', () => {
      const dev = this.d() as unknown as { getUnhandledConfigLines?: () => readonly string[] };
      const agent = getNtpAgent(this.d());
      if (agent?.getConfig) {
        const cfg = agent.getConfig();
        if (cfg.associations && cfg.associations.size > 0) {
          return ['SNTP server   Stratum   Version   Last Receive', ...[...cfg.associations.keys()].map(k => `${k.padEnd(14)}1         4         00:00:01`)].join('\n');
        }
      }
      const lines = dev.getUnhandledConfigLines?.() ?? [];
      const sntpLines = lines.filter(l => l.startsWith('sntp server'));
      if (sntpLines.length === 0) return 'No SNTP servers configured';
      return ['SNTP server   Stratum   Version   Last Receive', ...sntpLines.map(l => `${l.split(/\s+/)[2]?.padEnd(14) ?? ''}1         4         00:00:01`)].join('\n');
    });

    this.registerCommonShowCommands(this.privilegedTrie);

    // `clock set` est une commande d'EXEC privilégié sur IOS, et n'était
    // enregistrée qu'en mode configuration — donc refusée là où on la
    // tape. Elle est posée ici, à côté des autres commandes réservées au
    // privilégié, et surtout PAS dans `registerCommonShowCommands`, qui
    // est appelée une fois par arbre (utilisateur puis privilégié) : y
    // toucher au `privilegedTrie` l'enregistrerait deux fois, ce que
    // `command-trie-hygiene.test.ts` signale à juste titre.
    this.privilegedTrie.registerGreedy('clock set', 'Set the system clock',
      (args) => this.applyClockSet(args));

    // ARP commands (shared between router and switch)
    registerArpShowCommands(this.privilegedTrie, () => this.d());
    registerArpPrivilegedCommands(this.privilegedTrie, () => this.d());
    this.privilegedTrie.registerGreedy('ssh', 'Open an SSH connection to a remote host', (args) => {
      return this.runOutboundSshClient(args);
    });
    this.userTrie.registerGreedy('ssh', 'Open an SSH connection to a remote host', (args) => {
      return this.runOutboundSshClient(args);
    });
    this.userTrie.registerGreedy('telnet', 'Open a Telnet session', (args) => this.runOutboundTelnet(args));
    this.privilegedTrie.registerGreedy('telnet', 'Open a Telnet session', (args) => this.runOutboundTelnet(args));
  }

  /**
   * Outbound Telnet driven by the real topology: resolve the target,
   * pick a source interface, and verify L2/L3 reachability. A session is
   * recorded only when a Telnet listener (network CLI device with telnet
   * transport) actually accepts the connection.
   *
   * Unlike `runOutboundSshClient`, this never pushes a nested interactive
   * session — success just prints the banner (see the Telnet note in
   * CLAUDE.md's Terminal emulation section).
   */
  private runOutboundTelnet(args: string[]): string {
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length === 0) return '% Incomplete command.';
    const display = positional[0];
    const port = positional[1] ? parseInt(positional[1], 10) : 23;
    const router = this.d() as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    let host = display;
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;

    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return `Trying ${display} ...\n% Destination unreachable; no source interface for outbound Telnet`;

    const remote = findHostByAddress(host, undefined, this.d() as never);
    if (!remote || remote.poweredOff || remote.interfaceDown) {
      return `Trying ${display} ...\n% Connection timed out; remote host not responding`;
    }
    if (!isPathReachable(sourceIp, remote.ip, this.d() as never)) {
      return `Trying ${display} ...\n% Destination unreachable; gateway or route not found`;
    }
    if (!this.remoteAcceptsTelnet(remote.device, port)) {
      return `Trying ${display} ...\n% Connection refused by remote host`;
    }
    this.outgoingSessions.open({ host: display, address: remote.ip, protocol: 'telnet', user: '' });
    return `Trying ${display} ... Open\n`;
  }

  private remoteAcceptsTelnet(device: unknown, port: number): boolean {
    if (port !== 23) return false;
    const d = device as { getDeviceType?: () => string; constructor: { name: string } };
    const cls = d.constructor?.name ?? '';
    const type = (d.getDeviceType?.() ?? '').toLowerCase();
    const isNetworkCli =
      /Router|Switch/.test(cls) || /router|switch/.test(type);
    if (!isNetworkCli) return false;
    const transport = (device as { _getVtyTransportInput?: () => string })._getVtyTransportInput?.();
    if (transport === undefined) return true;
    return transport === 'telnet' || transport === 'all';
  }

  /**
   * Parse `ssh [-l user] [-p port] <host> [command ...]` (the IOS form)
   * and dispatch through the shared runSshClient. Source IP is the
   * router's first configured interface — runSshClient probes for it
   * automatically when sourceIp resolves to a known device.
   */
  private runOutboundSshClient(args: string[]): string {
    let user = 'admin';
    let port: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { user = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) { port = args[++i]; continue; }
      if (a === '-v') continue;
      if (a.startsWith('-')) continue;
      rest.push(a);
    }
    if (rest.length === 0) return '% Incomplete command.';
    let host = rest[0];
    const cmd = rest.slice(1).join(' ');
    const router = this.d() as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostnameInternal: () => string;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    // Resolve through the static `ip host` table before any DNS fallback.
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;
    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return '% No usable interface IP for outbound SSH';
    const clientArgs: string[] = [];
    if (port) clientArgs.push('-p', port);
    clientArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    // Cisco IOS' built-in ssh client always allocates a line-mode PTY on
    // the VTY — opposite of OpenSSH's exec-mode default.
    clientArgs.push('-t');
    clientArgs.push(`${user}@${host}`);
    if (cmd) clientArgs.push(cmd);
    const result = runSshClient({
      args: clientArgs,
      sourceHostname: router._getHostnameInternal(),
      sourceIp,
      sourceUser: user,
      localVfs: {
        readFile: () => null,
        writeFile: () => undefined,
      },
    });
    // TOFU: record the remote host key in this router's local
    // known-hosts table so `show ip ssh known-hosts` reflects it.
    if (result.exitCode === 0) {
      const dev = this.d() as unknown as {
        _getSshKnownHosts?: () => { add: (e: { host: string; keyType: string; publicKey: string }) => void };
      };
      const remoteHk = this.lookupRemoteSshHostKey(host);
      if (remoteHk) {
        dev._getSshKnownHosts?.().add({ host, ...remoteHk });
      }
      if (!cmd) {
        this.outgoingSessions.open({ host: rest[0], address: host, protocol: 'ssh', user });
      }
    }
    return result.output;
  }

  /** Read the remote machine's host key via the topology registry. */
  private lookupRemoteSshHostKey(host: string): { keyType: string; publicKey: string } | null {
    const found = findHostByAddress(host, undefined, this.d() as never) as { device?: { getSshHostKey?: () => { type: string; publicKey: string } } } | null;
    const hk = found?.device?.getSshHostKey?.();
    return hk ? { keyType: hk.type, publicKey: hk.publicKey } : null;
  }

  private registerCommonConfigCommands(): void {
    // `configure terminal` while already in config is an idempotent
    // no-op (re-issuing it must not error mid-sequence).
    this.configTrie.register('configure terminal', 'Already in global config', () => '');

    // La séquence de démarrage. `config-register 0x2142` est la moitié
    // de la récupération de mot de passe la plus enseignée du cours ;
    // le registre est réellement stocké et son bit 0x40 réellement lu.
    this.configTrie.registerGreedy('boot system', 'Specify system image to load', (args) => {
      const image = (args[0] ?? '').replace(/^flash:\/?/i, '');
      if (!image) return '% Incomplete command.';
      this.fs().addBootSystem(image);
      return '';
    });
    this.configTrie.registerGreedy('no boot system', 'Remove a system image from the boot list', (args) => {
      const image = (args[0] ?? '').replace(/^flash:\/?/i, '');
      this.fs().removeBootSystem(image || undefined);
      return '';
    });
    this.configTrie.registerGreedy('config-register', 'Set configuration register', (args) => {
      const val = args[0] ?? '';
      if (!this.fs().setConfigRegister(val)) {
        return '% Invalid config register value';
      }
      return '';
    });

    this.configTrie.registerGreedy('hostname', 'Set system hostname', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.d()._setHostnameInternal(args[0]);
      return '';
    });

    this.configTrie.register('no hostname', 'Reset hostname', () => {
      const dev = this.d();
      dev._setHostnameInternal(dev.defaultHostname());
      return '';
    });

    // `alias <mode> <name> <command…>` — real, working aliases.
    this.configTrie.registerGreedy('alias', 'Create a command alias', (args) => {
      if (args.length < 3) return '% Incomplete command.';
      const [modeTok, name, ...rest] = args;
      if (name.length > 31) return '% Alias name exceeds 31 characters.';
      this.aliases.set(this.aliasMode(modeTok), name, rest.join(' '));
      return '';
    });
    this.configTrie.registerGreedy('no alias', 'Remove a command alias', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      this.aliases.remove(this.aliasMode(args[0]), args[1]);
      return '';
    });

    // Global feature toggles — mutate the real CiscoConfigState
    // Repository (shared switch + router, DRY). `show cdp`/`show lldp`
    // and `show running-config` project this real state.
    const flag = (feature: string, enableCmd: string, desc: string) => {
      this.configTrie.registerGreedy(enableCmd, desc, () => {
        this.configState.set(feature, true);
        return '';
      });
      this.configTrie.registerGreedy(`no ${enableCmd}`, `Disable ${desc}`, () => {
        this.configState.set(feature, false);
        return '';
      });
    };
    // cdp/lldp follow the `flag` pattern, but the cdp toggle must also
    // start / stop the per-device protocol agent so `show cdp neighbors`
    // reflects real learnt state (and stops learning when disabled).
    this.configTrie.registerGreedy('cdp run', 'Enable CDP globally', () => {
      this.configState.set('cdp', true);
      this.applyToCdpAgent(a => a.setEnabled(true));
      return '';
    });
    this.configTrie.registerGreedy('no cdp run', 'Disable CDP globally', () => {
      this.configState.set('cdp', false);
      this.applyToCdpAgent(a => a.setEnabled(false));
      return '';
    });
    this.configTrie.registerGreedy('cdp timer', 'Advertisement period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 254) return '% Invalid timer value (5-254)';
      this.applyToCdpAgent(a => a.setTimerSec(n));
      return '';
    });
    this.configTrie.registerGreedy('cdp holdtime', 'Hold-time advertised to peers (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 10 || n > 255) return '% Invalid holdtime value (10-255)';
      this.applyToCdpAgent(a => a.setHoldtimeSec(n));
      return '';
    });
    this.configTrie.register('cdp advertise-v2', 'Advertise CDPv2 PDUs', () => {
      this.applyToCdpAgent(a => (a as unknown as { setAdvertiseV2?: (v: boolean) => void }).setAdvertiseV2?.(true));
      return '';
    });
    this.configTrie.register('no cdp advertise-v2', 'Use CDPv1 PDUs', () => {
      this.applyToCdpAgent(a => (a as unknown as { setAdvertiseV2?: (v: boolean) => void }).setAdvertiseV2?.(false));
      return '';
    });
    this.configTrie.registerGreedy('lldp run', 'Enable LLDP globally', () => {
      this.configState.set('lldp', true);
      this.applyToLldpAgent(a => a.setEnabled(true));
      return '';
    });
    this.configTrie.registerGreedy('no lldp run', 'Disable LLDP globally', () => {
      this.configState.set('lldp', false);
      this.applyToLldpAgent(a => a.setEnabled(false));
      return '';
    });
    this.configTrie.registerGreedy('lldp timer', 'Advertisement period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 32768) return '% Invalid timer value (5-32768)';
      this.applyToLldpAgent(a => a.setTimerSec(n));
      return '';
    });
    this.configTrie.registerGreedy('lldp holdtime-multiplier', 'TTL = timer x multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 2 || n > 10) return '% Invalid multiplier (2-10)';
      this.applyToLldpAgent(a => a.setHoldtimeMultiplier(n));
      return '';
    });
    this.configTrie.registerGreedy('lldp holdtime', 'Holdtime in seconds', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 10 || n > 3600) return '% Invalid holdtime value (10-3600)';
      this.applyToLldpAgent(a => {
        const cfg = a.getConfig();
        const mult = Math.max(2, Math.min(10, Math.round(n / cfg.timerSec)));
        a.setHoldtimeMultiplier(mult);
      });
      return '';
    });
    this.configTrie.registerGreedy('lldp reinit', 'Re-init delay (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 1 || n > 10) return '% Invalid reinit delay (1-10)';
      this.applyToLldpAgent(a => a.setReinitDelaySec(n));
      return '';
    });

    // [no] cdp enable — per-interface — needs `selectedInterface` /
    // `selectedInterfaceRange` from the device-specific shell, but the
    // applyToSelectedInterfaces helper is implemented per subclass.
    this.configIfTrie.register('cdp enable', 'Enable CDP on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToCdpAgent(a => a.setPortEnabled(p, true));
      return '';
    });
    this.configIfTrie.register('no cdp enable', 'Disable CDP on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToCdpAgent(a => a.setPortEnabled(p, false));
      return '';
    });
    this.configIfTrie.register('lldp transmit', 'Enable LLDP transmit on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortTransmit(p, true));
      return '';
    });
    this.configIfTrie.register('no lldp transmit', 'Disable LLDP transmit on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortTransmit(p, false));
      return '';
    });
    this.configIfTrie.register('lldp receive', 'Enable LLDP receive on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortReceive(p, true));
      return '';
    });
    this.configIfTrie.register('no lldp receive', 'Disable LLDP receive on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortReceive(p, false));
      return '';
    });
    flag('ip cef', 'ip cef', 'CEF');
    this.registerHttpServerCommands();
    flag('ip source-route', 'ip source-route', 'IP source-route');
    // `ip routing` / `ipv6 unicast-routing` enable forms are owned by
    // the router (CiscoOspfCommands, device-specific); only record the
    // negation here so it's recognised on both vendors without
    // shadowing that specific handler.
    this.configTrie.registerGreedy('no ip routing', 'Disable IP routing', () => {
      this.configState.set('ip routing', false);
      return '';
    });
    this.configTrie.registerGreedy('no ipv6 unicast-routing', 'Disable IPv6 routing', () => {
      this.configState.set('ipv6 unicast-routing', false);
      return '';
    });
    this.configTrie.registerGreedy('ip name-server', 'Configure DNS name servers', (args) => {
      if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
      for (const s of args) if (!isValidIPv4(s)) return CISCO_ERRORS.INVALID_INPUT;
      const mgmt = getManagementService(this.d());
      if (mgmt) for (const s of args) if (!mgmt.nameServers.includes(s)) mgmt.nameServers.push(s);
      return '';
    });
    this.configTrie.registerGreedy('no ip name-server', 'Clear DNS name servers', (args) => {
      const mgmt = getManagementService(this.d());
      if (mgmt) {
        if (args.length === 0) mgmt.nameServers.length = 0;
        else for (const s of args) {
          const i = mgmt.nameServers.indexOf(s);
          if (i >= 0) mgmt.nameServers.splice(i, 1);
        }
      }
      return '';
    });
    this.configTrie.register('ip domain-lookup', 'Enable DNS lookups', () => {
      const mgmt = getManagementService(this.d());
      if (mgmt) mgmt.ipDomainLookupEnabled = true;
      return '';
    });
    this.configTrie.register('no ip domain-lookup', 'Disable DNS lookups', () => {
      const mgmt = getManagementService(this.d());
      if (mgmt) mgmt.ipDomainLookupEnabled = false;
      return '';
    });
    this.configTrie.register('ip bootp server', 'Enable BOOTP server', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('bootp-server', true);
      return '';
    });
    this.configTrie.register('no ip bootp server', 'Disable BOOTP server', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('bootp-server', false);
      return '';
    });
    this.configTrie.register('ip finger', 'Enable finger service', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('finger', true);
      return '';
    });
    this.configTrie.register('no ip finger', 'Disable finger service', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('finger', false);
      return '';
    });
    this.configTrie.register('ip gratuitous-arps', 'Enable gratuitous ARP', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('gratuitous-arps', true);
      return '';
    });
    this.configTrie.register('no ip gratuitous-arps', 'Disable gratuitous ARP', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('gratuitous-arps', false);
      return '';
    });
    this.configTrie.register('no banner motd', 'Clear MOTD banner', () => {
      const dev = this.d() as unknown as {
        _setSshBanner?: (b: string) => void;
        _setMotdBanner?: (b: string) => void;
      };
      dev._setSshBanner?.('');
      dev._setMotdBanner?.('');
      return '';
    });
    this.configTrie.registerGreedy('vrf', 'VRF configuration', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `vrf ${args.join(' ')}`);
      return '';
    });
    // `vrf definition NAME` est la forme moderne de `ip vrf NAME` : elle
    // entre dans le MÊME sous-mode et crée la MÊME instance, sans quoi
    // deux orthographes d'une seule commande donnaient deux résultats
    // — l'une entrait en config-vrf, l'autre notait une ligne et rendait
    // la main en configuration globale.
    this.configTrie.registerGreedy('vrf definition', 'Configure a VRF', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const name = args[0];
      const dev = this.d() as unknown as {
        _vrfs?: Map<string, { name: string; rd?: string; rts: { import: string[]; export: string[] }; interfaces: Set<string> }>;
      };
      const vrfs = dev._vrfs ??= new Map();
      if (!vrfs.has(name)) vrfs.set(name, { name, rts: { import: [], export: [] }, interfaces: new Set() });
      (this as unknown as { setSelectedVRF?: (n: string) => void }).setSelectedVRF?.(name);
      this.mode = 'config-vrf';
      return '';
    });
    this.configTrie.registerGreedy('ip community-list', 'Define BGP community list', (args, raw) => {
      if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
      const kind = args[0].toLowerCase();
      const named = kind === 'standard' || kind === 'expanded';
      const name = named ? args[1] : args[0];
      const rule = (named ? args.slice(2) : args.slice(1)).join(' ');
      const store = this.communityLists();
      const key = `${named ? kind : 'standard'} ${name}`;
      const list = store.get(key) ?? [];
      list.push(rule);
      store.set(key, list);
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `ip community-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('ip as-path access-list', 'Define BGP AS-path filter', (args, raw) => {
      if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
      const store = this.asPathLists();
      const list = store.get(args[0]) ?? [];
      list.push(args.slice(1).join(' '));
      store.set(args[0], list);
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `ip as-path access-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('priority-list', 'Legacy PQ list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `priority-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('queue-list', 'Legacy CQ list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `queue-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('privilege', 'Configure command privilege levels', (args, raw) => {
      if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const mode = args[0]?.toLowerCase();
      if (!['exec', 'configure', 'interface', 'line'].includes(mode ?? '')) {
        return "% Invalid input detected at '^' marker.";
      }
      if (args[1]?.toLowerCase() !== 'level') return CISCO_ERRORS.INCOMPLETE;
      if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
      const lvl = parseInt(args[2] ?? '', 10);
      if (!Number.isFinite(lvl) || lvl < 0 || lvl > 15) {
        return "% Invalid input detected at '^' marker.";
      }
      if (args.length < 4) return CISCO_ERRORS.INCOMPLETE;
      const router = this.d() as unknown as { _ciscoPrivilegeRules?: Map<string, number> };
      const key = `${mode} ${args.slice(3).join(' ')}`;
      (router._ciscoPrivilegeRules ??= new Map()).set(key, lvl);
      const recorder = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      recorder._recordUnhandledConfigLine?.(raw ?? `privilege ${args.join(' ')}`);
      return '';
    });
    /**
     * `parser view <nom>` — declarer une vue CLI (le RBAC d'IOS).
     *
     * Deux conditions d'IOS, et ce ne sont pas des formalites : il faut
     * `aaa new-model` (une vue est un mecanisme d'autorisation, il vit
     * dans AAA) et il faut etre dans la vue RACINE (sans quoi une vue
     * restreinte pourrait s'octroyer des commandes, ce qui viderait le
     * mecanisme de son sens).
     */
    this.configTrie.registerGreedy('parser view', 'Define a CLI view', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      const sec = getSecurityConfig(this.d());
      if (!sec.aaaNewModel) {
        return '%Parser view commands are not available. AAA must be enabled first';
      }
      if (this.activeParserView !== null) {
        return '%Currently in view mode. Please exit to root view first';
      }
      const nom = args[0];
      if (!sec.parserViews.has(nom)) {
        sec.parserViews.set(nom, { name: nom, execInclude: [], execExclude: [] });
      }
      this.selectedParserView = nom;
      this.mode = 'config-view';
      return '';
    });
    this.configTrie.registerGreedy('no parser view', 'Remove a CLI view', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      getSecurityConfig(this.d()).parserViews.delete(args[0]);
      return '';
    });
    // Après les deux enregistrements, qui créent les nœuds : sans cela
    // `?` proposerait `parser` et `no parser` nus.
    this.configTrie.describeNode('parser', 'Configure parser');
    this.configTrie.describeNode('no parser', 'Negate a parser command');

    this.configTrie.registerGreedy('no privilege', 'Remove privilege command rule', (args) => {
      const mode = args[0]?.toLowerCase();
      if (args[1]?.toLowerCase() !== 'level') return CISCO_ERRORS.INCOMPLETE;
      const router = this.d() as unknown as {
        _ciscoPrivilegeRules?: Map<string, number>;
        _removeUnhandledConfigLine?: (pattern: string) => void;
      };
      const key = `${mode} ${args.slice(3).join(' ')}`;
      router._ciscoPrivilegeRules?.delete(key);
      router._removeUnhandledConfigLine?.(`privilege ${args.join(' ')}`);
      return '';
    });

    this.configTrie.registerGreedy('ip domain-name', 'Set domain name', (args) => {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      const dev = this.d() as unknown as { _setDomainName?: (name: string) => void };
      const mgmt = getManagementService(this.d());
      if (mgmt) (mgmt as unknown as { domainName: string }).domainName = args[0];
      else dev._setDomainName?.(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('ip domain', 'IP domain configuration', (args) => {
      if (args[0]?.toLowerCase() !== 'name' || !args[1]) return '';
      const mgmt = getManagementService(this.d());
      if (mgmt) (mgmt as unknown as { domainName: string }).domainName = args[1];
      return '';
    });
    this.configTrie.registerGreedy('no ip domain-name', 'Clear domain name', () => {
      const dev = this.d() as unknown as { _setDomainName?: (name: string) => void };
      const mgmt = getManagementService(this.d());
      if (mgmt) (mgmt as unknown as { domainName: string }).domainName = '';
      else dev._setDomainName?.('');
      return '';
    });
    // `ip host <name> <ip>` — static hostname → IP mapping consulted by
    // outbound ssh / stelnet / ping / traceroute before any DNS fallback.
    this.configTrie.registerGreedy('ip host', 'Configure a static host entry', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      if (!isValidIPv4(args[1])) return `% Invalid IP address ${args[1]}.`;
      const dev = this.d() as unknown as { _getHostsTable?: () => { upsert: (n: string, ip: string) => void } };
      dev._getHostsTable?.().upsert(args[0], args[1]);
      return '';
    });
    this.configTrie.registerGreedy('no ip host', 'Remove a static host entry', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const dev = this.d() as unknown as { _getHostsTable?: () => { remove: (n: string) => boolean } };
      dev._getHostsTable?.().remove(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('banner', 'Set a banner', (args, rawLine) => {
      const which = args[0]?.toLowerCase();
      if (!which || !['motd', 'login', 'exec', 'incoming'].includes(which)) {
        return "% Invalid input detected at '^' marker.";
      }
      // The delimiter is the first non-space character after the banner
      // type; everything after it (spaces included) is content — split
      // from the raw line, not the collapsed args.
      const line = rawLine ?? `banner ${args.join(' ')}`;
      const typePos = line.toLowerCase().indexOf(which);
      const rest = line.slice(typePos + which.length).replace(/^\s+/, '');
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      // show running-config renders the delimiter as the two-character
      // notation ^C (Ctrl-C); accept it back so the output re-pastes.
      const delim = rest.startsWith('^C') ? '^C' : rest[0];
      const body = rest.slice(delim.length);
      const closeIdx = body.indexOf(delim);
      if (closeIdx !== -1) {
        // Inline form — content truncates at the FIRST delimiter
        // occurrence, exactly like IOS.
        this.setBanner(which as 'motd' | 'login' | 'exec' | 'incoming', body.slice(0, closeIdx));
        return '';
      }
      // Multi-line form: collect subsequent input verbatim until a line
      // containing the delimiter.
      this.bannerCollector = {
        type: which as 'motd' | 'login' | 'exec' | 'incoming',
        delimiter: delim,
        lines: body.length > 0 ? [body] : [],
      };
      return `Enter TEXT message.  End with the character '${delim}'.`;
    });
    this.configTrie.registerGreedy('no banner', 'Remove a banner', (args) => {
      const which = args[0]?.toLowerCase();
      const dev = this.d() as unknown as {
        _setMotdBanner?: (b: string) => void;
        _setLoginBanner?: (b: string) => void;
        _setExecBanner?: (b: string) => void;
        _setIncomingBanner?: (b: string) => void;
        _setSshBanner?: (b: string) => void;
      };
      if (which === 'motd') { dev._setMotdBanner?.(''); dev._setSshBanner?.(''); }
      else if (which === 'login') dev._setLoginBanner?.('');
      else if (which === 'exec') dev._setExecBanner?.('');
      else if (which === 'incoming') dev._setIncomingBanner?.('');
      return '';
    });
    registerLoggingConfigCommands(this.configTrie, this.loggingCommandContext());
    registerSequenceNumbersCommand(this.configTrie, this.loggingCommandContext());
    this.configTrie.registerGreedy('service timestamps', 'Timestamp log/debug messages', (args) =>
      this.applyServiceTimestamps(args, false));
    this.configTrie.registerGreedy('no service timestamps', 'Stop timestamping messages', (args) =>
      this.applyServiceTimestamps(args, true));
    // Chaque sous-commande de `ntp` est un VRAI noeud de l'arbre.
    //
    // Un unique noeud glouton n'a pas de sous-arbre : son aide ne
    // pouvait donc rien descendre, et `?` reproduisait la meme liste a
    // toutes les profondeurs — `ntp access-group access-group ?`
    // proposait encore la liste complete, et la commande etait acceptee.
    // Pire, la liste elle-meme etait EXTRAITE du code source du
    // gestionnaire (`autoContinuations`), d'ou trois mots qui ne sont
    // pas des sous-commandes de `ntp` : `md5` (argument
    // d'`authentication-key`), `prefer` (argument de `server`) et
    // `mode` — qui portait « Set trunking mode of the interface », la
    // description de `switchport mode`, une fuite d'une commande vers
    // une autre.
    //
    // Declarer les vrais enfants les exclut de l'extraction, donne a
    // chacun sa propre aide, et fait refuser ce qui n'existe pas.
    for (const { mot, desc, args: prendArgs } of NTP_SOUS_COMMANDES) {
      if (prendArgs === false) {
        this.configTrie.register(`ntp ${mot}`, desc, () => this.appliquerNtp([mot]));
        this.configTrie.register(`no ntp ${mot}`, desc, () => this.retirerNtp([mot]));
        continue;
      }
      this.configTrie.registerGreedy(`ntp ${mot}`, desc,
        (a) => this.appliquerNtp([mot, ...a]));
      this.configTrie.registerGreedy(`no ntp ${mot}`, desc,
        (a) => this.retirerNtp([mot, ...a]));
    }
    this.configTrie.register('ntp', 'Configure NTP', () => CISCO_ERRORS.INCOMPLETE);

    this.configTrie.registerGreedy('snmp-server', 'SNMP configuration', (args) => {
      const svc = getSnmpService(this.d());
      if (!svc) return '';
      svc.configure(args);
      this.syncSnmpAgent();
      return '';
    });

    this.configTrie.registerGreedy('clock timezone', 'Set timezone', (args) => {
      const mgmt = getManagementService(this.d());
      if (mgmt && args[0] && args[1]) {
        const offsetHrs = parseInt(args[1], 10);
        const offsetMin = parseInt(args[2] ?? '0', 10);
        const cfg = mgmt.getClock();
        cfg.timezone = args[0];
        cfg.offsetMin = (isNaN(offsetHrs) ? 0 : offsetHrs) * 60 + (isNaN(offsetMin) ? 0 : offsetMin) * (offsetHrs < 0 ? -1 : 1);
      }
      return '';
    });
    this.configTrie.registerGreedy('clock summer-time', 'Configure daylight saving time', (args) => {
      const mgmt = getManagementService(this.d());
      if (mgmt && args[0]) {
        const cfg = mgmt.getClock();
        cfg.summerTimezone = args[0];
        if (args[1]?.toLowerCase() === 'recurring') {
          cfg.daylightStart = args.slice(2, 6).join(' ');
          cfg.daylightEnd = args.slice(6, 10).join(' ');
        }
      }
      return '';
    });
    // Même chemin exact que la forme d'EXEC privilégié : deux analyseurs
    // pour une seule commande finiraient par se contredire sur la même
    // date.
    this.configTrie.registerGreedy('clock set', 'Set system clock',
      (args) => this.applyClockSet(args));
    this.configTrie.registerGreedy('clock', 'Configure time-of-day clock', (args, raw) => {
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      dev._recordUnhandledConfigLine?.(raw ?? `clock ${args.join(' ')}`);
      return '';
    });

    // Management commands missing on BOTH switch & router → shared here
    // (DRY). Recognised; the sim has no AAA/crypto datapath.
    this.configTrie.registerGreedy('aaa', 'AAA configuration', (args, raw) => {
      const mgmt = getManagementService(this.d());
      if (mgmt) (mgmt as unknown as { recordRaw: (f: string, l: string) => void }).recordRaw('aaa', raw ?? `aaa ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('enable secret', 'Set enable secret', (args) => {
      const dev = this.d() as unknown as { _setEnableSecretForLevel?: (level: number, s: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7') => void };
      let algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' = 'md5';
      let secret = '';
      let level = 15;
      // Cleartext forms (0, level N, or bare) are what `security passwords
      // min-length` validates — a pasted hash (5/7/8/9) is exempt, same as
      // `username ... secret` (CiscoSecurityCommands.ts).
      let plaintextEntered: string | undefined;
      if (args[0] === '0') { algo = 'plain'; secret = args.slice(1).join(' '); plaintextEntered = secret; }
      else if (args[0] === '5') { algo = 'md5'; secret = args.slice(1).join(' '); }
      else if (args[0] === '7') { algo = 'type-7'; secret = args.slice(1).join(' '); }
      else if (args[0] === '8') { algo = 'sha256'; secret = args.slice(1).join(' '); }
      else if (args[0] === '9') { algo = 'scrypt'; secret = args.slice(1).join(' '); }
      else if (args[0] === 'level' && /^\d+$/.test(args[1] ?? '')) {
        level = parseInt(args[1], 10);
        secret = args.slice(2).join(' '); plaintextEntered = secret;
      } else { secret = args.join(' '); plaintextEntered = secret; }
      if (secret === '') return '% Incomplete command.';
      const minLength = getSecurityConfig(this.d()).passwords.minLength;
      if (plaintextEntered !== undefined && minLength && plaintextEntered.length < minLength) {
        return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
      }
      dev._setEnableSecretForLevel?.(level, secret, algo);
      return '';
    });
    // `enable algorithm-type {md5|scrypt|sha256} secret [level N] <pwd>` —
    // explicit-algorithm form of `enable secret` (IOS 15.3+), always takes
    // a cleartext password and hashes it with the named algorithm.
    this.configTrie.registerGreedy('enable algorithm-type', 'Set enable secret with an explicit hash algorithm', (args) => {
      const dev = this.d() as unknown as { _setEnableSecretForLevel?: (level: number, s: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7') => void };
      const algoName = args[0]?.toLowerCase();
      const algoMap: Record<string, 'md5' | 'scrypt' | 'sha256'> = { md5: 'md5', scrypt: 'scrypt', sha256: 'sha256' };
      const algo = algoMap[algoName ?? ''];
      if (!algo) return "% Invalid input detected at '^' marker.";
      if (args[1]?.toLowerCase() !== 'secret') return "% Invalid input detected at '^' marker.";
      let level = 15;
      let rest = args.slice(2);
      if (rest[0]?.toLowerCase() === 'level' && /^\d+$/.test(rest[1] ?? '')) {
        level = parseInt(rest[1], 10);
        rest = rest.slice(2);
      }
      const secret = rest.join(' ');
      if (secret === '') return CISCO_ERRORS.INCOMPLETE;
      const minLength = getSecurityConfig(this.d()).passwords.minLength;
      if (minLength && secret.length < minLength) {
        return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
      }
      dev._setEnableSecretForLevel?.(level, secret, algo);
      return '';
    });
    this.configTrie.registerGreedy('enable password', 'Set enable password', (args) => {
      const dev = this.d() as unknown as {
        _setEnablePasswordForLevel?: (level: number, p: string, algo: 'plain' | 'type-7') => void;
        getServiceFlags?: () => ReadonlyMap<string, boolean>;
      };
      let algo: 'plain' | 'type-7' = 'plain';
      let password = '';
      let level = 15;
      let plaintextEntered: string | undefined;
      if (args[0] === '0') { algo = 'plain'; password = args.slice(1).join(' '); plaintextEntered = password; }
      else if (args[0] === '7') { algo = 'type-7'; password = args.slice(1).join(' '); }
      else if (args[0] === 'level' && /^\d+$/.test(args[1] ?? '')) {
        level = parseInt(args[1], 10);
        password = args.slice(2).join(' '); plaintextEntered = password;
      } else { password = args.join(' '); plaintextEntered = password; }
      if (password === '') return '% Incomplete command.';
      const minLength = getSecurityConfig(this.d()).passwords.minLength;
      if (plaintextEntered !== undefined && minLength && plaintextEntered.length < minLength) {
        return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
      }
      if (algo === 'plain' && dev.getServiceFlags?.().get('password-encryption') === true) {
        const salt = parseInt(_md5Hex(`cisco-type7:${password}`).slice(0, 1), 16);
        dev._setEnablePasswordForLevel?.(level, _encryptType7(password, salt), 'type-7');
      } else {
        dev._setEnablePasswordForLevel?.(level, password, algo);
      }
      return '';
    });
    this.configTrie.register('no enable secret', 'Remove enable secret', () => {
      const dev = this.d() as unknown as { _setEnableSecret?: (s: string, algo: 'plain') => void };
      dev._setEnableSecret?.('', 'plain');
      return '';
    });
    this.configTrie.register('no enable password', 'Remove enable password', () => {
      const dev = this.d() as unknown as { _setEnablePassword?: (p: string, algo: 'plain') => void };
      dev._setEnablePassword?.('', 'plain');
      return '';
    });
    // `username <name> [privilege N] [secret|password] <pwd>` — captures
    // the local-user database so the sshd dispatch can validate inbound
    // logins. Anything we don't parse is still accepted silently.
    this.configTrie.registerGreedy('username', 'Configure a local user', (args) => {
      const dev = this.d() as unknown as {
        _upsertCiscoUsername?: (name: string, kv: {
          privilege?: number; secret?: string; secretAlgo?: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
          autocommand?: string; nopassword?: boolean; description?: string;
        }) => void;
      };
      const name = args[0];
      if (!name || typeof dev._upsertCiscoUsername !== 'function') return '';
      const kv: {
        privilege?: number; secret?: string; secretAlgo?: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
        autocommand?: string; nopassword?: boolean; description?: string;
      } = {};
      // `username X algorithm-type {md5|sha256|scrypt} secret <pwd>` : le
      // mot-cle etait accepte et JETE, si bien qu'un secret demande en
      // scrypt etait range en MD5 -- la commande de durcissement rendait
      // exactement l'inverse de ce qu'elle promet, en silence. Son
      // homologue `enable algorithm-type` fonctionne depuis toujours :
      // meme famille, deux comportements.
      let algoDemande: 'md5' | 'sha256' | 'scrypt' | undefined;
      for (let i = 1; i < args.length; i++) {
        const tok = args[i];
        if (tok === 'privilege' && /^\d+$/.test(args[i + 1] ?? '')) { kv.privilege = Number(args[++i]); continue; }
        if (tok === 'algorithm-type') {
          const nom = (args[i + 1] ?? '').toLowerCase();
          if (nom !== 'md5' && nom !== 'sha256' && nom !== 'scrypt') {
            throw new CliInvalidInput({ token: args[i + 1] });
          }
          algoDemande = nom;
          i++;
          continue;
        }
        if (tok === 'nopassword') { kv.nopassword = true; continue; }
        if (tok === 'autocommand') { kv.autocommand = args.slice(i + 1).join(' '); i = args.length; continue; }
        if (tok === 'description') { kv.description = args.slice(i + 1).join(' '); i = args.length; continue; }
        if (tok === 'secret' || tok === 'password') {
          const isSecret = tok === 'secret';
          const next = args[i + 1];
          let algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' = isSecret ? 'md5' : 'plain';
          let value: string;
          if (next === '0') { algo = 'plain'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '5') { algo = 'md5'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '7') { algo = 'type-7'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '8') { algo = 'sha256'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '9') { algo = 'scrypt'; value = args[i + 2] ?? ''; i += 2; }
          else { value = next ?? ''; i++; }
          kv.secret = value;
          // Un chiffre explicite (`secret 5 $1$…`) decrit un condense
          // DEJA calcule et l'emporte donc sur l'algorithme demande, qui
          // ne porte que sur du clair a hacher.
          const chiffreExplicite = ['0', '5', '7', '8', '9'].includes(next ?? '');
          kv.secretAlgo = isSecret && algoDemande && !chiffreExplicite ? algoDemande : algo;
          continue;
        }
      }
      dev._upsertCiscoUsername(name, kv);
      return '';
    });
    this.configTrie.registerGreedy('crypto', 'Encryption module', (args, raw) => {
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      dev._recordUnhandledConfigLine?.(raw ?? `crypto ${args.join(' ')}`);
      return '';
    });
    // `service timestamps` has its own registration above and the trie
    // routes to the more specific one, so the second parser this handler
    // used to carry never ran — it could only ever contradict the first.
    this.configTrie.registerGreedy('service', 'Service configuration', (args) => {
      const dev = this.d() as unknown as { _setServiceFlag?: (name: string, on: boolean) => void };
      const name = args.join(' ');
      if (name) dev._setServiceFlag?.(name, true);
      return '';
    });
    this.configTrie.registerGreedy('no service', 'Disable a service', (args) => {
      const dev = this.d() as unknown as { _setServiceFlag?: (name: string, on: boolean) => void };
      const name = args.join(' ');
      if (name) dev._setServiceFlag?.(name, false);
      return '';
    });
    this.configTrie.registerGreedy('no username', 'Remove a local user', (args) => {
      const dev = this.d() as unknown as { _removeLocalUser?: (n: string) => void };
      if (args[0] && typeof dev._removeLocalUser === 'function') dev._removeLocalUser(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('login', 'Login configuration', (args) => {
      const dev = this.d() as unknown as {
        _configureLoginBlock?: (s: number, a: number, w: number) => void;
        _setLoginBlockConfigLine?: (line: string) => void;
      };
      if (args[0] === 'block-for' && /^\d+$/.test(args[1] ?? '')) {
        const seconds = Number(args[1]);
        let attempts = 0;
        let within = 0;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === 'attempts' && /^\d+$/.test(args[i + 1] ?? '')) attempts = Number(args[++i]);
          else if (args[i] === 'within' && /^\d+$/.test(args[i + 1] ?? '')) within = Number(args[++i]);
        }
        if (typeof dev._configureLoginBlock === 'function') {
          dev._configureLoginBlock(seconds, attempts, within);
        }
      }
      return '';
    });
    // `ip ssh …` : le handler qui vivait ici ecrivait un SECOND magasin
    // (celui du gestionnaire) que rien ne lisait pour ces champs, et il
    // etait de toute facon ombre sur le routeur par l'enregistrement plus
    // specifique de `CiscoSecurityCommands`. Deux magasins pour un fait,
    // avec des defauts qui se contredisaient : il n'en reste qu'un.
    // Le commutateur garde son propre `ip ssh version`.

    // `line {console|vty|aux} …` → shared config-line sub-mode.
    // We remember the selected VTY range so subsequent directives
    // (exec-timeout, access-class, transport input, …) land in the
    // right VtyLineConfig block.
    this.configTrie.registerGreedy('line', 'Enter line configuration', (args) => {
      this.mode = 'config-line';
      const kind = args[0]?.toLowerCase();
      if (kind === 'vty') {
        const first = Number.parseInt(args[1] ?? '0', 10);
        const last  = Number.parseInt(args[2] ?? args[1] ?? '0', 10);
        this.selectedVtyRange = { first, last };
        this.selectedConsoleLine = null;
        const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
        dev._getVtyLineConfig?.().upsert({ first, last });
      } else if (kind === 'console' || kind === 'con') {
        this.selectedVtyRange = null;
        this.selectedConsoleLine = Number.parseInt(args[1] ?? '0', 10);
        this.selectedAuxLine = null;
      } else if (kind === 'aux') {
        this.selectedVtyRange = null;
        this.selectedConsoleLine = null;
        this.selectedAuxLine = Number.parseInt(args[1] ?? '0', 10);
      } else {
        this.selectedVtyRange = null;
        this.selectedConsoleLine = null;
        this.selectedAuxLine = null;
      }
      return '';
    });
    for (const kw of ['login', 'password',
      'logging', 'privilege', 'no', 'speed', 'stopbits', 'databits', 'parity',
      'flowcontrol', 'session-timeout', 'history', 'length', 'width', 'authorization',
      'accounting', 'rotary', 'autocommand', 'motd-banner', 'exec']) {
      this.configLineTrie.registerGreedy(kw, `line ${kw}`, (args, raw) => {
        this.requireLineKind(kw);
        const range = this.selectedVtyRange;
        if (!range) {
          if (this.selectedAuxLine != null) {
            if (kw === 'exec') { this.auxLineNoExec = false; return ''; }
            if (kw === 'no' && args[0]?.toLowerCase() === 'exec') { this.auxLineNoExec = true; return ''; }
            return '';
          }
          if (this.selectedConsoleLine == null) return '';
          if (kw === 'password') {
            if (!args[0]) return '% Incomplete command.';
            let pwArgs = [...args];
            this.consoleLinePasswordEncrypted = false;
            if (pwArgs[0] === '0') pwArgs = pwArgs.slice(1);
            else if (pwArgs[0] === '7') { this.consoleLinePasswordEncrypted = true; pwArgs = pwArgs.slice(1); }
            this.consoleLinePassword = pwArgs.join(' ');
            return '';
          }
          if (kw === 'login') {
            const sub = args[0]?.toLowerCase();
            this.consoleLineLogin = sub === 'local' ? 'local' : 'password';
            return '';
          }
          if (kw === 'logging' && args[0]?.toLowerCase() === 'synchronous') {
            this.consoleLineLoggingSynchronous = true;
            return '';
          }
          if (kw === 'privilege' && args[0]?.toLowerCase() === 'level' && args[1]) {
            const lvl = parseInt(args[1], 10);
            if (!Number.isFinite(lvl) || lvl < 0 || lvl > 15) {
              return "% Invalid input detected at '^' marker.";
            }
            this.consoleLinePrivilegeLevel = lvl;
            return '';
          }
          if (kw === 'no') {
            const sub = args[0]?.toLowerCase();
            if (sub === 'login') {
              if (args[1]?.toLowerCase() === 'local') {
                this.consoleLineLogin = null;
              } else {
                this.consoleLineLogin = 'none';
              }
              return '';
            }
            if (sub === 'password') { this.consoleLinePassword = null; return ''; }
            if (sub === 'privilege') { this.consoleLinePrivilegeLevel = null; return ''; }
            if (sub === 'logging') { this.consoleLineLoggingSynchronous = false; return ''; }
          }
          return '';
        }
        if (kw === 'password' && !args[0]) return '% Incomplete command.';
        const dev = this.d() as unknown as {
          _getVtyLineConfig?: () => { upsert: (p: object) => { requiresPasswordButUnset?: () => boolean } };
        };
        const update: Record<string, unknown> = { first: range.first, last: range.last };
        if (kw === 'login') {
          // bare `login` → authenticate with the line password; `login local`
          // → local user DB; `login authentication …` → AAA.
          const sub = args[0]?.toLowerCase();
          update.login = sub === 'local' ? 'local' : sub === 'authentication' ? 'aaa' : 'password';
        } else if (kw === 'password') {
          update.linePassword = args.slice(1).join(' ') || args[0];
        } else if (kw === 'logging' && args[0]?.toLowerCase() === 'synchronous') {
          update.loggingSynchronous = true;
        } else if (kw === 'privilege' && args[0]?.toLowerCase() === 'level' && args[1]) {
          update.privilege = parseInt(args[1], 10);
        } else if (kw === 'session-timeout' && args[0]) {
          update.sessionTimeoutMinutes = parseInt(args[0], 10);
        } else if (kw === 'history' && args[0]?.toLowerCase() === 'size' && args[1]) {
          update.historySize = parseInt(args[1], 10);
        } else if (kw === 'length' && args[0]) {
          update.terminalLength = parseInt(args[0], 10);
        } else if (kw === 'width' && args[0]) {
          update.terminalWidth = parseInt(args[0], 10);
        } else if (kw === 'autocommand') {
          update.autocommand = args.join(' ');
        } else if (kw === 'motd-banner') {
          update.motdBannerSuppressed = false;
        } else if (kw === 'exec' && args[0]?.toLowerCase() === 'banner') {
          update.execBannerSuppressed = false;
        } else if (kw === 'authorization' && args[0] && args[1]) {
          update.authorizationList = `${args[0]} ${args[1]}`;
        } else if (kw === 'accounting' && args[0] && args[1]) {
          update.accountingList = `${args[0]} ${args[1]}`;
        } else if (kw === 'speed' && args[0]) {
          update.speedBaud = parseInt(args[0], 10);
        } else if (kw === 'stopbits' && args[0]) {
          update.stopbits = parseInt(args[0], 10);
        } else if (kw === 'rotary' && args[0]) {
          update.rotaryGroup = parseInt(args[0], 10);
        } else if (kw === 'no' && args.length > 0) {
          const sub = args[0]?.toLowerCase();
          // `no password` clears the line secret (empty string → explicitly
          // unset, distinct from "never configured"); `no login` disables auth.
          if (sub === 'password') update.linePassword = '';
          else if (sub === 'login') update.login = 'none';
          update.removed = (raw ?? `no ${args.join(' ')}`).trim();
        }
        const line = dev._getVtyLineConfig?.().upsert(update as Parameters<NonNullable<ReturnType<NonNullable<typeof dev._getVtyLineConfig>>['upsert']>>[0]);
        // Bare `login` with no line password configured is inert on real IOS —
        // the line refuses incoming sessions until a password is set. Echo the
        // warning so operators (and the simulated incoming-VTY verdict) agree.
        if (kw === 'login' && update.login === 'password' && line?.requiresPasswordButUnset?.()) {
          return `% Login disabled on line vty ${range.first} ${range.last}, until 'password' is set`;
        }
        return '';
      });
    }
    // `exec-timeout <minutes> [seconds]` — persisted on the VTY block
    // so show running-config can echo it back exactly.
    // ─── Sous-mode `config-view` ────────────────────────────────────
    this.configViewTrie.registerGreedy('secret', 'Set the view password', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      const vue = this.vueEnCours();
      if (!vue) return '';
      // Meme forme que `username … secret` : un chiffre en tete decrit un
      // condense deja calcule, sinon on hache.
      const chiffre = args[0];
      const map: Record<string, 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7'> = {
        '0': 'plain', '5': 'md5', '7': 'type-7', '8': 'sha256', '9': 'scrypt',
      };
      if (map[chiffre] !== undefined && args.length > 1) {
        vue.secretAlgo = map[chiffre];
        vue.secret = args.slice(1).join(' ');
      } else {
        vue.secretAlgo = 'md5';
        vue.secret = args.join(' ');
      }
      return '';
    });
    this.configViewTrie.registerGreedy('commands', 'Configure the commands of a view', (args) => {
      // `commands exec {include|exclude} <commande>`
      if (args.length < 3) throw new CliIncomplete();
      const vue = this.vueEnCours();
      if (!vue) return '';
      if (args[0].toLowerCase() !== 'exec') {
        // IOS connait d'autres modes (`configure`, `interface`…) ; ce
        // simulateur ne filtre que le mode exec, et le dire vaut mieux
        // que ranger une regle que la porte ne consultera jamais.
        throw new CliInvalidInput({ token: args[0] });
      }
      const sens = args[1].toLowerCase();
      const commande = args.slice(2).join(' ').toLowerCase();
      // Une commande qui n'existe pas n'accorderait rien : l'accepter
      // ferait d'une faute de frappe une vue silencieusement vide, ce
      // qui est le defaut que ce mecanisme est cense refermer. IOS
      // refuse aussi. On interroge l'arbre PRIVILEGIE, le seul qui
      // contienne l'ensemble des commandes exec.
      const essai = this.privilegedTrie.match(commande);
      if (essai.status !== 'ok' && essai.status !== 'incomplete') {
        return '%Command not found';
      }
      if (sens === 'include' || sens === 'include-exclusive') {
        if (!vue.execInclude.includes(commande)) vue.execInclude.push(commande);
      } else if (sens === 'exclude') {
        if (!vue.execExclude.includes(commande)) vue.execExclude.push(commande);
      } else {
        throw new CliInvalidInput({ token: args[1] });
      }
      return '';
    });

    this.configLineTrie.setCompletionFilter((path, keyword) =>
      this.lineKeywordAllowed(path.length > 0 ? path[0] : keyword));
    // `login-timeout <secondes>` : le delai laisse pour s'identifier,
    // distinct de `exec-timeout` qui compte l'inactivite APRES la
    // connexion. La commande d'IOS etait refusee.
    this.configLineTrie.registerGreedy('login-timeout', 'Set login timeout', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      const secondes = Number.parseInt(args[0], 10);
      if (!/^\d+$/.test(args[0]) || secondes < 1 || secondes > 300) {
        throw new CliInvalidInput({ token: args[0] });
      }
      const range = this.selectedVtyRange;
      if (!range) return '';
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      dev._getVtyLineConfig?.().upsert({
        first: range.first, last: range.last, loginTimeoutSeconds: secondes,
      });
      return '';
    });
    this.configLineTrie.registerGreedy('exec-timeout', 'Set line exec timeout', (args) => {
      if (args.length === 0) return '% Incomplete command.';
      if (!/^\d+$/.test(args[0]) || (args[1] !== undefined && !/^\d+$/.test(args[1]))) {
        return "% Invalid input detected at '^' marker.";
      }
      const range = this.selectedVtyRange;
      if (!range) {
        if (this.selectedConsoleLine != null) {
          this.consoleLineExecTimeoutMin = parseInt(args[0], 10);
          this.consoleLineExecTimeoutSec = parseInt(args[1] ?? '0', 10);
        }
        return '';
      }
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      dev._getVtyLineConfig?.().upsert({
        first: range.first, last: range.last,
        execTimeoutMinutes: parseInt(args[0], 10),
        execTimeoutSeconds: parseInt(args[1] ?? '0', 10),
      });
      return '';
    });
    // `access-class <acl> {in|out}` — VTY ACL gate (§21).
    this.configLineTrie.registerGreedy('access-class', 'Apply ACL to VTY', (args) => {
      this.requireLineKind('access-class');
      const range = this.selectedVtyRange;
      if (!range) return '';
      if (!args[0] || !args[1]) return '% Incomplete command.';
      const dir = args[1].toLowerCase();
      if (dir !== 'in' && dir !== 'out') return "% Invalid input detected at '^' marker.";
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      const field = dir === 'out' ? 'accessClassOut' : 'accessClassIn';
      dev._getVtyLineConfig?.().upsert({ first: range.first, last: range.last, [field]: args[0] });
      return '';
    });
    // `transport input {all|ssh|telnet|none}` — the only line directive
    // we *do* react to today, because the sshd dispatch needs to know
    // whether SSH is administratively allowed on the VTY. Anything we
    // don't recognise is accepted silently, matching real IOS.
    this.configLineTrie.registerGreedy('transport', 'transport input/output', (args) => {
      const dev = this.d() as unknown as {
        _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none') => void;
        _getVtyLineConfig?: () => { upsert: (p: object) => void };
      };
      const dir = args[0]?.toLowerCase();
      if (!dir) return CISCO_ERRORS.INCOMPLETE;
      // `preferred` existe sur IOS et ne s'applique qu'aux connexions
      // sortantes d'un serveur de terminaux : il est accepté et
      // n'entraîne rien ici, mais il est refusé plutôt que stocké
      // inerte, faute de quoi l'aide promettrait un réglage sans effet.
      if (dir !== 'input' && dir !== 'output') return "% Invalid input detected at '^' marker.";
      const proto = (args[1] ?? '').toLowerCase();
      if (!proto) return '% Incomplete command.';
      if (proto !== 'all' && proto !== 'ssh' && proto !== 'telnet' && proto !== 'none') {
        return "% Invalid input detected at '^' marker.";
      }
      if (dir !== 'input') return '';
      if (this.selectedAuxLine != null) {
        this.auxLineTransportInput = proto;
        return '';
      }
      if (typeof dev._setVtyTransportInput === 'function') {
        dev._setVtyTransportInput(proto);
        const range = this.selectedVtyRange;
        if (range) dev._getVtyLineConfig?.().upsert({ first: range.first, last: range.last, transportInput: proto });
      }
      return '';
    });

    // ARP config commands (shared between router and switch)
    registerArpConfigCommands(this.configTrie, () => this.d());
  }

  /**
   * `test aaa group <nom> <user> <mot de passe> {legacy | new-code}`
   * (`docs/PRD-Serveur-HTTP-Cisco.md` §5).
   *
   * Elle existait dans `CiscoTerminalSession` — donc dans le terminal
   * graphique et nulle part ailleurs : la même machine y répondait par un
   * onglet et l'ignorait par le shell, en SSH comme dans un script. Le
   * motif invoqué là-bas (« un gestionnaire du trie doit rendre une
   * chaîne synchrone ») ne tient pas : `_pendingAsync` est précisément
   * l'écoutille que `ping` emprunte, et c'est celle-ci.
   */
  private registerTestAaaCommand(): void {
    this.privilegedTrie.registerGreedy('test aaa group',
      'Test AAA server-group authentication', (args) => {
        const [groupName, username, password, mode] = args;
        if (!groupName || !username || password === undefined) throw new CliIncomplete();
        // `legacy` et `new-code` désignent deux versions du code d'appel
        // interne d'IOS, pas deux protocoles : le dialogue sur le fil est
        // le même, donc les deux mots sont acceptés.
        if (mode === undefined) throw new CliIncomplete();
        if (mode !== 'legacy' && mode !== 'new-code') throw new CliInvalidInput({ token: mode });

        const dev = this.d() as unknown as { getAaaAuthenticator?: () => AaaAuthenticator };
        const authenticator = dev.getAaaAuthenticator?.();
        if (!authenticator) throw new CliInvalidInput({ token: 'aaa' });

        this._pendingAsync = runTestAaaGroup(authenticator, groupName, username, password)
          .then((lines) => lines.join('\n'));
        return '';
      });
    // Le nœud intermédiaire porte sa description, sans quoi `?` le
    // proposerait nu — ce que le garde-fou
    // `cisco-help-every-keyword-described` attrape.
    this.privilegedTrie.describeNode('test', 'Test subsystems, memory, and interfaces');
    this.privilegedTrie.describeNode('test aaa', 'Test AAA subsystem');
  }

  /**
   * La famille `ip http` (`docs/PRD-Serveur-HTTP-Cisco.md` §2). Les deux
   * drapeaux étaient rangés dans une table dont le rendu est mort, et
   * les cinq commandes qui les accompagnent étaient refusées — donc un
   * serveur qu'on ne pouvait ni déplacer de port, ni authentifier, ni
   * restreindre, et dont l'état ne survivait pas à un enregistrement.
   *
   * Une valeur hors bornes est REFUSÉE plutôt que rognée : la ranger
   * silencieusement ferait mentir la configuration relue.
   */
  private registerHttpServerCommands(): void {
    const svc = () => getHttpService(this.d());
    const sync = () => {
      const dev = this.d() as unknown as { _refreshHttpListeners?: () => void };
      dev._refreshHttpListeners?.();
    };

    this.configTrie.register('ip http server', 'Enable HTTP server', () => {
      svc()?.setEnabled(true); sync(); return '';
    });
    this.configTrie.register('no ip http server', 'Disable HTTP server', () => {
      svc()?.setEnabled(false); sync(); return '';
    });
    this.configTrie.register('ip http secure-server', 'Enable HTTPS server', () => {
      svc()?.setSecureEnabled(true, this.d().getHostname()); sync(); return '';
    });
    this.configTrie.register('no ip http secure-server', 'Disable HTTPS server', () => {
      svc()?.setSecureEnabled(false); sync(); return '';
    });

    this.configTrie.registerGreedy('ip http port', 'HTTP server port', (args) => {
      const port = Number(args[0]);
      if (args.length === 0) throw new CliIncomplete();
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliInvalidInput({ token: args[0] });
      }
      svc()?.setPort(port); sync(); return '';
    });
    this.configTrie.registerGreedy('no ip http port', 'Restore default HTTP port', () => {
      svc()?.setPort(80); sync(); return '';
    });
    this.configTrie.registerGreedy('ip http secure-port', 'HTTPS server port', (args) => {
      const port = Number(args[0]);
      if (args.length === 0) throw new CliIncomplete();
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliInvalidInput({ token: args[0] });
      }
      svc()?.setSecurePort(port); sync(); return '';
    });

    this.configTrie.registerGreedy('ip http authentication',
      'Set HTTP server authentication method', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        const method = args[0].toLowerCase();
        if (!HTTP_AUTH_METHODS.includes(method as HttpAuthMethod)) {
          throw new CliInvalidInput({ token: args[0] });
        }
        svc()?.setAuthMethod(method as HttpAuthMethod, args[1]);
        return '';
      });
    this.configTrie.registerGreedy('no ip http authentication',
      'Restore default authentication', () => { svc()?.resetAuthMethod(); return ''; });

    this.configTrie.registerGreedy('ip http max-connections',
      'Set maximum concurrent connections', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        const n = Number(args[0]);
        if (!Number.isInteger(n)
          || n < HTTP_MAX_CONNECTIONS_MIN || n > HTTP_MAX_CONNECTIONS_MAX) {
          throw new CliInvalidInput({ token: args[0] });
        }
        svc()?.setMaxConnections(n);
        return '';
      });
    this.configTrie.registerGreedy('no ip http max-connections',
      'Restore default connection limit', () => { svc()?.setMaxConnections(5); return ''; });

    this.configTrie.registerGreedy('ip http access-class',
      'Restrict HTTP server access by ACL', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        // `ipv4 <nom>` est la forme longue d'IOS ; le premier mot seul est
        // la forme numérotée historique.
        const acl = args[0].toLowerCase() === 'ipv4' ? args[1] : args[0];
        if (!acl) throw new CliIncomplete();
        svc()?.setAccessClass(acl);
        return '';
      });
    this.configTrie.registerGreedy('no ip http access-class',
      'Remove HTTP access restriction', () => { svc()?.setAccessClass(null); return ''; });

    this.configTrie.registerGreedy('ip http timeout-policy',
      'Set HTTP server timeout policy', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        // Les trois mots-clés sont obligatoires sur IOS et dans cet
        // ordre : la commande décrit une politique entière, pas trois
        // réglages indépendants.
        const wanted = ['idle', 'life', 'requests'];
        const values: number[] = [];
        for (let i = 0; i < 3; i++) {
          if (args[i * 2] === undefined || args[i * 2 + 1] === undefined) {
            throw new CliIncomplete();
          }
          if (args[i * 2].toLowerCase() !== wanted[i]) {
            throw new CliInvalidInput({ token: args[i * 2] });
          }
          const v = Number(args[i * 2 + 1]);
          if (!Number.isInteger(v) || v < 1) throw new CliInvalidInput({ token: args[i * 2 + 1] });
          values.push(v);
        }
        svc()?.setTimeoutPolicy({ idleSec: values[0], lifeSec: values[1], requests: values[2] });
        return '';
      });
    this.configTrie.registerGreedy('no ip http timeout-policy',
      'Restore default timeout policy', () => { svc()?.resetTimeoutPolicy(); return ''; });
  }
}

/**
 * Une empreinte stable dérivée du nom et de la taille. Ce n'est pas un
 * vrai MD5 de l'image — le simulateur n'en stocke aucune — mais une
 * valeur **reproductible** : `verify` deux fois de suite rend la même
 * chose, et deux fichiers différents en rendent deux différentes, ce
 * qui est tout ce qu'un exercice de vérification demande.
 */
function pseudoMd5(name: string, size: number): string {
  let h1 = 0x811c9dc5, h2 = size >>> 0;
  for (let i = 0; i < name.length; i++) {
    h1 = Math.imul(h1 ^ name.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + name.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const part = (n: number) => n.toString(16).padStart(8, '0');
  return part(h1) + part(h2) + part((h1 ^ h2) >>> 0) + part((h1 + h2) >>> 0);
}
