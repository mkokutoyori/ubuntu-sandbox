/**
 * PRD-NTP-Tutoriel.md §13 / lot N11 — `ntpq`, le client des requetes de
 * controle.
 *
 * ── Pourquoi cette commande et non `chronyc` ────────────────────────
 *
 * Elles ne parlent PAS le meme protocole, et c'est la premiere chose
 * qu'un lab doit montrer : `chronyc` cause a SON demon par un socket
 * prive (UDP/323), donc uniquement a la machine locale ou a un chronyd
 * qui l'a explicitement autorise ; `ntpq` envoie de vrais messages NTP de
 * **mode 6** sur UDP/123 et interroge donc n'importe quel serveur qui les
 * accepte — un routeur Cisco, un Huawei, un `ntpd`.
 *
 * C'est aussi pourquoi **`ntpq` interroge un routeur et pas un chronyd** :
 * chronyd n'implemente pas le mode 6 du tout. Une machine chrony
 * repondra donc « no server found », ce qui n'est pas un manque de ce
 * simulateur mais le comportement du vrai logiciel — et une bonne
 * surprise a faire vivre plutot qu'a masquer.
 *
 * ── Les colonnes, mesurees ──────────────────────────────────────────
 *
 * Les largeurs viennent d'une sortie reelle de `ntpq -p`, reproduite au
 * caractere pres par les colonnes declarees plus bas. **L'en-tete de
 * `ntpq` ne s'aligne pas sur ses propres donnees** — `reach` finit a la
 * colonne 52 quand sa valeur finit a la 51 —, exactement comme chez
 * chrony : il reste donc la constante mesuree, les donnees passent par
 * les colonnes. La deriver donnerait un tableau plus propre que la vraie
 * machine, donc faux.
 */
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import {
  analyserVariables, analyserListeAssociations, pointageDepuisSelect,
  NOMS_ERREURS_CONTROLE,
} from '@/network/ntp/control';
import { renderTable, FIXED_TABLE } from '@/network/devices/shells/cli/TextTable';

/**
 * L'en-tete du tableau des pairs, mesure sur une sortie reelle.
 * Voir l'en-tete du fichier pour la raison de sa forme constante.
 */
const ENTETE_PAIRS =
  '     remote           refid      st t when poll reach   delay   offset  jitter';

interface RangeePair {
  pointage: string; nom: string; refid: string; st: string; t: string;
  when: string; poll: string; reach: string;
  delay: string; offset: string; jitter: string;
}

function rendrePairs(rangees: readonly RangeePair[]): string {
  const D = (n: number) => ({ width: n, align: 'right' as const });
  const lignes = renderTable<RangeePair>(rangees, [
    { header: '     remote', width: 17, value: (r) => `${r.pointage}${r.nom}` },
    { header: '     refid', width: 16, value: (r) => r.refid },
    { header: 'st', ...D(2), value: (r) => r.st },
    { header: 't', ...D(2), value: (r) => r.t },
    { header: 'when', ...D(5), value: (r) => r.when },
    { header: 'poll', ...D(5), value: (r) => r.poll },
    { header: 'reach', ...D(5), value: (r) => r.reach },
    { header: 'delay', ...D(9), value: (r) => r.delay },
    { header: 'offset', ...D(9), value: (r) => r.offset },
    { header: 'jitter', ...D(8), value: (r) => r.jitter },
  ], FIXED_TABLE).slice(1);
  return [ENTETE_PAIRS, '='.repeat(78), ...lignes].join('\n');
}

/** Ce que `ntpq` dit quand personne ne repond : sa propre phrase. */
const AUCUN_SERVEUR = 'ntpq: read: Connection refused';

export const ntpqCommand: LinuxCommand = {
  name: 'ntpq',
  package: 'ntpsec',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/ntpq',
  usage: 'ntpq [-n] [-p] [-c command] [host]',
  run(ctx: LinuxCommandContext, argv: string[]): string {
    const agent = ctx.executor.ntpAgent?.();
    if (!agent) return 'ntpq: no NTP support on this host';

    const commandes: string[] = [];
    const libres: string[] = [];
    let pairs = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-p' || a === '--peers') { pairs = true; continue; }
      if (a === '-c' || a === '--command') { const v = argv[++i]; if (v) commandes.push(v); continue; }
      // `-n` demande de ne pas resoudre les noms. Ce simulateur n'a pas
      // de resolveur inverse cote `ntpq`, donc il n'affiche QUE des
      // adresses : l'option est acceptee et sans effet, ce qui est vrai
      // plutot que decoratif.
      if (a === '-n' || a === '--numeric') continue;
      if (a.startsWith('-')) return `ntpq: invalid option -- '${a.replace(/^-+/, '')}'`;
      libres.push(a);
    }
    const cible = libres[0];
    // Sans hote, le vrai `ntpq` interroge `localhost`. Ici cela n'a pas
    // de sens : chronyd — le seul demon de temps de cette image — ne
    // repond PAS au mode 6, donc l'exiger evite de faire croire qu'une
    // machine s'interroge elle-meme par ce chemin.
    if (!cible) return 'ntpq: no host specified (this build has no mode 6 responder of its own)';
    if (pairs) commandes.unshift('peers');
    if (commandes.length === 0) {
      return 'ntpq: no command given (interactive mode is not available here)';
    }

    const sorties: string[] = [];
    for (const cmd of commandes) {
      const mots = cmd.trim().split(/\s+/);
      const verbe = (mots[0] ?? '').toLowerCase();
      if (verbe === 'peers' || verbe === 'pe' || verbe === 'lpeers') {
        sorties.push(listerPairs(agent, cible));
        continue;
      }
      if (verbe === 'associations' || verbe === 'as') {
        sorties.push(listerAssociations(agent, cible));
        continue;
      }
      if (verbe === 'readvar' || verbe === 'rv') {
        const id = mots[1] !== undefined ? parseInt(mots[1], 10) : 0;
        sorties.push(lireVariables(agent, cible, isNaN(id) ? 0 : id, mots.slice(2)));
        continue;
      }
      sorties.push(`***Command \`${verbe}' unknown`);
    }
    return sorties.join('\n');
  },
};

type Agent = NonNullable<ReturnType<NonNullable<LinuxCommandContext['executor']['ntpAgent']>>>;

/** Le refus, rendu tel que la reponse le nomme. */
function refus(status: number): string {
  const code = (status >> 8) & 0xff;
  return `***Server reports a ${NOMS_ERREURS_CONTROLE[code] ?? 'unknown error'}`;
}

function listerPairs(agent: Agent, cible: string): string {
  const liste = agent.controlQuery(cible, 1);
  if (!liste) return AUCUN_SERVEUR;
  if (liste.error) return refus(liste.status);
  const rangees: RangeePair[] = [];
  for (const e of analyserListeAssociations(liste.data)) {
    const rep = agent.controlQuery(cible, 2, e.id);
    if (!rep || rep.error) continue;
    const v = analyserVariables(rep.data);
    rangees.push({
      // Le pointage vient du champ `select` du mot d'etat, jamais
      // recalcule a cote : c'est la meme information.
      pointage: pointageDepuisSelect((e.status >> 8) & 0x7),
      nom: v.srcadr ?? '',
      refid: v.refid ?? '.INIT.',
      st: v.stratum ?? '16',
      // `u` pour unicast : c'est le seul mode d'association que ce
      // moteur forme vers un serveur.
      t: 'u',
      when: v.when ?? '-',
      poll: String(1 << Number(v.ppoll ?? 6)),
      reach: v.reach ?? '000',
      delay: v.delay ?? '0.000',
      offset: v.offset ?? '0.000',
      jitter: v.jitter ?? '0.000',
    });
  }
  return rendrePairs(rangees);
}

function listerAssociations(agent: Agent, cible: string): string {
  const liste = agent.controlQuery(cible, 1);
  if (!liste) return AUCUN_SERVEUR;
  if (liste.error) return refus(liste.status);
  const entrees = analyserListeAssociations(liste.data);
  const lignes = entrees.map((e, i) =>
    `${String(i + 1).padStart(3)} ${String(e.id).padStart(5)}  `
    + `${e.status.toString(16).padStart(4, '0')}  `
    + `${pointageDepuisSelect((e.status >> 8) & 0x7) === '*' ? 'sys.peer' : 'candidate'}`);
  return ['ind assid status  conf reach auth condition  last_event cnt',
    '===========================================================', ...lignes].join('\n');
}

function lireVariables(
  agent: Agent, cible: string, id: number, demandees: readonly string[],
): string {
  const rep = agent.controlQuery(cible, 2, id);
  if (!rep) return AUCUN_SERVEUR;
  if (rep.error) return refus(rep.status);
  const v = analyserVariables(rep.data);
  const noms = demandees.length > 0
    ? demandees.flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean)
    : Object.keys(v);
  const paires: string[] = [];
  for (const n of noms) {
    // Une variable qu'on demande et que le serveur ne porte pas est
    // NOMMEE : la taire ferait croire a une valeur vide.
    if (v[n] === undefined) { paires.push(`${n}=?`); continue; }
    paires.push(`${n}=${v[n]}`);
  }
  // `ntpq` replie a environ 72 colonnes et prefixe l'etat, comme ici.
  const lignes: string[] = [`associd=${id} status=${rep.status.toString(16).padStart(4, '0')},`];
  let courante = '';
  for (const p of paires) {
    if (courante && courante.length + p.length + 2 > 72) { lignes.push(courante + ','); courante = ''; }
    courante = courante ? `${courante}, ${p}` : p;
  }
  if (courante) lignes.push(courante);
  return lignes.join('\n');
}
