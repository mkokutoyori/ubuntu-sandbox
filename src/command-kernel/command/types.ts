import { ArgumentSpec, OptionSpec } from "../args/types";
import { ParsedArgs } from "../args/parsed-args";
import { CommandIO } from "../io/types";
import { MachineApi } from "../machine/types";
import { PrivilegePolicy } from "../session/privilege-policy";
import { Session } from "../session/types";

export type ExitCode = number;
export const EXIT_OK: ExitCode = 0;
/** 128 + SIGINT(2) : commande interrompue par Ctrl+C (ctx.signal). */
export const EXIT_INTERRUPTED: ExitCode = 130;
/** 128 + SIGPIPE(13) : écriture vers un pipe dont le lecteur est parti. */
export const EXIT_BROKEN_PIPE: ExitCode = 141;

/**
 * Carte d'identité déclarative d'une commande : nom, alias, contrat
 * d'arguments/options ET politique de privilèges.
 * Le moteur n'a besoin QUE de ce descripteur pour router, parser,
 * autoriser et générer l'aide (--help) automatiquement.
 */
export interface CommandDescriptor {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly args: readonly ArgumentSpec[];
  readonly options: readonly OptionSpec[];
  readonly privileges: PrivilegePolicy;
  readonly category?: string;
  readonly version?: string;
  /** Un jeton non reconnu ressemblant à une option devient un positional
   *  au lieu de lever une erreur (ex: `echo -w foo`, comme le vrai `echo`). */
  readonly lenientOptions?: boolean;
  /** Commande qui tient le terminal et émet au fil de l'eau (sonde réseau,
   *  suivi) : l'hôte la fait tourner en job de premier plan avec un canal
   *  vivant (onOutput/signal) au lieu d'attendre une réponse d'un bloc. */
  readonly streaming?: boolean;
}

/** Tout ce dont une commande dispose au moment de l'exécution. */
export interface CommandContext {
  readonly session: Session;
  readonly io: CommandIO;
  readonly machine: MachineApi; // les méthodes internes de la machine
  readonly args: ParsedArgs; // l'entrée utilisateur déjà convertie
  readonly rawArgv: readonly string[];
  readonly signal: AbortSignal; // annulation (Ctrl+C)
}

/**
 * LE contrat que toute commande — interne ou développée à part —
 * doit respecter pour être enregistrable dans le registre.
 */
export interface ICommand {
  readonly descriptor: CommandDescriptor;
  execute(ctx: CommandContext): Promise<ExitCode>;
}
