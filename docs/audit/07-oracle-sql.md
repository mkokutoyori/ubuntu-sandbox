# Audit — Simulation Oracle/SQL

**Périmètre audité** : `src/database/engine/**` (moteur SQL générique — lexer, parser AST,
executor, catalog, storage), `src/database/oracle/**` (~585 fichiers, ~62 000 lignes : OracleLexer/
Parser/Executor/Catalog/Storage/Database/Instance, `plsql/`, `transaction/`, `lock/`, `asm/`, `awr/`,
`dataguard/`, `flashback/`, `multitenant/`, `plan/`, `metadata/`, `packages/`, `commands/`, `actors/`,
`security/`, `views/` — 70+ vues V\$/DBA\_/ALL\_/USER\_ dans autant de fichiers dédiés),
`src/terminal/subshells/SqlPlusSubShell.ts`, `src/terminal/sql/`, `src/adapters/OracleFilesystemSync.ts`,
`src/adapters/OracleSystemdSync.ts`, `src/adapters/OracleListenerTcpSync.ts`,
`src/adapters/OracleAuditSyslogSync.ts`. RMAN (`src/terminal/subshells/rman/`) est **hors périmètre**
(couvert par `docs/audit/10-rman.md`) — il n'est mentionné ici que pour le contexte transactionnel/fichiers.

Référence de comparaison : Oracle Database **19c** (comportement réel `sqlplus`/`lsnrctl`, sémantique
SQL, codes ORA-, architecture instance).

Document de référence interne : `docs/BRD-Oracle-DBMS.md` (v1.2, daté 2026-06-12 — **antérieur d'environ
40 jours** au code actuel ; plusieurs statuts qu'il affiche comme ❌ sont en réalité implémentés
aujourd'hui, notamment le flashback query — voir plus bas).

**Méthode** : lecture profonde du code (executor 4282 lignes, catalog 1817 lignes, database 2277
lignes, instance 1291 lignes, PL/SQL interpreter 1420 lignes, etc.), lecture des tests existants,
et **exécution ponctuelle** de sondes vitest temporaires (créées puis supprimées, aucun fichier de
code n'a été modifié) pour vérifier expérimentalement : sémantique NULL/chaîne vide, format DATE par
défaut, cohérence de lecture inter-session, comportement de `ROLLBACK` avec deux sessions actives,
`FOR UPDATE`/`NOWAIT`, ORA-01476/ORA-01722. Suite complète `src/__tests__/unit/database/` exécutée :
**135 fichiers, 3088 tests, 100% passés** (`npx vitest run src/__tests__/unit/database/`). Scénarios
RAC exécutés séparément (voir §4).

---

## Synthèse

| Domaine | État | Sévérité max |
|---|---|---|
| SQL — SELECT (jointures, GROUP BY/HAVING, sous-requêtes corrélées, CTE, analytiques, CONNECT BY) | Très large, réellement exécuté (pas de canned rows) | — |
| Contraintes PK/FK/UNIQUE/CHECK/NOT NULL | Réellement appliquées, avec cascade ON DELETE, ORA- corrects | — |
| Sémantique NULL Oracle (chaîne vide = NULL, concaténation) | Correcte et vérifiée expérimentalement | — |
| **Format DATE par défaut en sortie SQL\*Plus** | **Bug confirmé** : affiche `2026-07-22 09:06:29` au lieu de `22-JUL-26` sur un `SELECT` brut d'une colonne DATE | 🟠 MAJEUR |
| Codes ORA- | 87 codes numériques distincts levés via `OracleError`, 151 chaînes `ORA-NNNNN` au total — dépasse les « 60+ » du BRD | — |
| Transactions — COMMIT/ROLLBACK/SAVEPOINT (session unique) | Réel, undo par snapshot, points de reprise nommés réutilisables | — |
| **Transactions — écrivains concurrents (2 sessions actives simultanément)** | **Corruption confirmée** : le `ROLLBACK` d'une session peut faire disparaître les lignes insérées par une autre session encore active, et un lecteur peut voir une valeur qui ne correspond à aucun état réel (ni avant ni après le rollback) | 🔴 CRITIQUE |
| `SELECT … FOR UPDATE` (NOWAIT / SKIP LOCKED) | Correct, lève ORA-00054 | — |
| `SELECT … FOR UPDATE` (sans NOWAIT, standard) | **Ne bloque jamais** — retourne immédiatement sans réellement empêcher un accès concurrent, contrairement à Oracle réel | 🟠 MAJEUR (limitation architecturale assumée) |
| Verrous de table (TM) | Posés *après coup* (event bus, une fois le DML déjà appliqué au stockage) — bookkeeping pour V\$LOCK, ne bloquent pas réellement un DML concurrent | 🟠 MAJEUR |
| Détection de deadlock ORA-00060 | Implémentée (cycle de wait-for graph) mais seulement exercée par le chemin `FOR UPDATE`/`LOCK TABLE`, pas par le DML ordinaire | 🟡 MINEUR |
| Niveaux d'isolation (`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`) | Accepté syntaxiquement, silencieusement ignoré (aucun ORA-08177) | 🟡 MINEUR (documenté par le BRD comme non fait) |
| Architecture instance (NOMOUNT→MOUNT→OPEN, processus d'arrière-plan, PMON/SMON/LGWR/DBWn/CKPT) | Solide, PID stables, sémantique fatal/non-fatal correcte | — |
| SGA/PGA | Tailles affichées cohérentes mais pas de vraie comptabilité mémoire (assumé par le BRD) | 💡 Info |
| Fichiers (control files, datafiles, redo, spfile) ↔ VFS Linux | Synchronisation **bidirectionnelle réelle** via adapters (Oracle→FS et FS/systemd→Oracle) | — |
| PL/SQL (blocs, procédures, fonctions, packages, curseurs, exceptions, transactions autonomes) | Interpréteur AST réel et profond, pas un stub | — |
| Multitenant CDB/PDB | **Façade** — aucune isolation de données par CON_ID, `ALTER SESSION SET CONTAINER` ne change qu'un label | 🟠 MAJEUR (documenté dans le code) |
| Data Guard | **Façade** — switchover = permutation de deux chaînes de rôle, pas de transport/apply réel | 🟡 MINEUR (hors ambition réaliste d'un simulateur navigateur) |
| Flashback (query AS OF, FLASHBACK TABLE, recycle bin) | **Réellement fonctionnel** sur un historique court (64 versions/table en mémoire) — plus avancé que ce que documente le BRD | — |
| ASM | Bookkeeping honnête (diskgroups/disks/files réels, vues alimentées dessus), sans matérialisation de fichiers réels sur les disques | 💡 Info |
| AWR | Alimenté par de vrais compteurs runtime (pas de données fabriquées), capture passive (pas d'auto-snapshot périodique) | — |
| RAC | **Non implémenté** — confirmé par l'échec de 6/7 et 11/12 tests des scénarios 07/08 (V\$CLUSTER_INTERCONNECTS absente, aucun wait event `gc *`, descripteur TAF non parsé → ORA-12154) | 🟠 MAJEUR (gap connu et documenté par la mission) |
| Accès réseau distant (`sqlplus user@//host:1521/service`) | **Traverse réellement le réseau simulé** (pile TCP, switch, listener lié à un vrai socket, ORA-12541/12514/12528 réalistes, `V$SESSION`/listener.log reflètent la machine cliente réelle) | — |
| Séparation `engine/` (générique) vs `oracle/` (spécifique) | Respectée en surface (héritage de classes), mais `engine/` est un squelette fin — la réutilisabilité multi-SGBD est non éprouvée (aucun second dialecte n'existe) | 💡 Info |
| Taille des fichiers / duplication | `OracleExecutor.ts` (4282 lignes), `OracleDatabase.ts` (2277), `OracleCatalog.ts` (1817), `BaseParser.ts` (2492) — objets-dieu, partiellement décomposés via des classes déléguées | 🟡 MINEUR |
| Tests | 135 fichiers / 3088 tests dans `unit/database`, 100% verts au moment de l'audit | — |

---

## Constats

### 1. Conformité SQL

**✅ Couverture SELECT large et réellement exécutée.** Jointures INNER/LEFT/RIGHT/FULL/CROSS,
sous-requêtes corrélées et non corrélées, `GROUP BY`/`HAVING` avec validation ORA-00979
(`OracleExecutor.ts:1186-1201`), `CONNECT BY`/`START WITH`/`PRIOR`/`LEVEL`
(`OracleExecutor.ts:1181-1183`), fonctions analytiques (`OVER`/`PARTITION BY`, `ROW_NUMBER`, `RANK`,
`LAG`/`LEAD`, frame `ROWS`/`RANGE BETWEEN` — `functions/windowFunctions.ts`), CTE (`WITH`), `MERGE`,
`FETCH FIRST`/`OFFSET`. Ce n'est pas un moteur à réponses préfabriquées : les jointures et
regroupements opèrent sur les lignes réelles du `OracleStorage`.

**✅ NULL vs chaîne vide — sémantique Oracle correcte et vérifiée expérimentalement.**
`src/database/engine/parser/BaseParser.ts:2022-2025` :
```ts
// Oracle treats empty string as NULL
if (val === '') {
  return { type: 'Literal', position: pos, dataType: 'null', value: null };
}
```
Sonde exécutée : `INSERT INTO t1 VALUES ('', NULL)` puis `SELECT a,b FROM t1` renvoie `[[null,null]]`,
`WHERE a IS NULL` matche la ligne, et `a || 'X'` renvoie `'X'` (la concaténation NULL est bien
l'identité). C'est le comportement Oracle réel, correctement reproduit — un piège classique des
simulateurs SQL naïfs (Postgres/SQL Server traitent `''` différemment) qui est ici bien géré.
⚠️ Remarque architecture : cette règle *spécifiquement Oracle* est codée dans le **parser générique**
(`engine/parser/BaseParser.ts`) plutôt que dans `OracleParser.ts` — fuite mineure de la séparation
dialecte-agnostique visée par le BRD §2.1 (💡, sans impact pratique tant qu'un seul dialecte existe).

**🟠 MAJEUR — Format DATE par défaut incorrect en sortie SQL\*Plus.** Un `SELECT` brut d'une colonne
`DATE` (sans `TO_CHAR`) doit afficher le format `NLS_DATE_FORMAT` par défaut d'Oracle 19c, soit
`DD-MON-RR` (ex. `22-JUL-26`). Reproduit en conditions réelles via `SQLPlusSession` :
```
SQL> SELECT d FROM t9;

D
-------------------
2026-07-22 09:06:29

1 row selected.
```
Cause : les valeurs `DATE` sont stockées comme des **chaînes** au format `YYYY-MM-DD HH:MM:SS`
(`src/database/oracle/functions/dateSupport.ts:19-22`, `formatDateValue`), pas comme des objets
`Date`. Or `QueryResultRenderer.renderValue` (`src/database/oracle/commands/QueryResultRenderer.ts:118-125`)
ne sait formater que les valeurs `instanceof Date` :
```ts
private renderValue(value: unknown, format: string | undefined, numeric: boolean): string {
  if (value === null || value === undefined) return this.settings.nullDisplay;
  if (value instanceof Date) return this.formatDate(value);   // jamais atteint pour une string
  ...
  return String(value);   // affiche la chaîne de stockage brute
}
```
Aucune conversion string→Date n'existe entre la lecture de la ligne (`OracleExecutor.ts:1216-1227`,
passthrough direct `row[col.colIndex]`) et le rendu. Le format explicite `TO_CHAR(d,'DD-MON-YYYY')`
fonctionne correctement (`formatDateWithPattern`), donc l'algorithme de formatage existe — seul le
chemin *implicite* (`SELECT date_col FROM t` sans conversion) est cassé. C'est un défaut de
conformité visible et fréquent (toute requête HR/SCOTT affichant `HIRE_DATE` sans `TO_CHAR` en sera
affectée), à corriger en priorité.

**✅ Contraintes réellement appliquées** (`src/database/oracle/constraints/ConstraintValidator.ts`) :
NOT NULL/PK → ORA-01400 (ligne 76), UNIQUE/PK dupliqué → ORA-00001 (ligne 90), FK parent absent →
ORA-02291 (ligne 97), FK enfant au DELETE → ORA-02292 (ligne 224) avec vrai `ON DELETE CASCADE`/
`SET NULL` (lignes 214-222), CHECK → ORA-02290 avec expression parsée et **mise en cache** par texte
(lignes 30-51, bonne optimisation — évite de relancer un lexer/parser à chaque ligne), VARCHAR2/CHAR
trop long → ORA-12899 (ligne 167), NUMBER hors précision → ORA-01438 (ligne 183). Limite mineure
documentée en commentaire : les FK sont résolues uniquement à l'intérieur du même schéma (ligne 124),
alors qu'Oracle autorise une FK cross-schéma qualifiée — 💡 gap mineur, cas rare en pratique.

**✅ Codes ORA- larges et corrects sur les cas testés.** 87 codes numériques distincts levés via
`new OracleError(...)`, 151 occurrences distinctes de la forme `ORA-NNNNN` au total dans
`src/database/oracle/` (le BRD §14 n'en revendique que « 60+ » — sous-estimé). Sondes ponctuelles :
`SELECT 1/0 FROM DUAL` → `ORA-01476: divisor is equal to zero` ; `TO_NUMBER('abc')` →
`ORA-01722: invalid number`. Les deux sont conformes à Oracle 19c.

**✅ Index et plan d'accès réels.** `tryIndexAccessPath` (`OracleExecutor.ts:1311-1363`) exploite les
index déclarés pour éviter un balayage complet sur une égalité indexée — ce n'est pas cosmétique :
`V$SQL_PLAN_MONITOR` reflète réellement `TABLE ACCESS FULL` vs `INDEX` selon la requête (vérifié via
`src/__tests__/unit/database/oracle-sql-plan-monitor.test.ts`, qui passe).

### 2. Transactions

**✅ Modèle mono-écrivain solide.** `TransactionManager`
(`src/database/oracle/transaction/TransactionManager.ts`) implémente un vrai cycle Oracle : début
implicite au premier DML (`begin()`, ligne 87), `COMMIT`/`ROLLBACK` avec restauration par snapshot
complet des tables (undo par copie profonde, lignes 200-226), `SAVEPOINT` réutilisable qui déplace le
point de reprise (lignes 143-148, conforme à la doc Oracle citée en commentaire de tête du fichier),
`ROLLBACK TO SAVEPOINT` avec ORA-01086 si le nom n'existe pas (ligne 130), et un vrai support des
**transactions autonomes** (`PRAGMA AUTONOMOUS_TRANSACTION`, `enterAutonomous`/`exitAutonomous`,
lignes 159-198) — point notable, souvent absent des simulateurs.

**✅ Cohérence de lecture (read consistency) correcte dans le cas mono-écrivain.** Sonde exécutée :
session 1 modifie une ligne sans commit ; session 2 lit la table et voit l'ancienne valeur (pas de
dirty read) ; après `COMMIT` de session 1, session 2 voit la nouvelle valeur. Le mécanisme
(`TransactionCoordinator.committedImageFor`, `src/database/oracle/transaction/TransactionCoordinator.ts:13-22`)
sert à chaque lecteur l'image « avant transaction » de l'écrivain actif trouvé dans le registre — ce
qui reproduit fidèlement READ COMMITTED **tant qu'un seul écrivain est actif à la fois**.

**🔴 CRITIQUE — Corruption confirmée avec deux écrivains concurrents.** Le modèle ne fait pas de vraie
MVCC : `TransactionCoordinator` ne garde qu'**un seul** fournisseur d'image par table (le premier
« autre » writer trouvé dans un `Set`, sans notion de laquelle des transactions concurrentes a
réellement la vue pertinente), et `TransactionManager.rollback()`
(`src/database/oracle/transaction/TransactionManager.ts:110-119`) restaure une table entière par
`truncateTable` + réinsertion de **son propre** snapshot, sans distinguer les lignes écrites entre
temps par une autre session. Reproduction :
```
Session 1 : UPDATE t4 SET v='s1-change' WHERE id=1;      -- txn démarre, snapshot = [1,'orig']
Session 2 : INSERT INTO t4 VALUES (2, 's2-new-row');      -- txn démarre, snapshot = [1,'s1-change']
Session 1 : SELECT * FROM t4;   →  [[1,'s1-change']]      -- ne voit pas l'insert non commité de S2 (correct)
Session 1 : ROLLBACK;
Session 1 : SELECT * FROM t4;   →  [[1,'s1-change']]      -- FAUX : devrait être [[1,'orig']]
```
Ce qui se passe réellement en mémoire : `ROLLBACK` de session 1 tronque physiquement la table et n'y
réinsère que `[1,'orig']` (son propre snapshot pré-transaction) — la ligne `(2,'s2-new-row')` de
session 2, toujours en transaction ouverte, est **irrémédiablement perdue**, sans erreur ni
avertissement. Dans le même temps, la requête de lecture de session 1 après son propre `ROLLBACK`
n'interroge plus son propre stockage (elle n'est plus un writer actif) mais retombe sur l'image
pré-transaction de session 2 (encore active), qui se trouve être `[1,'s1-change']` — une valeur qui
**ne correspond à aucun état réel de la base** (ni le `'orig'` attendu après rollback, ni la donnée
physiquement présente après le troncage). Concrètement : dès que deux sessions ont une transaction
ouverte simultanément sur une table commune, les garanties ACID (durabilité, isolation, atomicité du
rollback) ne tiennent plus — perte de données silencieuse possible. C'est une limite déjà pressentie
par le BRD (« pas de MVCC multi-session », §16 phase 6) mais sa gravité réelle (perte de données
silencieuse, pas seulement lecture obsolète) n'est pas documentée à sa juste mesure. À corriger avant
tout usage pédagogique mettant en scène plusieurs sessions concurrentes sur les mêmes tables (ce que
plusieurs scénarios de test font déjà, sans détecter le problème car ils ne vérifient pas ce cas
précis).

**🟠 MAJEUR — `SELECT … FOR UPDATE` sans `NOWAIT` ne bloque jamais.**
`OracleExecutor.ts:1365-1407` (`lockForUpdateRows`) implémente correctement `NOWAIT` (ORA-00054,
ligne 1395) et `SKIP LOCKED` (ligne 1393), mais le cas standard (attente bloquante) est explicitement
contourné :
```ts
// plain FOR UPDATE: cannot block — return without stealing the lock
out.push(row); // ligne 1397
```
Sonde exécutée : session 1 verrouille une ligne avec `FOR UPDATE` ; session 2 exécute le même
`FOR UPDATE NOWAIT` → lève bien ORA-00054 ; mais session 2 en `FOR UPDATE` simple (sans NOWAIT)
retourne **immédiatement** la ligne sans jamais l'avoir réellement verrouillée pour elle-même. Dans
Oracle réel, cette session resterait bloquée jusqu'au COMMIT/ROLLBACK du détenteur. C'est une
limitation architecturale assumée (le simulateur est synchrone, mono-thread, et ne peut pas suspendre
une session en attente comme le ferait un vrai processus serveur) — mais elle casse un idiome très
courant utilisé en production pour éviter les *lost updates* (verrouillage pessimiste explicite), et
mériterait au minimum un log/avertissement dans le simulateur pour ne pas laisser croire à
l'utilisateur qu'un verrou a été posé.

**🟠 MAJEUR — Les verrous de table (TM) sont posés *après coup*, pas de manière bloquante.**
`LockActor` (`src/database/oracle/lock/LockActor.ts:22-31`) acquiert le verrou `TM`/`TX` seulement en
réaction à l'événement `oracle.dml.executed`, c'est-à-dire **après** que le DML a déjà modifié le
stockage. `LockManager.acquireDmlLock` (`src/database/oracle/lock/LockManager.ts:141-149`) avale même
silencieusement une `DeadlockError` si elle se présente à ce stade tardif (catch qui ne relance que
`DeadlockError`, mais rien n'annule le DML déjà appliqué). En pratique, les verrous de table servent
uniquement à peupler `V$LOCK`/`V$LOCKED_OBJECT` (observabilité) et n'empêchent jamais réellement un
DML concurrent de s'exécuter — cohérent avec le constat précédent sur l'absence de MVCC multi-session.

**🟡 MINEUR — Détection de deadlock existe mais n'est exercée que par un seul chemin.**
`LockManager.detectDeadlock` (`src/database/oracle/lock/LockManager.ts:192-205`) implémente un vrai
suivi de graphe d'attente (wait-for graph) et lève `DeadlockError`/ORA-00060 correctement en cas de
cycle. Mais comme les DML ordinaires n'appellent le gestionnaire de verrous qu'après coup (voir
ci-dessus), ce mécanisme n'est réellement actif que via `LOCK TABLE` explicite ou l'empilement de
plusieurs `FOR UPDATE NOWAIT` — la sonde « deux tables, verrouillage croisé » exécutée dans le cadre
de cet audit n'a pas réussi à provoquer un vrai deadlock inter-sessions (seulement des ORA-00054
`NOWAIT`), ce qui confirme que le chemin de blocage réel (donc de deadlock réel) n'est, de fait,
jamais emprunté par le simulateur.

**🟡 MINEUR — Niveaux d'isolation non appliqués.** `executeSetTransaction`
(`OracleExecutor.ts:741-754`) ne gère que `READ ONLY` (ORA-01456 en écriture ensuite, ligne 758) ;
`SERIALIZABLE` est accepté par le lexer/parser mais silencieusement traité comme READ COMMITTED —
aucun ORA-08177 (« can't serialize access ») n'est jamais levé. Conforme à l'auto-évaluation du BRD
(§16.4, « Niveaux d'isolation — non implémenté »).

### 3. Architecture instance Oracle simulée

**✅ Cycle de vie de l'instance solide et réaliste.** `OracleInstance`
(`src/database/oracle/OracleInstance.ts`) implémente `SHUTDOWN → NOMOUNT → MOUNT → OPEN` avec les
bons garde-fous, `STARTUP RESTRICT`/`FORCE`, `SHUTDOWN NORMAL/IMMEDIATE/TRANSACTIONAL/ABORT`. Les
processus d'arrière-plan ont des PID fixes et cohérents (`PMON=472, SMON=474, LGWR=470, DBW0=471,
CKPT=469`, lignes 111-117) et une **sémantique fatale/non-fatale correcte** : la mort de
PMON/SMON/LGWR/DBWn/CKPT abat l'instance (`SHUTDOWN ABORT` en cascade, lignes 766-776, avec log
d'alerte réaliste « PMON (ospid: N): terminating the instance due to error… »), alors que RECO/MMON/
ARCn sont redémarrés silencieusement par PMON — comportement fidèle à l'architecture Oracle réelle.

**✅ Composition riche plutôt que monolithe.** `OracleInstance` est un **agrégat** de nombreux
gestionnaires spécialisés injectés (AsmManager, AuditJournal, MultitenantManager,
DataGuardConfiguration, FlashbackArchiveManager, ResultCacheManager, LockManager, WaitEventEngine,
AwrSnapshotManager, PlanCache, StatisticsManager, ResourceManager…) — bon pattern de composition,
1291 lignes réparties en délégation plutôt qu'un fourre-tout.

**💡 SGA/PGA — tailles affichées, pas de vraie comptabilité mémoire.** Assumé et documenté par le BRD
lui-même (§9.1 : « la mémoire réelle sera un simple `Map<string, any>` ») — cohérent avec l'ambition
d'un simulateur pédagogique, pas un défaut en soi.

**✅ Synchronisation VFS/systemd bidirectionnelle réelle — point fort notable.**
`src/adapters/OracleFilesystemSync.ts` matérialise sur le VFS Linux simulé chaque événement du
domaine Oracle (spfile, alert log, datafiles, processus). `src/adapters/OracleSystemdSync.ts` va plus
loin : la synchronisation est **bidirectionnelle** — `STARTUP`/`SHUTDOWN` et `lsnrctl start/stop`
font basculer l'unité systemd correspondante, ET `systemctl start/stop oracle-<SID>` pilote
réellement la machine à états de l'instance/listener (pas seulement un processus factice), avec
convergence garantie par idempotence des deux côtés (commentaire de tête, lignes 1-25). C'est une
qualité d'intégration rare dans ce genre de simulateur.

### 4. PL/SQL

**✅ Interpréteur AST réel, pas un stub.** `src/database/oracle/plsql/` comprend un lexer
(`PlsqlLexer.ts`, 151 lignes), un parser récursif descendant (`PlsqlParser.ts`, 963 lignes) et un
interpréteur arbre-parcouru (`PlsqlInterpreter.ts`, 1420 lignes) avec :
- portée lexicale réelle (`Scope`/`child()`, `PlsqlInterpreter.ts:50-56`) ;
- gestion d'exceptions avec `WHEN OTHERS`, exceptions utilisateur, `SQLCODE`/`SQLERRM` restaurés
  correctement en pile (lignes 60-79) ;
- `PRAGMA AUTONOMOUS_TRANSACTION` réellement câblée sur `TransactionManager.enterAutonomous()`
  (ligne 59, `host.beginAutonomousScope?.()`) ;
- curseurs explicites/implicites, `GOTO`, boucles avec garde-fou anti-boucle-infinie
  (`MAX_LOOP = 1_000_000`, ligne 16) ;
- packages utilisateur avec état par session (spec + body), PLS-00302/00363, ORA-04067/04068 selon
  le BRD (§16 phase 4, cohérent avec le code observé).

C'est un niveau d'implémentation nettement au-dessus d'un « bloc anonyme minimal » : procédures,
fonctions, packages et curseurs sont réellement exécutés, pas simulés par pattern-matching de texte.

### 5. Sous-systèmes avancés (hors RMAN)

**🟠 MAJEUR — Multitenant CDB/PDB : façade sans isolation de données.**
`src/database/oracle/multitenant/PluggableDatabase.ts` gère une liste de `PluggableDatabase` (CON_ID,
nom, mode d'ouverture, statut) mais `OracleStorage` n'a **aucune notion de CON_ID** — tous les objets
de toutes les PDB partagent le même espace de noms schéma/table. `ALTER SESSION SET CONTAINER` est
honnêtement documenté comme un changement de label uniquement :
```ts
// src/database/oracle/OracleDatabase.ts:948-952
// ALTER SESSION SET CONTAINER = <name> — move the session into a PDB (or
// back to CDB$ROOT). Validates existence (ORA-65011) and that the PDB is
// open (ORA-65040). Data isolation across containers is not modelled; the
// session context (CON_NAME / CON_ID / V$SESSION) is what switches.
```
C'est transparent dans le code (bon point de traçabilité), mais cela signifie qu'un scénario
pédagogique « créer une table dans PDB1, vérifier qu'elle n'existe pas dans PDB2 » **échouerait**
silencieusement (la table serait visible partout). À documenter clairement dans toute doc utilisateur
qui présenterait le multitenant comme une fonctionnalité à part entière.

**🟡 MINEUR — Data Guard : machine à états sans transport/apply réel.**
`DataGuardConfiguration.switchover` (`src/database/oracle/dataguard/DataGuardConfiguration.ts:83-90`)
se contente de permuter deux champs `role` (`PRIMARY` ↔ `PHYSICAL STANDBY`) ; les champs de lag
(`applyLagSeconds`, `transportLagSeconds`) sont de simples propriétés mutables, jamais dérivées d'un
vrai flux de redo transporté/appliqué. Attendu et raisonnable pour un simulateur navigateur (Data
Guard réel implique deux instances Oracle physiquement distinctes communicant en continu — hors de
portée d'une simulation client-side), mais à ne pas présenter comme « Data Guard fonctionnel ».

**✅ Flashback plus abouti que ne le documente le BRD (à corriger dans le BRD).** Le BRD §15.6 affiche
« Flashback ❌ » mais le code implémente réellement :
- `SELECT … AS OF TIMESTAMP|SCN` (`OracleExecutor.ts:1480-1481`, `flashbackRowsAt`) ;
- `FLASHBACK TABLE … TO TIMESTAMP|SCN` (`OracleExecutor.ts:634-651`) ;
- `FLASHBACK TABLE … TO BEFORE DROP` via une vraie corbeille/recyclebin (lignes 653-667).

Le mécanisme (`src/database/oracle/flashback/TableHistory.ts`) capture un snapshot des lignes à
chaque DML significatif, dans un ring-buffer borné à **64 versions par table**
(`MAX_ENTRIES_PER_TABLE = 64`, ligne 9), entièrement en mémoire (perdu au redémarrage de l'onglet).
Le commentaire de l'executor est honnête sur la limite : « DATABASE / TO TIMESTAMP / SCN [au niveau
base] sont acceptés mais no-op logiques — le simulateur n'a pas de machine à remonter le temps
undo/redo » (lignes 636-639). C'est donc un flashback **table-level, fenêtre courte, en mémoire** —
utile pédagogiquement pour illustrer le concept, mais pas une implémentation UNDO-based complète. Le
BRD doit être resynchronisé sur ce point (statut réel : 🟡 partiel, pas ❌).

**💡 ASM : bookkeeping honnête, sans matérialisation réelle.** `AsmManager.ts` gère diskgroups/
disks/files avec un vrai état mutable consommé directement par les vues `V$ASM_*` (commentaire de
tête, lignes 1-15 : « No fabricated rows »), mais le commentaire ligne 8 admet qu'aucun fichier n'est
encore réellement créé par DBMS_FILE_TRANSFER/RMAN (« none yet ») — cohérence de façade correcte,
profondeur physique absente (pas de vrai striping/mirroring de blocs, ce qui est attendu).

**✅ AWR alimenté par de vraies statistiques, pas fabriqué.** `AwrSnapshotManager.createSnapshot`
(`src/database/oracle/awr/AwrSnapshotManager.ts:44-109`) construit chaque snapshot à partir des
compteurs runtime réels de l'instance (`instance.getRuntimeState().counters` — commits, rollbacks,
exécutions, parses…) et du vrai cache SQL (`runtime.sqlCache`), pas de données aléatoires. Le manager
est volontairement **passif** (pas d'auto-snapshot périodique, pour garder les tests déterministes,
commentaire lignes 9-12) — un choix cohérent mais qui signifie que l'intervalle `AWR_SNAPSHOT_INTERVAL`
par défaut n'est pas simulé automatiquement sans déclenchement explicite.

**🟠 MAJEUR — RAC non implémenté, confirmé par l'exécution des tests dédiés.** Les deux scénarios
`src/__tests__/unit/network-v2/scenario-oracle-07-rac-node-eviction.test.ts` et
`scenario-oracle-08-rac-cache-fusion-interconnect.test.ts` échouent respectivement sur **6/7** et
**11/12** tests à l'exécution (`npx vitest run`) :
- `V$CLUSTER_INTERCONNECTS` n'existe pas (`ORA-00942: table or view does not exist`) ;
- aucun wait event `gc buffer busy`/`gc cr request` (Cache Fusion) — `V$SYSTEM_EVENT` retourne
  `no rows selected` pour ces événements ;
- le descriptor TNS `FAILOVER_MODE=(TYPE=SELECT)` (Transparent Application Failover) n'est pas
  reconnu par le parseur TNS, provoquant `ORA-12154` au lieu d'une connexion réussie ;
- la dégradation du lien d'interconnect privé (latence/perte injectée sur le réseau simulé) n'a
  aucun effet mesurable sur les temps de réponse Cache Fusion (le test attend un delta de +150ms,
  observe +0.9ms).

C'est un gap cohérent avec l'attendu de la mission (RAC absent) — à traiter comme un axe de roadmap
distinct plutôt qu'un défaut de qualité du code existant (aucune prétention à supporter RAC
n'apparaît dans le BRD).

### 6. Accès réseau (listener, TNS, connexions distantes)

**✅ Point fort marquant : un client distant traverse réellement le réseau simulé, pas de raccourci
« magique ».** Vérifié par exécution complète du scénario e2e
`src/__tests__/unit/network-v2/scenario-oracle-01-tns-e2e-connection.test.ts` (**9/9 tests passés**),
sur une topologie à deux `LinuxServer` reliés par un `GenericSwitch` :
- `lsnrctl status` sur l'hôte serveur montre un vrai port 1521 lié (`netstat -tlnp`/`ss -tlnp`
  affichent `tnslsnr` sur `:1521` — pas une chaîne codée en dur, mais un vrai binding via
  `OracleListenerNetworkBinding.attach()` sur la pile TCP du device,
  `src/database/oracle/listener/OracleListenerNetworkBinding.ts:55-71`) ;
- une sonde TCP (`tcpProbeSync`) depuis le client échoue sur le port 1522 et réussit sur 1521, et
  **cesse de réussir dès que le listener est arrêté** — le port n'est donc pas ouvert de façon
  statique, il suit l'état réel du listener ;
- `sqlplus system/oracle@ORCLDB` (alias `tnsnames.ora` pointant vers l'IP du serveur) établit une
  session, exécute une requête qui s'exécute **réellement côté serveur** (table créée côté serveur,
  lue depuis le client) ;
- `listener.log` (fichier réel sur le VFS du serveur) et `V$SESSION` côté serveur reflètent la
  **vraie IP source du client** et son hostname (`MACHINE` = `appclient`) — pas une valeur
  générique.

**✅ Échelle d'erreurs TNS fidèle.** `ListenerControl.attemptConnect`
(`src/database/oracle/listener/ListenerControl.ts:139-172`) reproduit la vraie hiérarchie
Oracle : `ORA-12541` (pas de listener), `ORA-12514` (service inconnu), `ORA-12528` (instance en
cours de démarrage, bloquante) — dérivée dynamiquement de l'état **réel** de l'instance
(`serviceStatus()`, lignes 127-132 : `READY` seulement si `OPEN`, `BLOCKED` si NOMOUNT/MOUNT), pas de
table statique.

**✅ Connexions locales « bequeath » correctement distinguées.** Le commentaire de tête de
`ListenerControl` précise que les connexions locales (`sqlplus / as sysdba`) « ne touchent jamais le
listener, comme dans le vrai Oracle » (lignes 10-12) — distinction souvent oubliée dans les
simulateurs, ici respectée.

### 7. Génie logiciel

**✅ Séparation `engine/`/`oracle/` respectée structurellement.** Chaque classe Oracle étend
explicitement sa base générique (`OracleLexer extends BaseLexer`, `OracleParser extends BaseParser`,
`OracleExecutor extends BaseExecutor`, `OracleCatalog extends BaseCatalog`,
`OracleStorage extends BaseStorage`). Peu de fuite constatée dans `BaseParser.ts` (seule référence
Oracle : le point d'extension documenté pour `CONNECT BY`, ligne 153/445, correctement délégué à
`OracleParser`). **Mais** cette architecture reste **non éprouvée** : `postgres/`, `mysql/`,
`sqlserver/` n'existent pas (marqués « futur » dans le BRD §2.1) — la réutilisabilité multi-SGBD est
une intention de conception, pas un fait vérifié. `BaseExecutor` (`src/database/engine/executor/
BaseExecutor.ts`, 67 lignes) ne porte quasiment aucune logique partagée (juste le contrat + le
contexte d'exécution) : la quasi-totalité de la sémantique SQL vit dans `OracleExecutor.ts`
(4282 lignes) — ce qui est honnête vu qu'un seul dialecte existe, mais relativise l'ambition
« moteur réutilisable » affichée par le BRD.

**🟡 MINEUR — Fichiers objets-dieu.** `OracleExecutor.ts` (4282 lignes), `OracleDatabase.ts`
(2277 lignes), `OracleCatalog.ts` (1817 lignes), `BaseParser.ts` (2492 lignes), `OracleParser.ts`
(1534 lignes) dépassent largement les tailles habituellement recommandées pour la lisibilité/
testabilité. Le projet a engagé une décomposition partielle et de bonne qualité — `UserAdminExecutor`,
`SecurityDclExecutor`, `InstanceAdminExecutor`, `ConstraintValidator`, `ScalarFunctionEvaluator`,
`QueryResultRenderer` sont extraits en classes dédiées et injectées dans `OracleExecutor` — mais le
cœur SELECT/DML/DDL-dispatch reste dans un seul fichier massif. Point positif contrastant : le
répertoire `src/database/oracle/views/` adopte une granularité exemplaire — **un fichier par vue**
V\$/DBA\_ (près de 300 fichiers courts), ce qui facilite grandement la navigation et les tests
ciblés ; ce pattern gagnerait à être étendu au reste de l'executor (un module par catégorie
d'instruction plutôt qu'un dispatcher monolithique).

**✅ Couverture de tests solide et verte.** `npx vitest run src/__tests__/unit/database/` :
**135 fichiers, 3088 tests, 100% passés** au moment de l'audit. Le BRD §19 fixe un objectif de
« 90%+ de couverture sur le moteur SQL » comme critère d'acceptation, mais `vite.config.ts` ne scope
la porte de couverture (`coverage.thresholds`) que sur `src/network/protocols/ssh/**` — **aucune
porte de couverture CI n'existe pour le module Oracle**, donc l'atteinte du critère du BRD n'est
jamais vérifiée automatiquement (le nombre de tests est élevé et rassurant, mais ce n'est pas la même
garantie qu'un seuil de couverture appliqué en continu).

---

## Top 10 des actions recommandées

1. **🔴 CRITIQUE — Corriger la perte de données au ROLLBACK en présence de plusieurs écrivains
   concurrents.** `TransactionManager.rollback()` ne doit restaurer que les lignes que *sa propre*
   transaction a modifiées (diff ciblé plutôt que troncage+réinsertion complète de table), et
   `TransactionCoordinator` doit distinguer plusieurs writers concurrents par table au lieu de servir
   arbitrairement le premier trouvé. À défaut d'une vraie MVCC, documenter/alerter explicitement
   l'utilisateur (bannière ou log) quand deux sessions ouvrent une transaction d'écriture sur la même
   table, pour éviter un piège pédagogique silencieux.

2. **🟠 MAJEUR — Corriger le format DATE par défaut en sortie SQL\*Plus.** Convertir les valeurs
   `DATE` en objets `Date` réels avant qu'elles n'atteignent `QueryResultRenderer` (ou étendre
   `renderValue` pour détecter et reformater les chaînes de stockage au format `DD-MON-RR`). C'est le
   défaut de conformité le plus visible identifié (affecte tout `SELECT` de colonne DATE sans
   `TO_CHAR`, y compris sur les schémas de démo HR/SCOTT).

3. **🟠 MAJEUR — Documenter (ou faire échouer explicitement) le `FOR UPDATE` non bloquant.** Puisque
   le simulateur ne peut pas suspendre une session, envisager a minima un avertissement explicite
   dans la sortie SQL\*Plus quand une session « prend » un `FOR UPDATE` déjà tenu par une autre, pour
   ne pas laisser croire à un verrouillage effectif.

4. **🟠 MAJEUR — Documenter clairement l'absence d'isolation de données multitenant** dans toute
   documentation utilisateur/pédagogique présentant CDB/PDB, pour éviter qu'un scénario de cours ne
   suppose une isolation qui n'existe pas.

5. **🟡 Resynchroniser `docs/BRD-Oracle-DBMS.md`** avec l'état réel du code : le flashback (§15.6) est
   en réalité partiellement implémenté (query AS OF, FLASHBACK TABLE, recyclebin) et mérite un statut
   🟡 plutôt que ❌ ; le nombre de codes ORA- (§14) est en réalité 87+ et non « 60+ ».

6. **🟡 Faire converger le verrouillage table (TM) avec le DML au lieu de le poser après coup** via
   l'event bus — au minimum pour que la détection de deadlock (`LockManager.detectDeadlock`, déjà
   correcte) soit réellement exercée par des DML ordinaires et pas seulement par `FOR UPDATE`/
   `LOCK TABLE` explicites.

7. **🟡 Ajouter une porte de couverture CI dédiée au module Oracle** (`src/database/oracle/**`,
   `src/database/engine/**`) dans `vite.config.ts`, pour donner un sens mesurable au critère
   « 90%+ » du BRD §19 (actuellement non vérifié automatiquement — seule la SSH est sous seuil).

8. **🟡 Décomposer `OracleExecutor.ts` (4282 lignes)** en modules par catégorie d'instruction (SELECT/
   DML, DDL, DCL sont déjà partiellement extraits — poursuivre sur SELECT/JOIN/agrégation), en
   s'inspirant de la granularité déjà exemplaire de `src/database/oracle/views/`.

9. **🟡 Ajouter des tests de régression ciblant explicitement le cas « deux sessions actives sur la
   même table »** (aujourd'hui absent de `src/__tests__/unit/database/`, qui teste surtout la
   cohérence de lecture mono-écrivain) — le bug critique du point 1 serait autrement resté invisible
   à la suite de tests actuelle malgré ses 3088 tests verts.

10. **💡 Clarifier dans la documentation les limites assumées d'ASM et Data Guard** (bookkeeping/façade
    d'état sans transport de données réel) pour que les scénarios pédagogiques bâtis dessus
    (ex. bascule Data Guard, ajout de disque ASM) ne prêtent pas au moteur des garanties physiques
    qu'il n'a pas — un simple encart « simulation d'état, sans mouvement de données réel » dans les
    sorties `DGMGRL`/`asmcmd` correspondantes suffirait.
