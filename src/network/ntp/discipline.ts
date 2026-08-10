/**
 * PRD-NTP-Tutoriel.md §11 / lot N9 — la discipline de l'horloge.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `selectAndSync` posait `config.offsetMs = best.offsetMs` : **tout
 * ecart etait applique d'un coup, quelle qu'en soit la taille**. Le §2
 * du tutoriel — glissement, saut, mode panique — n'avait donc aucune
 * contrepartie observable, et `chronyc makestep` corrigeait un ecart
 * deja corrige.
 *
 * ── Ce qui a ete verifie, et ou le tutoriel simplifie ───────────────
 *
 * Le tutoriel ecrit : « **Stepping (saut)** : si l'offset est grand
 * (> 128ms), NTP peut corriger d'un coup. » **Ce n'est pas ce que fait
 * un vrai ntpd**, et la nuance est le coeur du sujet :
 *
 * > « When an offset exceeds the 128 ms step threshold, it is
 * > **initially discarded** rather than applied immediately. However,
 * > if such large offsets persist beyond the stepout threshold, the
 * > system then performs a clock step. »
 *
 * Un ecart au-dela du seuil est donc d'abord tenu pour une **aberration**
 * — une pointe de congestion reseau — et ignore. Ce n'est que s'il
 * PERSISTE au-dela du seuil de sortie que l'horloge saute. C'est
 * precisement ce qui empeche une seule mesure aberrante de derégler une
 * machine, et un simulateur qui sauterait tout de suite enseignerait
 * l'inverse.
 *
 * Les valeurs sont celles de la documentation de reference :
 *
 * | Seuil                        | Valeur   |
 * |------------------------------|----------|
 * | Saut (`STEPT`)               | 128 ms   |
 * | Sortie d'aberration          | 300 s    |
 * | Panique (`PANICT`)           | 1000 s   |
 * | Vitesse de glissement max    | 500 ppm  |
 *
 * 500 ppm est la limite du noyau Unix, « requiring approximately 33
 * minutes per second of correction » : corriger une seconde d'ecart par
 * glissement demande une demi-heure. C'est ce qui rend le saut
 * necessaire, et c'est la raison d'etre du mode panique.
 *
 * ── Ce qui est modelise et ce qui ne l'est pas ──────────────────────
 *
 * Les cinq etats de la machine reelle (NSET, FSET, SPIK, FREQ, SYNC)
 * sont reduits a quatre : **FREQ n'est pas modelise**, parce qu'il sert
 * a l'entrainement de FREQUENCE et que ce simulateur n'a pas d'horloge
 * materielle qui derive — la derive y est une mesure, pas une propriete
 * du quartz. Le dire vaut mieux que d'ajouter un etat qu'aucune
 * transition ne pourrait quitter pour la bonne raison.
 */

/** Le seuil au-dela duquel un ecart cesse d'etre corrige par glissement. */
export const SEUIL_SAUT_MS = 128;
/** Depuis combien de temps un ecart doit persister avant de faire sauter. */
export const SEUIL_SORTIE_MS = 300_000;
/** Au-dela, la machine refuse de se synchroniser. */
export const SEUIL_PANIQUE_MS = 1_000_000;
/** La limite du noyau : 500 ppm, soit 0,5 ms par seconde. */
export const PPM_MAX = 500;

/**
 * L'etat de la boucle de discipline.
 *
 * `NSET` : jamais synchronise, aucune frequence connue.
 * `SPIK` : un ecart au-dela du seuil a ete vu et tenu pour aberrant.
 * `SYNC` : regime normal, l'horloge est disciplinee.
 * `PANIC` : l'ecart depasse le seuil de panique ; plus rien n'est
 *           applique sans intervention.
 */
export type EtatDiscipline = 'NSET' | 'SPIK' | 'SYNC' | 'PANIC';

export interface EtatHorloge {
  etat: EtatDiscipline;
  /** L'ecart REELLEMENT applique a l'horloge, en millisecondes. */
  offsetApplique: number;
  /** Depuis quand un ecart aberrant persiste ; 0 si aucun. */
  aberrationDepuisMs: number;
  /** Un saut a-t-il deja eu lieu ? `makestep <seuil> <limite>` le borne. */
  sautsFaits: number;
}

export function creerEtatHorloge(): EtatHorloge {
  return { etat: 'NSET', offsetApplique: 0, aberrationDepuisMs: 0, sautsFaits: 0 };
}

/** Ce que la discipline decide d'une mesure. */
export type DecisionDiscipline =
  /** Corriger progressivement : l'ecart applique se rapproche du mesure. */
  | { quoi: 'slew'; nouvelOffset: number }
  /** Corriger d'un coup. */
  | { quoi: 'step'; nouvelOffset: number }
  /** Tenir la mesure pour aberrante et ne rien appliquer. */
  | { quoi: 'spike' }
  /** Refuser : l'ecart est trop grand pour etre credible. */
  | { quoi: 'panic' };

export interface ReglagesDiscipline {
  /**
   * Le seuil de saut, en millisecondes.
   *
   * chrony le rend configurable par `makestep <seuil> <limite>` ; ntpd
   * le fixe a 128 ms. C'est le meme reglage, d'ou un seul champ.
   */
  seuilSautMs?: number;
  /**
   * Combien de sauts sont autorises. `-1` signifie « toujours »,
   * l'ecriture de chrony ; `0` interdit tout saut, ce que fait un ntpd
   * sans `-g` apres le premier reglage.
   */
  limiteSauts?: number;
  /** Le seuil de panique ; `0` le desactive (`chronyd -x`, `ntpd -g`). */
  seuilPaniqueMs?: number;
}

/**
 * Que faire d'un ecart mesure.
 *
 * `ecoulementMs` est le temps depuis la mesure precedente : il decide de
 * combien le glissement peut avancer, et si une aberration a persiste
 * assez longtemps pour justifier un saut.
 */
export function disciplinerHorloge(
  etat: EtatHorloge,
  offsetMesureMs: number,
  ecoulementMs: number,
  reglages: ReglagesDiscipline = {},
): DecisionDiscipline {
  const seuilSaut = reglages.seuilSautMs ?? SEUIL_SAUT_MS;
  const seuilPanique = reglages.seuilPaniqueMs ?? SEUIL_PANIQUE_MS;
  const limite = reglages.limiteSauts ?? -1;
  const ecart = Math.abs(offsetMesureMs - etat.offsetApplique);

  // Le mode panique passe avant tout : un ecart de plus de mille
  // secondes ne se corrige pas, il se signale. Un vrai ntpd s'arrete
  // plutot que de deregler la machine sur une mesure invraisemblable.
  if (seuilPanique > 0 && ecart > seuilPanique) return { quoi: 'panic' };

  // Sous le seuil, le glissement suffit — et c'est le regime normal.
  if (ecart <= seuilSaut) return { quoi: 'slew', nouvelOffset: glisser(etat, offsetMesureMs, ecoulementMs) };

  // Au-dessus, deux cas seulement. Le PREMIER reglage a le droit de
  // sauter — c'est ce que `ntpd -g` et `makestep <seuil> <limite>`
  // autorisent — parce qu'une machine qui demarre a la mauvaise heure ne
  // se rattraperait jamais par glissement : 500 ppm demandent une
  // demi-heure par seconde d'ecart.
  const sautPermis = limite < 0 || etat.sautsFaits < limite;
  if (etat.etat === 'NSET' && sautPermis) return { quoi: 'step', nouvelOffset: offsetMesureMs };

  // Sinon l'ecart est tenu pour ABERRANT, et seule sa persistance
  // au-dela du seuil de sortie le rend credible. C'est la nuance que le
  // tutoriel omet, et c'est elle qui protege d'une mesure isolee.
  if (etat.aberrationDepuisMs >= SEUIL_SORTIE_MS && sautPermis) {
    return { quoi: 'step', nouvelOffset: offsetMesureMs };
  }
  return { quoi: 'spike' };
}

/**
 * De combien l'ecart applique se rapproche de l'ecart mesure.
 *
 * La correction est bornee par 500 ppm — la limite du noyau — donc par
 * `0,5 ms par seconde ecoulee`. Un ecart de 50 ms demande cent secondes,
 * ce que le tutoriel annonce et ce qui est desormais observable.
 */
function glisser(etat: EtatHorloge, offsetMesureMs: number, ecoulementMs: number): number {
  const reste = offsetMesureMs - etat.offsetApplique;
  const maxCorrection = (PPM_MAX / 1e6) * ecoulementMs;
  if (Math.abs(reste) <= maxCorrection) return offsetMesureMs;
  return etat.offsetApplique + Math.sign(reste) * maxCorrection;
}

/** Applique une decision a l'etat, et rend l'etat suivant. */
export function appliquerDecision(
  etat: EtatHorloge,
  decision: DecisionDiscipline,
  ecoulementMs: number,
): EtatHorloge {
  switch (decision.quoi) {
    case 'slew':
      return {
        etat: 'SYNC', offsetApplique: decision.nouvelOffset,
        aberrationDepuisMs: 0, sautsFaits: etat.sautsFaits,
      };
    case 'step':
      return {
        etat: 'SYNC', offsetApplique: decision.nouvelOffset,
        aberrationDepuisMs: 0, sautsFaits: etat.sautsFaits + 1,
      };
    case 'spike':
      // L'horloge ne bouge pas, mais le temps passe : c'est cette
      // accumulation qui finira par rendre l'ecart credible.
      return {
        ...etat, etat: 'SPIK',
        aberrationDepuisMs: etat.aberrationDepuisMs + ecoulementMs,
      };
    case 'panic':
      return { ...etat, etat: 'PANIC' };
  }
}

/**
 * L'etat de la boucle tel qu'IOS le nomme dans `show ntp status`.
 *
 * IOS ecrit `CTRL` en regime normal et `FSET` quand la frequence vient
 * du fichier de derive sans synchronisation. `SPIK` est le nom de la
 * machine a etats de reference, employe tel quel : lui inventer un
 * equivalent IOS non atteste serait pire que d'emprunter le nom juste.
 */
export function nomLoopfilterIos(etat: EtatDiscipline): { code: string; libelle: string } {
  switch (etat) {
    case 'SYNC': return { code: 'CTRL', libelle: 'Normal Controlled Loop' };
    case 'SPIK': return { code: 'SPIK', libelle: 'Spike Detected' };
    case 'PANIC': return { code: 'PANIC', libelle: 'Panic Threshold Exceeded' };
    case 'NSET': return { code: 'FSET', libelle: 'Drift set from file' };
  }
}
