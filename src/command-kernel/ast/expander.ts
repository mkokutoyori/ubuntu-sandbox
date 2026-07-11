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
    let result = word
      .replace(/\$\?/g, String(session.lastExitCode))
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
