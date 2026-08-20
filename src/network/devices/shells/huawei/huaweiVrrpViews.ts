/**
 * PRD-CLI-Fidelite-VRP.md §24 / lot V15 — VRRP : un magasin, une
 * grammaire, une vue.
 *
 * Le routeur et le commutateur repondaient differemment a la meme
 * question posee au meme objet. Mesure avant d'ecrire une ligne ici,
 * sur la MEME configuration des deux cotes :
 *
 * ```
 * routeur                          commutateur
 * GE0/0/0 | Virtual Router 1       Vlanif10 | Virtual Router 1
 *     State : Initialize             State : Initialize
 *     Virtual IP : 10.0.12.254       Virtual IP : 10.0.10.254
 *     Priority : 120                 Virtual MAC : 00:00:5e:00:01:01
 *     Advertisement timer : 1 s      PriorityRun : 90
 *     Preempt mode : Yes (delay 5s)  PriorityConfig : 120
 *     Authentication : none          Preempt : YES
 * ```
 *
 * Rien de commun : ni les champs, ni l'indentation, ni l'ecriture de la
 * MAC, ni le nom de l'interface. Et le desaccord n'etait pas que de mise
 * en page — le `PriorityRun` du commutateur BAISSE parce que son `track`
 * atteint l'agent, la `Priority` du routeur non, pour la meme commande.
 *
 * ── Ce que ce module decide ─────────────────────────────────────────
 *
 * Un seul magasin : l'agent VRRP reel (`VrrpAgent`), qui porte deja
 * l'etat, l'election et les pistes. Le routeur ecrivait en plus dans une
 * facade (`HuaweiVrrpService`) que ses vues lisaient — deux magasins
 * pour un fait, donc deux reponses possibles.
 *
 * Une seule grammaire : `analyserVrrp`, qui VALIDE. Le commutateur
 * refusait `vrid 999`, `priority 300`, une IP qui n'en est pas une ; le
 * routeur acceptait tout, et rangeait meme `vrrp vrid 1 zzz` dans sa
 * configuration rendue, donc rejoue a l'import.
 *
 * Une seule vue : `rendreDisplayVrrp` et ses soeurs, appelees par les
 * deux plateformes.
 *
 * ── Mesure et connaissance du constructeur, tenues separees ─────────
 *
 * Ce qui precede est MESURE. Que le bloc de VRP porte `PriorityRun` et
 * `PriorityConfig` cote a cote, `TimerRun`/`TimerConfig`, `Auth type` et
 * une MAC en `0000-5e00-0101` releve de la connaissance du constructeur,
 * et le PRD (§24) tient les deux separes.
 *
 * ── Ce qui est porte sans etre agi, et pourquoi c'est dit ───────────
 *
 * `preempt-mode timer delay` et `authentication-mode` sont ranges,
 * rendus et rejoues, mais le moteur ne differe aucune prise de role et
 * n'authentifie rien. C'etait deja le cas cote routeur ; ce lot leur
 * donne un seul magasin au lieu de les PERDRE cote commutateur, ce qui
 * est un progres et non une decoration. Les faire agir est un travail de
 * protocole, pas de CLI, et il reste ouvert.
 */

import type { VrrpAgent } from '../../../vrrp/VrrpAgent';
import type { VrrpGroupRuntime, VrrpAuthMode, VrrpGlobalStats } from '../../../vrrp/types';
import { vrrpVirtualMac, effectivePriority, createVrrpStats } from '../../../vrrp/types';
import { IPAddress } from '../../../core/types';
import { huaweiDisplayInterfaceName } from '../cli-utils';
import type { ErreurGrammaireVrp } from '../cli-utils';
import { huaweiMacAddress } from './huaweiTableLayouts';
import { renderTable, VRP_RULED_TABLE, type TableColumn } from '../cli/TextTable';

// ── La grammaire ────────────────────────────────────────────────────

export type ActionVrrp =
  | { quoi: 'groupe' }
  | { quoi: 'virtual-ip'; ip: string }
  | { quoi: 'priority'; valeur: number }
  | { quoi: 'preempt-mode'; delai: number }
  | { quoi: 'timer-advertise'; sec: number }
  | { quoi: 'track'; cible: string; reduced: number }
  | { quoi: 'description'; texte: string }
  | { quoi: 'authentication-mode'; mode: VrrpAuthMode; cle?: string };

export type AnalyseVrrp =
  | { statut: 'ok'; vrid: number; action: ActionVrrp }
  | { statut: 'refus'; err: ErreurGrammaireVrp };

const refus = (err: ErreurGrammaireVrp): AnalyseVrrp => ({ statut: 'refus', err });
const mauvais = (token: string) => refus({ kind: 'wrong', token });
const incomplet = () => refus({ kind: 'incomplete' });

/** Un entier decimal strict — `12abc` n'est pas 12. */
function entier(mot: string | undefined): number | null {
  if (!mot || !/^\d+$/.test(mot)) return null;
  return parseInt(mot, 10);
}

/**
 * Analyse les mots qui SUIVENT `vrrp`, soit `vrid <n> [...]`.
 *
 * Les deux plateformes n'enregistrent pas la commande au meme endroit de
 * l'arbre — `vrrp` cote routeur, `vrrp vrid` cote commutateur — et c'est
 * l'appelant qui recompose, pour que la grammaire n'ait qu'une forme.
 */
export function analyserVrrp(args: readonly string[]): AnalyseVrrp {
  if (args.length === 0) return incomplet();
  if (args[0].toLowerCase() !== 'vrid') return mauvais(args[0]);
  const vrid = entier(args[1]);
  if (args.length < 2) return incomplet();
  if (vrid === null || vrid < 1 || vrid > 255) return mauvais(args[1]);

  const reste = args.slice(2);
  if (reste.length === 0) return { statut: 'ok', vrid, action: { quoi: 'groupe' } };

  const mot = reste[0].toLowerCase();
  switch (mot) {
    case 'virtual-ip': {
      if (!reste[1]) return incomplet();
      if (!IPAddress.isValid(reste[1])) return mauvais(reste[1]);
      return { statut: 'ok', vrid, action: { quoi: 'virtual-ip', ip: reste[1] } };
    }
    case 'priority': {
      if (!reste[1]) return incomplet();
      const p = entier(reste[1]);
      // 255 est reserve au proprietaire de l'adresse, 0 a la renonciation
      // (RFC 3768 §6.1) : ni l'un ni l'autre ne se configure.
      if (p === null || p < 1 || p > 254) return mauvais(reste[1]);
      return { statut: 'ok', vrid, action: { quoi: 'priority', valeur: p } };
    }
    case 'preempt-mode': {
      if (reste.length === 1) return { statut: 'ok', vrid, action: { quoi: 'preempt-mode', delai: 0 } };
      if (reste[1].toLowerCase() !== 'timer') return mauvais(reste[1]);
      if (!reste[2]) return incomplet();
      if (reste[2].toLowerCase() !== 'delay') return mauvais(reste[2]);
      if (!reste[3]) return incomplet();
      const d = entier(reste[3]);
      if (d === null || d < 1 || d > 3600) return mauvais(reste[3]);
      return { statut: 'ok', vrid, action: { quoi: 'preempt-mode', delai: d } };
    }
    case 'timer': {
      if (!reste[1]) return incomplet();
      if (reste[1].toLowerCase() !== 'advertise') return mauvais(reste[1]);
      if (!reste[2]) return incomplet();
      const s = entier(reste[2]);
      if (s === null || s < 1 || s > 255) return mauvais(reste[2]);
      return { statut: 'ok', vrid, action: { quoi: 'timer-advertise', sec: s } };
    }
    case 'track': {
      if (!reste[1]) return incomplet();
      if (reste[1].toLowerCase() !== 'interface') return mauvais(reste[1]);
      if (!reste[2]) return incomplet();
      const iReduced = reste.findIndex((m) => m.toLowerCase() === 'reduced');
      let reduced = 10;
      if (iReduced >= 0) {
        const r = entier(reste[iReduced + 1]);
        if (r === null || r < 1 || r > 255) return reste[iReduced + 1] ? mauvais(reste[iReduced + 1]) : incomplet();
        reduced = r;
      }
      const cible = reste.slice(2, iReduced >= 0 ? iReduced : undefined).join(' ');
      if (!cible) return incomplet();
      return { statut: 'ok', vrid, action: { quoi: 'track', cible, reduced } };
    }
    case 'description': {
      const texte = reste.slice(1).join(' ');
      if (!texte) return incomplet();
      return { statut: 'ok', vrid, action: { quoi: 'description', texte } };
    }
    case 'authentication-mode': {
      if (!reste[1]) return incomplet();
      const m = reste[1].toLowerCase();
      if (m !== 'simple' && m !== 'md5' && m !== 'none') return mauvais(reste[1]);
      if (m === 'none') return { statut: 'ok', vrid, action: { quoi: 'authentication-mode', mode: 'none' } };
      const cle = reste[2]?.toLowerCase() === 'cipher' ? reste[3] : reste[2];
      if (!cle) return incomplet();
      return { statut: 'ok', vrid, action: { quoi: 'authentication-mode', mode: m, cle } };
    }
    default:
      return mauvais(reste[0]);
  }
}

/**
 * Ecrit l'analyse dans l'agent — le seul magasin.
 *
 * `resoudreNom` sert au `track`, dont la cible est un nom d'interface
 * que l'operateur a le droit d'abreger comme partout ailleurs.
 */
export function appliquerVrrp(
  agent: VrrpAgent,
  iface: string,
  vrid: number,
  action: ActionVrrp,
  resoudreNom: (nom: string) => string,
): void {
  const g = agent.ensureGroup(iface, vrid);
  switch (action.quoi) {
    case 'groupe': break;
    case 'virtual-ip': agent.setVip(iface, vrid, action.ip); break;
    case 'priority': agent.setPriority(iface, vrid, action.valeur); break;
    case 'preempt-mode':
      agent.setPreempt(iface, vrid, true);
      g.preemptDelaySec = action.delai;
      break;
    case 'timer-advertise': agent.setAdvertiseSec(iface, vrid, action.sec); break;
    case 'track': agent.addTrack(iface, vrid, resoudreNom(action.cible), action.reduced); break;
    case 'description': g.description = action.texte; break;
    case 'authentication-mode':
      g.authMode = action.mode;
      g.authKey = action.cle;
      break;
  }
}

// ── Les vues ────────────────────────────────────────────────────────

const ETAT: Record<string, string> = { master: 'Master', backup: 'Backup', init: 'Initialize' };

const etatDe = (g: VrrpGroupRuntime): string => ETAT[g.state] ?? 'Initialize';

/**
 * Le bloc detaille d'un groupe.
 *
 * Les deux plateformes rendaient ce bloc chacune avec ses champs et son
 * indentation ; il n'en reste qu'un. `PriorityRun` et `PriorityConfig`
 * sont TOUJOURS rendus, la ou le commutateur ne montrait le couple que
 * lorsque les deux differaient : un lecteur qui ne voit qu'une ligne
 * `Priority` ne peut pas savoir si la piste a joue.
 */
export function rendreBlocVrrp(g: VrrpGroupRuntime): string[] {
  const lignes = [
    `  ${huaweiDisplayInterfaceName(g.iface)} | Virtual Router ${g.vrid}`,
    `    State : ${etatDe(g)}`,
    `    Virtual IP : ${g.vip ?? 'unassigned'}`,
    `    Master IP : ${g.masterIp ?? '0.0.0.0'}`,
    `    PriorityRun : ${effectivePriority(g)}`,
    `    PriorityConfig : ${g.priority}`,
    `    MasterPriority : ${g.masterPriority}`,
    `    Preempt : ${g.preempt ? 'YES' : 'NO'}   Delay Time : ${g.preemptDelaySec ?? 0} s`,
    `    TimerRun : ${g.advertiseSec} s`,
    `    TimerConfig : ${g.advertiseSec} s`,
    `    Auth type : ${(g.authMode ?? 'none').toUpperCase()}`,
    `    Virtual MAC : ${huaweiMacAddress(vrrpVirtualMac(g.vrid))}`,
    `    Check TTL : YES`,
    `    Config type : normal-vrrp`,
  ];
  if (g.description) lignes.push(`    Description : ${g.description}`);
  for (const t of g.tracks) {
    lignes.push(`    Track IF : ${huaweiDisplayInterfaceName(t.target)}   Priority reduced : ${t.decrement}`);
    lignes.push(`    IF state : ${t.down ? 'DOWN' : 'UP'}`);
  }
  return lignes;
}

export const AUCUN_GROUPE = 'Info: No VRRP backup group is configured.';

export function rendreDisplayVrrp(groupes: readonly VrrpGroupRuntime[]): string {
  if (groupes.length === 0) return AUCUN_GROUPE;
  return groupes.map((g) => rendreBlocVrrp(g).join('\n')).join('\n');
}

const COLONNES_BRIEF: ReadonlyArray<TableColumn<VrrpGroupRuntime>> = [
  { header: 'VRID', width: 6, value: (g) => String(g.vrid) },
  { header: 'State', width: 12, value: (g) => etatDe(g) },
  { header: 'Interface', width: 17, value: (g) => huaweiDisplayInterfaceName(g.iface) },
  { header: 'Type', width: 8, value: () => 'Normal' },
  { header: 'Virtual IP', value: (g) => g.vip ?? 'unassigned' },
];

/**
 * `display vrrp brief`. Le bloc de comptage etait rendu par le routeur
 * et absent du commutateur, pour la meme commande — le meme defaut que
 * le lot V12 avait ferme sur `display ip interface brief`.
 */
export function rendreDisplayVrrpBrief(groupes: readonly VrrpGroupRuntime[]): string {
  const etats = groupes.map(etatDe);
  const compte = (quoi: string) => etats.filter((e) => e === quoi).length;
  const total = groupes.length;
  const actifs = compte('Master') + compte('Backup');
  return [
    `Total:${total}     Master:${compte('Master')}     Backup:${compte('Backup')}     Non-active:${total - actifs}`,
    ...renderTable(groupes, COLONNES_BRIEF, { ...VRP_RULED_TABLE, indent: '  ' }),
  ].join('\n');
}

/**
 * `display vrrp statistics`. Les compteurs sont a zero et c'est un FAIT
 * et non un manque : rien dans cet agent ne compte les annonces emises
 * ou recues, et afficher un nombre invente serait pire que zero. Ce qui
 * est compte pour de bon — le nombre de pistes — l'est depuis l'agent.
 */
/**
 * `display vrrp statistics`.
 *
 * **Les intitules etaient INVENTES**, en plus d'etre a zero : cette vue
 * annoncait `Advertisement sent`, `Become master` et `Track interfaces`,
 * dont **aucun** ne figure dans la sortie d'une vraie machine. Ce sont
 * desormais les dix-neuf champs de VRP, dans son ordre, precedes des
 * quatre compteurs qu'il tient pour la MACHINE et non par groupe — ils
 * sont globaux parce qu'ils portent sur des paquets qu'on n'a pas pu
 * rattacher a un groupe, et une somme de controle fausse ou un VRID
 * inconnu ne designent justement aucun groupe.
 *
 * L'alignement est celui de la sortie reelle : l'intitule, un espace, un
 * deux-points, un espace, la valeur — VRP ne met pas ses valeurs en
 * colonne ici, et les y mettre serait plus joli que la machine.
 */
export function rendreDisplayVrrpStatistics(
  groupes: readonly VrrpGroupRuntime[],
  globales?: Readonly<VrrpGlobalStats>,
): string {
  if (groupes.length === 0) return AUCUN_GROUPE;
  const gl = globales ?? { checksumErrors: 0, versionErrors: 0, vridErrors: 0, otherErrors: 0 };
  const tete = [
    `  Checksum errors : ${gl.checksumErrors}`,
    `  Version errors : ${gl.versionErrors}`,
    `  Vrid errors : ${gl.vridErrors}`,
    `  Other errors : ${gl.otherErrors}`,
  ];
  const corps = groupes.map((g) => {
    const c = g.stats ?? createVrrpStats();
    return [
      `  ${huaweiDisplayInterfaceName(g.iface)} | Virtual Router ${g.vrid}`,
      `    Transited to master : ${c.transitedToMaster}`,
      `    Transited to backup : ${c.transitedToBackup}`,
      `    Transited to initialize : ${c.transitedToInitialize}`,
      `    Received advertisements : ${c.receivedAdvertisements}`,
      `    Sent advertisements : ${c.sentAdvertisements}`,
      `    Advertisement interval errors : ${c.advertisementIntervalErrors}`,
      `    Failed to authentication check : ${c.failedAuthCheck}`,
      `    Received ip ttl errors : ${c.receivedIpTtlErrors}`,
      `    Received packets with priority zero : ${c.receivedPriorityZero}`,
      `    Sent packets with priority zero : ${c.sentPriorityZero}`,
      `    Received invalid type packets : ${c.receivedInvalidType}`,
      `    Received unmatched address list packets : ${c.receivedUnmatchedAddressList}`,
      `    Unknown authentication type packets : ${c.unknownAuthType}`,
      `    Mismatched authentication type : ${c.mismatchedAuthType}`,
      `    Packet length errors : ${c.packetLengthErrors}`,
      `    Discarded packets since track admin-vrrp : ${c.discardedTrackAdminVrrp}`,
      `    Received attacking packets : ${c.receivedAttacking}`,
      `    Received selfsend packets : ${c.receivedSelfsend}`,
      `    Sent gratuitous arp packets : ${c.sentGratuitousArp}`,
    ].join('\n');
  });
  return [...tete, ...corps].join('\n');
}

/**
 * Les lignes `vrrp` d'un bloc `interface` de la configuration.
 *
 * Un SEUL constructeur, parce que les quatre chemins qui rendent une
 * configuration se contredisaient deux a deux : le routeur les rendait
 * dans sa vue par interface et pas dans sa configuration complete, le
 * commutateur exactement l'inverse. Une configuration qu'on ne peut pas
 * relire est une configuration perdue, le running-config etant rejoue a
 * l'import d'une topologie.
 */
export function lignesConfigVrrp(groupes: readonly VrrpGroupRuntime[], iface: string): string[] {
  const out: string[] = [];
  for (const g of groupes) {
    if (g.iface !== iface) continue;
    if (g.vip) out.push(` vrrp vrid ${g.vrid} virtual-ip ${g.vip}`);
    if (g.priority !== 100) out.push(` vrrp vrid ${g.vrid} priority ${g.priority}`);
    if (g.advertiseSec !== 1) out.push(` vrrp vrid ${g.vrid} timer advertise ${g.advertiseSec}`);
    if (g.preempt && (g.preemptDelaySec ?? 0) > 0) {
      out.push(` vrrp vrid ${g.vrid} preempt-mode timer delay ${g.preemptDelaySec}`);
    } else if (g.preempt) {
      out.push(` vrrp vrid ${g.vrid} preempt-mode`);
    } else {
      out.push(` undo vrrp vrid ${g.vrid} preempt-mode`);
    }
    if (g.description) out.push(` vrrp vrid ${g.vrid} description ${g.description}`);
    if (g.authMode && g.authMode !== 'none') {
      out.push(` vrrp vrid ${g.vrid} authentication-mode ${g.authMode}${g.authKey ? ` cipher ${g.authKey}` : ''}`);
    }
    for (const t of g.tracks) {
      out.push(` vrrp vrid ${g.vrid} track interface ${huaweiDisplayInterfaceName(t.target)} reduced ${t.decrement}`);
    }
  }
  return out;
}

/** Les groupes portes par une interface, resolue comme partout ailleurs. */
export function groupesDeLInterface(
  agent: VrrpAgent | undefined,
  iface: string,
): readonly VrrpGroupRuntime[] {
  return agent?.listGroups().filter((g) => g.iface === iface) ?? [];
}
