import { ArgumentParser } from "../args/argument-parser";
import { BaseCommand } from "../command/base-command";
import type { CommandContext, ExitCode, ICommand } from "../command/types";
import { EXIT_OK } from "../command/types";
import { CommandNotFoundError, ShellError, UsageError } from "../errors";
import { PermissionGuard } from "../exec/permission-guard";
import type { CommandIO } from "../io/types";
import type { MachineApi } from "../machine/types";
import type { CommandRegistry } from "../registry/command-registry";
import { applyCliPipeFilter, tokenizeCliLine } from "./cli-tokenizer";
import { matchByPrefix } from "./prefix-match";
import type { ModeRegistry } from "./mode-registry";
import type { CliCommand, CliSession } from "./types";
import { PipeBuffer } from "../io/pipe-buffer";

/**
 * =====================================================================
 *  CliInterpreter — porte d'entrée UNIQUE pour toute ligne CLI vendeur
 * =====================================================================
 *
 *  Pipeline strict, dans l'ordre, sans court-circuit :
 *
 *    1. Tokenisation (whitespace + quotes + filtre pipe terminal)
 *    2. Résolution hiérarchique dans le mode courant :
 *       - premier mot : préfixe-unique dans `mode.registry`
 *       - mots suivants : préfixe-unique dans `command.subRegistry`
 *         jusqu'à une commande terminale (sans sous-registre) ou
 *         jusqu'à un mot qui ne matche pas (les suivants deviennent argv)
 *    3. Politique de mode (`command.allowedModes` inclut le mode courant)
 *    4. Parsing d'arguments (`ArgumentParser`) — options/args typés selon
 *       le descripteur de la feuille résolue
 *    5. Garde de privilèges (`PermissionGuard` + `command.privileges`)
 *    6. Exécution (`command.execute(ctx)`)
 *    7. Filtre pipe terminal appliqué au texte de sortie
 *
 *  Aucune commande n'est appelée sans traverser CE pipeline. C'est le
 *  seul point où une ligne devient une exécution — les hôtes (terminal
 *  session, SSH exec, tests) l'invoquent, jamais les commandes elles-
 *  mêmes.
 */
/**
 * Formatage vendor-exact d'une `ShellError` produite par le socle
 * (`CommandNotFoundError`, `UsageError` "ambigu :", "indisponible en
 * mode", tokenisation). Injecté au constructeur du `CliInterpreter`
 * par le bootstrap vendeur — c'est le SEUL point où un message
 * kernel générique devient une chaîne vendeur (`% Invalid input...` /
 * `Error: Unrecognized command...`). Défaut = message brut.
 */
export type KernelErrorFormatter = (err: ShellError) => string;

const DEFAULT_ERROR_FORMATTER: KernelErrorFormatter = (err) => err.message;

export class CliInterpreter {
  private readonly argParser = new ArgumentParser();

  constructor(
    private readonly modes: ModeRegistry,
    private readonly machine: MachineApi,
    private readonly guard: PermissionGuard = new PermissionGuard(),
    private readonly errorFormatter: KernelErrorFormatter = DEFAULT_ERROR_FORMATTER,
  ) {}

  async interpretLine(line: string, session: CliSession, io: CommandIO, signal?: AbortSignal): Promise<ExitCode> {
    // Étape 1 : tokenisation. Le filtre pipe est extrait et retenu pour
    // l'étape 7 ; les commandes ignorent qu'il existe.
    let tokens;
    try {
      tokens = tokenizeCliLine(line);
    } catch (err) {
      if (err instanceof ShellError) {
        await io.stderr.write(`${this.errorFormatter(err)}\n`);
        session.lastExitCode = err.exitCode;
        return err.exitCode;
      }
      throw err;
    }
    if (tokens.argv.length === 0) return EXIT_OK;

    // Étape 2 : résolution hiérarchique dans le mode courant.
    const currentMode = session.modeStack[session.modeStack.length - 1];
    const mode = this.modes.get(currentMode);
    let resolved;
    try {
      resolved = this.resolveHierarchy(mode.registry, tokens.argv, currentMode);
    } catch (err) {
      if (err instanceof ShellError) {
        await io.stderr.write(`${this.errorFormatter(err)}\n`);
        session.lastExitCode = err.exitCode;
        return err.exitCode;
      }
      throw err;
    }
    if (!resolved) {
      // Aucune feuille résolue = commande inconnue dans ce mode. Signal
      // clair, jamais silencieux — le vrai IOS répond « Invalid input »
      // mais c'est un texte vendeur, à porter par une couche vendor-
      // wrapper si nécessaire (pas par l'interpréteur générique).
      throw new CommandNotFoundError(tokens.argv[0]);
    }

    const { command, argv, path } = resolved;

    // Étape 3 : politique de mode.
    const allowed = (command as CliCommand).allowedModes;
    if (allowed && !allowed.includes(currentMode)) {
      throw new UsageError(`${path.join(' ')} : indisponible en mode "${currentMode}"`);
    }

    // Étape 7 (préparé) : capture de la sortie pour appliquer le filtre.
    const useFilter = tokens.filter !== undefined;
    const capture = useFilter ? new PipeBuffer() : null;
    const effectiveIO: CommandIO = capture
      ? { stdin: io.stdin, stdout: capture, stderr: io.stderr, interaction: io.interaction, openSubShell: io.openSubShell }
      : io;

    // Étapes 4-6 : parse → guard → execute.
    const args = this.argParser.parse(argv, command.descriptor);
    this.guard.check(command, session.user, args);
    const ctx: CommandContext = {
      session,
      io: effectiveIO,
      machine: this.machine,
      args,
      rawArgv: argv,
      signal: signal ?? new AbortController().signal,
    };
    let exitCode: ExitCode;
    try {
      exitCode = command instanceof BaseCommand ? await command.run(ctx) : await command.execute(ctx);
    } catch (err) {
      if (err instanceof ShellError) {
        await io.stderr.write(`${path.join(' ')}: ${err.message}\n`);
        session.lastExitCode = err.exitCode;
        return err.exitCode;
      }
      throw err;
    }
    session.lastExitCode = exitCode;

    // Étape 7 : filtre pipe appliqué sur le texte capturé.
    if (capture) {
      await capture.close();
      const raw = await capture.readAll();
      const filtered = applyCliPipeFilter(raw, tokens.filter!);
      if (filtered) await io.stdout.write(filtered.endsWith('\n') ? filtered : `${filtered}\n`);
    }
    return exitCode;
  }

  /**
   * Descend dans les sous-registres tant que les mots suivants matchent
   * (préfixe-unique) ; s'arrête sur une feuille (pas de sous-registre)
   * OU sur un mot qui ne matche pas (les mots restants deviennent argv
   * de la feuille courante). `path` retient les noms canoniques déjà
   * consommés — utile pour les messages d'erreur.
   */
  private resolveHierarchy(
    rootRegistry: CommandRegistry,
    tokens: readonly string[],
    currentMode: string,
  ): { command: ICommand; argv: readonly string[]; path: readonly string[] } | null {
    let registry: CommandRegistry | undefined = rootRegistry;
    let leaf: ICommand | null = null;
    const path: string[] = [];
    let i = 0;
    while (i < tokens.length && registry) {
      const match = matchByPrefix(registry, tokens[i], currentMode);
      if (match.status === 'ambiguous') {
        throw new UsageError(`ambigu : "${tokens[i]}" ↦ ${match.candidates!.join(' | ')}`);
      }
      if (match.status === 'not-found') break;
      leaf = match.command!;
      path.push(leaf.descriptor.name);
      i++;
      registry = (leaf as CliCommand).subRegistry;
    }
    if (!leaf) return null;
    return { command: leaf, argv: tokens.slice(i), path };
  }

  /**
   * Aide contextuelle `?` (Cisco/Huawei) — n'exécute rien, retourne la
   * liste des sous-commandes disponibles au point de saisie. Utilise
   * la même mécanique de résolution que `interpretLine` pour rester
   * cohérent (mêmes règles de mode, mêmes règles de préfixe).
   */
  helpAt(line: string, session: CliSession): readonly { name: string; summary: string }[] {
    const { argv } = tokenizeCliLine(line);
    const currentMode = session.modeStack[session.modeStack.length - 1];
    const mode = this.modes.get(currentMode);
    let registry: CommandRegistry | undefined = mode.registry;
    for (const token of argv) {
      if (!registry) return [];
      const match = matchByPrefix(registry, token, currentMode);
      if (match.status !== 'ok') return this.registryDescriptors(registry, currentMode, token);
      const sub = (match.command as CliCommand).subRegistry;
      if (!sub) return [{ name: '<cr>', summary: 'terminer la commande' }];
      registry = sub;
    }
    return registry ? this.registryDescriptors(registry, currentMode) : [];
  }

  private registryDescriptors(
    registry: CommandRegistry,
    currentMode: string,
    prefix?: string,
  ): { name: string; summary: string }[] {
    const needle = prefix?.toLowerCase() ?? '';
    return registry.list()
      .filter((d) => {
        if (needle && !d.name.toLowerCase().startsWith(needle)) return false;
        const cmd = registry.resolve(d.name);
        const modes = (cmd as CliCommand | undefined)?.allowedModes;
        return !modes || modes.includes(currentMode);
      })
      .map((d) => ({ name: d.name, summary: d.summary }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** La table des modes utilisée par cet interpréteur — exposée aux
   *  commandes de transition (`enable`, `configure terminal`, `exit`,
   *  `end`) via `ctx.machine.cli` (façade). */
  getModes(): ModeRegistry {
    return this.modes;
  }
}
