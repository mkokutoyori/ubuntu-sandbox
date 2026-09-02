/**
 * `conntrack` — la table de suivi de connexions de netfilter.
 *
 * Encore un moteur sans porte, et le dernier manque Linux des
 * transcripts (audit 12, §3.1). `LinuxIptablesManager` tient une vraie
 * table de suivi — c'est elle, et pas une approximation, qui décide si un
 * paquet correspond à `-m state --state ESTABLISHED`. Elle est alimentée
 * à chaque paquet traversant les chaînes, dans les deux sens, et purgée
 * au bout de `CONNTRACK_TIMEOUT`. Rien ne la nommait : un lab pouvait
 * écrire la règle qui s'en sert, jamais montrer la table qui la
 * justifie.
 *
 * Ce que rend `-L`, et d'où ça vient :
 *
 *   - protocole, adresses et ports : lus des clés de la table ;
 *   - le sens retour : présent ou non dans la table, ce qui est
 *     exactement la distinction que le vrai binaire marque
 *     `[UNREPLIED]` ;
 *   - le délai restant : `CONNTRACK_TIMEOUT` moins l'âge de l'entrée,
 *     le même chiffre que celui qui décide de la purge.
 *
 * **Ce qui n'est PAS affiché, et pourquoi c'est correct** : les
 * compteurs de paquets et d'octets par direction. Le vrai `conntrack -L`
 * ne les montre pas non plus par défaut — ils demandent
 * `net.netfilter.nf_conntrack_acct=1`, désactivé sur toute installation
 * courante. Les omettre n'est donc pas une simplification, c'est le
 * comportement par défaut.
 *
 * Ce qui EST une simplification, écrite ici plutôt que découverte : le
 * champ d'état ne connaît que `ESTABLISHED` et `UNREPLIED`. Le vrai
 * conntrack suit la machine à états TCP complète (`SYN_SENT`,
 * `SYN_RECV`, `FIN_WAIT`, `TIME_WAIT`, `CLOSE`), et le moteur derrière
 * n'a pas cette information : il ne mémorise qu'un horodatage par tuple.
 * Afficher `SYN_SENT` demanderait de suivre les drapeaux TCP dans la
 * table, ce qui est un autre chantier — et inventer l'état serait pire
 * que de n'en montrer que deux.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const CONNTRACK_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-L', aliases: ['--dump'], dest: 'dump', description: 'List connection tracking table' },
  { flag: '-S', aliases: ['--stats'], dest: 'stats', description: 'Show statistics' },
  { flag: '-F', aliases: ['--flush'], dest: 'flush', description: 'Flush the connection tracking table' },
  { flag: '-C', aliases: ['--count'], dest: 'count', description: 'Show number of flow entries' },
  { flag: '-p', aliases: ['--proto'], dest: 'proto', takesArg: true, argName: 'proto', description: 'Filter by layer 4 protocol' },
];

const VERSION = 'conntrack v1.4.7 (conntrack-tools)';

/**
 * Le protocole est stocké par NUMÉRO dans le moteur (`PacketInfo.protocol`
 * est un `number` : 1=ICMP, 6=TCP, 17=UDP) — mesuré, pas supposé : la
 * première version de cette commande affichait « 1 » là où le vrai
 * binaire écrit « icmp », et `-p icmp` ne filtrait rien.
 *
 * `conntrack` affiche les DEUX, le nom puis le numéro, et c'est aussi
 * par le nom qu'on filtre. La conversion vit donc ici, dans les deux
 * sens, plutôt que dupliquée à chaque point d'usage.
 */
const PROTOS: Readonly<Record<number, string>> = {
  1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 58: 'icmpv6', 132: 'sctp',
};

function protoNom(brut: string): string {
  const n = parseInt(brut, 10);
  if (!Number.isNaN(n)) return PROTOS[n] ?? `unknown-${n}`;
  return brut.toLowerCase();
}

function protoNum(brut: string): number {
  const n = parseInt(brut, 10);
  if (!Number.isNaN(n)) return n;
  const trouve = Object.entries(PROTOS).find(([, nom]) => nom === brut.toLowerCase());
  return trouve ? Number(trouve[0]) : 0;
}

export function runConntrack(
  ctx: LinuxCommandContext, args: string[],
): { output: string; exitCode: number } {
  const ipt = ctx.executor.iptables;
  const has = (...n: string[]) => n.some((x) => args.includes(x));

  // Le vrai binaire exige une commande ; sans elle il affiche l'aide et
  // sort en erreur plutôt que de deviner.
  if (args.length === 0) {
    return { output: `${VERSION}\nconntrack: Parameter problem: missing command`, exitCode: 2 };
  }

  const iProto = args.findIndex((a) => a === '-p' || a === '--proto');
  const filtre = iProto >= 0 ? (args[iProto + 1] ?? '').toLowerCase() : '';

  if (has('-F', '--flush')) {
    ipt.flushConntrack();
    return { output: 'conntrack v1.4.7 (conntrack-tools): connection tracking table has been emptied.', exitCode: 0 };
  }

  // Le filtre `-p` porte sur le NOM, le moteur range un numéro : on
  // compare donc les deux sous leur forme nommée.
  const flux = ipt.listConntrack()
    .filter((f) => !filtre || protoNom(f.protocol) === protoNom(filtre));

  if (has('-C', '--count')) {
    return { output: String(flux.length), exitCode: 0 };
  }

  if (has('-S', '--stats')) {
    const s = ipt.conntrackStats;
    // Une seule ligne : le simulateur a un plan de données, pas des
    // files par cœur. Annoncer cpu=0..N alors qu'un seul chemin traite
    // les paquets répartirait des chiffres au hasard.
    return {
      output: `cpu=0   found=${s.found} invalid=${s.invalid} insert=${s.insert} `
        + `insert_failed=0 drop=${s.drop} early_drop=0 error=0 search_restart=0`,
      exitCode: 0,
    };
  }

  if (!has('-L', '--dump')) {
    return { output: `${VERSION}\nconntrack: Parameter problem: missing command`, exitCode: 2 };
  }

  const timeout = ipt.conntrackTimeoutSec();
  const lignes = flux.map((f) => {
    const restant = Math.max(0, Math.round(timeout - f.ageMs / 1000));
    const orig = `src=${f.srcIP} dst=${f.dstIP} sport=${f.srcPort} dport=${f.dstPort}`;
    const reply = `src=${f.dstIP} dst=${f.srcIP} sport=${f.dstPort} dport=${f.srcPort}`;
    const etat = f.replied ? 'ESTABLISHED' : '[UNREPLIED]';
    return `${protoNom(f.protocol).padEnd(8)} ${String(protoNum(f.protocol)).padEnd(2)} ${String(restant).padEnd(6)} `
      + `${etat} ${orig} ${reply} mark=0 use=1`;
  });

  // Le récapitulatif part sur stderr chez le vrai binaire ; ce
  // simulateur n'a qu'un flux de sortie, on le garde en queue comme le
  // fait un terminal qui mélange les deux.
  lignes.push(`${VERSION}: ${flux.length} flow entries have been shown.`);
  return { output: lignes.join('\n'), exitCode: 0 };
}

export const conntrackCommand: LinuxCommand = {
  name: 'conntrack',
  package: 'conntrack',
  needsNetworkContext: true,
  usage: 'conntrack [-L | -S | -F | -C] [-p proto]',
  manSection: 8,
  binaryPath: '/usr/sbin/conntrack',
  options: CONNTRACK_OPTIONS,
  help: 'Command line interface for the netfilter connection tracking table.',
  run(ctx, args) { return runConntrack(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runConntrack(ctx, args); },
};
