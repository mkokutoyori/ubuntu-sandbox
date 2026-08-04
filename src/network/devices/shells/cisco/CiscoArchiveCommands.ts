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
import type { ArchiveService } from '../../router/archive/ArchiveService';

export type ArchiveAccessor = () => ArchiveService | undefined;

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
  trie.register('show archive config differences', 'Display archive config diff', () => {
    const s = ar();
    return s ? s.formatShowArchiveDiff() : 'No archive differences available.';
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
