import type { CommandSpec } from '../CommandTable';
import type { ArgumentSpec } from '../ArgumentTypes';

/**
 * Une commande = des mots-cles, une SUITE d'arguments, et sa negation.
 *
 * Les trois familles migrees jusqu'ici ont chacune apporte son
 * declarateur — `debugFamily` pour les paires, `loggingFamily` pour les
 * continuations, `legacyFamily` pour ce qui garde sa fermeture. Le point
 * commun est toujours le meme : un chemin de mots-cles, zero ou
 * plusieurs arguments typés, un gestionnaire qui recoit les valeurs dans
 * l'ordre, et une forme en `no` qui part de la MEME declaration.
 *
 * Celui-ci le dit une fois pour toutes, de sorte que la prochaine
 * famille n'ait plus a l'ecrire.
 */
export interface SequenceEntry {
  readonly path: readonly string[];
  readonly description: string;
  readonly args?: readonly ArgumentSpec[];
  /**
   * La queue libre, quand la commande accepte des options qu'aucun
   * chemin fixe ne decrit (`ntp server <ip> prefer key 7`).
   *
   * Ses FORMES nomment ce qui peut suivre : la place est alors mieux
   * DECRITE qu'elle n'est contrainte, ce qui vaut mieux que l'inverse.
   */
  readonly tail?: ArgumentSpec;
  /**
   * La suite d'arguments de la forme en `no`, quand elle differe.
   *
   * Sur IOS elle est souvent plus COURTE : `no ntp source` retire sans
   * nommer l'interface, `no ntp authentication-key 1` sans redonner la
   * cle. Exiger la meme suite dans les deux sens ferait refuser la
   * negation que tout operateur tape.
   */
  readonly undoArgs?: readonly ArgumentSpec[];
  /**
   * La forme d'`undoArgs` n'existe QUE niee.
   *
   * `no clock summer-time` se tape sans zone, la ou `clock summer-time`
   * en exige une. Sans ce drapeau la forme courte serait aussi une
   * commande POSITIVE complete, donc `clock summer-time` seul passerait
   * pour valide alors qu'IOS le declare incomplet.
   */
  readonly undoArgsOnlyNegated?: boolean;
  /**
   * Faux quand le moteur derriere n'a AUCUNE notion de negation.
   *
   * Declarer un `undo` ferait accepter `no <commande>` pour appeler le
   * meme gestionnaire, qui REPOSERAIT ce qu'on lui demande de retirer —
   * une commande qui fait le contraire de ce qu'elle promet. Le refus
   * est la reponse honnete tant que le moteur ne sait pas defaire.
   */
  readonly negatable?: boolean;
  /**
   * Les modes ou la commande existe, quand ce n'est pas la seule
   * configuration globale.
   *
   * `clock set` vit en EXEC privilegie ET en configuration : le trie
   * l'enregistre donc DEUX fois, avec deux fois le meme gestionnaire.
   * Une declaration unique portant ses deux modes est precisement ce que
   * la migration achete.
   */
  readonly modes?: readonly string[];
  readonly minPrivilege?: number;
}

export interface SequenceHost {
  apply(words: string[], negate: boolean): string;
}

function valuesOf(
  args: Record<string, string>, specs: readonly ArgumentSpec[],
): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    const value = args[spec.name];
    if (value === undefined) continue;
    if (spec.type === 'REST') out.push(...value.trim().split(/\s+/).filter(Boolean));
    else out.push(value);
  }
  return out;
}

function specFor(
  entry: SequenceEntry, specs: readonly ArgumentSpec[], suffixe: string,
  host: () => SequenceHost,
): CommandSpec {
  const words = (args: Record<string, string>): string[] =>
    [...entry.path.slice(1), ...valuesOf(args, specs)];

  const spec: CommandSpec = {
    id: entry.path.join('-') + suffixe,
    path: [...entry.path, ...specs],
    description: entry.description,
    modes: entry.modes ?? ['config'],
    minPrivilege: entry.minPrivilege ?? 15,
    run: (_session, args) => host().apply(words(args), false),
  };
  if (entry.negatable === false) return spec;

  return { ...spec, undo: (_session, args) => host().apply(words(args), true) };
}

export function sequenceFamily(
  entries: readonly SequenceEntry[], host: () => SequenceHost,
): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const entry of entries) {
    specs.push(specFor(
      entry, [...(entry.args ?? []), ...(entry.tail ? [entry.tail] : [])], '', host));

    if (entry.undoArgs && entry.negatable !== false) {
      const undo = specFor(entry, entry.undoArgs, '-undo', host);
      specs.push(entry.undoArgsOnlyNegated
        ? { ...undo, existsOnlyNegated: true, run: () => '% Incomplete command.' }
        : undo);
    }
  }
  return specs;
}
