/**
 * La grammaire commune de `class-map` et `policy-map` : un `type <sorte>`
 * facultatif, un `match-all`/`match-any` facultatif pour `class-map`, puis
 * le NOM, qui est obligatoire.
 *
 * Elle est declaree ici parce que DEUX lecteurs en dependent et doivent
 * s'accorder : le gestionnaire, qui refuse une commande incomplete, et
 * l'aide, qui annonce `<cr>`. Les laisser chacun l'ecrire est exactement
 * ce qui a produit `class-map type ?` annoncant `<cr>` pour une frappe que
 * la meme machine refuse par `% Incomplete command.`.
 */

export interface MapPrefix {
  kind: 'qos' | 'inspect';
  matchAll: boolean;
  /** Index du premier mot restant : celui du nom, s'il y en a un. */
  next: number;
  /** Un mot-cle attendu manque — la commande ne peut pas se terminer ici. */
  incomplete: boolean;
  /** Un mot est present la ou la grammaire n'en admet pas. */
  invalidToken?: string;
}

export function readMapPrefix(
  args: readonly string[], allowMatch: boolean,
): MapPrefix {
  let kind: 'qos' | 'inspect' = 'qos';
  let matchAll = true;
  let i = 0;

  if (args[i] === 'type') {
    if (args[i + 1] === undefined) {
      return { kind, matchAll, next: i, incomplete: true };
    }
    if (args[i + 1] !== 'inspect') {
      return { kind, matchAll, next: i, incomplete: false, invalidToken: args[i + 1] };
    }
    kind = 'inspect';
    i += 2;
  }

  if (allowMatch) {
    if (args[i] === 'match-all') { matchAll = true; i++; }
    else if (args[i] === 'match-any') { matchAll = false; i++; }
  }

  return { kind, matchAll, next: i, incomplete: args[i] === undefined };
}

/** Vrai quand la frappe nomme deja sa classe ou sa politique. */
export function mapCommandIsComplete(
  args: readonly string[], allowMatch: boolean,
): boolean {
  const prefix = readMapPrefix(args, allowMatch);
  return !prefix.incomplete && prefix.invalidToken === undefined;
}
