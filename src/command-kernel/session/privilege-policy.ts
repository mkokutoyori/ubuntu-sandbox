import { AuthorizationResult, Capability, PrivilegeLevel, User } from "./types";

/**
 * Politique de privilèges EMBARQUÉE DANS LA COMMANDE.
 * C'est la commande qui déclare qui a le droit de l'exécuter.
 * Interface = Strategy : on peut écrire des politiques exotiques
 * (horaires, quotas, MFA…) sans toucher au moteur.
 */
export interface PrivilegePolicy {
  readonly minLevel: PrivilegeLevel;
  readonly requiredGroups?: readonly string[];
  readonly requiredCapabilities?: readonly Capability[];
  authorize(user: User): AuthorizationResult;
}

/** Implémentation standard : niveau + groupes + capacités. */
export class DefaultPrivilegePolicy implements PrivilegePolicy {
  constructor(
    public readonly minLevel: PrivilegeLevel,
    public readonly requiredGroups: readonly string[] = [],
    public readonly requiredCapabilities: readonly Capability[] = [],
  ) {}

  authorize(user: User): AuthorizationResult {
    if (user.isRoot()) return { granted: true }; // root passe toujours

    if (this.minLevel === PrivilegeLevel.ROOT) {
      return { granted: false, reason: "réservée au superutilisateur" };
    }

    const missingGroup = this.requiredGroups.find((g) => !user.groups.has(g));
    if (missingGroup) {
      return { granted: false, reason: `groupe requis : ${missingGroup}` };
    }

    const missingCap = this.requiredCapabilities.find(
      (c) => !user.capabilities.has(c),
    );
    if (missingCap) {
      return { granted: false, reason: `capacité requise : ${missingCap}` };
    }

    return { granted: true };
  }
}
