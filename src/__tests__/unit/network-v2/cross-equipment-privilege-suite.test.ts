/**
 * Cross-equipment privilege suite — 400+ scenarios, table-driven.
 *
 * Sibling of `cross-equipment-ssh-suite.test.ts`, built the same way: one
 * heterogeneous LAN, `test.each` over data rows, adding a case is adding
 * a row. Where that suite asks "does SSH reach the peer", this one asks
 * the question underneath — **once you are on the peer, what may you
 * run?** — and asks it from three different client machines, because a
 * privilege model that quietly took the caller's word for it would pass
 * on one box and fail across a LAN.
 *
 * Every threshold below was MEASURED against the product before being
 * written, and two measurements changed the design:
 *
 *  - **A Catalyst is not an SSH target here.** `Switch` carries no TCP
 *    stack, so an ssh onto it never launches — the reference suite says
 *    the same in its own topology comment ("pure L2 switches — no L3
 *    address"). The switch therefore keeps the whole privilege matrix but
 *    over its vty, which is the same gate, and §13 pins the refusal
 *    itself rather than leaving it as a silent hole.
 *  - **VRP does not read the IOS `privilege` table.** A Huawei peer
 *    answers `display version` at every level. §7 pins that DIFFERENCE
 *    instead of asserting a uniformity the two vendors do not have.
 *
 * The defaults in `UNMOVED` are measured too, not assumed: `clear
 * counters`, `show logging` and `show tech-support` sit at 15 with
 * `show running-config`, while `show clock`, `show arp` and `show
 * interfaces` sit at 1. An earlier draft of this file guessed some of
 * them and was wrong in both directions.
 *
 * The LAN is built once and re-registered per case: 400 logins that each
 * rebuilt a lab would cost minutes for nothing, and these rows only READ
 * the configuration. The two sections that MUTATE it build their own.
 */

import { describe, expect, beforeEach, beforeAll, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import {
  tryInterpretSshLaunch, finalisePendingAuth,
  type SshLaunchOptions, type PendingSshAuth,
} from '@/shell/sshLauncher';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

reinstallDefaultShells();

/** What a refusal looks like, whichever gate produced it. */
const REFUSED = /% Invalid input|authorization failed|% Access denied|Unrecognized/i;

const LEVELS = [1, 3, 5, 7, 10, 12, 15] as const;
type Level = (typeof LEVELS)[number];

/**
 * The assignments both Cisco boxes carry. Moving a command DOWN from 15
 * is the case that matters: a rule that only ever raised a level could be
 * mistaken for the default and would prove nothing.
 */
const EXEC_RULES: ReadonlyArray<readonly [string, Level]> = [
  ['show clock', 3],
  ['show ip interface brief', 5],
  ['clear counters', 7],
  ['show running-config', 10],
  ['show startup-config', 12],
];

/** Commands nobody moved, with the level the product actually gives them. */
const UNMOVED: ReadonlyArray<readonly [string, Level]> = [
  ['show version', 1],
  ['show users', 1],
  ['show sessions', 1],
  ['show history', 1],
  ['show logging', 15],
  ['show tech-support', 15],
];

/** Defaults restored by `privilege exec reset`, measured on a bare router. */
const DEFAULT_LEVEL: Readonly<Record<string, Level>> = {
  'show clock': 1,
  'show ip interface brief': 1,
  'clear counters': 15,
  'show running-config': 15,
  'show startup-config': 15,
  'show version': 1,
};

const IP = {
  linux1: '10.0.0.1', lxsrv1: '10.0.0.3', win1: '10.0.0.4',
  ciscoR1: '10.0.0.6', hwR1: '10.0.0.8',
} as const;

interface PrivLan {
  linux1: LinuxPC; lxsrv1: LinuxServer; win1: WindowsPC;
  ciscoR1: CiscoRouter; ciscoS1: CiscoSwitch; hwR1: HuaweiRouter;
  sw: GenericSwitch;
  all: Equipment[];
}

/** One account per level: `username uN privilege N secret PassN`. */
const accountFor = (level: Level) => ({ user: `u${level}`, password: `Pass${level}` });

/**
 * Les règles du laboratoire partagé.
 *
 * `privilege exec level 1 show` en tête est le remède que Cisco
 * documente : hisser `show clock` ou `show running-config` hisse leurs
 * PARENTES, donc `show`, et toute la branche quitterait le niveau 1 —
 * le piège n°1 du chapitre. Sans cette ligne, ce laboratoire décrirait
 * une machine qui n'existe pas.
 *
 * Note historique : une version précédente disait que la règle courte
 * `privilege exec level 3 show` « couvrait toute la branche » et
 * déplaçait les commandes laissées à leur défaut. C'était vrai du
 * simulateur d'alors, qui appliquait à TOUTE règle la sémantique du
 * mot-clé `all`. Une règle sans `all` ne vaut désormais que pour la
 * commande NOMMÉE, donc poser `show` ici ne déplace plus rien.
 */
const privilegeLines = (): string[] => [
  'privilege exec level 1 show',
  ...EXEC_RULES.map(([cmd, lvl]) => `privilege exec level ${lvl} ${cmd}`),
  // Un espace voisin, pour que le débordement soit observable s'il a lieu.
  'privilege configure level 4 hostname',
];

async function configureCiscoRouter(dev: CiscoRouter): Promise<void> {
  for (const line of [
    'enable', 'configure terminal', 'hostname ciscoR1',
    'interface GigabitEthernet0/0', `ip address ${IP.ciscoR1} 255.255.255.0`, 'no shutdown', 'exit',
    ...LEVELS.map((l) => `username ${accountFor(l).user} privilege ${l} secret ${accountFor(l).password}`),
    'enable secret Enable@15', 'ip domain-name lab.local', 'crypto key generate rsa',
    ...privilegeLines(),
    'line vty 0 4', 'login local', 'transport input ssh', 'end',
  ]) await dev.executeCommand(line);
}

async function configureCiscoSwitch(dev: CiscoSwitch): Promise<void> {
  for (const line of [
    'enable', 'configure terminal', 'hostname ciscoS1',
    ...LEVELS.map((l) => `username ${accountFor(l).user} privilege ${l} secret ${accountFor(l).password}`),
    'enable secret Enable@15',
    ...privilegeLines(),
    'end',
  ]) await dev.executeCommand(line);
}

async function configureHuawei(dev: HuaweiRouter): Promise<void> {
  for (const line of [
    'system-view', 'sysname hwR1',
    'interface GigabitEthernet0/0/0', `ip address ${IP.hwR1} 255.255.255.0`, 'undo shutdown', 'quit',
    'aaa', 'local-user hwu password irreversible-cipher Pass@123',
    'local-user hwu privilege level 3', 'local-user hwu service-type ssh', 'quit',
    'rsa local-key-pair create', 'stelnet server enable',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit', 'quit',
  ]) await dev.executeCommand(line);
}

let lanPromise: Promise<PrivLan> | null = null;

async function buildPrivLan(): Promise<PrivLan> {
  const linux1 = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const lxsrv1 = new LinuxServer('linux-server', 'lxsrv1', 0, 0);
  const win1 = new WindowsPC('windows-pc', 'win1', 0, 0);
  const ciscoR1 = new CiscoRouter('ciscoR1', 0, 0);
  const ciscoS1 = new CiscoSwitch('switch-cisco', 'ciscoS1', 24, 0, 0);
  const hwR1 = new HuaweiRouter('hwR1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 16, 0, 0);

  const all: Equipment[] = [linux1, lxsrv1, win1, ciscoR1, ciscoS1, hwR1, sw];
  all.forEach((d) => d.powerOn());
  [linux1, lxsrv1, win1, ciscoR1, ciscoS1, hwR1].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });

  const mask = new SubnetMask('255.255.255.0');
  linux1.getPorts()[0].configureIP(new IPAddress(IP.linux1), mask);
  lxsrv1.getPorts()[0].configureIP(new IPAddress(IP.lxsrv1), mask);
  win1.getPorts()[0].configureIP(new IPAddress(IP.win1), mask);

  await configureCiscoRouter(ciscoR1);
  await configureCiscoSwitch(ciscoS1);
  await configureHuawei(hwR1);

  return { linux1, lxsrv1, win1, ciscoR1, ciscoS1, hwR1, sw, all };
}

const lan = (): Promise<PrivLan> => (lanPromise ??= buildPrivLan());

/**
 * The global setup clears the registry before every test, and the SSH
 * launcher resolves its target through it. The LAN is shared on purpose
 * (see the header), so put its devices back rather than rebuild them.
 */
beforeEach(async () => {
  const l = await lan();
  for (const d of l.all) EquipmentRegistry.getInstance().register(d);
});

beforeAll(async () => { await lan(); }, 180_000);

type Client = 'linux1' | 'lxsrv1' | 'win1';
const CLIENTS: Client[] = ['linux1', 'lxsrv1', 'win1'];

function launchOptions(l: PrivLan, from: Client): SshLaunchOptions {
  const device = l[from];
  return {
    defaultUser: 'root',
    sourceIp: IP[from],
    sourceDevice: device as never,
    wireProbe: (h, p) => (device as unknown as {
      tcpConnectOutcome(ip: IPAddress, port: number): 'open' | 'refused' | 'timeout';
    }).tcpConnectOutcome(new IPAddress(h), p),
  };
}

/** `ssh <user>@<peer> <cmd>` — a real login, then the command on the far side. */
async function sshExec(
  l: PrivLan, from: Client, target: string, user: string, password: string, command: string,
): Promise<string> {
  const attempt = await tryInterpretSshLaunch(
    `ssh ${user}@${target} ${command}`, launchOptions(l, from),
  );
  const kind = (attempt as { kind?: string } | null)?.kind;
  if (kind !== 'pending') return `<launch:${String(kind)}>`;
  const outcome = await finalisePendingAuth(
    (attempt as { pendingAuth: PendingSshAuth }).pendingAuth, password,
  );
  const lines = (outcome as { lines?: readonly string[] }).lines ?? [];
  return lines.join('\n');
}

const sshAtLevel = (
  l: PrivLan, from: Client, target: string, level: Level, command: string,
): Promise<string> => {
  const { user, password } = accountFor(level);
  return sshExec(l, from, target, user, password, command);
};

/** The same gate reached without a login — for the rule's own algebra. */
function vtyAt(dev: CiscoRouter | CiscoSwitch | HuaweiRouter, level: number, vrp = false): CliShellSession {
  const s = (dev as unknown as { openVtySession(): CliShellSession }).openVtySession();
  s.state.privilegeLevel = level;
  (s.state as { mode: unknown }).mode = vrp ? 'user-view' : (level >= 15 ? 'privileged' : 'user');
  return s;
}

const runAt = async (
  dev: CiscoRouter | CiscoSwitch | HuaweiRouter, level: number, command: string, vrp = false,
): Promise<string> => String(await (dev as unknown as {
  executeCommandInVty(c: string, s: CliShellSession): Promise<string>;
}).executeCommandInVty(command, vtyAt(dev, level, vrp)));

const reachable = (out: string): boolean => !REFUSED.test(out);

const requiredFor = (command: string): Level => {
  const moved = EXEC_RULES.find(([c]) => c === command);
  if (moved) return moved[1];
  const fixed = UNMOVED.find(([c]) => c === command);
  return fixed ? fixed[1] : 15;
};

interface LevelRow { command: string; required: Level; level: Level }
const levelRows = (rules: ReadonlyArray<readonly [string, Level]>): LevelRow[] =>
  rules.flatMap(([command, required]) => LEVELS.map((level) => ({ command, required, level })));

// ── §1 — le niveau du compte voyage avec la session SSH (35) ─────────

describe('§1 un compte SSH ne peut que ce que son niveau permet — routeur Cisco', () => {
  test.each(levelRows(EXEC_RULES))(
    'niveau $level, `$command` (exigée au niveau $required)',
    async ({ command, required, level }) => {
      const l = await lan();
      const out = await sshAtLevel(l, 'linux1', IP.ciscoR1, level, command);
      expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= required);
    }, 30_000);
});

// ── §2 — la même règle sur un commutateur Cisco, via sa vty (35) ─────

describe('§2 la même règle décide sur un commutateur Cisco', () => {
  test.each(levelRows(EXEC_RULES))(
    'niveau $level, `$command` (exigée au niveau $required)',
    async ({ command, required, level }) => {
      const l = await lan();
      const out = await runAt(l.ciscoS1, level, command);
      expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= required);
    }, 30_000);
});

// ── §3 — le client ne prête pas son niveau (84) ──────────────────────

const CROSS_COMMANDS = [
  'show clock', 'show ip interface brief', 'show running-config', 'show version',
] as const;

describe('§3 le verdict suit le COMPTE, pas la machine qui appelle', () => {
  test.each(
    CLIENTS.flatMap((from) =>
      LEVELS.flatMap((level) =>
        CROSS_COMMANDS.map((command) => ({ from, level, command, required: requiredFor(command) })))),
  )('depuis $from, niveau $level, `$command`', async ({ from, level, command, required }) => {
    const l = await lan();
    const out = await sshAtLevel(l, from, IP.ciscoR1, level, command);
    expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= required);
  }, 30_000);
});

// ── §4 — la règle la plus longue gagne (28) ──────────────────────────

/**
 * `privilege exec level 3 show` couvre toute la branche ; chaque règle
 * plus longue la bat sur la sienne. Un `show` qu'aucune règle longue ne
 * nomme tombe donc à 3 — c'est ce que les deux premières lignes
 * mesurent, sans quoi on ne saurait pas si la règle courte existe.
 */
const LONGEST_ROWS: ReadonlyArray<readonly [string, Level]> = [
  ['show interfaces', 3],
  ['show arp', 3],
  ['show running-config', 10],
  ['show startup-config', 12],
];

let longestPromise: Promise<CiscoRouter> | null = null;

/** Le laboratoire de §4 : la règle courte ET les règles longues ensemble. */
const longestLab = (): Promise<CiscoRouter> => (longestPromise ??= (async () => {
  const dev = new CiscoRouter('R-longest', 0, 0);
  dev.powerOn();
  for (const c of ['enable', 'configure terminal',
    'privilege exec level 3 show',
    ...EXEC_RULES.map(([cmd, lvl]) => `privilege exec level ${lvl} ${cmd}`),
    'end']) await dev.executeCommand(c);
  return dev;
})());

describe('§4 la règle la plus longue décide, pas l\'ordre de frappe', () => {
  test.each(levelRows(LONGEST_ROWS))(
    'niveau $level, `$command` (exigée au niveau $required)',
    async ({ command, required, level }) => {
      const dev = await longestLab();
      const out = await runAt(dev, level, command);
      expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= required);
    }, 30_000);
});

// ── §5 — les espaces ne débordent pas l'un sur l'autre (21) ──────────

/**
 * `privilege configure level 4 hostname` est posée sur le laboratoire.
 * Elle vit dans l'espace `configure` et ne doit déplacer aucune commande
 * d'EXÉCUTION : les trois ci-dessous gardent le niveau que §1 et §6 leur
 * mesurent, règle voisine ou pas.
 */
const SCOPE_COMMANDS = ['show clock', 'clear counters', 'show version'] as const;

describe('§5 une règle `configure` ne déplace rien en `exec`', () => {
  test.each(
    SCOPE_COMMANDS.flatMap((command) => LEVELS.map((level) => ({ command, level }))),
  )('niveau $level, `$command` en EXEC', async ({ command, level }) => {
    const l = await lan();
    const out = await runAt(l.ciscoR1, level, command);
    expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= requiredFor(command));
  }, 30_000);
});

// ── §6 — les défauts que personne n'a déplacés (42) ──────────────────

describe('§6 une commande non déplacée garde son niveau', () => {
  test.each(levelRows(UNMOVED))(
    'niveau $level, `$command` (défaut $required)',
    async ({ command, required, level }) => {
      const l = await lan();
      const out = await runAt(l.ciscoR1, level, command);
      expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= required);
    }, 30_000);
});

// ── §7 — VRP n'est pas IOS (42) ──────────────────────────────────────

const VRP_COMMANDS = [
  'display version', 'display clock', 'display current-configuration',
  'display interface brief', 'display ip routing-table', 'display users',
] as const;

describe('§7 un pair Huawei ne lit pas la table `privilege` d\'IOS', () => {
  test.each(
    VRP_COMMANDS.flatMap((command) => LEVELS.map((level) => ({ command, level }))),
  )('niveau $level, `$command` sur VRP', async ({ command, level }) => {
    const l = await lan();
    const out = await runAt(l.hwR1, level, command, true);
    // Mesuré : VRP répond à tous les niveaux. Ce cas fige la DIFFÉRENCE
    // entre les deux constructeurs plutôt qu'une uniformité inventée.
    expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(true);
  }, 30_000);
});

// ── §8 — `reset` rend le défaut (28, laboratoire propre : il MUTE) ───

const RESET_COMMANDS = [
  'show clock', 'show ip interface brief', 'clear counters', 'show running-config',
] as const;

describe('§8 `privilege exec reset` rend la commande à son défaut', () => {
  test.each(
    RESET_COMMANDS.flatMap((command) => LEVELS.map((level) => ({ command, level }))),
  )('niveau $level, `$command` après reset', async ({ command, level }) => {
    const dev = new CiscoRouter('R-reset', 0, 0);
    dev.powerOn();
    for (const c of ['enable', 'configure terminal',
      'privilege exec level 1 show',
      ...EXEC_RULES.map(([cmd, lvl]) => `privilege exec level ${lvl} ${cmd}`),
      `privilege exec reset ${command}`, 'end']) await dev.executeCommand(c);
    const out = await runAt(dev, level, command);
    expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= DEFAULT_LEVEL[command]);
  }, 30_000);
});

// ── §9 — bornes et validation (9) ────────────────────────────────────

describe('§9 un niveau hors de 0-15 est refusé, pas rangé', () => {
  test.each((['16', '99', '-1', 'sept', ''] as const).map((niveau) => ({ niveau })))(
    'niveau « $niveau » est refusé', async ({ niveau }) => {
      const dev = new CiscoRouter('R-bounds', 0, 0);
      dev.powerOn();
      await dev.executeCommand('enable');
      await dev.executeCommand('configure terminal');
      const out = String(await dev.executeCommand(`privilege exec level ${niveau} show clock`));
      expect(out).toMatch(/% (Invalid input|Incomplete command)/);
    }, 30_000);

  test.each((['0', '1', '7', '15'] as const).map((niveau) => ({ niveau })))(
    'niveau « $niveau » est accepté', async ({ niveau }) => {
      const dev = new CiscoRouter('R-ok', 0, 0);
      dev.powerOn();
      await dev.executeCommand('enable');
      await dev.executeCommand('configure terminal');
      expect(String(await dev.executeCommand(`privilege exec level ${niveau} show clock`))).toBe('');
    }, 30_000);
});

// ── §10 — deux sessions ne partagent pas leur niveau (21) ────────────

describe('§10 une session privilégiée n\'ouvre rien aux autres', () => {
  test.each(
    LEVELS.flatMap((level) => (['show running-config', 'show startup-config', 'clear counters'] as const)
      .map((command) => ({ level, command }))),
  )('une session à 15 n\'ouvre pas `$command` au niveau $level',
    async ({ level, command }) => {
      const l = await lan();
      await runAt(l.ciscoR1, 15, command);
      const out = await runAt(l.ciscoR1, level, command);
      expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= requiredFor(command));
    }, 30_000);
});

// ── §11 — un mot de passe faux n'exécute rien, à aucun niveau (7) ────

describe('§11 un mot de passe faux n\'exécute la commande à aucun niveau', () => {
  test.each(LEVELS.map((level) => ({ level })))(
    'niveau $level, mauvais secret', async ({ level }) => {
      const l = await lan();
      const { user } = accountFor(level);
      const out = await sshExec(l, 'linux1', IP.ciscoR1, user, 'MauvaisSecret', 'show version');
      expect(out).not.toMatch(/Cisco IOS Software/);
    }, 30_000);
});

// ── §12 — `show privilege` dit le niveau du compte (7) ───────────────

describe('§12 la session SSH annonce le niveau de son compte', () => {
  test.each(LEVELS.map((level) => ({ level })))(
    'un compte de niveau $level lit `Current privilege level is $level`',
    async ({ level }) => {
      const l = await lan();
      const out = await sshAtLevel(l, 'linux1', IP.ciscoR1, level, 'show privilege');
      expect(out).toContain(`Current privilege level is ${level}`);
    }, 30_000);
});

// ── §13 — un Catalyst n'est pas une cible SSH (3) ────────────────────

/**
 * Fait mesuré, écrit plutôt que laissé en trou : `Switch` n'a aucune pile
 * TCP, donc l'ssh n'aboutit pas — et c'est pourquoi §2 passe par la vty.
 * Le cas existe pour que la limite soit tenue par un test : le jour où un
 * commutateur écoutera, il faudra revenir ici plutôt que le découvrir.
 */
describe('§13 un commutateur Cisco n\'écoute pas en SSH', () => {
  test.each(CLIENTS.map((from) => ({ from })))(
    'depuis $from, l\'ssh vers le commutateur n\'aboutit pas', async ({ from }) => {
      const l = await lan();
      const out = await sshExec(l, from, '10.0.0.7', 'u15', 'Pass15', 'show version');
      expect(out).not.toMatch(/Cisco IOS Software/);
    }, 30_000);
});

// ── §14 — routeur et commutateur s'accordent (35) ────────────────────

describe('§14 la même règle donne le même verdict sur les deux plateformes', () => {
  test.each(levelRows(EXEC_RULES))(
    'niveau $level, `$command` : routeur et commutateur d\'accord',
    async ({ command, level }) => {
      const l = await lan();
      const routeur = reachable(await runAt(l.ciscoR1, level, command));
      const commutateur = reachable(await runAt(l.ciscoS1, level, command));
      expect(commutateur).toBe(routeur);
    }, 30_000);
});

// ── §15 — `enable` demande le secret du niveau visé (35) ─────────────

describe('§15 `enable` sans le bon secret ne monte pas le niveau', () => {
  test.each(
    LEVELS.flatMap((level) => (['show running-config', 'clear counters', 'show startup-config',
      'show logging', 'show tech-support'] as const).map((command) => ({ level, command }))),
  )('niveau $level, `$command` reste refusée sans `enable`', async ({ level, command }) => {
    const l = await lan();
    const out = await sshAtLevel(l, 'linux1', IP.ciscoR1, level, command);
    expect(reachable(out), `sortie: ${out.slice(0, 120)}`).toBe(level >= requiredFor(command));
  }, 30_000);
});
