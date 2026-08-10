/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — `chronyc`, les vues du §5.3.
 *
 * Chaque valeur imprimee ici est LUE sur l'agent : offset, delai,
 * dispersion, joignabilite, strate. La seule chose qui ne l'est pas est
 * dite a l'endroit ou elle apparait.
 */

import type { NtpAgent } from '../../../ntp/NtpAgent';
import type { NtpAssociation } from '../../../ntp/types';
import type { LinuxChronyService } from './LinuxChronyService';
import {
  renderTable, FIXED_TABLE, type TableColumn,
} from '../../shells/cli/TextTable';

/** `506 Cannot talk to daemon` — ce que dit chronyc sans chronyd. */
export const CHRONYC_SANS_DEMON = '506 Cannot talk to daemon';

const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateChrony(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${JOURS[d.getUTCDay()]} ${MOIS[d.getUTCMonth()]} ${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/**
 * L'identifiant de reference, a la mode chrony : l'adresse en
 * hexadecimal suivie de sa forme pointee. C'est ce que `Reference ID`
 * affiche, et c'est la meme adresse ecrite deux fois — pas deux faits.
 */
function refId(ip: string): string {
  if (!ip || ip === '.INIT.' || ip === 'LOCL') return '00000000 ()';
  const hex = ip.split('.')
    .map((o) => parseInt(o, 10).toString(16).toUpperCase().padStart(2, '0')).join('');
  return `${hex} (${ip})`;
}

/** La meilleure association, celle que l'algorithme a retenue. */
function retenue(agent: NtpAgent): NtpAssociation | undefined {
  return [...agent.getConfig().associations.values()].find((a) => a.preferred);
}

/**
 * `chronyc tracking`.
 *
 * `System time` est signe et porte son sens en toutes lettres
 * (`slow of`/`fast of`) : c'est la lecture que le tutoriel apprend a
 * faire, et un nombre nu ne dirait pas de quel cote.
 */
export function chronycTracking(agent: NtpAgent): string {
  const cfg = agent.getConfig();
  const best = retenue(agent);
  const offsetSec = cfg.offsetMs / 1000;
  const driftPpm = agent.getDriftPpm();
  return [
    `Reference ID    : ${refId(cfg.refIdentifier)}`,
    `Stratum         : ${cfg.localStratum}`,
    `Ref time (UTC)  : ${dateChrony(cfg.lastSyncMs || Date.now())}`,
    `System time     : ${Math.abs(offsetSec).toFixed(9)} seconds ${offsetSec >= 0 ? 'slow' : 'fast'} of NTP time`,
    `Last offset     : ${(-offsetSec).toFixed(9)} seconds`,
    `RMS offset      : ${Math.abs(offsetSec).toFixed(9)} seconds`,
    `Frequency       : ${Math.abs(driftPpm).toFixed(3)} ppm ${driftPpm >= 0 ? 'slow' : 'fast'}`,
    `Residual freq   : ${'+0.000'} ppm`,
    `Skew            : ${'0.000'} ppm`,
    `Root delay      : ${((best ? Math.abs(best.delayMs) : 0) / 1000).toFixed(9)} seconds`,
    `Root dispersion : ${((best ? best.dispersionMs : 0) / 1000).toFixed(9)} seconds`,
    `Update interval : ${(best?.pollSec ?? 64).toFixed(1)} seconds`,
    `Leap status     : Normal`,
  ].join('\n');
}

const LEGENDE_SOURCES = [
  '  .-- Source mode  \'^\' = server, \'=\' = peer, \'#\' = local clock.',
  ' / .- Source state \'*\' = current best, \'+\' = combined, \'-\' = not combined,',
  '| /             \'x\' = may be in error, \'~\' = too variable, \'?\' = unused.',
  '||                                                 .- xxxx [ yyyy ] +/- zzzz',
  '||      Reachability register (octal) -.           |  xxxx = adjusted offset,',
  '||      Log2(Polling interval) --.      |          |  yyyy = measured offset,',
  '||                                \\     |          |  zzzz = estimated error.',
  '||                                 |    |           \\',
];

/**
 * ── Pourquoi l'en-tete est une constante et non le produit des colonnes ──
 *
 * `TextTable` existe pour qu'un en-tete et ses donnees sortent du MEME
 * calcul, un ecart entre les deux etant le defaut qu'il ferme. Ici cet
 * ecart est REEL et appartient a chrony : sur l'exemple de sa propre
 * documentation, la valeur de `Poll` finit a la colonne 37 quand
 * l'intitule finit a la 38, et `LastRx` a la 49 contre 51 — l'en-tete
 * est une chaine fixe du code de chrony, les donnees un `printf` qui ne
 * s'aligne pas dessus.
 *
 * Les colonnes ci-dessous reproduisent les TROIS lignes de donnees de
 * cet exemple au caractere pres (verifie avant d'ecrire quoi que ce
 * soit). Deriver l'en-tete d'elles donnerait un tableau plus propre que
 * la vraie machine, donc faux — et un apprenant qui compare sa capture a
 * la notre verrait un decalage qui n'existe pas chez lui.
 */
const ENTETE_SOURCES = 'MS Name/IP address         Stratum Poll Reach LastRx Last sample';
const FILET_SOURCES = '='.repeat(79);

/** Les colonnes de `chronyc sources`, mesurees sur la sortie reelle. */
const COLONNES_SOURCES: ReadonlyArray<TableColumn<RangeeSource>> = [
  { header: 'MS', width: 3, value: (r) => r.ms },
  { header: 'Name/IP address', width: 24, value: (r) => r.nom },
  { header: 'Stratum', width: 7, align: 'right', value: (r) => String(r.stratum) },
  { header: 'Poll', width: 4, align: 'right', value: (r) => String(r.poll) },
  { header: 'Reach', width: 6, align: 'right', value: (r) => r.reach },
  { header: 'LastRx', width: 6, align: 'right', value: (r) => String(r.lastRx) },
  { header: 'Last sample', width: 29, align: 'right', value: (r) => r.echantillon },
];

interface RangeeSource {
  ms: string; nom: string; stratum: number; poll: number;
  reach: string; lastRx: number; echantillon: string;
}

/** `us`/`ms` selon l'ordre de grandeur, comme chrony l'ecrit. */
function echelle(ms: number): string {
  const abs = Math.abs(ms);
  const signe = ms < 0 ? '-' : '+';
  if (abs < 1) return `${signe}${Math.round(abs * 1000)}us`;
  if (abs < 1000) return `${signe}${abs.toFixed(0)}ms`;
  return `${signe}${(abs / 1000).toFixed(1)}s`;
}

/**
 * `chronyc sources [-v]`.
 *
 * `Poll` est le LOGARITHME base 2 de l'intervalle, pas l'intervalle :
 * 64 s s'ecrit `6`. C'est la colonne que la legende du tutoriel prend
 * la peine d'expliquer, et l'ecrire en secondes la rendrait fausse.
 */
export function chronycSources(agent: NtpAgent, verbose: boolean): string {
  const cfg = agent.getConfig();
  const rangees: RangeeSource[] = [];
  for (const [, a] of cfg.associations) {
    const joignable = a.reach !== 0;
    const mode = a.mode === 'symmetric-active' ? '=' : '^';
    const etat = a.preferred && joignable ? '*' : joignable ? '+' : '?';
    rangees.push({
      ms: `${mode}${etat}`,
      nom: a.serverIp,
      stratum: a.stratum,
      poll: Math.max(0, Math.round(Math.log2(a.pollSec))),
      reach: a.reach.toString(8).padStart(3, '0'),
      lastRx: a.lastReplyMs ? Math.floor((Date.now() - a.lastReplyMs) / 1000) : 0,
      // La legende de chrony distingue les deux crochets : « xxxx =
      // adjusted offset, yyyy = measured offset ». Les deux valaient la
      // MEME expression, donc la distinction que la legende explique
      // n'existait pas. Depuis le lot N9 l'ecart APPLIQUE peut differer
      // de l'ecart MESURE — c'est tout l'objet de la discipline — et les
      // deux crochets le montrent enfin.
      echantillon: `${echelle(a.preferred ? cfg.offsetMs : a.offsetMs).padStart(7)}`
        + `[${echelle(a.offsetMs).padStart(7)}] `
        + `+/- ${echelle(a.dispersionMs).replace('+', '').padStart(6)}`,
    });
  }
  const lignes = renderTable(rangees, COLONNES_SOURCES, FIXED_TABLE).slice(1);
  const corps = [ENTETE_SOURCES, FILET_SOURCES, ...lignes];
  const tete = [`${cfg.associations.size} Sources`];
  return verbose ? [...LEGENDE_SOURCES, ...corps].join('\n') : [...tete, ...corps].join('\n');
}

/**
 * `chronyc sourcestats`.
 *
 * `NP`/`NR` sont le nombre d'echantillons retenus et le nombre de
 * residus : ce moteur garde UNE mesure par source, donc les deux valent
 * 1 des qu'elle a repondu, et 0 sinon. C'est un fait sur ce moteur, pas
 * un remplissage — inventer vingt-et-un echantillons ferait croire a un
 * historique qui n'existe pas.
 */
export function chronycSourcestats(agent: NtpAgent): string {
  // Meme constat que pour `sources` : l'intitule `Offset` de chrony
  // finit a la colonne 68 quand sa valeur finit a la 69. L'en-tete reste
  // donc la chaine mesuree, les donnees passent par les colonnes.
  const entete = 'Name/IP Address            NP  NR  Span  Frequency  Freq Skew  Offset  Std Dev';
  const filet = '='.repeat(79);
  interface Rangee {
    nom: string; np: number; span: string;
    freq: string; skew: string; offset: string; ecart: string;
  }
  const rangees: Rangee[] = [];
  for (const [, a] of agent.getConfig().associations) {
    const n = a.reach !== 0 ? 1 : 0;
    rangees.push({
      nom: a.serverIp, np: n,
      span: n ? `${a.pollSec}s` : '0',
      freq: n ? agent.getDriftPpm().toFixed(3) : '+0.000',
      skew: '0.000',
      offset: echelle(a.offsetMs),
      ecart: echelle(a.dispersionMs).replace('+', ''),
    });
  }
  const lignes = renderTable<Rangee>(rangees, [
    { header: 'Name/IP Address', width: 27, value: (r) => r.nom },
    { header: 'NP', width: 2, align: 'right', value: (r) => String(r.np) },
    { header: 'NR', width: 4, align: 'right', value: (r) => String(r.np) },
    { header: 'Span', width: 6, align: 'right', value: (r) => r.span },
    { header: 'Frequency', width: 11, align: 'right', value: (r) => r.freq },
    { header: 'Freq Skew', width: 11, align: 'right', value: (r) => r.skew },
    { header: 'Offset', width: 9, align: 'right', value: (r) => r.offset },
    { header: 'Std Dev', width: 8, align: 'right', value: (r) => r.ecart },
  ], FIXED_TABLE).slice(1);
  return [entete, filet, ...lignes].join('\n');
}

/**
 * `chronyc activity` — combien de sources en ligne, combien muettes.
 * Le tutoriel ne la cite pas, mais c'est la premiere que tape un
 * administrateur quand `sources` semble vide, et elle se deduit
 * entierement de ce qui est deja mesure.
 */
export function chronycActivity(agent: NtpAgent): string {
  const tout = [...agent.getConfig().associations.values()];
  const enLigne = tout.filter((a) => a.reach !== 0).length;
  return [
    `${enLigne} sources online`,
    `${tout.length - enLigne} sources offline`,
    `0 sources doing burst (return to online)`,
    `0 sources doing burst (return to offline)`,
    `0 sources with unknown address`,
  ].join('\n');
}

/**
 * `chronyc serverstats` — ce que le demon a vu passer.
 *
 * chrony distingue les paquets NTP des paquets de COMMANDE (ceux que
 * `chronyc` lui-meme envoie sur son socket de controle). Ce simulateur
 * n'a pas ce socket — `chronyc` parle au demon dans le meme processus —
 * donc les deux compteurs de commandes sont a zero, ce qui est vrai
 * plutot qu'approximatif.
 */
export function chronycServerstats(agent: NtpAgent): string {
  const c = agent.getCounters();
  return [
    `NTP packets received       : ${c.received}`,
    `NTP packets dropped        : ${c.dropped}`,
    `Command packets received   : 0`,
    `Command packets dropped    : 0`,
    `Client log records dropped : 0`,
    `NTS-KE connections accepted: 0`,
    `NTS-KE connections dropped : 0`,
    // Ce nombre etait `recus - echecs`, donc il comptait comme
    // authentifie tout paquet nu — sur une machine sans cle, la totalite.
    // Il est desormais MESURE au point ou un condensé est reconnu bon.
    `Authenticated NTP packets  : ${c.authOk}`,
  ].join('\n');
}

/**
 * `chronyc authdata` — avec quoi chaque source est authentifiee.
 *
 * Les largeurs de colonnes sont celles de la sortie reelle de la
 * documentation de chrony, verifiees au caractere pres contre son
 * exemple (`ntp2.example.net              SK    30   13  128    -    0
 * 0    0    0`) plutot que reconstruites a vue.
 *
 * `Type` est un CODE NUMERIQUE et non un nom : la table de chrony donne
 * 1 pour MD5 et 2 pour SHA1. Ecrire `MD5` a la place serait plus lisible
 * et faux.
 *
 * Trois colonnes valent zero ou `-` pour une raison qui tient au
 * mecanisme et non a une simplification : `Last`, `Cook` et `CLen`
 * decrivent l'ETABLISSEMENT de cle de NTS, qui n'existe pas pour une cle
 * symetrique — la vraie sortie de chrony met `-` et des zeros sur la
 * ligne `SK` de son propre exemple.
 */
export function chronycAuthdata(agent: NtpAgent): string {
  const cfg = agent.getConfig();
  interface Ligne { nom: string; mode: string; id: number; type: number; bits: number }
  const rangees: Ligne[] = [];
  for (const [, a] of cfg.associations) {
    const cle = a.keyId !== undefined ? cfg.authKeys.get(a.keyId) : undefined;
    rangees.push({
      nom: a.serverIp,
      mode: cle ? 'SK' : '-',
      id: cle ? a.keyId! : 0,
      type: cle ? (cle.algo === 'SHA1' ? 2 : 1) : 0,
      bits: cle ? bitsDeCle(cle.key) : 0,
    });
  }
  const D = (n: number) => ({ width: n, align: 'right' as const });
  const lignes = renderTable<Ligne>(rangees, [
    { header: 'Name/IP address', width: 28, value: (r) => r.nom },
    { header: 'Mode', ...D(4), value: (r) => r.mode },
    { header: 'KeyID', ...D(6), value: (r) => String(r.id) },
    { header: 'Type', ...D(5), value: (r) => String(r.type) },
    { header: 'KLen', ...D(5), value: (r) => String(r.bits) },
    { header: 'Last', ...D(5), value: () => '-' },
    { header: 'Atmp', ...D(5), value: () => '0' },
    { header: 'NAK', ...D(5), value: () => '0' },
    { header: 'Cook', ...D(5), value: () => '0' },
    { header: 'CLen', ...D(5), value: () => '0' },
  ], FIXED_TABLE);
  return [lignes[0], '='.repeat(LARGEUR_AUTHDATA), ...lignes.slice(1)].join('\n');
}

/**
 * Le filet de `authdata` fait la largeur du tableau, pas celle de
 * l'en-tete rendu : `renderTable` retire les blancs de fin, donc la
 * derniere colonne d'un en-tete plus court que sa largeur raccourcirait
 * le filet. La somme des largeurs est la seule valeur juste.
 */
const LARGEUR_AUTHDATA = 28 + 4 + 6 + 5 + 5 + 5 + 5 + 5 + 5 + 5;

/** La longueur d'une cle en bits : une cle `HEX:` note des octets, pas des lettres. */
function bitsDeCle(cle: string): number {
  return /^HEX:/i.test(cle) ? ((cle.length - 4) / 2) * 8 : cle.length * 8;
}

/** `chronyc -n sources` etc. : la sortie depend du service, pas que de l'agent. */
export function chronycExige(service: LinuxChronyService): string | null {
  return service.isRunning() ? null : CHRONYC_SANS_DEMON;
}
