/**
 * `configure replace` — la vraie restauration.
 *
 * `copy <source> running-config` FUSIONNE : les lignes de la source
 * s'ajoutent à la configuration courante, et celles que la courante
 * porte en trop restent. Ce n'est pas un retour en arrière, et c'est le
 * malentendu que ce chapitre existe pour lever. `configure replace`
 * calcule la DIFFÉRENCE entre la configuration courante et un fichier
 * cible, puis applique les ajouts ET les suppressions — la courante
 * finit exactement égale au fichier.
 *
 * Ce module ne réinvente pas la comparaison : il lit le même
 * `diffConfigurations` que `show archive config differences`, pour que
 * les deux commandes ne puissent pas décrire deux différences
 * différentes entre les deux mêmes textes.
 *
 * Ce qui est délibérément absent, et dit plutôt que simulé : le compte
 * à rebours de `time <minutes>`. IOS arme un retour arrière automatique
 * si la session meurt avant confirmation ; ici la commande s'exécute
 * entièrement dans l'appel, donc aucune session ne peut mourir entre
 * l'application et la confirmation. Le mot-clé est accepté et son
 * effet — « rien à annuler » — est annoncé, plutôt qu'un minuteur qui
 * ne protégerait de rien.
 */

export interface ConfigReplaceSource {
  /** Le texte cible, ou `null` si la source est introuvable. */
  readonly texte: string | null;
  /** Ce qu'IOS affiche comme nom de la source. */
  readonly nom: string;
}

export interface ConfigReplaceOptions {
  /** `force` — pas de demande de confirmation. */
  readonly force: boolean;
  /** `list` — simulation : montrer les lignes, ne rien appliquer. */
  readonly list: boolean;
  /** `time <minutes>` — accepté, cf. l'en-tête du module. */
  readonly timeMinutes: number | null;
}

export function parseConfigReplaceArgs(args: readonly string[]): {
  url: string; options: ConfigReplaceOptions; erreur?: string;
} {
  const url = args[0] ?? '';
  let force = false;
  let list = false;
  let timeMinutes: number | null = null;
  for (let i = 1; i < args.length; i++) {
    const mot = args[i].toLowerCase();
    if (mot === 'force') { force = true; continue; }
    if (mot === 'list') { list = true; continue; }
    if (mot === 'time') {
      const n = Number.parseInt(args[i + 1] ?? '', 10);
      if (!Number.isFinite(n) || n < 1 || n > 120) {
        return { url, options: { force, list, timeMinutes }, erreur: "% Invalid input detected at '^' marker." };
      }
      timeMinutes = n;
      i++;
      continue;
    }
    if (mot === 'nolock' || mot === 'revert') continue;
    return { url, options: { force, list, timeMinutes }, erreur: "% Invalid input detected at '^' marker." };
  }
  return { url, options: { force, list, timeMinutes } };
}

/**
 * Les lignes à AJOUTER et à SUPPRIMER pour que `courante` devienne
 * `cible`. Le contexte (`interface X`) est reproduit devant chaque
 * ligne qu'il gouverne, sans quoi une suppression s'appliquerait au
 * mauvais objet — c'est ce que fait IOS, et c'est pourquoi il parle de
 * « Contextual Config Diffs ».
 */
export function replacePlan(courante: string, cible: string): {
  ajouts: string[]; suppressions: string[];
} {
  const parse = (texte: string): Map<string, string[]> => {
    const blocs = new Map<string, string[]>();
    let contexte = '';
    for (const brute of texte.split('\n')) {
      const ligne = brute.replace(/\s+$/, '');
      if (ligne.trim() === '' || ligne.trim() === '!') continue;
      if (/^(Building configuration|Current configuration|Using \d+ out of)/.test(ligne)) continue;
      if (ligne === 'end') continue;
      if (/^\S/.test(ligne)) {
        contexte = ligne;
        if (!blocs.has(contexte)) blocs.set(contexte, []);
        continue;
      }
      if (!blocs.has(contexte)) blocs.set(contexte, []);
      blocs.get(contexte)!.push(ligne);
    }
    return blocs;
  };

  const a = parse(courante);
  const b = parse(cible);
  const ajouts: string[] = [];
  const suppressions: string[] = [];

  for (const [contexte, lignes] of b) {
    const avant = a.get(contexte);
    if (avant === undefined) {
      ajouts.push(contexte, ...lignes);
      continue;
    }
    const manquantes = lignes.filter((l) => !avant.includes(l));
    if (manquantes.length > 0) ajouts.push(contexte, ...manquantes);
  }
  for (const [contexte, lignes] of a) {
    const apres = b.get(contexte);
    if (apres === undefined) {
      suppressions.push(contexte, ...lignes);
      continue;
    }
    const enTrop = lignes.filter((l) => !apres.includes(l));
    if (enTrop.length > 0) suppressions.push(contexte, ...enTrop);
  }
  return { ajouts, suppressions };
}

/**
 * Les lignes de configuration à REJOUER pour appliquer le plan : les
 * suppressions deviennent des `no <ligne>`, et un bloc entier disparu
 * devient `no <contexte>`.
 */
export function replaceCommands(plan: { ajouts: string[]; suppressions: string[] }): string[] {
  const out: string[] = [];
  let contexte = '';
  for (const ligne of plan.suppressions) {
    if (/^\S/.test(ligne)) {
      contexte = ligne;
      out.push(`no ${ligne}`);
      continue;
    }
    out.push(contexte, `no ${ligne.trim()}`);
  }
  out.push(...plan.ajouts);
  return out;
}

/** La bannière qu'IOS écrit avant d'appliquer, mot pour mot. */
export const CONFIG_REPLACE_BANNER = [
  'This will apply all necessary additions and deletions',
  'to replace the current running configuration with the',
  'contents of the specified configuration file, which is',
  'assumed to be a complete configuration.',
].join('\n');
