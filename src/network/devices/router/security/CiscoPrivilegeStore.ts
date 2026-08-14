import type { CommandLevelRule } from '../../shells/cli/CliAuthorization';

/**
 * Le magasin des regles `privilege <mode> level <n> <commande>` que
 * porte un equipement Cisco.
 *
 * Il etait atteint par un cast en ligne repete a cinq endroits
 * (`as unknown as { _ciscoPrivilegeRules?: Map<…> }`), ce que la
 * convention de ce depot demande explicitement de remplacer par une
 * interface de capacite : un cast en ligne ne dit pas qui porte la
 * propriete, et ne previent personne quand sa forme change — la table a
 * justement change de forme en gagnant le mot-cle `all`.
 */
export interface CiscoPrivilegeStore {
  _ciscoPrivilegeRules?: Map<string, CommandLevelRule>;
}

/** Les regles d'un equipement, ou `undefined` s'il n'en porte pas. */
export function getPrivilegeRules(dev: unknown): Map<string, CommandLevelRule> | undefined {
  return (dev as CiscoPrivilegeStore | null)?._ciscoPrivilegeRules;
}

/** Les regles d'un equipement, creees a la demande. */
export function ensurePrivilegeRules(dev: unknown): Map<string, CommandLevelRule> | undefined {
  const store = dev as CiscoPrivilegeStore | null;
  if (!store) return undefined;
  return (store._ciscoPrivilegeRules ??= new Map());
}
