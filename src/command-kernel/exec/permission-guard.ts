import { ParsedArgs } from "../args/parsed-args";
import { ICommand } from "../command/types";
import { PermissionError } from "../errors";
import { User } from "../session/types";

/**
 * Applique la politique portée par la commande AVANT toute exécution,
 * y compris les capacités exigées par certaines options (--system…).
 * Point d'ancrage idéal pour la journalisation d'audit.
 */
export class PermissionGuard {
  check(command: ICommand, user: User, args?: ParsedArgs): void {
    const verdict = command.descriptor.privileges.authorize(user);
    if (!verdict.granted) {
      throw new PermissionError(
        `${command.descriptor.name} : accès refusé (${verdict.reason})`,
      );
    }
    if (args) {
      for (const opt of command.descriptor.options) {
        if (
          opt.requiredCapability &&
          args.has(opt.long) &&
          !user.isRoot() &&
          !user.capabilities.has(opt.requiredCapability)
        ) {
          throw new PermissionError(
            `option --${opt.long} : capacité ${opt.requiredCapability} requise`,
          );
        }
      }
    }
  }
}
