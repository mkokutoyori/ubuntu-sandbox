# Audit — RMAN

**Périmètre audité** : `src/terminal/subshells/rman/**` (architecture réactive en production, ~70 fichiers /
~5600 lignes), `src/database/oracle/views/v_rman_*.ts`, `src/adapters/OracleFilesystemSync.ts`,
`docs/DESIGN-RMAN.md` (obsolète), `docs/DESIGN-RMAN-REACTIVE.md` (design de production),
`src/__tests__/debug/rman/*.debug.test.ts` (4 suites, ~21 000 lignes de transcript générées),
`src/__tests__/unit/database/oracle-rman-*.test.ts`, `src/__tests__/unit/terminal/subshells/rman/`.

Référence de comparaison : Oracle Database 19c RMAN (comportement réel du client `rman`, codes
RMAN-NNNNN, formats `LIST`/`REPORT`/`SHOW ALL`).

Méthode : lecture du code source complet du sous-système RMAN, exécution des 9 fichiers de tests
(`npx vitest run src/__tests__/debug/rman/ src/__tests__/unit/database/oracle-rman-*.test.ts
src/__tests__/unit/database/oracle-shell-rman.test.ts src/__tests__/unit/terminal/subshells/rman/`
→ **19/19 tests passés**), lecture des transcripts générés dans `debug-output/rman/*.txt`
(~21 000 lignes de sortie RMAN simulée sur 4 scénarios : bases, politique incrémentale, PITR +
DUPLICATE, reprise après sinistre multi-site).

---

## Synthèse (tableau)

| Domaine | État | Sévérité max |
|---|---|---|
| Couverture syntaxique des commandes RMAN | Très large (BACKUP/RESTORE/RECOVER/LIST/REPORT/DELETE/CROSSCHECK/CONFIGURE/CATALOG/DUPLICATE/BLOCKRECOVER/scripts stockés) | — |
| Machine à états de session (garde-fous OPEN/MOUNT/NOMOUNT/SHUTDOWN) | Bonne, testée sur les 4 états | ⚠️ Mineur (RESTORE ne fait pas de distinction MOUNT vs contrôle plus fin) |
| Persistance du catalogue et de la config entre sessions | Bonne (fix explicite documenté du défaut DEF-RMAN-01) | — |
| Cohérence physique VFS ↔ catalogue (existence des pièces) | Bonne (le `rm` d'une pièce fait échouer un RESTORE ultérieur avec le bon code) | — |
| **Cohérence des tailles** (taille de la pièce VFS vs taille annoncée par `LIST BACKUP`) | **Incohérente** : la pièce physique fait ~30–50 octets quel que soit la taille annoncée (1.61G) | 🔴 CRITIQUE |
| **Réalisme incrémental** (LEVEL 1 plus petit que LEVEL 0) | **Absent** : taille et durée identiques quel que soit le niveau | 🔴 CRITIQUE |
| RECOVER sans archivelog disponible | **Ne échoue jamais** — RECOVER réussit toujours, aucune vérification RMAN-06054/08137 | 🟠 MAJEUR |
| RESTORE ... UNTIL SCN/TIME (PITR) | `SET UNTIL` est ignoré par `RESTORE`, seul `RECOVER` en tient compte | 🟠 MAJEUR |
| RESTORE CONTROLFILE FROM AUTOBACKUP | Toujours un succès simulé même si aucun autobackup n'a jamais été pris | 🟠 MAJEUR |
| CONFIGURE BACKUP OPTIMIZATION ON | Stocké et affiché dans SHOW ALL mais sans aucun effet sur `BACKUP DATABASE` | 🟠 MAJEUR |
| Formatage des erreurs (double préfixe de code) | Bug reproductible sur 2 chemins de code distincts | 🟡 MINEUR |
| Politique de rétention REDUNDANCY | Pool global toutes catégories confondues, pas de granularité par datafile/chaîne | 🟡 MINEUR |
| Réalisme des sorties (bannières, `Starting/Finished`, `channel ORA_DISK_1`, `piece handle=`) | Très bon, quasi-identique à un vrai transcript RMAN 19c | — |
| Architecture réactive documentée (DESIGN-RMAN-REACTIVE.md) vs implémentation | Fidèle — bus d'événements, opérateurs, séparation commande/moteur/catalogue conformes | — |
| Fonctionnalités avancées manquantes (Data Recovery Advisor, SBT réel, TSPITR, encryption réelle) | Absentes, en grande partie documentées comme hors périmètre | 💡 Info |

---

## Matrice de couverture des commandes RMAN

| Commande RMAN 19c | Supportée | Fidélité | Manques observés |
|---|---|---|---|
| `BACKUP DATABASE` [TAG/FORMAT/COMPRESSED/ENCRYPTED/MAXPIECESIZE/KEEP] | ✅ | Bonne (sorties très fidèles) | Taille toujours = somme des datafiles, ignore réellement COMPRESSED (pas de réduction de taille) |
| `BACKUP INCREMENTAL LEVEL 0/1 [CUMULATIVE]` | ✅ | Syntaxe complète | 🔴 Taille et durée identiques à un FULL — aucune notion de blocs changés |
| `BACKUP TABLESPACE` / `BACKUP DATAFILE` | ✅ | Bonne | — |
| `BACKUP ARCHIVELOG ALL [DELETE INPUT] [FROM SCN]` | ✅ | Bonne, `DELETE INPUT` supprime réellement les fichiers VFS | `FROM SCN` accepté syntaxiquement mais ne filtre rien réellement (tous les archivelogs sont pris) |
| `BACKUP CURRENT CONTROLFILE` / `BACKUP SPFILE` | ✅ | Bonne | — |
| `BACKUP AS COPY DATABASE/TABLESPACE/DATAFILE` | ✅ | Correcte (DATAFILECOPY dédié) | — |
| `BACKUP VALIDATE` / `VALIDATE DATABASE/TABLESPACE/DATAFILE/BACKUPSET` | ✅ | Bonne, pas d'écriture VFS (conforme) | — |
| `BACKUP NOT BACKED UP n TIMES` | ✅ | Correcte | — |
| `PLUS ARCHIVELOG` | ✅ | Correcte (déclenche un second job) | — |
| `RESTORE DATABASE/TABLESPACE/DATAFILE [FROM TAG][PREVIEW][VALIDATE]` | ✅ | Bonne pour le cas nominal | 🟠 Ignore `SET UNTIL` (pas de sélection du bon jeu de sauvegarde en PITR) |
| `RESTORE CONTROLFILE FROM AUTOBACKUP / FROM '<path>'` | ✅ | Sortie plausible | 🟠 Ne vérifie jamais qu'un autobackup existe réellement |
| `RESTORE SPFILE FROM AUTOBACKUP / TO` | ✅ | Sortie plausible | Même lacune que ci-dessus |
| `RECOVER DATABASE/TABLESPACE/DATAFILE` | ✅ | Bonne pour la mécanique d'état | 🟠 Réussit toujours même sans archivelog disponible |
| `RECOVER ... UNTIL SCN/TIME/CANCEL` | ✅ | Syntaxe complète | Manque `UNTIL SEQUENCE`; le SCN cible n'est pas réellement appliqué au choix des sauvegardes |
| `BLOCKRECOVER DATAFILE ... BLOCK ...` / `RECOVER COPY OF ...` | ✅ (alias) | Assumé comme stub documenté | Pas de suivi réel de corruption de blocs (`V$DATABASE_BLOCK_CORRUPTION` absent) |
| `LIST BACKUP` / `LIST BACKUP SUMMARY` | ✅ | Bon format tabulaire | Pas de `LIST BACKUP OF DATABASE/TABLESPACE/DATAFILE`, pas de `BY BACKUP`/`BY FILE` |
| `LIST ARCHIVELOG ALL` / `LIST COPY` / `LIST EXPIRED BACKUP` / `LIST OBSOLETE` | ✅ | Bonne | — |
| `LIST INCARNATION [OF DATABASE]` | ✅ | Plausible mais figée (2 lignes statiques indépendantes du vécu réel de la base) | — |
| `REPORT SCHEMA` | ✅ | Bonne pour les datafiles réels | Bloc "Temporary Files" toujours codé en dur |
| `REPORT NEED BACKUP` / `REPORT OBSOLETE` / `REPORT UNRECOVERABLE` | ✅ | Correcte pour NEED BACKUP/OBSOLETE | UNRECOVERABLE toujours vide (pas de suivi NOLOGGING, documenté) |
| `CROSSCHECK BACKUP` / `CROSSCHECK ARCHIVELOG ALL` | ✅ | Vérifie réellement le VFS | — |
| `DELETE EXPIRED/OBSOLETE/BACKUP TAG/BACKUPSET/ARCHIVELOG` | ✅ | Bonne, supprime réellement catalogue + VFS | — |
| `CHANGE BACKUPSET AVAILABLE/UNAVAILABLE` / `CHANGE BACKUP TAG ... DELETE` | ✅ | Correcte | — |
| `CONFIGURE RETENTION POLICY` (REDUNDANCY/RECOVERY WINDOW/NONE) | ✅ | Persisté et appliqué par `REPORT OBSOLETE`/`DELETE OBSOLETE` | Granularité globale, pas par chaîne de sauvegarde (voir constat) |
| `CONFIGURE CONTROLFILE AUTOBACKUP [FORMAT]` | ✅ | Réellement appliqué (autobackup se déclenche) | — |
| `CONFIGURE DEVICE TYPE ... PARALLELISM` / `CONFIGURE CHANNEL ... FORMAT` | ✅ | Persisté, `ChannelPool` respecte le parallélisme | — |
| `CONFIGURE BACKUP OPTIMIZATION ON/OFF` | ✅ (affichage) | ❌ fonctionnelle | 🟠 Sans effet sur `BACKUP DATABASE` |
| `CONFIGURE ENCRYPTION / COMPRESSION / MAXSETSIZE / EXCLUDE / ARCHIVELOG DELETION POLICY` | ✅ | Persisté et affiché | Chiffrement/compression n'affectent jamais la taille simulée |
| `SHOW ALL` / `SHOW RETENTION POLICY` / `SHOW CHANNEL` / etc. | ✅ | Très bonne, dynamique (pas figée) | Manque `CONFIGURE SNAPSHOT CONTROLFILE NAME`, pas de suffixe `# default` systématique |
| `ALLOCATE CHANNEL` / `RELEASE CHANNEL` (dans `RUN{}`) | ✅ | Bonne | — |
| `RUN { ... }` multi-instructions, `SET NEWNAME`, `SET UNTIL` | ✅ | Bonne mécanique de bloc | `SET UNTIL` non consommé par RESTORE (cf. supra) |
| `CATALOG DATAFILECOPY` / `CATALOG BACKUPPIECE` | ✅ | Vérifie l'existence VFS | — |
| `DUPLICATE DATABASE TO` (+ options avancées) | ✅ (syntaxe large) | Fonctionnellement plate | Toutes les clauses avancées (`UNTIL`, `FOR STANDBY`, `SKIP TABLESPACE`, `NOFILENAMECHECK`, `SPFILE PARAMETER_VALUE_CONVERT`) sont acceptées mais **ignorées** — le clone est toujours identique |
| `CREATE CATALOG` / `REGISTER DATABASE` / `CONNECT CATALOG` / `RESYNC CATALOG` | ✅ (no-op) | Messages plausibles | Aucun second catalogue réel — assumé et documenté |
| `ALTER DATABASE OPEN RESETLOGS` | ✅ | Message plausible | N'interagit pas avec l'état réel de l'instance (accepté même hors contexte restore) |
| `LIST FAILURE` / `ADVISE FAILURE` / `REPAIR FAILURE` (Data Recovery Advisor) | ❌ | — | Absent |
| `DUPLEX` / `SBT`/tape réel / médiathèque | ⚠️ partiel | SBT accepté en surface (`ALLOCATE CHANNEL ... DEVICE TYPE SBT`) mais écrit sur le même VFS que DISK | Pas de différenciation fonctionnelle DISK/SBT |
| `TSPITR` (`RECOVER TABLESPACE ... UNTIL ... AUXILIARY DESTINATION`) | ❌ | — | Absent |
| Chiffrement réel des sauvegardes | ❌ (marqueur textuel seulement) | — | Documenté hors périmètre dans DESIGN-RMAN.md §1.4 |

Légende fidélité : ✅ correcte / ⚠️ partielle / ❌ absente.

---

## Constats détaillés

### 🔴 [CRITIQUE] Taille physique de la pièce VFS incohérente avec le catalogue RMAN

- `src/terminal/subshells/rman/job/RmanJobEngine.ts:243` : `this._ctx.vfs.writeFile(path, new Uint8Array(0))`
  — le buffer écrit est **toujours vide**, quelle que soit la taille `size` calculée juste avant (ligne 246-248,
  qui peut être `1.61G`).
- `src/terminal/subshells/rman/integration/LinuxRmanContext.ts:116-123` : le contenu réellement écrit sur le VFS
  est la chaîne littérale `` `[ORACLE RMAN BACKUP PIECE - ${_data.length} bytes]` `` — comme `_data.length` est
  toujours `0`, chaque pièce s'écrit comme `[ORACLE RMAN BACKUP PIECE - 0 bytes]` (37 octets).
- `src/network/devices/linux/VirtualFileSystem.ts:591` : `inode.size = inode.content.length` — la taille que
  `ls -l`/`find -size` verront est donc la longueur de cette chaîne (~37 octets), **jamais** la taille annoncée
  par `LIST BACKUP` (qui peut afficher `1.61G`).
- Conséquence directe pour la mission d'audit : la réponse à *"les backup pieces créés par RMAN existent-ils
  réellement comme fichiers dans le filesystem simulé, avec des tailles cohérentes ?"* est : **le fichier
  existe** (bon point, testé et vérifié par `oracle-rman-backup-piece-coherence.test.ts`), **mais sa taille sur
  le VFS ne correspond à rien de réaliste** — un `du -sh /u01/backup` sur le device donnerait quelques centaines
  d'octets pour des téraoctets de sauvegardes annoncées par RMAN. Un audit physique (`du`/`df`) contredirait
  systématiquement le catalogue RMAN.
- Recommandation : soit écrire un buffer dont la longueur reflète (même à l'échelle, ex. `Math.min(size, cap)`)
  la taille logique, soit — plus réaliste en mémoire — stocker une métadonnée de taille "déclarée" séparée du
  contenu physique dans l'inode VFS et faire en sorte que RMAN s'appuie dessus pour `ls`.

### 🔴 [CRITIQUE] Aucune différence physique entre BACKUP INCREMENTAL LEVEL 0 et LEVEL 1

- `src/terminal/subshells/rman/job/RmanJobEngine.ts:148-152` : `totalSize` est calculé comme la somme brute des
  `sizeBytes` de tous les datafiles ciblés, **indépendamment de `incLevel`** (0, 1, ou `undefined` pour un FULL).
  Le paramètre `cumulative` (LEVEL 1 CUMULATIVE) n'intervient nulle part dans ce calcul.
- Preuve dans les transcripts réels (`debug-output/rman/rman-incremental-policy_results_debug.txt` lignes
  149, 1003, 1031, 1092… ) : **chaque** `LIST BACKUP`, qu'il s'agisse d'un `Incr-0` ou d'un `Incr-1`, affiche
  exactement `1.61G` — semaine entière de sauvegardes L0/L1/L1-CUM sans la moindre variation de taille.
- Durée elle aussi figée : `src/terminal/subshells/rman/ReactiveRmanSubShell.ts:176` imprime
  `'channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15'` en dur pour **tout** backup, quelle que
  soit sa taille logique — il n'existe d'ailleurs plus, dans le code réel, de fonction
  `simulateBackupSeconds()` (celle-ci n'existait que dans le design obsolète `DESIGN-RMAN.md §3.6` et n'a pas
  été portée dans `core/pureUtils.ts`, qui ne contient que `formatElapsed`/`formatSize`/`generatePieceName`/
  `formatOracleDate`).
- Impact : la scénarisation "L0 lundi (baseline) → L1 quotidien" — pourtant très soigneusement mise en scène
  dans `rman-incremental-policy.debug.test.ts` (204 commandes, semaine complète) — **ne démontre jamais** le
  bénéfice réel de l'incrémental (taille réduite), ce qui est pourtant l'intérêt pédagogique numéro un de la
  fonctionnalité RMAN LEVEL 1. Un DBA en formation observerait un comportement trompeur.
- Recommandation : dériver `totalSize` pour LEVEL 1 d'une fraction du FULL (ex. modèle simple : 5-15 % du
  volume total par défaut, éventuellement paramétrable en fonction d'un compteur "changements simulés depuis le
  dernier LEVEL 0/1"), et faire varier `elapsed time` en conséquence via une fonction proportionnelle à la
  taille (le principe existait déjà dans le design obsolète, à réintroduire).

### 🟠 [MAJEUR] RECOVER DATABASE réussit toujours, même sans archivelog disponible

- `src/terminal/subshells/rman/job/RmanJobEngine.ts:397-457` (`_doRecover`) : la seule garde est sur l'état de
  l'instance (SHUTDOWN/NOMOUNT rejeté, ligne 399). Il n'existe **aucune vérification** que les archivelogs requis
  entre le SCN de checkpoint du backup restauré et le SCN cible sont présents. La boucle
  `arcPaths.forEach(...)` (lignes 443-455) se contente d'émettre un événement `ARCHIVELOG_APPLIED` par archivelog
  trouvé sur le VFS — si `arcPaths` est vide, la boucle ne s'exécute simplement pas, et `RECOVER_COMPLETED` est
  quand même émis à la ligne 456.
- Aucune des erreurs canoniques Oracle (`RMAN-06054: media recovery requesting unknown archived log for
  thread N with sequence N`, `RMAN-06025`, `ORA-00279`/`ORA-00289`) n'est implémentée nulle part dans
  `src/terminal/subshells/rman/core/RmanError.ts` — le type `RmanError` (lignes 10-36) ne référence même pas ces
  codes.
- Réponse factuelle à la question de mission *"un recover sans les archives échoue-t-il correctement ?"* :
  **non**. C'est une lacune fonctionnelle centrale de RMAN (le couple RESTORE+RECOVER est justement construit
  autour de la nécessité des archivelogs pour rattraper le SCN courant).
- Recommandation : faire échouer `_doRecover` avec un nouveau code (`RMAN_06054` par ex.) quand la plage de SCN
  requise pour rattraper la base n'est pas entièrement couverte par les archivelogs du catalogue/VFS.

### 🟠 [MAJEUR] RESTORE ignore SET UNTIL SCN/TIME — pas de vraie sélection PITR du backup set

- `src/terminal/subshells/rman/commands/RestoreCommand.ts:22-49` : le contexte `RmanCommandContext` transporte
  `setUntil` (défini dans `commands/types.ts:30`), mais `RestoreCommand.execute()` ne le lit **jamais** — seules
  les clauses `FROM TAG`, `PREVIEW`, `VALIDATE` sont extraites de `trailing`.
- Côté moteur, `RmanJobEngine._doRestore()` (lignes 291-344) ne filtre les `BackupSet` que par `tag`
  (`params.tag`) — il n'y a nulle part de filtre `ckpScn <= untilScn` équivalent à
  `IRmanCatalogRepository.findBackupSetsForScn()` évoqué dans le design (`DESIGN-RMAN.md §4.3`, jamais porté
  côté réactif : `InMemoryRmanCatalog.ts` actuel n'a pas de méthode de ce nom, cf. section écarts ci-dessous).
- Conséquence observée dans `rman-pitr-duplicate.debug.test.ts` (section 3.4, "SET UNTIL inside RUN") : les 5
  scénarios `RUN { SET UNTIL ... ; RESTORE DATABASE; RECOVER DATABASE; }` avec des cibles temporelles
  radicalement différentes (`2026-12-31`, SCN `1800000`, SCN `1900000`, `2025-06-01`) produisent tous
  strictement la même séquence de restauration (tous les jeux de sauvegarde disponibles, sans discrimination) —
  seul `RECOVER` référence effectivement le SCN cible dans son message de progression.
- Recommandation : propager `setUntil` jusqu'à `RestoreCommand`/`JobBuilder.restoreDatabase`, et filtrer les
  `BackupSet` par `ckpScn <= untilScn` (ou `completionTime <= untilTime`) avant restauration, en échouant avec
  `RMAN_06023`/`RMAN-06026` si aucun jeu ne convient.

### 🟠 [MAJEUR] RESTORE CONTROLFILE FROM AUTOBACKUP réussit sans qu'un autobackup ait jamais existé

- `src/terminal/subshells/rman/commands/RestoreSystemCommands.ts:35-49` : le cas `CONTROLFILE_AUTOBACKUP`
  retourne systématiquement une sortie de succès câblée en dur (`'channel ORA_DISK_1: AUTOBACKUP found: ...'`)
  sans interroger `catalog` pour vérifier qu'un backup set de type `CONTROLFILE` avec tag `AUTOBACKUP` existe
  réellement (le paramètre `catalog` n'est même pas dans la signature `execute(args, { ctx })`).
  Un vrai RMAN échouerait avec `RMAN-06172: no autobackup found or specified handle is not a valid copy of the
  controlfile` s'il n'y a pas de pièce correspondante.
- Impact pour le scénario "perte totale du controlfile" (point 2 de la mission) : le simulateur ne peut pas
  démontrer l'échec attendu si l'opérateur n'a jamais configuré `CONTROLFILE AUTOBACKUP ON` ni pris de backup —
  la commande donne systématiquement une fausse impression de succès.
- Recommandation : consulter le catalogue (via `cmdCtx.catalog`) pour un `BackupSet` de type `CONTROLFILE` /
  tag `AUTOBACKUP`, et retourner `RMAN_06004` (mappé sur un futur `RMAN-06172`) sinon.

### 🟠 [MAJEUR] CONFIGURE BACKUP OPTIMIZATION ON n'a aucun effet fonctionnel

- `src/terminal/subshells/rman/session/RmanConfig.ts:57,114-116` : la valeur est stockée et affichée dans
  `SHOW ALL` (`src/terminal/subshells/rman/commands/ShowCommand.ts:55`).
- Recherche exhaustive (`grep -rn backupOptimization`) : **aucune** référence en dehors de `RmanConfig.ts` et
  `ShowCommand.ts` — ni `BackupCommand.ts` ni `RmanJobEngine._doBackup()` ne la consultent. Seule la clause
  syntaxique explicite `BACKUP NOT BACKED UP n TIMES DATABASE` implémente une logique de saut de fichiers déjà
  couverts (`RmanJobEngine.ts:170-182`).
- Un vrai `CONFIGURE BACKUP OPTIMIZATION ON` change le comportement de **tout** `BACKUP DATABASE`/`BACKUP
  ARCHIVELOG` ultérieur (saut des fichiers identiques déjà sauvegardés) — ici la commande est acceptée,
  affichée, mais silencieusement sans effet, ce qui est trompeur puisqu'elle ne produit aucune erreur.
- Recommandation : appliquer la même logique que `notBackedUpNTimes` (avec seuil 1) quand
  `cmdCtx.config.snapshot().backupOptimization === true` et qu'aucun changement de contenu n'est simulé.

### 🟡 [MINEUR] Double préfixe de code d'erreur RMAN (bug reproductible, deux occurrences)

- **Occurrence 1** — `src/terminal/subshells/rman/ReactiveRmanSubShell.ts:212` :
  `` this._push(`RMAN-03014: ${rmanErrorMessage(e.error)}`) `` — pour **toute** erreur de job asynchrone
  (`JOB_FAILED`), le code générique `RMAN-03014` (à l'origine réservé à `JOB_CANCELLED` dans
  `core/RmanError.ts:58`) est préfixé devant le code réel déjà rendu par `rmanErrorMessage()`. Résultat observé
  dans `debug-output/rman/rman-pitr-duplicate-phase1_results_debug.txt:134` :
  `RMAN-03014: RMAN-06403: database must be mounted (not open)` — deux codes RMAN concaténés sur une seule
  ligne, ce qu'aucun vrai client RMAN ne produit (il empile les codes sur des lignes séparées :
  `RMAN-03002: failure of restore command at ...` puis `RMAN-06403: ...`).
  Notez l'incohérence interne au fichier : la méthode sœur `_formatRmanError()` (ligne 237-254, utilisée pour
  les erreurs de commande synchrones) ne fait, elle, **pas** cette erreur — elle appelle
  `rmanErrorMessage(e)` sans préfixe superflu (ligne 252). D'où la divergence visible entre par exemple
  `rman-wan-disaster-recovery_results_debug.txt:50` (`RMAN-03002: target database is not connected`, correct,
  chemin synchrone) et `rman-pitr-duplicate-phase1_results_debug.txt:134` (chemin job asynchrone, buggé).
- **Occurrence 2 (pattern différent)** — `src/terminal/subshells/rman/commands/CatalogCommand.ts:34` :
  `` err({ code: 'RMAN_06004', message: \`RMAN-06004: backup piece not found: ${path}\` }) `` — le message
  embarque déjà le préfixe `RMAN-06004:`, qui est ensuite re-préfixé par `rmanErrorMessage()`. Résultat observé
  (`debug-output/rman/rman-basics_results_debug.txt:4444`) :
  `RMAN-06004: RMAN-06004: backup piece not found: /missing/file.bkp`. Même défaut dupliqué dans
  `src/terminal/subshells/rman/commands/ValidateCommand.ts:57`.
- Impact : cosmétique mais immédiatement repérable par tout DBA lisant la sortie — casse la crédibilité du
  transcript sur les chemins d'erreur, qui sont pourtant la partie la plus scrutée d'un audit RMAN.
- Recommandation : (a) dans `ReactiveRmanSubShell.ts:212`, retirer le préfixe `RMAN-03014:` codé en dur et
  utiliser directement `rmanErrorMessage(e.error)` comme le fait déjà `_formatRmanError`, avec un
  `RMAN-03002: failure of <verb> command at <date>` généré dynamiquement en tête de pile plutôt qu'un code fixe
  hors-sujet ; (b) dans `CatalogCommand.ts:34` et `ValidateCommand.ts:57`, retirer le préfixe `RMAN-06004:` du
  texte du `message` (le code est déjà porté par le champ `code`).

### 🟡 [MINEUR] Politique REDUNDANCY appliquée globalement, pas par chaîne de sauvegarde

- `src/terminal/subshells/rman/policy/RedundancyPolicy.ts:22-25` : `findObsolete()` trie **tous** les
  `BackupSet` (FULL, INCREMENTAL_0, INCREMENTAL_1, ARCHIVELOG, CONTROLFILE confondus) par date de complétion et
  considère obsolète tout ce qui dépasse le rang N — sans distinguer par type d'objet ni par datafile.
- Le vrai RMAN calcule la redondance par **chaîne de restauration indépendante** (un backup FULL/L0 + ses L1
  dépendants forment une unité ; les backups de controlfile/archivelog suivent des règles de rétention propres,
  et un archivelog n'est jamais rendu obsolète tant qu'il est nécessaire à la récupération d'un backup encore
  dans la fenêtre). Ici, un `AUTOBACKUP` de controlfile peut rendre "obsolète" un backup de données plus
  ancien mais encore utile, ou l'inverse.
- Impact concret visible dans les transcripts : sur `rman-basics_results_debug.txt`, chaque `BACKUP DATABASE`
  génère systématiquement 2 entrées catalogue (le backup + son AUTOBACKUP controlfile) mélangées dans le même
  pool de rétention — avec `REDUNDANCY 1`, cela ferait déclarer obsolète la moitié des paires sans lien réel
  avec la récupérabilité des données.
- Recommandation : séparer le calcul d'obsolescence par `backupObject` (DATABASE/TABLESPACE/DATAFILE d'un
  côté, CONTROLFILE de l'autre, ARCHIVELOG à part avec sa propre politique de suppression) avant application de
  `RedundancyPolicy`/`RecoveryWindowPolicy`.

### 🟡 [MINEUR] MAXPIECESIZE modélisé comme N backup sets distincts, pas 1 set à N pièces

- `src/terminal/subshells/rman/job/RmanJobEngine.ts:235-265` : le commentaire l'assume explicitement
  (« Each piece is its own BackupSet/BackupPiece in the catalog »). Un vrai RMAN avec `MAXPIECESIZE` découpe
  **un seul** backup set logique en plusieurs `BackupPiece` physiques, visibles sous une **unique** `BS Key`
  dans `LIST BACKUP`. Ici, chaque pièce reçoit sa propre `BS Key`.
- Conséquence secondaire : `ListBackupCommand._summary()` (`ListBackupCommand.ts:109`) affiche `#Pieces`
  toujours codé en dur à `1` — même incohérence pour tout backup dont le `BackupSet` aurait plusieurs pièces.
- Sévérité mineure : la fonctionnalité `MAXPIECESIZE` reste démontrable (le fractionnement a bien lieu), mais
  le comptage `BS Key`/`#Pieces` affiché diverge de la structure réelle du catalogue Oracle.

### ⚠️ Sorties non paramétrées par la taille réelle (élargit le constat CRITIQUE ci-dessus)

- `ReactiveRmanSubShell.ts:176,184,197` : `elapsed time: 00:00:15` (backup), `00:00:25` (restore),
  `00:00:03` (recover) sont des constantes textuelles, indépendantes de `job.params`/taille/nombre de
  datafiles. Le champ `RmanEvent.JOB_COMPLETED.elapsedMs` (calculé correctement via `Date.now() - start` dans
  `RmanJobEngine.ts:85`) n'est **jamais utilisé** pour l'affichage — il est calculé puis jeté. Occasion facile
  de corriger le point CRITIQUE "durée figée" en réutilisant cette valeur déjà disponible.

### 💡 Bonnes pratiques observées (à noter positivement)

- **Machine à états correctement gardée** : `RmanJobEngine._doRestore`/`_doRecover`/`RestoreSystemCommand`
  refusent explicitement `RESTORE`/`RECOVER CONTROLFILE` quand l'instance est `OPEN`, avec le bon code
  `RMAN_06403` et le bon message (« database must be mounted (not open) ») — testé bout-en-bout dans
  `rman-pitr-duplicate.debug.test.ts` sur les 4 états du cycle de vie Oracle (OPEN→SHUTDOWN→MOUNT→OPEN), y
  compris la reconnexion RMAN après un crash externe simulé (`db.instance.shutdown('IMMEDIATE')` déclenché
  hors session).
- **Persistance catalogue/config par device** (`DeviceCatalogRegistry.ts`, `DeviceConfigRegistry.ts`) : fix
  explicite et documenté du défaut historique DEF-RMAN-01 (« chaque session repart de zéro ») — le
  commentaire de tête du fichier explique précisément le problème résolu et pourquoi. C'est le genre de note
  d'intention qu'on voudrait voir partout dans une base de code legacy.
- **Cohérence RESTORE ↔ existence physique des pièces** : `oracle-rman-backup-piece-coherence.test.ts` prouve
  que `rm` d'une pièce de backup fait échouer un `RESTORE` ultérieur avec `RMAN-06023`/`06026`, et que le
  fichier réellement absent du VFS empêche l'`ALTER DATABASE OPEN` de réussir ensuite — chaîne causale complète
  testée VFS → RMAN → SQL*Plus.
- **CONFIGURE réellement stateful** (`ConfigureCommand.ts`, `RmanConfig.ts`) : contrairement au défaut DEF-RMAN-02
  documenté dans le design obsolète (« SHOW ALL retourne des strings hardcodées »), l'implémentation actuelle
  fait bien muter un état vivant consulté par `SHOW ALL`/`REPORT OBSOLETE`/`DELETE OBSOLETE`/l'autobackup — testé
  sur ~30 variantes de `CONFIGURE` dans `rman-basics.debug.test.ts`.
- **Scénarios multi-sites et multi-sessions très soignés** : `rman-multi-server-lan.debug.test.ts` et
  `rman-wan-disaster-recovery.debug.test.ts` orchestrent 4 rôles RMAN distincts (`@prim`/`@rcat`/`@dr`/
  `@witness`) sur des `LinuxServer` séparés, avec un vrai scénario "primaire mort → bascule DR → nouveau
  primaire" où `CONNECT TARGET` échoue correctement (`RMAN-04014: Oracle instance is not started`) tant que
  l'ancien primaire n'a pas redémarré. C'est un niveau de mise en scène rarement atteint dans un simulateur.
- **Architecture réactive fidèle au design documenté** : `RmanEventBus` (bus + streams typés `jobStarted$`,
  `progress$`, `jobCompleted$`, `jobFailed$`, `channelAllocated$`, `catalogUpdated$`, etc.) reproduit
  quasi littéralement le schéma de `DESIGN-RMAN-REACTIVE.md §1.2/§4` ; séparation nette
  Command → JobEngine → ChannelPool/Catalog respectée ; `Result<T,E>` sans exception utilisé de bout en bout.
- **Formats de sortie très proches d'un vrai RMAN 19c** : bannière (`Recovery Manager: Release 19.0.0.0.0 -
  Production on ...`), `Starting backup at ...`/`Finished backup at ...`, `allocated channel: ORA_DISK_1`,
  `channel ORA_DISK_1: SID=NNN device type=DISK`, `piece handle=... tag=...`, table `LIST BACKUP SUMMARY`
  avec les bonnes colonnes (`Key TY LV S Device Type Completion Time #Pieces #Copies Compressed Tag`) — un DBA
  lisant un transcript nominal (hors chemins d'erreur) aurait du mal à la distinguer d'un vrai log.

---

## Écarts design documenté ↔ implémentation

`docs/DESIGN-RMAN.md` est explicitement marqué **obsolète** en tête de fichier (« L'implémentation en
production est l'architecture réactive décrite dans DESIGN-RMAN-REACTIVE.md ») — c'est une bonne pratique de
documentation qui évite la confusion, et l'analyse ci-dessous porte donc sur `DESIGN-RMAN-REACTIVE.md` comme
référence.

| Élément documenté (DESIGN-RMAN-REACTIVE.md) | Statut dans le code réel |
|---|---|
| Arborescence `src/terminal/subshells/rman/{core,values,reactive,catalog,channel,job,policy,commands,session,integration}/` (§1.3) | ✅ Respectée quasi à l'identique — mêmes noms de dossiers et de fichiers principaux |
| `RmanEventBus` avec streams typés (`jobStarted$`, `progress$`, `channelAllocated$`, `catalogUpdated$`, etc.) (§4) | ✅ Implémenté fidèlement dans `reactive/RmanEventBus.ts` |
| `RmanSubject`/opérateurs (`ofType`, `filter`, `map`) (§4) | ✅ Présents (`reactive/RmanSubject.ts`, `reactive/operators.ts`, `reactive/aggregations.ts`) |
| `IRmanCatalogRepository` avec `findBackupSetsForScn(targetScn)` pour la sélection PITR (dérivé de §4.3/§7 du design v1, repris implicitement par le design réactif) | ❌ Absent de `catalog/IRmanCatalogRepository.ts` réel — aucune méthode de sélection par SCN ; explique directement le constat MAJEUR "RESTORE ignore SET UNTIL" ci-dessus |
| `IRetentionPolicy` (Strategy) — Redundancy / RecoveryWindow / None (§6 design v1, repris) | ✅ Implémenté (`policy/RedundancyPolicy.ts`, `RecoveryWindowPolicy.ts`, `NonePolicy.ts`) mais sans la granularité par objet évoquée implicitement par le modèle `BackupSet` documenté (constat MINEUR ci-dessus) |
| `ChannelPool` / allocation réactive avec `CHANNEL_ALLOCATED`/`CHANNEL_RELEASED` (§6) | ✅ `channel/ReactiveChannelPool.ts` conforme |
| `Job Execution Engine — pipeline réactif` (§7) | ✅ `job/RmanJobEngine.ts` suit le cycle documenté (JOB_STARTED → allocation → steps → opération → JOB_COMPLETED/FAILED) |
| Extension "commande = nouvelle classe + enregistrement dispatcher" (Open/Closed, hérité du design v1 §7) | ✅ Respecté — `RmanCommandDispatcher.ts` reste une simple table de correspondance regex → commande, ~60 entrées, aucune commande ne nécessite de modifier le dispatcher existant |
| `DUPLICATE DATABASE TO standby via réseau` — explicitement "hors périmètre simulateur" (DESIGN-RMAN.md §1.4, repris tel quel) | ✅ Cohérent : `DuplicateCommand.ts` n'implémente que le cas local, comme annoncé |
| `Recovery Catalog sur base séparée` — explicitement "catalog en mémoire uniquement" (§1.4) | ✅ Cohérent : `RecoveryCatalogCommands.ts` documente lui-même en tête de fichier que ce sont des no-ops assumés |
| Erreurs typées `Result<T, RmanError>` sans exception (fondation §2) | ✅ Respecté de bout en bout — aucun `throw` trouvé dans le chemin métier des commandes |
| Persistance catalogue/config entre sessions | ⚠️ Non explicitement documentée dans DESIGN-RMAN-REACTIVE.md (le design suppose une session/un catalogue), mais l'implémentation réelle va **au-delà** du design via `DeviceCatalogRegistry`/`DeviceConfigRegistry` pour corriger DEF-RMAN-01 — évolution positive non rétro-documentée |

**Conclusion sur l'écart design/implémentation** : contrairement à beaucoup de projets où le design diverge
rapidement du code, ici la fidélité est réellement bonne pour la structure et les patterns. Le principal écart
substantiel concerne la sélection des sauvegardes par SCN pour le PITR (`findBackupSetsForScn` documenté dans le
design v1 mais jamais porté côté réactif), qui est aussi le principal manque fonctionnel identifié dans les
constats détaillés.

---

## Top 10 des actions recommandées

1. **[CRITIQUE]** Faire correspondre la taille physique de la pièce VFS à la taille annoncée par le catalogue
   (`RmanJobEngine.ts:243`, `LinuxRmanContext.ts:118`) — actuellement `ls`/`du` contredisent systématiquement
   `LIST BACKUP`.
2. **[CRITIQUE]** Différencier réellement la taille (et la durée) d'un `BACKUP INCREMENTAL LEVEL 1` par rapport
   à un `LEVEL 0` (`RmanJobEngine.ts:148-152`) — réintroduire une notion de "volume de blocs changés" même
   simplifiée.
3. **[MAJEUR]** Faire échouer `RECOVER DATABASE` quand les archivelogs nécessaires ne sont pas tous présents
   (`RmanJobEngine._doRecover`, `core/RmanError.ts`) — ajouter le code `RMAN-06054`.
4. **[MAJEUR]** Propager `SET UNTIL SCN/TIME` jusqu'à `RestoreCommand`/`RmanJobEngine._doRestore` et filtrer
   les `BackupSet` candidats par `ckpScn`/`completionTime` avant restauration.
5. **[MAJEUR]** Faire vérifier au catalogue l'existence réelle d'un backup `CONTROLFILE`/`AUTOBACKUP` avant de
   déclarer un succès dans `RESTORE CONTROLFILE FROM AUTOBACKUP` (`RestoreSystemCommands.ts:35-49`).
6. **[MAJEUR]** Implémenter un effet réel pour `CONFIGURE BACKUP OPTIMIZATION ON` sur `BACKUP DATABASE`
   standard (réutiliser la logique déjà écrite pour `NOT BACKED UP n TIMES`).
7. **[MINEUR]** Corriger le double préfixe de code d'erreur : retirer `RMAN-03014:` en dur dans
   `ReactiveRmanSubShell.ts:212`, et retirer le préfixe dupliqué dans les messages de
   `CatalogCommand.ts:34`/`ValidateCommand.ts:57`.
8. **[MINEUR]** Réutiliser `elapsedMs` (déjà calculé dans `RmanJobEngine.ts:85` mais jeté) pour afficher une
   durée `elapsed time` variable au lieu des constantes `00:00:15`/`00:00:25`/`00:00:03`.
9. **[MINEUR]** Séparer le calcul d'obsolescence par type d'objet dans `RedundancyPolicy`/
   `RecoveryWindowPolicy` (DATABASE/TABLESPACE/DATAFILE vs CONTROLFILE vs ARCHIVELOG) plutôt qu'un pool global.
10. **[INFO/💡]** Si le budget le permet : ajouter un stub minimal de Data Recovery Advisor
    (`LIST FAILURE`/`ADVISE FAILURE`) et `LIST BACKUP OF DATABASE/TABLESPACE/DATAFILE` (actuellement seul
    `LIST BACKUP` générique existe) — ce sont les deux familles de commandes RMAN 19c les plus utilisées en
    production qui restent totalement absentes de la matrice de couverture.
