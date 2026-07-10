import { Session } from "../session/types";

/**
 * Expansion juste avant exécution : $VAR, ${VAR}, $?, ~.
 * Séparée du parser pour que l'AST reste réutilisable (boucles).
 */
export class Expander {
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
    return [result]; // le globbing (*.txt) retournerait plusieurs éléments
  }
}
