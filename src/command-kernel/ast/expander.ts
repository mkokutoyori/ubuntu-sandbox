import { ESCAPED_DOLLAR } from "./tokens";
import { Session } from "../session/types";

/**
 * Contrat minimal attendu par l'Executor — permet à un vendeur dont la
 * syntaxe diverge trop du bash (ex: cmd.exe et son `%VAR%`) de fournir sa
 * propre expansion sans toucher à l'Executor lui-même.
 */
export interface IExpander {
  expand(word: string, session: Session): string[];
}

/**
 * Expansion juste avant exécution : $VAR, ${VAR}, $?, ~.
 * Séparée du parser pour que l'AST reste réutilisable (boucles).
 */
export class Expander implements IExpander {
  expand(word: string, session: Session): string[] {
    const pid = session.shellPid;
    const ppid = session.parentPid;
    let result = word
      .replace(/\$\?/g, String(session.lastExitCode))
      // Paramètres spéciaux du shell : $$/$BASHPID (PID du shell) et $PPID
      // (parent). Traités avant la règle générique $VAR car $$ n'est pas un
      // nom `\w+`, et PPID/BASHPID doivent venir de la session, pas d'une
      // variable homonyme.
      .replace(/\$\$|\$\{BASHPID\}|\$BASHPID\b/g, (m) => (pid !== undefined ? String(pid) : m))
      .replace(/\$\{PPID\}|\$PPID\b/g, (m) => (ppid !== undefined ? String(ppid) : m))
      .replace(/\$\{(\w+)\}/g, (_, name: string) =>
        session.variables.get(name) ?? session.env.get(name) ?? "",
      )
      .replace(/\$(\w+)/g, (_, name: string) =>
        session.variables.get(name) ?? session.env.get(name) ?? "",
      );

    if (result.startsWith("~")) {
      result = (session.env.get("HOME") ?? "/") + result.slice(1);
    }
    result = result.split(ESCAPED_DOLLAR).join("$");
    return [result]; // le globbing (*.txt) retournerait plusieurs éléments
  }
}
