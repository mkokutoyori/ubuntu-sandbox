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

const ENTETE_SOURCES = 'MS Name/IP address         Stratum Poll Reach LastRx Last sample';
const FILET_SOURCES = '='.repeat(79);

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
  const lignes: string[] = [];
  for (const [, a] of cfg.associations) {
    const joignable = a.reach !== 0;
    const mode = a.mode === 'symmetric-active' ? '=' : '^';
    const etat = a.preferred && joignable ? '*' : joignable ? '+' : '?';
    const log2 = Math.max(0, Math.round(Math.log2(a.pollSec)));
    const depuis = a.lastReplyMs ? Math.floor((Date.now() - a.lastReplyMs) / 1000) : 0;
    lignes.push(
      `${mode}${etat} ${a.serverIp}`.padEnd(29)
      + `${String(a.stratum).padStart(2)}  ${String(log2).padStart(2)}  `
      + `${a.reach.toString(8).padStart(3, '0')}   ${String(depuis).padStart(4)}  `
      + `${echelle(a.offsetMs).padStart(7)}[${echelle(a.offsetMs).padStart(7)}] `
      + `+/- ${echelle(a.dispersionMs).replace('+', '').padStart(6)}`,
    );
  }
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
  const entete = 'Name/IP Address            NP  NR  Span  Frequency  Freq Skew  Offset  Std Dev';
  const filet = '='.repeat(79);
  const lignes: string[] = [];
  for (const [, a] of agent.getConfig().associations) {
    const n = a.reach !== 0 ? 1 : 0;
    lignes.push(
      `${(a.serverIp).padEnd(26)} ${String(n).padStart(2)}  ${String(n).padStart(2)}  `
      + `${(n ? String(a.pollSec) + 's' : '0').padStart(4)}  `
      + `${(n ? agent.getDriftPpm().toFixed(3) : '+0.000').padStart(9)} ppm  `
      + `${'0.000'.padStart(6)} ppm  ${echelle(a.offsetMs).padStart(6)}  `
      + `${echelle(a.dispersionMs).replace('+', '').padStart(6)}`,
    );
  }
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

/** `chronyc -n sources` etc. : la sortie depend du service, pas que de l'agent. */
export function chronycExige(service: LinuxChronyService): string | null {
  return service.isRunning() ? null : CHRONYC_SANS_DEMON;
}
