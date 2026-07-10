import { Session } from "../session/types";

/** Construit l'invite façon PS1 : \u utilisateur, \h hôte, \w cwd, \$ (# si root). */
export class PromptBuilder {
  constructor(private readonly template = "\\u@\\h:\\w\\$ ") {}

  build(session: Session, hostname: string): string {
    return this.template
      .replace(/\\u/g, session.user.name)
      .replace(/\\h/g, hostname)
      .replace(/\\w/g, session.cwd)
      .replace(/\\\$/g, session.user.isRoot() ? "#" : "$");
  }
}
