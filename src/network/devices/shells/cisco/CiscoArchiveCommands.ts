/**
 * `archive` — la sauvegarde périodique de la configuration, pour les
 * DEUX plateformes Cisco.
 *
 * Ce bloc existait pour le routeur seul, et il lui manquait sa moitié
 * agissante. `ArchiveService.capture()` était écrit, testé par personne
 * et **appelé de nulle part** : les révisions ne pouvaient donc jamais
 * exister, `show archive` restait bloqué sur son message de table vide,
 * et `write-memory` — dont le sens EST « archive à chaque sauvegarde » —
 * était mémorisé sans que rien ne le lise. Encore un moteur sans porte,
 * sauf qu'ici il en manquait deux : la commande manuelle
 * (`archive config`) et le déclenchement automatique.
 *
 * Sur le SWITCH, la famille entière était refusée alors qu'un vrai
 * Catalyst la connaît. Plutôt que d'en écrire une seconde copie, les
 * constructeurs ci-dessous prennent un simple accesseur vers le service
 * : les deux shells enregistrent donc les mêmes commandes, avec le même
 * comportement, et ne peuvent pas diverger.
 */

import type { CommandTrie } from '../CommandTrie';
import type { ArchiveService, ConfigLogRecord } from '../../router/archive/ArchiveService';
import { renderTable, type TableColumn, FIXED_TABLE } from '../cli/TextTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';

export type ArchiveAccessor = () => ArchiveService | undefined;

/**
 * Les colonnes de `show archive log config`. La largeur porte son propre
 * blanc (`FIXED_TABLE`) parce que la colonne de commande est precedee
 * d'une barre qui n'appartient a aucune des deux voisines.
 */
const CONFIG_LOG_COLONNES: ReadonlyArray<TableColumn<ConfigLogRecord>> = [
  { header: ' idx', width: 6, align: 'right', value: (r) => String(r.index) },
  { header: '  sess', width: 7, align: 'right', value: (r) => String(r.session) },
  { header: '           user@line', width: 21, value: (r) => `      ${r.user}@${r.line}` },
  { header: '      Logged command', value: (r) => ` |  ${r.command}` },
];

function renderConfigLog(records: readonly ConfigLogRecord[]): string {
  if (records.length === 0) return ' idx   sess           user@line      Logged command';
  return renderTable(records, CONFIG_LOG_COLONNES, FIXED_TABLE).join('\n');
}

/**
 * Réserve d'honnêteté, écrite ici plutôt que découverte : le libellé
 * exact d'IOS quand on demande une archive sans chemin configuré n'a pas
 * pu être vérifié contre un vrai équipement depuis cet environnement. La
 * forme retenue suit la convention d'IOS (préfixe `%`, une phrase, la
 * condition nommée) et le refus lui-même n'est pas douteux : sans
 * chemin, il n'y a pas d'endroit où écrire.
 */
const SANS_CHEMIN = '% Archive path not configured';

/** `archive config` (EXEC privilégié) — archive la configuration courante. */
export function registerArchiveExecCommands(
  trie: CommandTrie, ar: ArchiveAccessor, runningConfig: () => string,
): void {
  trie.register('show archive', 'Display archive status', () => {
    const s = ar();
    return s ? s.formatShowArchive() : 'No archives configured / no revisions captured.';
  });
  /*
   * `show archive config differences [<avant> [<apres>]]` — la commande
   * la plus utile de tout ce sous-systeme pour un auditeur, et elle etait
   * enregistree SANS ARGUMENT (donc la forme du tutoriel, qui en prend
   * un, etait refusee) et rendait une PHRASE au lieu d'un diff.
   *
   * Sans argument, IOS compare la derniere archive a la configuration
   * courante : c'est la question qu'on pose le plus souvent, « qu'est-ce
   * qui a bouge depuis la derniere sauvegarde ? ».
   */
  trie.registerGreedy('show archive config differences', 'Display archive config diff', (args) => {
    const s = ar();
    if (!s) return 'No archive differences available.';
    const courant = runningConfig();
    const lire = (ref: string): string | null => {
      if (/^system:running-config$/i.test(ref)) return courant;
      return s.readArchivedConfig(ref);
    };
    if (args.length === 0) {
      const derniere = s.latestArchivedConfig();
      if (derniere === null) return 'No archive differences available.';
      return s.formatShowArchiveDiff(derniere, courant);
    }
    // Avec UN seul argument, IOS compare la derniere archive au fichier
    // nomme — et non ce fichier a lui-meme, qui ne differerait jamais de
    // rien. C'est ce qui donne un sens a la forme du tutoriel,
    // `... differences system:running-config`.
    if (args.length === 1) {
      const cible = lire(args[0]);
      if (cible === null) return `%Error opening ${args[0]} (No such file or directory)`;
      const derniere = s.latestArchivedConfig();
      if (derniere === null) return 'No archive differences available.';
      return s.formatShowArchiveDiff(derniere, cible);
    }
    const avant = lire(args[0]);
    if (avant === null) return `%Error opening ${args[0]} (No such file or directory)`;
    const apres = lire(args[1]);
    if (apres === null) return `%Error opening ${args[1]} (No such file or directory)`;
    return s.formatShowArchiveDiff(avant, apres);
  });

  /*
   * `show archive log config all` — la porte du journal des commandes.
   * Il n'y en avait aucune : le sous-mode `log config` etait accepte, ses
   * reglages ranges, et rien ne pouvait etre relu.
   */
  trie.registerGreedy('show archive log config', 'Display configuration log', (args) => {
    const s = ar();
    if (!s) return '';
    const mot = (args[0] ?? 'all').toLowerCase();
    if (mot !== 'all' && !/^\d+$/.test(mot)) throw new CliInvalidInput({ token: args[0] });
    const tous = s.listConfigLog();
    const choisis = mot === 'all' ? tous : tous.filter((r) => r.index >= Number(mot));
    return renderConfigLog(choisis);
  });
  trie.register('archive config', 'Archive the running configuration', () => {
    const s = ar();
    if (!s) return SANS_CHEMIN;
    if (!s.getPath().path) return SANS_CHEMIN;
    const r = s.capture('manual', runningConfig());
    return 'erreur' in r ? r.erreur : `Writing ${r.path}`;
  });
}

/**
 * Le déclenchement automatique de `write-memory`, appelé par le
 * `onSave()` des deux shells. Ne fait rien tant que l'opérateur n'a pas
 * demandé `write-memory` sous `archive` — c'est ce mot-clé, et lui seul,
 * qui lie une sauvegarde à un archivage.
 */
export function archiveOnWriteMemory(ar: ArchiveAccessor, runningConfig: () => string): void {
  const s = ar();
  if (!s) return;
  if (!s.getPath().writeMemory || !s.getPath().path) return;
  // Une flash pleine fait échouer l'archivage sans empêcher la
  // sauvegarde elle-même : `write memory` a déjà écrit `startup-config`.
  s.capture('auto-write-memory', runningConfig());
}

/** Le sous-mode `(config-archive)#`. */
export function buildArchiveSubmodeOn(
  trie: CommandTrie, ar: ArchiveAccessor, enterLogMode: () => void,
): void {
  trie.registerGreedy('path', 'Archive path', (args) => {
    if (args[0]) ar()?.setPath(args[0]);
    return '';
  });
  trie.registerGreedy('time-period', 'Archive interval', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) ar()?.setTimePeriod(n);
    return '';
  });
  trie.registerGreedy('maximum', 'Max revisions', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) ar()?.setMaximum(n);
    return '';
  });
  trie.register('write-memory', 'Trigger archive on write', () => { ar()?.setWriteMemory(true); return ''; });
  trie.register('no write-memory', 'Disable archive-on-write', () => { ar()?.setWriteMemory(false); return ''; });
  trie.register('log config', 'Enter archive log config submode', () => {
    ar()?.enableLogging();
    enterLogMode();
    return '';
  });
}

/** Le sous-mode `(config-archive-log-cfg)#`. */
export function buildArchiveLogSubmodeOn(trie: CommandTrie, ar: ArchiveAccessor): void {
  trie.registerGreedy('logging size', 'Archive log buffer size', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) ar()?.setLogBufferSize(n);
    return '';
  });
  trie.register('logging enable', 'Enable archive logging', () => { ar()?.enableLogging(); return ''; });
  trie.register('logging disable', 'Disable archive logging', () => { ar()?.disableLogging(); return ''; });
  trie.register('hidekeys', 'Hide passwords in archive log', () => { ar()?.setHidekeys(true); return ''; });
  trie.register('no hidekeys', 'Show passwords in archive log', () => { ar()?.setHidekeys(false); return ''; });
  trie.registerGreedy('notify syslog contenttype', 'Notify syslog format', (args) => {
    ar()?.setNotifySyslog(args[0] === 'xml' ? 'xml' : 'plaintext');
    return '';
  });
}
