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
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import type { ArchiveService, ConfigLogRecord } from '../../router/archive/ArchiveService';
import { renderTable, type TableColumn, FIXED_TABLE } from '../cli/TextTable';
import { CliInvalidInput, CliIncomplete } from '../cli/CliDiagnostic';
import {
  parseConfigReplaceArgs, replacePlan, CONFIG_REPLACE_BANNER,
} from '../../router/archive/ConfigReplace';

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
  lireFichier: (url: string) => string | null = () => null,
  lireStartup: () => string | null = () => null,
  appliquer: (texte: string) => void = () => {},
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
      // `nvram:startup-config` est la moitié gauche de la comparaison
      // que le chapitre présente comme LE contrôle d'audit : « la
      // configuration courante est-elle sauvegardée ? ». La commande ne
      // savait lire que des archives, donc cette forme-là — la seule
      // vraiment utile — répondait `%Error opening`.
      if (/^(nvram:startup-config|nvram:|startup-config)$/i.test(ref)) return lireStartup();
      return s.readArchivedConfig(ref) ?? lireFichier(ref);
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
    const tous = s.listConfigLog();
    const mots = args.map((a) => a.toLowerCase());

    // `statistics` compte la memoire du journal — la seule forme de la
    // commande qui ne liste aucune entree.
    if (mots[0] === 'statistics') {
      const octets = tous.reduce((n, r) => n + r.command.length + 40, 0);
      return 'Config Log Session Info:\n'
        + `   Number of sessions being tracked: ${new Set(tous.map((r) => r.session)).size}\n`
        + `   Memory being held: ${octets} bytes\n`
        + `   Total memory allocated for session tracking: ${octets} bytes\n`
        + '   Total memory freed from session tracking: 0 bytes\n'
        + '\nConfig Log log-queue Info:\n'
        + `   Number of entries in the log-queue: ${tous.length}\n`
        + `   Memory being held in the log-queue: ${octets} bytes\n`
        + `   Total memory allocated for log entries: ${octets} bytes\n`
        + '   Total memory freed from log entries: 0 bytes';
    }

    // Les suffixes de PRESENTATION, qui ne choisissent pas les entrees.
    // `provisioning` rend le journal sous la forme d'un fichier de
    // configuration : les commandes seules, sans les colonnes.
    let provisioning = false;
    let reste = [...mots];
    const bruts = [...args];
    const retirer = (i: number, n = 1) => { reste.splice(i, n); bruts.splice(i, n); };
    for (;;) {
      const i = reste.indexOf('provisioning');
      if (i < 0) break;
      provisioning = true; retirer(i);
    }
    for (;;) {
      const i = reste.indexOf('persistent');
      if (i < 0) break;
      retirer(i);
    }
    const iType = reste.indexOf('contenttype');
    if (iType >= 0) {
      const forme = reste[iType + 1];
      if (forme !== 'plaintext' && forme !== 'xml') {
        throw new CliInvalidInput({ token: bruts[iType + 1] ?? 'contenttype' });
      }
      retirer(iType, 2);
    }

    // La SELECTION. IOS n'a pas de mot `last` : ou bien `all`, ou bien
    // un numero d'enregistrement avec une borne de fin facultative, le
    // tout eventuellement restreint a un utilisateur et a une session.
    let choisis = tous;
    let i = 0;
    if (reste[i] === 'user') {
      const nom = bruts[i + 1];
      if (!nom) throw new CliIncomplete();
      choisis = choisis.filter((r) => r.user === nom);
      i += 2;
      if (reste[i] === 'session') {
        const n = reste[i + 1];
        if (!n || !/^\d+$/.test(n)) throw new CliInvalidInput({ token: bruts[i + 1] ?? 'session' });
        choisis = choisis.filter((r) => r.session === Number(n));
        i += 2;
      }
    }
    const premier = reste[i] ?? 'all';
    if (premier !== 'all') {
      if (!/^\d+$/.test(premier)) throw new CliInvalidInput({ token: bruts[i] });
      const debut = Number(premier);
      const finBrute = reste[i + 1];
      if (finBrute !== undefined && !/^\d+$/.test(finBrute)) {
        throw new CliInvalidInput({ token: bruts[i + 1] });
      }
      const fin = finBrute === undefined ? Number.MAX_SAFE_INTEGER : Number(finBrute);
      choisis = choisis.filter((r) => r.index >= debut && r.index <= fin);
      i += finBrute === undefined ? 1 : 2;
    } else {
      i += 1;
    }
    if (i < reste.length) throw new CliInvalidInput({ token: bruts[i] });

    if (provisioning) return choisis.map((r) => r.command).join('\n');
    return renderConfigLog(choisis);
  });
  /**
   * `configure replace <url> [force|list|time <n>]` — la VRAIE
   * restauration, celle que le chapitre oppose à `copy`.
   *
   * `copy <source> running-config` fusionne : ce que la courante porte
   * en trop y reste. `configure replace` calcule la différence puis
   * applique les ajouts ET les suppressions, si bien que la courante
   * finit exactement égale au fichier. La commande n'existait pas du
   * tout : la moitié restauration du tutoriel était injouable.
   *
   * Deux limites écrites plutôt que tues. (1) L'application passe par
   * la remise à zéro de l'état rejouable puis le rejeu du fichier, là
   * où IOS n'applique que le delta ; l'état FINAL est le même — c'est ce
   * que la commande promet — mais un vrai IOS perturbe moins ce qui n'a
   * pas changé. (2) `time <n>` arme sur IOS un retour arrière si la
   * session meurt avant confirmation ; ici la commande s'exécute
   * entièrement dans l'appel, donc rien ne peut mourir entre les deux :
   * le mot-clé est accepté et son effet annoncé, pas simulé.
   */
  trie.registerGreedy('configure replace', 'Replace the running configuration', (args) => {
    if (args.length === 0) throw new CliIncomplete();
    const { url, options, erreur } = parseConfigReplaceArgs(args);
    if (erreur) return erreur;

    const s = ar();
    const courant = runningConfig();
    let cible: string | null = null;
    if (/^(nvram:startup-config|nvram:|startup-config)$/i.test(url)) {
      cible = lireStartup();
      if (cible === null) return '%% Non-volatile configuration memory is not present';
    } else if (/^archive:/i.test(url)) {
      cible = s?.readArchivedConfig(url.replace(/^archive:/i, '')) ?? null;
    } else {
      cible = lireFichier(url);
    }
    if (cible === null) return `%Error opening ${url} (No such file or directory)`;

    const plan = replacePlan(courant, cible);
    if (options.list) {
      const lignes = ['!List of Commands:'];
      for (const l of plan.suppressions) lignes.push(`no ${l.trim()}`);
      for (const l of plan.ajouts) lignes.push(l);
      lignes.push('end');
      return lignes.join('\n');
    }

    const tete = options.force ? [] : [CONFIG_REPLACE_BANNER, ''];
    if (options.timeMinutes !== null) {
      tete.push(`A rollback will automatically be triggered in ${options.timeMinutes} `
        + `minute${options.timeMinutes === 1 ? '' : 's'} if the operation fails.`, '');
    }
    appliquer(cible);
    return [...tete, 'Total number of passes: 1', 'Rollback Done'].join('\n');
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

const ARCHIVE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  path: { name: 'chemin', type: 'WORD', description: 'Path for backups' },
  'time-period': {
    name: 'minutes', type: 'INT', range: [1, 525600],
    description: 'Period of time in minutes between archives',
  },
  maximum: {
    name: 'revisions', type: 'INT', range: [1, 14],
    description: 'Maximum number of backups to keep',
  },
};

const ARCHIVE_LOG_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'logging size': {
    name: 'entrees', type: 'INT', range: [1, 1000],
    description: 'Number of entries the log keeps',
  },
  'notify syslog contenttype': {
    name: 'format', type: 'ENUM', description: 'Format of the syslog notification',
    values: [
      { keyword: 'plaintext', description: 'Plain text notification' },
      { keyword: 'xml', description: 'XML notification' },
    ],
  },
};

export function archiveSubmodeSpecs(
  ar: ArchiveAccessor, enterLogMode: () => void,
): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildArchiveSubmodeOn(collector as unknown as CommandTrie, ar, enterLogMode),
    {
      modes: ['config-archive'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => ARCHIVE_ARGUMENTS[path],
    },
  );
}

export function archiveLogSubmodeSpecs(ar: ArchiveAccessor): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildArchiveLogSubmodeOn(collector as unknown as CommandTrie, ar),
    {
      modes: ['config-archive-log'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => ARCHIVE_LOG_ARGUMENTS[path],
    },
  );
}
