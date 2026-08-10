/**
 * PRD-NTP-Tutoriel.md §3 / lot N2 — `ntp-service` et ses vues, sur le
 * magasin qui porte vraiment le protocole.
 *
 * ── Le defaut, mesure ───────────────────────────────────────────────
 *
 * Sur une machine ou l'on venait de taper quatre serveurs :
 *
 * ```
 * [R1]display ntp-service sessions
 * No NTP associations
 * [R1]display current-configuration | include ntp
 * ntp-service unicast-server 192.168.100.5 preference
 * ntp-service unicast-server 192.168.100.6
 * ntp-service unicast-peer 10.0.12.2
 * ```
 *
 * La vue et la configuration ne lisaient pas le meme magasin. Le CLI
 * ecrivait dans `RouterManagementService` — pour `unicast-server`, dans
 * un simple sac de chaines brutes (`recordRaw`) — tandis que les vues
 * lisaient le `NtpAgent`, celui qui porte le protocole. **Aucune
 * commande NTP tapee sur un Huawei n'atteignait donc le moteur** : ni
 * association, ni synchronisation, ni authentification, alors que le
 * meme moteur fonctionne sous Cisco depuis toujours.
 *
 * Trois consequences que le meme sac expliquait :
 *
 * - `ntp-service refclock-master 7` rangeait la chaine `7` et laissait
 *   la machine `unsynchronized`, stratum 16 ;
 * - `ntp-service authentication-keyid 1 authentication-mode md5 CLE`
 *   etait lu en positions fixes, si bien que l'algorithme retenu etait
 *   le mot `authentication-mode` et **la cle etait perdue** ; la
 *   configuration rendue ecrivait le mot deux fois ;
 * - un second `unicast-server` sur la meme adresse **ajoutait une
 *   ligne** au lieu de mettre a jour, le sac ne connaissant pas les
 *   adresses qu'il contenait.
 *
 * ── Ce que ce module decide ─────────────────────────────────────────
 *
 * Un seul magasin, l'agent — le meme que Cisco. Une grammaire qui
 * VALIDE au lieu de lire des positions. Un rendu de configuration qui
 * se relit. Et les vues, lues sur ce que la machine mesure.
 *
 * ── Mesure et connaissance du constructeur, tenues separees ─────────
 *
 * Tout ce qui precede est mesure. Que VRP nomme ses champs
 * `clock status`/`clock stratum`, sa frequence nominale 100 Hz (contre
 * 250 chez Cisco) et sa precision `2^17`, releve de la connaissance du
 * constructeur, et le PRD (§3) tient les deux separes.
 */

import type { NtpAgent } from '../../../ntp/NtpAgent';
import type { ErreurGrammaireVrp } from '../cli-utils';
import { isValidIPv4 } from '../../../core/ip';

// ── La grammaire ────────────────────────────────────────────────────

export type ActionNtpVrp =
  | { quoi: 'association'; mode: 'server' | 'peer'; ip: string; preference: boolean; keyId?: number }
  | { quoi: 'refclock-master'; stratum: number }
  | { quoi: 'source-interface'; nom: string }
  | { quoi: 'authentication'; actif: boolean }
  | { quoi: 'auth-key'; id: number; algo: string; cle: string }
  | { quoi: 'reliable'; id: number }
  | { quoi: 'access'; genre: string; acl: string }
  | { quoi: 'enable'; actif: boolean };

export type AnalyseNtpVrp =
  | { statut: 'ok'; action: ActionNtpVrp }
  | { statut: 'refus'; err: ErreurGrammaireVrp };

const refus = (err: ErreurGrammaireVrp): AnalyseNtpVrp => ({ statut: 'refus', err });
const mauvais = (token: string) => refus({ kind: 'wrong', token });
const incomplet = () => refus({ kind: 'incomplete' });

function entier(mot: string | undefined): number | null {
  return mot && /^\d+$/.test(mot) ? parseInt(mot, 10) : null;
}

/**
 * La queue commune de `unicast-server` et `unicast-peer` : les options
 * arrivent dans un ordre libre sur VRP, donc elles se lisent par leur
 * NOM et non par leur rang — c'est precisement ce que l'ancien
 * analyseur faisait a l'envers.
 */
function queueAssociation(
  mode: 'server' | 'peer', ip: string, reste: readonly string[],
): AnalyseNtpVrp {
  let preference = false;
  let keyId: number | undefined;
  for (let i = 0; i < reste.length; i++) {
    const mot = reste[i].toLowerCase();
    if (mot === 'preference') { preference = true; continue; }
    if (mot === 'authentication-keyid') {
      const id = entier(reste[i + 1]);
      if (id === null) return reste[i + 1] ? mauvais(reste[i + 1]) : incomplet();
      if (id < 1 || id > 4294967295) return mauvais(reste[i + 1]);
      keyId = id;
      i++;
      continue;
    }
    if (mot === 'version') {
      const v = entier(reste[i + 1]);
      if (v === null || v < 1 || v > 4) return reste[i + 1] ? mauvais(reste[i + 1]) : incomplet();
      i++;
      continue;
    }
    if (mot === 'source-interface') {
      if (!reste[i + 1]) return incomplet();
      i++;
      continue;
    }
    return mauvais(reste[i]);
  }
  return { statut: 'ok', action: { quoi: 'association', mode, ip, preference, keyId } };
}

/** Analyse les mots qui SUIVENT `ntp-service`. */
export function analyserNtpVrp(args: readonly string[]): AnalyseNtpVrp {
  if (args.length === 0) return incomplet();
  const tete = args[0].toLowerCase();
  const reste = args.slice(1);
  switch (tete) {
    case 'unicast-server':
    case 'unicast-peer': {
      if (!reste[0]) return incomplet();
      if (!isValidIPv4(reste[0])) return mauvais(reste[0]);
      return queueAssociation(tete === 'unicast-peer' ? 'peer' : 'server', reste[0], reste.slice(1));
    }
    case 'refclock-master': {
      // Le stratum est facultatif : `refclock-master` seul vaut 8, comme
      // sur une vraie machine.
      if (!reste[0]) return { statut: 'ok', action: { quoi: 'refclock-master', stratum: 8 } };
      const s = entier(reste[0]);
      if (s === null || s < 1 || s > 15) return mauvais(reste[0]);
      return { statut: 'ok', action: { quoi: 'refclock-master', stratum: s } };
    }
    case 'source-interface':
      if (!reste[0]) return incomplet();
      return { statut: 'ok', action: { quoi: 'source-interface', nom: reste[0] } };
    case 'authentication':
      if (!reste[0]) return incomplet();
      if (reste[0].toLowerCase() !== 'enable') return mauvais(reste[0]);
      return { statut: 'ok', action: { quoi: 'authentication', actif: true } };
    case 'authentication-keyid': {
      // La forme est `<id> authentication-mode <algo> <cle>`. L'ancien
      // analyseur lisait les positions 1/2/3, donc retenait le mot
      // `authentication-mode` comme algorithme et perdait la cle.
      const id = entier(reste[0]);
      if (id === null) return reste[0] ? mauvais(reste[0]) : incomplet();
      if (!reste[1]) return incomplet();
      if (reste[1].toLowerCase() !== 'authentication-mode') return mauvais(reste[1]);
      if (!reste[2]) return incomplet();
      const algo = reste[2].toLowerCase();
      if (algo !== 'md5' && algo !== 'hmac-sha256' && algo !== 'sha256') return mauvais(reste[2]);
      if (!reste[3]) return incomplet();
      return { statut: 'ok', action: { quoi: 'auth-key', id, algo, cle: reste[3] } };
    }
    case 'reliable': {
      if (!reste[0]) return incomplet();
      if (reste[0].toLowerCase() !== 'authentication-keyid') return mauvais(reste[0]);
      const id = entier(reste[1]);
      if (id === null) return reste[1] ? mauvais(reste[1]) : incomplet();
      return { statut: 'ok', action: { quoi: 'reliable', id } };
    }
    case 'access': {
      if (!reste[0]) return incomplet();
      const genre = reste[0].toLowerCase();
      if (!['peer', 'server', 'synchronisation', 'synchronization', 'query'].includes(genre)) {
        return mauvais(reste[0]);
      }
      if (!reste[1]) return incomplet();
      return { statut: 'ok', action: { quoi: 'access', genre, acl: reste[1] } };
    }
    case 'enable':
      return { statut: 'ok', action: { quoi: 'enable', actif: true } };
    default:
      return mauvais(args[0]);
  }
}

/** Ecrit l'analyse dans l'agent — le seul magasin. */
export function appliquerNtpVrp(agent: NtpAgent, action: ActionNtpVrp): void {
  switch (action.quoi) {
    case 'association':
      // Une seconde commande sur la MEME adresse doit mettre a jour : le
      // sac de chaines qu'elle remplaçait empilait deux lignes.
      agent.removeServer(action.ip);
      if (action.mode === 'peer') agent.addPeer(action.ip, action.preference, action.keyId);
      else agent.addServer(action.ip, action.preference, action.keyId);
      break;
    case 'refclock-master':
      agent.setServerMode(true);
      agent.setLocalStratum(action.stratum);
      break;
    case 'source-interface': agent.setSourceInterface(action.nom); break;
    case 'authentication': agent.setAuthenticate(action.actif); break;
    case 'auth-key': agent.addAuthKey(action.id, action.algo, action.cle); break;
    case 'reliable': agent.addTrustedKey(action.id); break;
    case 'access': agent.setAccessGroup(action.genre, action.acl); break;
    case 'enable': agent.setEnabled(action.actif); break;
  }
}

/** Ce que `undo ntp-service …` retire. */
export function retirerNtpVrp(agent: NtpAgent, action: ActionNtpVrp): void {
  switch (action.quoi) {
    case 'association': agent.removeServer(action.ip); break;
    case 'refclock-master': agent.setServerMode(false); agent.setLocalStratum(16); break;
    case 'source-interface': agent.setSourceInterface(''); break;
    case 'authentication': agent.setAuthenticate(false); break;
    case 'auth-key': agent.removeAuthKey(action.id); break;
    case 'reliable': agent.removeTrustedKey(action.id); break;
    case 'access': agent.removeAccessGroup(action.genre); break;
    case 'enable': agent.setEnabled(false); break;
  }
}

// ── Le rendu de configuration ───────────────────────────────────────

/**
 * Les lignes `ntp-service` de la configuration.
 *
 * Elles etaient produites par le sac de chaines brutes, donc elles
 * reproduisaient la saisie sans jamais decrire l'etat : deux lignes
 * pour une adresse configuree deux fois, et
 * `authentication-keyid 1 authentication-mode authentication-mode md5`
 * — le mot ecrit deux fois, la cle absente. Elles decrivent maintenant
 * l'agent, donc elles se relisent.
 */
export function lignesConfigNtpVrp(agent: NtpAgent | undefined): string[] {
  if (!agent) return [];
  const cfg = agent.getConfig();
  const out: string[] = [];
  if (cfg.serverMode) out.push(`ntp-service refclock-master ${cfg.localStratum}`);
  for (const [ip, a] of cfg.associations) {
    const genre = a.mode === 'symmetric-active' ? 'unicast-peer' : 'unicast-server';
    out.push(`ntp-service ${genre} ${ip}`
      + (a.keyId !== undefined ? ` authentication-keyid ${a.keyId}` : '')
      + (a.prefer ? ' preference' : ''));
  }
  if (cfg.sourceInterface) out.push(`ntp-service source-interface ${cfg.sourceInterface}`);
  if (cfg.authenticate) out.push('ntp-service authentication enable');
  for (const k of cfg.authKeys.values()) {
    out.push(`ntp-service authentication-keyid ${k.id} authentication-mode ${k.algo} ${k.key}`);
  }
  for (const id of cfg.trustedKeys) out.push(`ntp-service reliable authentication-keyid ${id}`);
  for (const [genre, acl] of cfg.accessGroups) out.push(`ntp-service access ${genre} ${acl}`);
  return out;
}

// ── Les vues ────────────────────────────────────────────────────────

const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** L'horodatage de reference, a la mode VRP : heure puis date puis NTP. */
function horodatageVrp(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const ntpSec = Math.floor(ms / 1000) + 2208988800;
  const frac = Math.floor(((ms % 1000) / 1000) * 0x100000000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
    + `.${String(d.getUTCMilliseconds()).padStart(3, '0')}  ${MOIS[d.getUTCMonth()]} `
    + `${d.getUTCDate()} ${d.getUTCFullYear()}`
    + `(${(ntpSec >>> 0).toString(16).toUpperCase().padStart(8, '0')}.`
    + `${(frac >>> 0).toString(16).toUpperCase().padStart(8, '0')})`;
}

/**
 * `display ntp-service status`.
 *
 * Trois lignes sur dix, dont aucune mesure. La frequence nominale de
 * VRP est 100 Hz et sa precision `2^17` — Cisco annonce 250 Hz et
 * `2**18` : ce sont deux plateformes, pas une constante partagee.
 */
export function displayNtpServiceStatus(agent: NtpAgent | undefined): string {
  if (!agent) return 'Clock status: unsynchronized\nClock stratum: 16';
  const cfg = agent.getConfig();
  const synced = agent.isSynced();
  const best = [...cfg.associations.values()].find((a) => a.preferred);
  const driftPpm = agent.getDriftPpm();
  const maitreLocal = synced && !best;
  const lignes = [
    `Clock status: ${synced ? 'synchronized' : 'unsynchronized'}`,
    `Clock stratum: ${cfg.localStratum}`,
    // VRP ecrit `LOCAL(0)` la ou IOS ecrit `LOCL` : l'agent est partage
    // entre les deux plateformes, la traduction est donc ici.
    `Reference clock ID: ${synced ? refVrp(cfg.refIdentifier) : 'none'}`,
    `Nominal frequency: 100.0000 Hz`,
    `Actual frequency: ${(100 * (1 + driftPpm / 1e6)).toFixed(4)} Hz`,
    `Clock precision: 2^17`,
    `Clock offset: ${cfg.offsetMs.toFixed(4)} ms`,
    `Root delay: ${(best ? Math.abs(best.delayMs) : 0).toFixed(2)} ms`,
    `Root dispersion: ${(best ? best.dispersionMs : maitreLocal ? 0 : 16000).toFixed(2)} ms`,
    `Peer dispersion: ${(best ? best.dispersionMs / 2 : maitreLocal ? 0 : 16000).toFixed(2)} ms`,
    `Reference time: ${horodatageVrp(cfg.lastSyncMs || Date.now())}`,
  ];
  if (cfg.sourceInterface) lignes.push(`Source interface: ${cfg.sourceInterface}`);
  return lignes.join('\n');
}

/** L'ecriture VRP d'une reference locale : IOS dit `LOCL`. */
function refVrp(ref: string): string {
  if (!ref || ref === '.INIT.') return 'LOCAL(0)';
  return ref === 'LOCL' ? 'LOCAL(0)' : ref;
}

/**
 * `display ntp-service statistics packet`.
 *
 * Le format vient de la documentation Huawei. Quinze compteurs y
 * figurent ; ce moteur en observe SIX pour de bon — `Sent`, `Received`,
 * `Processed`, `Dropped`, `Authentication failures`, `Access denied`.
 *
 * **Les neuf autres sont a zero, et c'est un FAIT plutot qu'un
 * remplissage** : ce simulateur n'a ni limiteur de debit, ni file de
 * traitement, ni plafond d'associations dynamiques, donc aucun paquet
 * n'a jamais pu etre limite, retarde ou refuse pour ces motifs. Zero est
 * la vraie valeur. Les omettre donnerait un format qui n'est pas celui
 * de la machine ; inventer un nombre serait pire.
 */
export function displayNtpStatisticsPacket(agent: NtpAgent | undefined): string {
  const c = agent?.getCounters();
  const n = (v: number | undefined) => String(v ?? 0);
  return [
    'NTP IPv4 Packet Statistical Information',
    '---------------------------------------',
    `Sent                            : ${n(c?.sent)}`,
    `Send failures                   : 0`,
    `Received                        : ${n(c?.received)}`,
    `Processed                       : ${n(c?.processed)}`,
    `Dropped                         : ${n(c?.dropped)}`,
    `Validity test failures          : ${n(c?.badVersion)}`,
    `Authentication failures         : ${n(c?.authFailures)}`,
    `Invalid packets                 : ${n(c?.protocolError)}`,
    `Access denied                   : ${n(c?.accessDenied)}`,
    `Rate-limited                    : 0`,
    `Processing delay                : 0`,
    `Interface disabled              : 0`,
    `Max dynamic association reached : 0`,
    `Server disabled                 : 0`,
    `Others                          : 0`,
  ].join('\n');
}

const FILET_SESSIONS = '*'.repeat(78);

/**
 * `display ntp-service sessions [verbose]`.
 *
 * Elle repondait `No NTP associations` sur une machine dont la
 * configuration listait quatre serveurs — parce qu'elle lisait le bon
 * magasin et que le CLI ecrivait dans un autre. Le `reach` etait ecrit
 * `377` en dur pour toute association, y compris celles qui n'avaient
 * jamais repondu.
 */
export function displayNtpServiceSessions(
  agent: NtpAgent | undefined, verbose = false,
): string {
  const cfg = agent?.getConfig();
  if (!cfg || cfg.associations.size === 0) {
    return 'Info: No NTP session exists.';
  }
  const entete = [
    ` source          reference       stra reach poll  now offset   delay  disper`,
    FILET_SESSIONS,
  ];
  if (cfg.sourceInterface) entete.unshift(`source-interface: ${cfg.sourceInterface}`);
  entete.unshift(`clock stratum: ${cfg.localStratum}`);
  const lignes: string[] = [];
  for (const [, a] of cfg.associations) {
    const joignable = a.reach !== 0;
    const marque = a.preferred && joignable ? '*' : a.prefer && joignable ? '+' : ' ';
    const depuis = a.lastReplyMs ? Math.floor((Date.now() - a.lastReplyMs) / 1000) : 0;
    lignes.push(
      `${marque}${a.serverIp.padEnd(15)} ${(a.stratum < 16 ? a.serverIp : 'LOCAL(0)').padEnd(15)} `
      + `${String(a.stratum).padStart(2)} ${a.reach.toString(8).padStart(3, '0')} `
      + `${String(a.pollSec).padStart(4)} ${String(depuis).padStart(4)} `
      + `${a.offsetMs.toFixed(4).padStart(8)} ${Math.abs(a.delayMs).toFixed(4).padStart(7)} `
      + `${a.dispersionMs.toFixed(3).padStart(6)}`,
    );
    if (verbose) {
      // Ce que `verbose` ajoute et que le tableau ne peut pas porter :
      // le role de l'association et sa qualite calculee.
      lignes.push(`  reference: ${a.stratum < 16 ? a.serverIp : 'LOCAL(0)'}, `
        + `role: ${a.mode === 'symmetric-active' ? 'symmetric active' : 'client'}, `
        + `${a.preferred ? 'selected' : joignable ? 'candidate' : 'unreachable'}`);
      lignes.push(`  sync dist: ${(Math.abs(a.delayMs) / 2 + a.dispersionMs).toFixed(3)}, `
        + `key id: ${a.keyId ?? 0}`);
    }
  }
  const total = cfg.associations.size;
  return [...entete, ...lignes, FILET_SESSIONS,
    `Total sessions: ${total}`].join('\n');
}
