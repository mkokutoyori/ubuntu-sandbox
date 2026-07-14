import { CommandContext } from "./types";
import { BaseCommand } from "./base-command";

/**
 * Classe de base des commandes à sortie continue (§14.6) : `ping`,
 * `traceroute`, `netstat -t`, suivis `-f`… Leur descripteur déclare
 * `streaming: true` ; l'hôte terminal les route alors par une entrée unique
 * et générique (un job de premier plan qui diffuse `onOutput` et s'arrête
 * sur Ctrl+C) plutôt que par un intercepteur dédié par commande. La commande
 * n'a plus qu'à définir SON comportement : écrire ses lignes au fil de l'eau
 * (`emit`) et rythmer ses envois en respectant l'annulation (`pace`). La
 * mécanique de flux n'est jamais redupliquée d'une commande à l'autre.
 */
export abstract class StreamingCommand extends BaseCommand {
  /** Écrit une ligne sur stdout en garantissant le saut de ligne final. */
  protected emit(ctx: CommandContext, line: string): Promise<void> {
    return ctx.io.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  /**
   * Attend `ms` en respectant l'annulation de l'hôte : résout immédiatement
   * si `signal` est déjà — ou devient — `aborted`, sans laisser de timer
   * pendant (garde-fou fuite mémoire / test qui n'avance jamais l'horloge).
   */
  protected pace(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const onAbort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
