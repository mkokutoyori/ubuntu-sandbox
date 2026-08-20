# Journal de bord — Refactoring du simulateur Oracle DBMS

Chaque entrée documente une défaillance ou limite identifiée, son diagnostic,
la correction structurelle appliquée et la preuve de non-régression. Les
entrées sont ordonnées chronologiquement ; une entrée = un commit.

---

## Itération 1 — Couche crypto : hachage incrémental + mémoïsation des verifiers (2026-06-10)

### Défaillance constatée
Trois tests de `oracle-access-management-comprehensive.test.ts` échouaient par
**timeout (>5 s)** : `SELECT * FROM sys.user$`, `SELECT … FROM dict_columns`,
`SELECT COUNT(*) FROM sys.user$ WHERE …`. Sur une base de 6 utilisateurs, un
simple `SELECT * FROM sys.user$` prenait **1,1 s** ; avec ~25 utilisateurs
créés par la suite de tests, plus de 7 s.

### Diagnostic
1. La vue `SYS.USER$` (`src/database/oracle/views/sys_user.ts`) recalculait
   les verifiers de mots de passe (10g/11g/12c) **à chaque requête, pour
   chaque utilisateur**. Le verifier 12c exécute un vrai PBKDF2-HMAC-SHA512 à
   4096 itérations (fidèle à Oracle), soit ~190 ms par compte en TS pur.
2. Cause aggravante architecturale : la couche crypto (`src/crypto`) n'offrait
   qu'une API de hachage *one-shot* (`digest(bytes)`). HMAC re-hachait donc
   les blocs de padding de clé à chaque appel, et PBKDF2 payait ~4
   compressions SHA-512 + plusieurs allocations **par itération** au lieu
   de 2 compressions sans allocation.

### Corrections (structurelles, pas cosmétiques)
- `src/crypto/hash/HashAlgorithm.ts` : ajout de l'abstraction
  `IncrementalHash` (update/clone/digest) — point d'extension standard de
  toute API de hachage réelle ; `createState?()` optionnel sur
  `HashAlgorithm`, les digests one-shot existants restent valides (OCP).
- `src/crypto/hash/sha512.ts` : refactoring en état incrémental
  (`Sha512State`) avec compression de bloc extraite (`compressBlock`) ;
  `sha512()` one-shot réimplémenté par-dessus — une seule source de vérité.
- `src/crypto/mac/hmac.ts` : nouveau `PrecomputedHmac` — midstates ipad/opad
  précalculés une fois par clé (RFC 2104), 2 compressions par message au
  lieu de 4+.
- `src/crypto/kdf/pbkdf2.ts` : chemin rapide via `PrecomputedHmac` quand le
  hash expose `createState` ; repli automatique sur le chemin générique
  sinon (SHA-1/SHA-256 inchangés pour IPSec/SSH).
- `src/database/oracle/security/storedVerifier.ts` : mémoïsation des
  verifiers — la dérivation est déterministe par (username, password), la
  recalculer à chaque SELECT était du gaspillage pur.

### Fidélité Oracle
Aucun compromis : les 4096 itérations du verifier 12c (`AUTH_PBKDF2_SPEEDY_KEY`)
sont conservées ; les vecteurs canoniques (openssl 10g, hashcat -m 112 /
-m 12300) passent toujours.

### Preuves
- Dérivation 12c : ~190 ms → ~109 ms ; requêtes répétées sur `SYS.USER$` :
  instantanées (cache).
- `src/__tests__/unit/crypto/` : 181/181 verts (vecteurs canoniques).
- `src/__tests__/unit/database/` + suites IPSec/SSH crypto : 2691/2691 verts,
  dont les **3 tests précédemment en échec** sur la baseline.

---

## Itération 2 — Suppression de l'interpréteur PL/SQL legacy en doublon (2026-06-10)

### Défaillance constatée (GAP.md §10.5, sévérité majeure)
Deux interpréteurs PL/SQL coexistaient :
- l'interpréteur moderne à AST (`src/database/oracle/plsql/` — lexer, parser,
  interpréteur, exceptions, curseurs) ;
- un interpréteur legacy à base de regex (~750 lignes dans
  `OracleDatabase.ts` : `executePLSQLLegacy`, `parsePLSQLBlock`,
  `executePLSQLStatement(s)`, `executePLSQLIf/For/While`,
  `evaluatePLSQLExpression*`, `evaluatePLSQLCondition`, …).

Le legacy s'activait **silencieusement** quand le parser moderne échouait :
même source, sémantique différente, aucun signal. Duplication pure et
maintenance double.

### Diagnostic
Instrumentation du fallback (`console.error` temporaire) puis exécution de
l'intégralité des suites (`unit/database` 2520 tests, `debug/oracle`,
`debug/rman`, `unit/terminal`) : **zéro déclenchement**. Le legacy était du
code mort en pratique — l'interpréteur AST couvre tous les usages réels.

### Corrections
- `OracleDatabase.executePLSQL` : plus de fallback. Un échec de compilation
  renvoie désormais `ORA-06550: line 1, column 1:` suivi du diagnostic
  `PLS-00103` — c'est le comportement du vrai Oracle (avant : exécution
  silencieuse par un moteur différent, ou pire, un faux succès).
- `plsql/index.ts` : `runAnonymousBlock` propage le message d'erreur du
  parser (`parseErrorMessage`) au lieu de le jeter.
- Suppression des ~750 lignes legacy ; `OracleDatabase.ts` passe de 2332 à
  ~1590 lignes. `invokeBuiltinPackage` et `callStoredUnit` (chemins vivants,
  partagés) conservés.
- Correction au passage des 6 erreurs ESLint préexistantes du fichier
  (`no-explicit-any`, `prefer-const`).

### Preuves
- 2539 tests verts (`unit/database` + `debug/oracle` + `debug/rman`).
- 2 nouveaux tests de régression dans `oracle-plsql-interpreter.test.ts` :
  un bloc imparsable produit `ORA-06550`/`PLS-00103`, jamais un faux
  « PL/SQL procedure successfully completed. ».

---

## Itération 3 — PRAGMA, FORALL et littéraux DATE dans l'interpréteur PL/SQL (2026-06-10)

### Défaillance constatée
Les transcripts debug régénérés après l'itération 2 ont révélé 8 blocs que
le legacy « réussissait » en réalité **en faux** (il ignorait ce qu'il ne
comprenait pas — ex. un FORALL qui n'insérait aucune ligne tout en
affichant « successfully completed ») :
- `PRAGMA AUTONOMOUS_TRANSACTION` dans les procédures stockées (5 cas) ;
- `FORALL i IN 1..n [SAVE EXCEPTIONS] <dml>` (2 cas) ;
- littéraux ANSI `DATE '2020-01-01'` dans les expressions (1 cas).

### Corrections
- `PlsqlParser.parseDeclaration` : branche PRAGMA généralisée —
  `EXCEPTION_INIT` garde sa sémantique, les autres pragmas
  (AUTONOMOUS_TRANSACTION, SERIALLY_REUSABLE, UDF, INLINE,
  RESTRICT_REFERENCES) deviennent un nœud AST `pragma` (directive de
  compilation, no-op à l'exécution — documenté).
- `PlsqlParser.parseForall` : `FORALL` désucré en boucle `forNum` sur
  l'unique ordre DML — sans moteur de bulk-bind, la sémantique ligne à
  ligne est identique à Oracle.
- Littéraux `DATE '...'` / `TIMESTAMP '...'` désucrés en `TO_DATE(...)`
  → évalués par la machinerie de dates du moteur SQL.
- `PlsqlInterpreter.interpolateBinds` : résolution des accès éléments de
  collection (`v_ids(i)`) dans le SQL embarqué — l'indice est parsé via le
  nouveau point d'entrée `PlsqlParser.parseExpression` et évalué dans la
  portée PL/SQL ; `ORA-06533` si hors bornes (fidèle à Oracle).
- `OracleDatabase.callStoredUnit` : le corps d'une unité stockée est
  `[déclarations] BEGIN … END` (le DECLARE est implicite après IS/AS) —
  les déclarations locales (variables, curseurs, pragmas) restent
  désormais dans la section déclarative du bloc wrapper au lieu d'être
  enveloppées comme des instructions exécutables.

### Preuves
- 4 nouveaux tests dans `oracle-plsql-interpreter.test.ts` : FORALL insère
  réellement (COUNT=3, valeurs vérifiées), SAVE EXCEPTIONS, DATE literal,
  procédure autonome qui insère réellement.
- 2545 tests verts (unit/database + debug/oracle + debug/rman).
- Transcripts debug : les 8 `ORA-06550/PLS-00103` introduits par
  l'itération 2 disparaissent, remplacés par de vraies exécutions.

---

## Itération 4 — Fidélité SQL : NULLS FIRST/LAST, ORA-01086, comparateur unifié (2026-06-10)

### Défaillances constatées
1. `ORDER BY … NULLS FIRST|LAST` était **parsé** (présent dans l'AST,
   `OrderByItem.nullsPosition`) mais **ignoré** par l'exécuteur : la clause
   n'avait aucun effet.
2. Le comparateur de tri était dupliqué à l'identique dans 4 sites
   (`executeSelectFromTable`, `projectGroupedRows`, fenêtres analytiques,
   `applySelectClauses`) — toute correction devait être faite 4 fois.
3. `ROLLBACK TO SAVEPOINT inexistant` renvoyait un faux
   « Rollback to savepoint X complete. » — le vrai Oracle lève
   `ORA-01086: savepoint 'X' never established in this session or is invalid`.

(Vérifications négatives : le zero-padding des codes ORA- et la gestion de
`DROP TABLE … PURGE` étaient déjà corrects, contrairement à ce que
suggérait l'analyse initiale — pas de modification.)

### Corrections
- Nouveau `compareWithOrderSpec(a, b, {direction, nullsPosition})` dans
  `OracleExecutor` : NULL traité comme la plus grande valeur (dernier en
  ASC, premier en DESC — défaut Oracle), `NULLS FIRST/LAST` prioritaire
  sur la direction. Les 4 sites de tri délèguent à ce comparateur unique.
- `executeRollback` : `ORA-01086` levée pour un savepoint jamais établi.
- Nettoyage des 12 erreurs ESLint préexistantes du fichier : 4 handlers
  typés `any` → vrais types AST (`CreateSynonymStatement`,
  `DropSynonymStatement`, `AlterSequenceStatement`, `AlterIndexStatement`),
  `prefer-const`, échappements regex inutiles, espace irrégulière.

### Preuves
- Nouveau fichier `oracle-orderby-savepoint-fidelity.test.ts` : 6 tests
  (défauts ASC/DESC, overrides NULLS FIRST/LAST, ORA-01086, rollback vers
  savepoint valide inchangé).
- 2532 tests `unit/database` verts ; lint et typecheck propres.

---

## Itération 5 — Déduplication des résolutions schéma/table/colonne dans OracleExecutor (2026-06-10)

### Défaillance constatée (GAP.md §10.15 — god class, duplication)
Chaque handler DML/DDL réinventait les trois mêmes motifs :
- repli de schéma : `(stmt.schema || this.context.currentSchema).toUpperCase()` — 18 occurrences ;
- contrôle d'existence + `ORA-00942` (7 occurrences inline) ;
- résolution de colonne + `ORA-00904` via `findIndex(...toUpperCase())` (7 occurrences).

### Corrections
Quatre helpers privés uniques dans `OracleExecutor` :
`resolveSchema`, `requireTableMeta` (ORA-00942), `requireColumnIndex`
(ORA-00904), `findColumnIndex`. Handlers convertis : INSERT (y compris
INSERT…SELECT et buildInsertRow), UPDATE, DELETE, MERGE, chargement de
table du SELECT, + les 15 sites de repli de schéma restants.

### Preuves
- 2532 tests `unit/database` verts, lint/typecheck propres.
- Comportement inchangé par construction (mêmes erreurs ORA, même ordre
  de contrôles) ; le gain est la maintenabilité (une seule source pour
  chaque règle de résolution).

---

## Itération 6 — Extraction des fonctions SQL scalaires hors de la god class (2026-06-10)

### Défaillance constatée (GAP.md §10.15)
`OracleExecutor.evaluateFunction` : ~400 lignes, 98 fonctions SQL dans un
switch enfoui au milieu de la god class de 5100+ lignes. Ajouter une
fonction SQL imposait de toucher l'exécuteur entier.

### Corrections
- Nouveau module `src/database/oracle/functions/ScalarFunctionEvaluator.ts` :
  toute l'évaluation scalaire (UPPER/SUBSTR/NVL/TO_DATE/SYS_CONTEXT/…,
  DECODE inclus) + les utilitaires `coerceDate`/`formatDate` (anciens
  statics d'OracleExecutor, utilisés nulle part ailleurs).
- Couplage inversé : l'évaluateur dépend d'une interface étroite
  `ScalarFunctionHost` (récursion d'expressions, comparaison, formats de
  dates, contexte de session) — pas de l'exécuteur concret. L'exécuteur
  fournit l'hôte par fermetures, ce qui garde ses helpers privés.
- `OracleExecutor.evaluateFunction` devient un délégué d'une ligne ;
  le fichier passe de 5181 à 4773 lignes.

### Preuves
- 2532 tests `unit/database` verts ; lint/typecheck propres.
- Une régression de migration (références aux statics
  `OracleExecutor.coerceDate/formatDate` devenues invisibles depuis le
  module) a été attrapée par la suite (§24 SYSDATE arithmetic) et
  corrigée en déplaçant les utilitaires dans le module — preuve que le
  filet de tests joue son rôle.

---

## Itération 7 — Fidélité : GUID V$PDBS réaliste, TRUNC(date) complet (2026-06-10)

### Défaillances constatées
1. (GAP.md §10.14) Le GUID des pluggable databases contenait littéralement
   « …-CONS-OLE-OURO-FAKED… » dans `V$PDBS`/`DBA_PDBS`, généré avec
   `Math.random()` (non déterministe d'un run à l'autre).
2. `TRUNC(date, fmt)` ne supportait que YYYY/MM/DAY ; les formats Oracle
   standard Q (trimestre), IW (semaine ISO), W, WW, HH24, MI manquaient,
   et IW était faux (assimilé à DAY, départ dimanche au lieu de lundi).

### Corrections
- `PluggableDatabase` : GUID = 32 hexadécimaux majuscules (format réel de
  `V$PDBS.GUID`), dérivé déterministiquement de l'identité du PDB via le
  md5 du projet — stable entre les runs et dans les transcripts.
- `ScalarFunctionEvaluator` : TRUNC(date) gère Q, IW (lundi ISO), W (même
  jour de semaine que le 1er du mois), WW (même jour que le 1er janvier),
  HH/HH12/HH24, MI ; DAY/D/DY reste à départ dimanche (NLS US par défaut).

### Preuves
- Nouveau test V$PDBS : GUID matche `[0-9A-F]{32}`, plus aucun « FAKED ».
- Nouveaux tests TRUNC : Q→2026-04-01, IW→lundi, DAY→dimanche, W.
- 2534 tests `unit/database` verts.

---

## Itération 8 — Fonctions de packages appelables depuis SQL et PL/SQL (2026-06-10)

### Défaillances constatées (suite du GAP.md §10.6)
Le cycle de vie des packages (spec/body/membres/DBA_OBJECTS/drop)
fonctionnait, mais :
1. `SELECT emp_pkg.double_it(21) FROM dual` → `ORA-00904` : aucune
   passerelle SQL → fonctions stockées ; le moteur SQL ne connaissait que
   ses builtins.
2. `emp_pkg.double_it(5)` appelé depuis PL/SQL renvoyait NULL :
   `PlsqlInterpreter.parseUnit` générait `FUNCTION EMP_PKG.DOUBLE_IT(...)`
   (nom pointé invalide comme identifiant de sous-programme) puis
   ajoutait un `;` aveugle produisant `END;;` — le parse échouait et
   l'unité était silencieusement mise en cache comme nulle.

### Corrections
- `PlsqlInterpreter.parseUnit` : en-tête généré avec le nom de membre nu ;
  terminateur ajouté seulement si absent ; les corps
  `[déclarations] BEGIN … END` (DECLARE implicite après IS/AS) sont
  acceptés.
- Nouvelle méthode publique `PlsqlInterpreter.callStoredFunction(unit,
  args)` : pont d'évaluation avec arguments scalaires pré-évalués.
- `SqlCommandHost.execScalarFunctionCall` + implémentation
  `OracleDatabase` (résolution via `resolveStoredUnit`, donc schémas et
  membres de packages) ; la construction du `PlsqlHost` est extraite en
  `buildPlsqlHost` (dédupliquée avec `executePLSQL`).
- `ScalarFunctionHost.callStoredFunction?` optionnel : le case `default`
  de l'évaluateur scalaire tente les fonctions stockées avant de lever
  `ORA-00904` — exactement la précédence du vrai Oracle.

### Preuves
- 4 nouveaux tests : SELECT pkg.fn FROM dual → 42 ; PUT_LINE(pkg.fn) → 10 ;
  EXEC pkg.proc avec DBMS_OUTPUT ; fonction inconnue → ORA-00904 conservé.
- 2552 tests verts (unit/database + debug/oracle).

---

## Itération 9 — Typage des statements DB link / vues matérialisées, hygiène engine (2026-06-10)

### Défaillances constatées
1. Les statements `CREATE/DROP DATABASE LINK` et `CREATE/DROP MATERIALIZED
   VIEW` étaient dispatchés par chaîne dans l'exécuteur mais **n'existaient
   pas dans l'AST** : le parser retournait des objets `as any` — aucun
   contrat de type, exclusion silencieuse de l'union `Statement`.
2. `PrivilegeChecker` perçait l'encapsulation du catalogue avec
   `(this.catalog as any).sysPrivileges` / `.roleGrants`.
3. 9 erreurs ESLint préexistantes dans `engine/` (consommations de tokens
   en expressions orphelines `a() || b();`, échappements regex inutiles,
   `any` sur `ViewMeta.queryAST`, prefer-const).

### Corrections
- 4 nouvelles interfaces AST (`CreateDbLinkStatement`, `DropDbLinkStatement`,
  `CreateMaterializedViewStatement`, `DropMaterializedViewStatement`)
  ajoutées à l'union `Statement` ; méthodes du parser typées, `as any`
  supprimés.
- Accesseurs en lecture `getRoleGrants()`/`getSysPrivilegeGrants()`
  **remontés dans `BaseCatalog`** (où vivent les champs protégés) ;
  doublons supprimés d'`OracleCatalog` ; `PrivilegeChecker` consomme les
  accesseurs publics au lieu de caster.
- Hygiène engine : consommations de mots-clés réécrites en `if`,
  regex q-quote nettoyée, `queryAST` typé `object` (commenté), const.

### Preuves
- 2538 tests `unit/database` verts ; `npx eslint src/database/` : 0 erreur ;
  typecheck propre.

---

## Itération 10 — UI terminal : test sudo-prompt préexistant en échec (2026-06-10)

### Défaillance constatée
`duplicate-display-fixes.test.ts §9.1` (« echoes the prompt to scrollback
once the user submits ») échouait **déjà sur main**. Cause : deux chemins
de soumission de mot de passe coexistent — le flow-engine écrit le prompt
dans `line.text` (`addLine`), le broker d'input le range dans le champ
dédié `line.promptText` (`addEchoLine`, le texte ne contenant que la
valeur masquée `***`). Le test ne filtrait que `line.text`, alors que le
chemin actif (broker) est devenu le chemin par défaut.

### Analyse de l'arbitrage
Deux specs existantes contradictoires : `BashReadIntegration` et
`SessionInputHost` exigent l'écho masqué `******` dans `text` (contrat
`addEchoLine` : le renderer compose visuellement `promptText` + `text`,
recherche/presse-papiers ne voient que la valeur). L'intention du §9.1
(« le prompt apparaît exactement une fois à l'écran ») est satisfaite par
ce contrat — c'est le filtre du test qui regardait le mauvais champ.

### Correction
Test corrigé pour matcher `text` **ou** `promptText` (avec commentaire du
contrat) ; commentaire clarifié dans `handleBrokerKey`. Aucun changement
de comportement runtime — les 3 suites (duplicate-display, BashRead,
SessionInputHost) sont désormais cohérentes et vertes.

### Preuves
- `unit/terminal` + `unit/shell` : 896/896 verts (1 échec préexistant résolu).

---

# Journal (série parallèle — branche happy-volta-51l0hy)

Ce journal documente chaque défaillance structurelle, duplication ou écart avec le
comportement du vrai Oracle Database identifié dans `src/database/`, et la correction
apportée. Une entrée par push.

**Règles suivies :**
- Améliorations structurelles profondes uniquement (pas de patchs cosmétiques).
- Les API publiques testées restent stables : `OracleDatabase.executeSql()`,
  `connectAsSysdba()`, `db.catalog.*`, `db.storage.*`, `SqlPlusSubShell.create()/processLine()`.
- Chaque correction est validée par `npm run test:run` sur les suites concernées avant push.

---

## État des lieux initial (2026-06-10)

### Filet de sécurité
- 67 fichiers de tests unitaires (~932 cas) sous `src/__tests__/unit/database/`.
- 16 suites de debug (transcripts, non-assertives) sous `src/__tests__/debug/oracle/`
  pilotées via `SqlPlusSubShell`.

### Défaillances identifiées (état des lieux)
1. **God class `OracleExecutor.ts` (5167 lignes, ~200 méthodes)** : dispatch par switch
   géant (140+ cas), pipeline SELECT (~800 lignes), évaluation d'expressions (~900 lignes),
   état transactionnel, télémétrie, I/O fichiers, mutations catalogue — tout dans une classe.
2. **Duplications internes à l'exécuteur** : validation des grantees dupliquée entre GRANT
   et REVOKE, détection de cycles de rôles dupliquée, résolution de schéma répétée ~20 fois,
   triplet « table existe + droit d'accès + métadonnées » répété dans chaque méthode DML.
3. **`OracleDatabase.ts` (2332 lignes)** : injections cachées par duck-typing
   (`session as unknown as { _awrManager... }`) qui contournent le typage ; double suivi
   des sessions avec `OracleInstance`.
4. **`SQLPlusSession.ts` (1415 lignes)** : logique de routage SQL/PLSQL partiellement
   dupliquée avec l'exécuteur.
5. **Écarts avec le vrai Oracle** :
   - `ROLLBACK TO SAVEPOINT` inexistant retournait silencieusement « complete » au lieu
     de lever `ORA-01086`.
   - Réutiliser un nom de savepoint ne déplaçait pas le savepoint (la position d'insertion
     d'origine était conservée par la `Map`), faussant l'effacement des savepoints
     postérieurs lors d'un rollback partiel.
   - Message `Rollback to savepoint X complete.` : SQL*Plus affiche `Rollback complete.`.
6. **Préexistant, à investiguer** : `SELECT * FROM sys.user$` dépasse 5 s (timeout) dans
   `oracle-access-management-comprehensive.test.ts` §12 — échec présent avant tout
   refactoring (vérifié sur le code de base).

---

---

## Entrées

### 2026-06-10 — Extraction de `TransactionManager` + conformité savepoints
**Défaillance :** l'état transactionnel (snapshots d'undo, savepoints, ids de transaction,
horodatage) vivait dans `OracleExecutor` — violation SRP dans une God class de 5167 lignes.
Trois écarts avec le vrai Oracle : pas d'`ORA-01086` sur savepoint inconnu, réutilisation
d'un nom de savepoint sans déplacement (ordre `Map` figé à la première insertion → effacement
erroné des savepoints postérieurs), message non conforme à SQL*Plus.
**Correction :** nouveau module `src/database/oracle/transaction/TransactionManager.ts`
qui possède le cycle de vie complet (begin implicite au premier DML, commit, rollback,
savepoints). Dépend d'une interface minimale `SnapshotableStorage` (DIP) et notifie un
`TransactionObserver` injecté — l'exécuteur garde la publication des événements
`oracle.transaction.*`. `executeCommit/Rollback/Savepoint` deviennent des délégations
de 2-3 lignes. `ROLLBACK TO SAVEPOINT` inconnu lève désormais `ORA-01086: savepoint 'X'
never established in this session or is invalid` ; `SAVEPOINT name` réutilisé déplace le
savepoint (delete + set) ; les messages alignés sur SQL*Plus (`Rollback complete.`).
**Validation :** `npx tsc --noEmit` propre ; `vitest run src/__tests__/unit/database/` :
2519/2520 (l'unique échec est le timeout préexistant §12 documenté ci-dessus, reproduit
à l'identique sur le code de base).

### 2026-06-10 — Extraction de `PrivilegeEnforcer` + déduplication GRANT/REVOKE
**Défaillance :** trois problèmes liés dans `OracleExecutor` :
(a) les règles de décision des erreurs de privilèges (ORA-01031 / ORA-00942 /
ORA-01917 / ORA-01934) étaient enfouies dans la God class ;
(b) code dupliqué à l'identique entre `executeGrant` et `executeRevoke` : validation
des grantees (ORA-01917), expansion de `ALL PRIVILEGES`, détection de cycles de rôles ;
(c) accès aux structures **privées** du catalogue par duck-typing
(`this.catalog as OracleCatalog & { tabPrivileges: ... }`) avec **mutation directe**
des lignes de privilèges (`row.grantable = false`) — contournement du typage et de
l'encapsulation, alors que `OracleCatalog` exposait déjà des accesseurs publics
(`getTablePrivilegeGrants()`, `getRoleGrants()`, `getSysPrivilegeGrants()`,
`getStoredUnits()`).
**Correction :**
- Nouveau `src/database/oracle/security/PrivilegeEnforcer.ts` : possède
  `requireSystemPrivilege`, `requireSchemaOrAnyPrivilege`, `requireObjectAccess`
  (règle d'« information hiding » d'Oracle : ORA-00942 préféré à ORA-01031 quand
  l'utilisateur n'a aucun droit sur l'objet), plus les règles partagées
  `assertGranteesExist`, `assertNoCircularRoleGrant`,
  `requireGrantableObjectPrivileges` (WITH GRANT OPTION).
- `BaseCatalog` : ajout des mutateurs `stripSystemGrantOption`,
  `stripTableGrantOption`, `stripRoleAdminOption` pour `REVOKE {GRANT|ADMIN} OPTION
  FOR` — la mutation des lignes de privilèges appartient au catalogue, plus à
  l'exécuteur.
- `executeGrant`/`executeRevoke` réécrits : ~90 lignes dupliquées supprimées,
  plus aucun cast de duck-typing, helpers partagés `granteesOf` /
  `expandSystemPrivileges` / `assertGrantableObjectExists`.
**Validation :** `npx tsc --noEmit` propre ; `vitest run src/__tests__/unit/database/` :
2520/2520 (y compris les 817 cas de `oracle-access-management-comprehensive.test.ts`).

### 2026-06-10 — Registre de fonctions SQL (suppression du switch de 400 lignes)
**Défaillance :** `OracleExecutor.evaluateFunction` était un dispatcher monolithique de
~400 lignes (switch sur ~70 fonctions SQL : chaînes, numériques, dates, conversion,
système, paquets DBMS_*). Ajouter une fonction exigeait de modifier la God class
(violation Open/Closed). Les helpers de dates (`formatOracleDate`, `parseOracleDate`,
`coerceDate`, `formatDate`, `implicitToDate`, `compareValues`) étaient enfouis dans
l'exécuteur alors qu'ils sont purs.
**Correction :** nouveau module `src/database/oracle/functions/` sur le modèle du
`PackageRegistry` existant (pattern Strategy + registre, comme `views/registry.ts`) :
- `types.ts` — contrat `SqlFunction(call, ctx)` ; le contexte n'expose que le strict
  nécessaire (utilisateur courant, schéma, provider USERENV, délégué
  `getMetadataDDL` pour DBMS_METADATA qui a besoin du storage).
- `valueUtils.ts` — utilitaires purs partagés (comparaison Oracle 3 voies avec règles
  de conversion implicite et tri des NULL, formats de dates NLS).
- `stringFunctions.ts`, `numericFunctions.ts`, `dateFunctions.ts`,
  `systemFunctions.ts` — implémentations groupées par domaine ; les fonctions de
  paquets (DBMS_RANDOM.VALUE, DBMS_UTILITY.GET_TIME, …) vérifient leur qualificateur
  via le combinateur `inPackage` (comportement historique préservé : appel non
  qualifié → NULL).
- `registry.ts` — résolution par nom ; inconnu → l'exécuteur lève ORA-00904
  (`invalid identifier`), comme le vrai Oracle.
`OracleExecutor` passe de 5167 (départ) à 4470 lignes ; `evaluateFunction` fait
désormais 20 lignes.
**Validation :** `npx tsc --noEmit` propre ; `vitest run src/__tests__/unit/database/` :
2519/2520 — l'unique échec est le timeout flaky préexistant §12 (`SELECT * FROM
sys.user$`, 5,17 s pour un seuil de 5 s ; passait à l'étape 2, échouait sur le code de
base ; toujours sur la liste à investiguer).

### 2026-06-10 — `SYS.USER$` : 1011 ms → 3,5 ms (vérificateurs de mots de passe)
**Défaillance :** la requête `SELECT * FROM sys.user$` prenait ~1 s pour 12 utilisateurs
(et >5 s dans la grande suite — source du timeout flaky §12). Cause racine en trois
couches :
1. **Écart avec le vrai Oracle** : les vérificateurs 10g/11g/12c étaient *re-dérivés à
   chaque requête* du dictionnaire, alors qu'Oracle les calcule une seule fois au
   `CREATE USER`/`ALTER USER` et les stocke dans `USER$`.
2. Le vérificateur 12c (`T:`) coûte un PBKDF2-HMAC-SHA512 à 4096 itérations en pur
   TypeScript (~144 ms) — par utilisateur, par requête.
3. PBKDF2 recompressait les deux blocs de clé HMAC (ipad/opad) à chaque itération,
   faute d'API de hachage incrémentale : 4 compressions SHA-512 par itération au lieu
   de 2.
**Correction :**
- `crypto/hash/HashAlgorithm.ts` : capacité optionnelle `ResumableHashAlgorithm`
  (état de chaînage Merkle–Damgård exposé : `initState`/`compressBlocks`/
  `finalizeState`) — extension pure, l'interface `HashAlgorithm` est inchangée.
- `crypto/hash/sha512.ts` : restructuré autour de `compressBlocks(state, blocks)` +
  `finalizeState` (le one-shot `sha512()` est désormais une composition) ; buffers de
  message-schedule partagés au niveau module.
- `crypto/kdf/pbkdf2.ts` : PRF avec états ipad/opad précalculés quand le hash est
  résumable (fallback inchangé sinon) → **144 ms → 65 ms** pour 4096 itérations.
- `security/storedVerifier.ts` : mémoïsation process-wide bornée (la dérivation est
  déterministe par construction — sel dérivé des credentials).
- `OracleCatalog.setPassword` : réchauffe la dérivation au moment du mot de passe —
  sémantique du vrai Oracle (vérificateurs stockés à l'écriture, lus par les requêtes).
  Les utilisateurs par défaut passent désormais par `setPassword` (memo → coût payé
  une fois par processus, pas par instance de base).
- `views/sys_user.ts` : suppression d'un duck-cast inutile (`getStoredPassword` est
  public sur `OracleCatalog`).
**Résultat mesuré :** `SELECT * FROM sys.user$` : 1011 ms → **3,5 ms**. Le timeout
flaky §12 est éliminé à la racine.
**Validation :** `npx tsc --noEmit` propre ; 181 tests vectoriels crypto (openssl/
hashcat) verts ; `unit/database/` + `crypto/` + `ipsec-algorithms` + `wan-vpn` :
2861/2861.

### 2026-06-10 — Suppression des injections cachées session → paquets DBMS_*
**Défaillance :** `OracleDatabase.openSession` faisait de la contrebande de managers
en écrivant des champs invisibles sur chaque `OracleSession` via
`session as unknown as { _awrManager; _resourceManager; _statisticsManager;
_statisticsManagerStorage; _schedulerManager }`. Les paquets `DBMS_STATS`,
`DBMS_WORKLOAD_REPOSITORY`, `DBMS_RESOURCE_MANAGER` et `DBMS_SCHEDULER` les
relisaient par les mêmes casts. Aucun contrat typé : un renommage silencieusement
cassant, des dépendances invisibles, et l'objet session pollué par des
responsabilités qui ne sont pas les siennes.
**Correction :** `PackageCallContext` (le contrat Strategy existant du
`PackageRegistry`) gagne un champ `services: PackageServices` typé (awr,
resourceManager, statistics, scheduler, storage — tous optionnels, imports
type-only donc pas de cycle). `OracleDatabase` construit le bundle au point
d'invocation (`packageServices()`), les quatre accesseurs des paquets lisent
`ctx.services.*`. Plus aucun champ caché sur la session.
**Validation :** `npx tsc --noEmit` propre ; `unit/database/` : 2520/2520.

### 2026-06-10 — Extraction de `ConstraintValidator` + cache des expressions CHECK
**Défaillance :** la validation d'intégrité (NOT NULL/PK → ORA-01400, UNIQUE →
ORA-00001, FK → ORA-02291/02292 avec actions CASCADE/SET NULL, CHECK → ORA-02290,
types → ORA-12899/01438) vivait dans l'exécuteur. Pire : l'expression CHECK était
**re-parsée à chaque ligne** de chaque INSERT/UPDATE — instanciation d'un
`OracleLexer` + `OracleParser` par ligne, dernier vestige de « parsing en cours
d'exécution » dans l'exécuteur.
**Correction :** nouveau `src/database/oracle/constraints/ConstraintValidator.ts` :
- possède les trois validations (`validateConstraints`, `validateDataTypes`,
  `validateDeleteForeignKeys`), dépend de `BaseStorage` et d'un délégué
  `ConditionEvaluator` injecté (l'évaluation d'expressions reste à l'exécuteur) ;
- les prédicats CHECK sont parsés **une fois par expression distincte** et mis en
  cache (borné, FIFO) ;
- comparaisons via le `compareValues` pur de `functions/valueUtils`.
Les imports `OracleLexer`/`OracleParser` disparaissent de l'exécuteur (4327 lignes,
−840 depuis le départ).
**Validation :** `npx tsc --noEmit` propre ; `unit/database/` : 2520/2520.

### 2026-06-11 — Packages PL/SQL utilisateur : un vrai runtime (GAP §10.6 clos)
**Défaillance :** `CREATE PACKAGE [BODY]` était accepté mais les packages étaient
inutilisables — le dernier gap « Majeur » encore ouvert du GAP §10 :
1. Les membres étaient extraits du corps par **regex** vers des unités autonomes
   sans aucune portée commune : les variables de package (`g_counter` du spec,
   privées du corps) levaient `PLS-00201` au premier appel — l'état de package
   n'existait tout simplement pas.
2. Les membres privés du corps étaient soit inaccessibles aux membres publics,
   soit exposés à l'extérieur (aucune notion de visibilité spec/corps).
3. `pkg.variable` lu depuis un bloc externe retournait NULL en silence ;
   l'écriture était impossible ; les constantes étaient assignables.
4. Corps manquant → `PLS-00201` au lieu d'`ORA-04067` ; recompilation → l'état
   périmé survivait au lieu d'`ORA-04068` ; le bloc d'initialisation du corps
   (`BEGIN … END pkg;`) n'était jamais exécuté.
5. **SQL*Plus exécutait la 1re ligne** d'un `CREATE PACKAGE` multi-ligne comme
   un statement complet (le corps contient des `;`), puis crachait `SP2-0734`
   sur chaque ligne suivante — toute création interactive d'unité PL/SQL
   multi-ligne était impossible dans le terminal.
6. `DESCRIBE pkg` n'affichait pas les sous-programmes ; `DBA_PROCEDURES`
   listait les membres avec `OBJECT_NAME='PKG.MEMBER'` au lieu du couple
   (`OBJECT_NAME`=package, `PROCEDURE_NAME`=membre) d'Oracle 19c.
**Correction :** suppression totale de l'extraction regex ; spec et corps sont
compilés par le **vrai parser PL/SQL** et exécutés dans une **portée d'instance
de package par session** — le mécanisme existant des sous-programmes locaux
fait alors naturellement la résolution des variables, des privés et des appels
croisés (zéro duplication d'interpréteur) :
- `PlsqlParser.parsePackageSection` — nouvelle production : déclarations +
  bloc d'initialisation optionnel + `END [name]` (gère les forward
  declarations du spec, déjà supportées par `parseSubprogram`).
- Nouveau `plsql/PackageUnit.ts` — compilation (`compilePackageSection`,
  erreurs → `USER_ERRORS`/`SHOW ERRORS`), contrat `PackageRuntimeHandle`
  (déclarations fusionnées spec→corps, `publicNames` du spec, version,
  état de session opaque).
- `PlsqlHost.resolvePackage` (optionnel) + interpréteur : instanciation
  paresseuse (déclarations puis bloc init, comme Oracle), appels
  `pkg.proc`/`pkg.fn` depuis PL/SQL et SQL, lecture/écriture `pkg.var`,
  `PLS-00302` pour les privés, `PLS-00363` pour les constantes,
  `ORA-04067`+`ORA-06508` si corps absent (sans instancier l'état),
  `ORA-04068`+`ORA-04061` une fois après recompilation puis reprise propre.
- `OracleDatabase` : registre `userPackages` versionné, état par session via
  `WeakMap<executor>`, visibilité EXECUTE alignée sur les unités stockées
  (information hiding), `PLS-00304` pour un corps sans spec, `ORA-00955`
  pour un `CREATE PACKAGE` sans `OR REPLACE` sur un nom existant.
- `SQLPlusSession` : mode « unité PL/SQL » fidèle — `CREATE [OR REPLACE]
  PROCEDURE|FUNCTION|PACKAGE [BODY]|TRIGGER` multi-ligne est collecté
  jusqu'au `/` terminal (jamais d'auto-exécution sur un `END;` de membre,
  comportement du vrai SQL*Plus) ; les DDL mono-ligne `… END;` restent
  exécutés immédiatement (compatibilité). `DESCRIBE` liste les
  sous-programmes publics avec leur table d'arguments.
- Dictionnaire : `DBA_PROCEDURES` expose les membres au format 19c via un
  provider dédié (`setPackageMembersProvider`) ; `DBA_OBJECTS`/`DBA_SOURCE`
  inchangés (les entrées PACKAGE/PACKAGE BODY restent dans `storedUnits`).
**Validation :** `npx tsc --noEmit` propre ; nouvelle suite
`oracle-user-packages.test.ts` (26 tests : état par session et par session
distincte, init block, constantes, privés depuis SQL/PLSQL, 04067/04068,
DROP spec/corps, DBA_*, DESCRIBE, erreurs de compilation, multi-ligne `/`) ;
`unit/database/` : **2619/2619** ; `unit/terminal*` : 451/451 ; ESLint propre.

### 2026-06-11 — Fonctions analytiques : registre + écarts Oracle corrigés
**Défaillance :** `computeWindowValue` était un switch monolithique de ~190 lignes
dans la God class `OracleExecutor` (violation Open/Closed : ajouter une fonction
analytique = modifier l'exécuteur), avec quatre écarts vis-à-vis du vrai Oracle :
1. `RANK` recalculait le rang **depuis le début de la partition pour chaque
   ligne** (O(n²) par partition, O(n³) au pire) ;
2. `MIN`/`MAX` fenêtrés passaient par `Math.min`/`Math.max` — résultat faux
   (NaN→NULL) sur VARCHAR2 et DATE, alors qu'Oracle ordonne tout type ;
3. `PERCENT_RANK` et `CUME_DIST` (analytiques standard) n'existaient pas ;
4. une fonction analytique **inconnue produisait NULL en silence** au lieu
   d'`ORA-00904: invalid identifier`.
**Correction :** nouveau `functions/windowFunctions.ts` sur le pattern registre
déjà établi (`functions/registry`, `views/registry`, `PackageRegistry`) :
- contrat `WindowPartition` **vectorisé par partition** (une implémentation
  reçoit la partition ordonnée et rend une valeur par position) — `RANK`,
  `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST` deviennent des balayages cumulés
  O(n) ; l'exécuteur garde le partitionnement, le tri et la résolution de
  frame (`resolveFramePositions`, désormais en positions pures) ;
- 16 fonctions enregistrées : ROW_NUMBER, RANK, DENSE_RANK, PERCENT_RANK,
  CUME_DIST, NTILE, LAG/LEAD (factorisés en `lagLead(direction)`),
  FIRST/LAST/NTH_VALUE, COUNT/SUM/AVG et MIN/MAX via le comparateur Oracle
  trois voies (chaînes et dates correctes) ;
- nom inconnu → `ORA-00904`, comme le vrai moteur.
`OracleExecutor` : −160 lignes, le switch disparaît au profit d'une délégation.
**Validation :** `npx tsc --noEmit` propre ; `oracle-phase4.test.ts` étendu
(PERCENT_RANK, CUME_DIST avec et sans ex æquo, MIN/MAX OVER sur VARCHAR2,
ORA-00904) : 73/73 ; `unit/database/` : **2624/2624**.

### 2026-06-11 — Data Pump réel (expdp/impdp) + adrci branché sur l'alert log
**Défaillance :** deux outils Oracle du terminal mentaient sur l'état simulé :
1. `impdp` affichait « imported … rows » **sans rien restaurer** : le fichier
   dump écrit par `expdp` était un marqueur cosmétique (`[ORACLE DATA PUMP
   DUMP - n tables…]`), l'import se contentait de re-parser ce texte pour
   afficher des compteurs. Le workflow DBA export → drop → import — central
   dans un lab — était donc factice. `REMAP_SCHEMA` n'était qu'un message,
   `TABLE_EXISTS_ACTION` n'existait pas.
2. `adrci SHOW ALERT` répondait « No alert log entries found in simulated
   environment » alors que l'instance maintient un véritable alert log
   (`logAlertEvent`/`getAlertLog`), déjà matérialisé sur le VFS par
   `OracleFilesystemSync`.
**Correction :**
- Nouveau `src/database/oracle/datapump/DataPumpEngine.ts` (sous-système
  conforme à l'arborescence oracle/) : `export()` sérialise métadonnées de
  tables (colonnes, contraintes, tablespace) et lignes (Dates encodées pour
  le round-trip JSON) ; `import()` recrée réellement les tables via l'API
  storage avec la sémantique Oracle : `TABLE_EXISTS_ACTION`
  SKIP (défaut, `ORA-31684`) / APPEND / TRUNCATE / REPLACE, `REMAP_SCHEMA`
  effectif, utilisateur cible inexistant → `ORA-39083`+`ORA-01918` par objet
  (pas de création magique de schéma) ; FULL exclut les schémas dictionnaire.
- `OracleCommands` : expdp écrit le dump réel sur le VFS (le fichier EST le
  transport), impdp le relit (`ORA-39000/39143` si contenu étranger), les
  deux journalisent les lignes par table dans le logfile.
- `adrci SHOW ALERT [-TAIL n]` lit le vrai alert log de l'instance.
**Validation :** `linux-commands-and-oracle-tools.test.ts` étendu (round-trip
export→drop→import avec comptes de lignes, SKIP/APPEND/TRUNCATE, REMAP vers
user existant/absent, dump étranger rejeté, adrci marqueur + -TAIL) : 66/66 ;
suites adjacentes (filesystem, ssh-lan) : 77/77 ; `npx tsc --noEmit` propre.

### 2026-06-12 — Authentification OS réelle pour `/ AS SYSDBA` (bequeath)
**Défaillance :** incohérence majeure entre la couche Oracle et la couche
identité/accès du Linux simulé. Le moteur possédait déjà le garde-fou
(`connectAsSysdba(osCtx)` → ORA-01031 si `!osCtx.isDbaGroup`), mais la couche
terminal ne lui transmettait **jamais** la réalité : `SQLPlusSession.login`
appelait `connectAsSysdba()` sans argument, donc tout `sqlplus / as sysdba`
réussissait quel que soit l'utilisateur shell — `su eve` puis
`sqlplus / as sysdba` donnait les pleins pouvoirs SYS, là où le vrai Oracle
vérifie l'appartenance au groupe OS `dba` (authentification bequeath).
S'ajoutaient trois écarts secondaires : (1) aucun utilisateur `oracle` ni
groupe `dba`/`oinstall` n'existait sur l'hôte (l'audit trail affichait un
OSUSER `oracle` fantôme) ; (2) V$SESSION.OSUSER et DBA_AUDIT_TRAIL.OS_USERNAME
montraient le contexte par défaut codé en dur au lieu du vrai utilisateur ;
(3) un refus SYSDBA ne laissait aucune trace (le vrai Oracle journalise tout
logon privilégié refusé : audit OS + alert log).
**Correction :**
- `SqlPlusSubShell.captureOsContext` — au lancement, snapshot de l'identité
  réelle du shell via la surface existante (`getCurrentUser()` de
  `ShellIdentityHost`, `id -Gn`, `hostname`) — comme un vrai process sqlplus
  hérite de l'uid/groupes du shell qui l'exec.
- `SQLPlusSession.setOsContext` — le contexte est porté par la session et
  utilisé par **tous** les chemins de login (lancement + `CONNECT` en cours
  de session) ; les tests moteur sans device gardent le contexte par défaut.
- `initOracleFilesystem` provisionne l'identité OS qu'une vraie installation
  crée (`oracle-database-preinstall`) : groupes `oinstall` (54321) /
  `dba` (54322), utilisateur `oracle` (54321, home, bash) — via les
  commandes shell du device (groupadd/useradd/usermod), donc /etc/passwd,
  /etc/group et les événements IAM restent cohérents. Choix de lab assumé et
  documenté : le cast opérateur pré-seedé (root, alice, bob, carl, dave) est
  enrôlé dans `dba` pour que les topologies existantes continuent de
  fonctionner ; tout **nouveau** compte est hors dba → ORA-01031 réel.
- `OracleDatabase.rejectOsAuthentication` — un refus SYSDBA/SYSOPER laisse
  désormais une trace fidèle : entrée d'audit LOGON returncode 1031 avec
  SESSIONID 0 (marqueur Oracle « aucune session ouverte »), alert log, et
  événement `oracle.connection.traced` outcome FAILURE.
**Validation :** nouvelle suite `oracle-os-authentication.test.ts` (8 tests :
refus moteur SYSDBA/SYSOPER, audit du refus, provisioning `id oracle`,
root connecté, cycle `su eve` → ORA-01031 → `usermod -aG dba eve` → Connected
avec V$SESSION.OSUSER=eve, OS_USERNAME réel dans DBA_AUDIT_TRAIL) ;
non-régression `unit/database/` + `unit/shell/` + `unit/terminal/` ;
`npx tsc --noEmit` propre.

### 2026-06-12 — Listener TNS : socket 1521 et processus tnslsnr pilotés par l'état réel
**Défaillance :** le listener était un simple booléen en mémoire, incohérent
avec les trois tables OS que tout DBA inspecte :
1. TCP 1521 était pré-lié au boot (`initDefaultSockets`, pid figé 2001) et
   **survivait à `lsnrctl stop`** — `netstat`/`ss` montraient un port à
   l'écoute alors que `tnsping` répondait ORA-12541 ;
2. aucun processus `tnslsnr` n'existait jamais dans `ps`, alors que les
   processus background de l'instance (pmon, smon…) y figurent ;
3. `oracle-listener-<SID>.service` (installé par OracleSystemdSync) ouvrait
   un wrapper shell sans lien avec le port — la `ServicePortProjection`
   existante (qui fait exactement ce travail pour ssh/nginx/mysql…) ne
   connaissait pas les unités au nom dynamique.
**Correction :** réutilisation du mécanisme existant plutôt qu'un canal ad hoc
(consigne « pas de duplication, enrichir l'existant ») :
- `LinuxServiceManager.registerServiceListener(name, spec)` — registre
  dynamique consulté en priorité sur la table statique `SERVICE_LISTENERS`
  (daemon-reload stampe les sockets, `getPortBinding` les sert à la
  projection) ; `ServiceListenerSpec.daemonCommand` optionnel : le process
  laissé en vie par l'unité quand il diffère d'ExecStart (`lsnrctl start`
  n'est qu'un lanceur, le daemon est `tnslsnr LISTENER -inherit` — c'est
  lui que `ps` doit montrer).
- `LinuxMachine.installSystemdUnit` accepte la déclaration listener et
  l'enregistre avant le daemon-reload.
- `OracleSystemdSync.listenerUnit()` déclare `tnslsnr` + TCP 1521. La chaîne
  devient : `lsnrctl stop` → événement bus oracle.listener.event →
  service inactive → `linux.service.stopped` → projection libère 1521 et
  SIGTERM le tnslsnr ; `lsnrctl start` → l'inverse, avec le vrai mainPid
  dans netstat/ss (plus jamais le pid placebo 2001 après un cycle).
**Validation :** nouvelle suite `oracle-listener-network-coherence.test.ts`
(4 tests : état initial cohérent, stop → port libéré + tnslsnr tué +
unité inactive + TNS-12541, start → re-bind avec pid vivant, accord ss ↔
netstat) ; non-régression `unit/database/` + suites services/ports
network-v2 ; `npx tsc --noEmit` et ESLint propres (au passage : purge des
4 échappements `\$` inutiles préexistants dans database.ts).

### 2026-06-12 — systemctl pilote réellement l'instance et le listener (synchro inverse)
**Défaillance :** la synchronisation Oracle ⇄ systemd était unidirectionnelle.
`OracleSystemdSync` installait bien `oracle-database-<SID>.service` /
`oracle-listener-<SID>.service` quand le moteur changeait d'état, mais dans
l'autre sens `systemctl start/stop oracle-…` ne faisait que spawner/tuer un
wrapper shell : le moteur Oracle n'en savait rien. Conséquence directe après
l'entrée précédente : `systemctl stop oracle-listener-ORCL` tuait tnslsnr et
libérait le port (projection), mais `lsnrctl status` répondait encore
« running » et `attemptConnect` acceptait les connexions — un état
schizophrène impossible sur une vraie machine où l'unité et lsnrctl pilotent
le même daemon. Idem pour la base : `systemctl stop oracle-database-ORCL`
laissait l'instance OPEN avec ses pmon/smon fantômes.
**Correction :**
- `OracleSystemdSync` s'abonne aussi à `linux.service.started/restarted/
  stopped` et pilote le moteur : unité listener → `startListener()`/
  `stopListener()`, unité database → `startup()`/`shutdown('IMMEDIATE')`
  (sémantique dbstart/dbshut). Ctx étendu d'un `resolveDatabase` optionnel
  (même pattern que `OracleFilesystemSync`).
- Convergence sans boucle par **idempotence des deux côtés** : chaque
  handler vérifie d'abord l'état cible (no-op si déjà atteint), et le
  service manager n'émet aucun événement pour un start/stop no-op — un
  aller-retour se termine toujours en un cycle. Documenté en tête d'adapter.
- Au passage, correction du sens aller : seuls les états terminaux pilotent
  l'unité database (OPEN → active, SHUTDOWN → inactive). Avant, les phases
  transitoires NOMOUNT/MOUNT d'un même STARTUP flappaient l'unité par
  `inactive` — avec la synchro inverse, ce flap aurait rappelé
  `shutdown()` en plein démarrage.
**Validation :** nouvelle suite `oracle-systemd-reverse-sync.test.ts`
(5 tests : stop/start listener via systemctl avec accord netstat +
attemptConnect, stop/start database avec disparition/retour des ora_pmon
dans ps et alert log « immediate », SHUTDOWN/STARTUP SQL*Plus → unité
cohérente sans boucle) ; non-régression `unit/database/` + `unit/shell/` +
suites services network-v2 ; `npx tsc --noEmit` propre.

### 2026-06-12 — Datafiles ⇄ filesystem hôte : ORA-01157 réel et RESTORE qui restaure
**Défaillance :** les copies VFS des datafiles étaient un décor en écriture
seule, avec quatre mensonges en cascade :
1. `rm users01.dbf` depuis bash n'avait **aucune** conséquence : Oracle ne
   relisait jamais le disque, STARTUP ouvrait toujours ;
2. pire, la resynchronisation sur chaque changement d'état
   (`OracleFilesystemSync.syncDatafiles`) **ressuscitait** le fichier
   supprimé au prochain MOUNT ;
3. `RMAN RESTORE` n'écrivait **rien** sur le disque (événements de
   progression seulement) — le workflow de récupération était théâtral ;
4. `LinuxRmanContext.getDatafiles()` retournait une liste figée de 4
   fichiers : un tablespace créé après le boot était invisible pour RMAN
   et ses FILE# pouvaient diverger de V$DATAFILE.
**Correction :**
- `OracleStorage.listDatafiles()` — énumération canonique (FILE# séquentiel,
  ordre tablespace, temp exclus, sémantique V$DATAFILE), source unique
  partagée par le contexte RMAN et le contrôle d'ouverture de l'instance.
- `OracleInstance` : à l'ouverture (STARTUP → OPEN et ALTER DATABASE OPEN),
  vérification d'existence de chaque datafile sur le filesystem hôte via
  deux injections (lister fourni par OracleDatabase, sonde d'existence
  fournie par le câblage terminal — null = pas de filesystem, contrôle
  sauté pour les tests moteur purs). Fichier manquant → la vraie échelle
  d'erreurs (`ORA-01157` + `ORA-01110`, première occurrence, trace alert
  log) et l'instance **reste MOUNT** pour RESTORE/RECOVER. Un `rm` sur
  instance ouverte reste sans effet (sémantique inode ouvert du vrai Linux).
- `OracleFilesystemSync` : matérialisation **une seule fois** par chemin
  (set par device, amorcé au boot via `primeDatafiles`, alimenté par les
  événements tablespace-created/datafile-added) — le VFS devient
  l'autorité sur l'existence, un `rm` n'est plus annulé.
- `RmanJobEngine._doRestore` : RESTORE réécrit réellement chaque datafile
  ciblé sur le VFS (c'est tout l'objet d'un restore).
- `LinuxRmanContext.getDatafiles()` : dérive du storage vivant quand une
  base est enregistrée (fallback figé conservé pour les devices sans
  Oracle, contextes de test).
**Validation :** nouvelle suite `oracle-datafile-vfs-coherence.test.ts`
(4 tests : instance ouverte insensible au rm, non-résurrection après
shutdown/startup, STARTUP bloqué en MOUNT avec ORA-01157/01110 exacts,
boucle DBA complète backup → rm → MOUNT → restore datafile 4 → ALTER
DATABASE OPEN) ; non-régression `unit/database/` + `unit/terminal/` +
`debug/rman/` + `debug/oracle/` ; `npx tsc --noEmit` propre.

### 2026-06-12 — Vues matérialisées réelles (clôt GAP §10.7 côté MV)
**Défaillance :** `CREATE MATERIALIZED VIEW` était un stub menteur :
« Materialized view created. » sans créer le moindre objet — `SELECT` sur la
MV échouait en ORA-00942, `DBA_MVIEWS` restait éternellement vide, `DROP
MATERIALIZED VIEW` « réussissait » sur du vide, et les clauses
BUILD/REFRESH étaient jetées par le parseur.
**Correction :**
- Parseur : capture de `BUILD IMMEDIATE|DEFERRED`, `REFRESH COMPLETE|FORCE
  [ON DEMAND|COMMIT]` et du texte de la requête (les clauses de stockage
  inconnues restent tolérées, compatibilité scripts).
- Exécuteur : `CREATE MATERIALIZED VIEW` exécute la requête définissante
  dans une **vraie table conteneur** (réutilisation du chemin CTAS existant
  — c'est ce qui rend `SELECT` fonctionnel ensuite), privilèges `CREATE
  [ANY] MATERIALIZED VIEW` exigés, `ORA-00955` sur doublon ; `BUILD
  DEFERRED` → conteneur vide, STALENESS=UNUSABLE ; `DROP` supprime conteneur
  + dictionnaire, `ORA-12003` si absent.
- Catalogue : registre `MaterializedViewMeta` (requête AST + texte, modes,
  tables de base extraites de l'AST — FROM/JOIN/CTE/sous-requêtes FROM,
  lastRefresh, staleness). Au choke point DML existant (`emitDml`), tout
  DML sur une table de base bascule les MV dépendantes à **STALE** — la MV
  reste un snapshot (sémantique Oracle), le dictionnaire dit la vérité.
- `DBMS_MVIEW.REFRESH` : nouveau package builtin (pattern
  `PackageRegistry` établi), service `materializedViews` injecté par
  `OracleDatabase` — refresh complet ré-exécutant la requête avec la
  résolution de noms du **propriétaire** (sémantique definer du vrai
  package), retour à FRESH, `ORA-12003` sur MV inconnue. Routé pour `EXEC`
  et pour les blocs `BEGIN…END` (même routeur).
- `DBA_MVIEWS` branchée sur le registre vivant (+ colonnes QUERY,
  LAST_REFRESH_DATE).
**Limites assumées :** refresh toujours COMPLETE (pas de log MV/fast
refresh), `ON COMMIT` accepté mais non déclencheur (pas de hook commit par
session sur les tables de base), pas de query rewrite.
**Validation :** nouvelle suite `oracle-materialized-views.test.ts`
(9 tests : conteneur interrogeable, DBA_MVIEWS, ORA-00955, BUILD DEFERRED
vide+UNUSABLE, snapshot + bascule STALE sur DML, REFRESH→FRESH avec
nouvelles données, ORA-12003 ×2, DROP complet) ; non-régression
`unit/database/` complète ; `npx tsc --noEmit` propre.

### 2026-06-12 — DB links persistés au catalogue (clôt GAP §10.7)
**Défaillance :** seconde moitié du §10.7 : `CREATE [PUBLIC] DATABASE LINK`
renvoyait « Database link created. » sans rien créer — `DBA_DB_LINKS`
restait vide à jamais, `DROP DATABASE LINK` « réussissait » sur de
l'inexistant, un nom dupliqué passait en silence. Un script DBA qui vérifie
son travail dans le dictionnaire était systématiquement trompé.
**Correction :** registre `DbLinkMeta` dans `OracleCatalog` (owner —
`PUBLIC` pour les liens publics —, CONNECT TO user, USING host, created) ;
exécuteur : privilèges `CREATE [PUBLIC] DATABASE LINK` exigés, `ORA-02011`
sur doublon, `ORA-02024` sur DROP d'un lien absent ; `DBA_DB_LINKS`
branchée sur le registre vivant. Les tests qui verrouillaient le stub
(DROP silencieux sur du vide) assertent désormais le comportement réel.
**Limite assumée (documentée dans GAP.md)** : pas de dispatch de requêtes
cross-link (`SELECT … FROM t@link`) — le dictionnaire, lui, ne ment plus.
**Validation :** `oracle-remaining-features.test.ts` réécrit (4 tests DB
links : persistance DBA_DB_LINKS, owner PUBLIC, ORA-02011, drop +
ORA-02024) ; non-régression `unit/database/` complète ; `npx tsc --noEmit`
propre. GAP.md §10.7 marqué ✅ CORRIGÉ.

### 2026-06-12 — Oracle Net traverse le réseau simulé (sqlplus/tnsping distants)
**Défaillance :** la plus grosse incohérence Oracle ↔ couche réseau restante :
`sqlplus user/pass@X` **supprimait** l'identifiant de connexion (`password
= password.replace(/@.*$/, '')`) et atterrissait toujours sur l'instance
LOCALE. Conséquences : impossible d'atteindre une base sur une autre
machine de la topologie (cas d'usage central d'un simulateur réseau), un
service inexistant « se connectait » quand même au lancement, le fichier
`tnsnames.ora` écrit par le provisioning n'était jamais consulté, et
`tnsping` ne connaissait que l'alias local (TNS-03505 pour tout le reste).
**Correction :** nouveau client Oracle Net côté terminal
(`src/terminal/commands/oracleNet.ts`), même politique de résolution que le
client SSH (helpers extraits de `sshLauncher` dans `src/shell/hostResolution.ts`
— partage, zéro duplication) :
- parsing EZConnect (`//host[:port]/service`, `host:port/service`) et
  **résolution d'alias dans le vrai tnsnames.ora du device client** (éditer
  le fichier au vi change réellement la résolution) ;
- échelle d'erreurs réelle : ORA-12154 (alias inconnu), ORA-12545 (hôte
  introuvable), ORA-12170 (hôte éteint), ORA-12541 (pas de listener /
  mauvais port / cible non-serveur), puis délégation au listener CIBLE
  pour ORA-12514/12528 — et incrément de ses compteurs established/refused ;
- la session SQL*Plus se **lie à l'OracleDatabase distante** ; le `CONNECT
  user/pass@X` en cours de session re-bind la session via un résolveur
  injecté (`setTnsResolver`, même pattern que setFileIO/setHostCommandRunner
  — la couche database n'importe jamais Equipment) ;
- `tnsping` résout alias + EZConnect, distingue adaptateur TNSNAMES/EZCONNECT,
  et — comme le vrai — répond OK même pour un service inconnu (il ne sonde
  que le listener, pas le CONNECT_DATA) ;
- au passage : correction du parsing `user/pass@id` qui tronquait au
  deuxième `/` (split('/', 2)) dans les deux chemins launch et CONNECT.
**Validation :** nouvelle suite `oracle-tns-remote.test.ts` (10 tests sur un
LAN à 2 serveurs + switch : marqueur distant visible via EZConnect et via
alias ajouté au tnsnames.ora, isolement local/distant, ORA-12514/12541/12545/
12154, cycle lsnrctl stop/start vu du client, CONNECT re-bind, tnsping OK →
TNS-12541) ; non-régression `unit/database/` + `unit/shell/` +
`unit/terminal/` ; `npx tsc --noEmit` et ESLint propres.

### 2026-06-12 — Requêtes cross-link réelles : SELECT … FROM table@dblink
**Défaillance :** dernier mensonge du GAP §10.7 : le parser capturait déjà
`@link` dans `TableRef.dbLink`… que l'exécuteur **ignorait silencieusement**
— `SELECT * FROM emp@remotedb` lisait la table LOCALE `emp` comme si le lien
n'existait pas (pire qu'une erreur : un résultat faux). Le mot de passe du
`CONNECT TO … IDENTIFIED BY` était jeté au parsing, et la valeur `USING`
était stockée avec ses quotes (`"'//host/svc'"`), rendant toute résolution
impossible.
**Correction :** chaîne complète, en réutilisant les briques des deux items
précédents (liens au catalogue + client Oracle Net) :
- parser : capture (et déquote) du mot de passe et du `USING` ;
- `SqlCommandHost.fetchDbLinkRows` — nouvelle couture entre l'exécuteur et
  la base : `loadTable` (point d'étranglement unique des row-sources) y
  route toute référence portant un dbLink ;
- `OracleDatabase.fetchDbLinkRows` : résolution du lien (courant puis
  PUBLIC, sinon **ORA-02019**), résolution réseau du `USING` via un
  résolveur injecté (`setDbLinkResolver`, même pattern que
  setDeviceFileReader — le moteur n'importe jamais Equipment), puis
  **ouverture d'une vraie session distante** comme l'utilisateur du lien :
  les privilèges et vues s'appliquent CÔTÉ CIBLE, ORA-01017 si les
  credentials du lien sont faux, ORA-12541/12545/12170 si le réseau ou le
  listener cible est en cause, session fermée en finally ;
- câblage terminal : le `USING` se résout comme sqlplus@/tnsping (alias du
  tnsnames.ora local ou EZConnect, hôte distant de la topologie).
- au passage : un test alias validait par un faux positif (`/1/` matchait
  « ORA-12154 ») — durci vers une assertion de contenu réel.
**Limite assumée :** lecture seule (pas de DML over link), pas de
two-phase commit — documenté ici.
**Validation :** `oracle-tns-remote.test.ts` étendu à 15 tests (lien EZConnect
et lien alias-tnsnames lisant les lignes distantes, isolement local
ORA-00942, ORA-02019, ORA-01017 distant, listener cible coupé → ORA-12541) ;
non-régression `unit/database/` complète ; tsc + ESLint propres.

### 2026-06-12 — Vues matérialisées : REFRESH ON COMMIT effectif
**Défaillance :** la clause `REFRESH … ON COMMIT` était acceptée au parsing
et exposée dans `DBA_MVIEWS.REFRESH_MODE`, mais aucun mécanisme ne la
réalisait : après un `COMMIT`, une MV ON COMMIT restait STALE avec son
contenu d'avant-transaction — exactement le mensonge dictionnaire ↔
comportement que cette série corrige.
**Correction :** les quatre points de commit de l'exécuteur (COMMIT
explicite, commit implicite avant/après DDL, autocommit SQL*Plus) sont
centralisés dans `commitActiveTransaction()`, qui après `txn.commit()`
re-matérialise toute MV `refreshMode=COMMIT` encore STALE via le
`refreshMaterializedView` existant (réutilisation, pas de second moteur de
refresh). Une MV ON DEMAND reste STALE jusqu'à `DBMS_MVIEW.REFRESH`.
**Limite assumée :** un ROLLBACK laisse la MV marquée STALE (le vrai
Oracle ne l'aurait jamais marquée) — un refresh la remet correcte.
**Validation :** `oracle-materialized-views.test.ts` 12/12 (+3 : refresh au
COMMIT avec contenu et staleness vérifiés avant/après, ON DEMAND inchangé
au commit, commit implicite DDL déclencheur) ; tsc propre. Régression
globale reportée en fin de série (consigne).

### 2026-06-12 — Les fichiers Oracle appartiennent à oracle:oinstall sur le VFS
**Défaillance :** toute l'arborescence /u01 (binaires, datafiles, redo,
control files, alert log, spfile) était créée root:root, et les fichiers
réécrits ensuite par `OracleFilesystemSync` prenaient l'uid de
l'utilisateur shell courant — `ls -l` contredisait la réalité d'une
installation (fichiers détenus par le propriétaire logiciel `oracle`,
écrits par les background processes, pas par le client connecté).
**Correction :** `installSystemFile` accepte un propriétaire optionnel
(défaut root inchangé) ; `initOracleFilesystem` crée tout /u01 en
54321:54321 (`/etc/oratab` et `/etc/profile.d/oracle.sh` restent root,
comme en vrai) ; `OracleFilesystemSync` écrit désormais tous ses fichiers
via `writeAsOracle` (installSystemFile en oracle:oinstall, fallback
writeFileFromEditor) — un spfile régénéré par `ALTER SYSTEM … SCOPE=SPFILE`
ou l'alert log appendé restent à oracle. Effet de bord réaliste : un
utilisateur hors oinstall ne peut plus écraser ces fichiers au shell
(permissions VFS 0644 + inode oracle).
**Validation :** nouvelle suite `oracle-file-ownership.test.ts` (5 tests :
binaires, datafiles/control files, alert log, spfile post-ALTER SYSTEM,
/etc/oratab root) ; tsc propre. Régression globale en fin de série.

### 2026-06-12 — DESCRIBE résout les objets dictionnaire SYS.x ; message ORA-04043 réel
**Défaillance :** signalée à l'usage : `DESC sys.user$` répondait
`ORA-04043: object %s does not exist: SYS.USER$` alors que
`SELECT * FROM sys.user$` fonctionne. Deux bugs : (1) `handleDescribe`
cherchait les vues dictionnaire sous le nom nu (`USER$`) alors que les
vues SYS-préfixées sont enregistrées sous leur clé complète
(`SYS.USER$`, `SYS.OBJ$`, …) — même règle de résolution que `loadTable`,
non répliquée ; (2) le template `ORA_04043` était concaténé au lieu de
substituer son `%s` (seul site fautif du codebase, audité).
**Correction :** résolution en deux temps (`SYS.<nom>` si le schéma est
SYS, puis nom nu) et `replace('%s', nom)` pour le message exact d'Oracle.
**Validation :** `oracle-sqlplus-commands.test.ts` 124/124 (+4 : sys.user$,
sys.obj$, v$session sans préfixe, message substitué sans %s).

### 2026-06-12 — DML over database links, réglé au COMMIT/ROLLBACK local
**Défaillance :** suite du chantier cross-link : `INSERT/UPDATE/DELETE …
@link` n'étaient pas même parsés (`parseTableRefSimple` ignorait `@`) —
le DML « réussissait » sur la table LOCALE homonyme ou échouait en
ORA-00942, sans jamais toucher la base distante.
**Correction :** `@dblink` capturé sur les cibles DML ; l'exécuteur route
vers `SqlCommandHost.execDbLinkDml` qui ouvre une session distante comme
l'utilisateur du lien (réutilisée par lien pendant la transaction) et
exécute l'AST côté cible (contraintes/privilèges distants appliqués).
Approximation 2PC : la transaction distante reste ouverte jusqu'au
règlement de la transaction LOCALE — `settleDbLinkTransactions` est
appelé par les quatre points de commit et par ROLLBACK, propage
COMMIT/ROLLBACK au distant puis ferme les sessions.
**Validation :** `oracle-tns-remote.test.ts` 19/19 (+4 : INSERT@link
commité visible côté serveur distant, UPDATE/DELETE avec WHERE, ROLLBACK
local annule le distant, ORA-02019 sur lien inconnu).

### 2026-06-12 — Flashback temporel réel (clôt GAP §10.8)
**Défaillance :** `SELECT … AS OF TIMESTAMP/SCN` n'était pas parsé du tout
et `FLASHBACK TABLE … TO TIMESTAMP/SCN` était un no-op loggé : « Flashback
complete. » sans aucun voyage dans le temps — la clause TO était stockée
en texte brut jamais interprété.
**Correction :** machine à remonter le temps par pré-images :
- `flashback/TableHistory` — pré-image par table capturée au premier DML
  de chaque transaction (dédup par txn via un Set vidé au commit/rollback,
  64 générations max par table), indexée par SCN réel de l'instance et
  horodatage ; sémantique de lecture : première entrée `scn >= q` (SCN
  discret, bump par commit) / `timeMs > q` (temps continu), sinon état
  courant ;
- parser : `AS OF SCN|TIMESTAMP expr` sur les références de tables
  (lookahead AS+OF pour ne pas avaler les alias) ; `FLASHBACK … TO`
  structuré (`toKind`/`toExpr`) en conservant le texte brut pour l'alert
  log ;
- exécuteur : lecture AS OF dans `loadTable` (ORA-08181 SCN invalide,
  ORA-08186 timestamp invalide), `FLASHBACK TABLE TO SCN/TIMESTAMP`
  remplace le contenu par l'image passée — en capturant d'abord la
  pré-image, donc un flashback est lui-même flashback-able ;
  `TO BEFORE DROP` (recyclebin) inchangé.
**Limites assumées :** pas de flashback à travers un DDL, MERGE non
capturé, granularité temporelle = ms.
**Validation :** nouvelle suite `oracle-flashback-temporal.test.ts` (9
tests : AS OF SCN multi-générations, ORA-08181, flashback + re-flashback,
BEFORE DROP préservé, AS OF TIMESTAMP futur/passé).

### 2026-06-12 — MV logs réels et REFRESH FAST contractuel
**Défaillance :** `CREATE MATERIALIZED VIEW LOG` n'existait pas (erreur de
syntaxe), `DBA_MVIEW_LOGS` était une coquille vide permanente, et
`REFRESH FAST` était accepté en silence sans le prérequis du vrai Oracle
(un log sur chaque table maître, sinon ORA-23413 à la création).
**Correction :** registre `MviewLogMeta` au catalogue (owner/master/
MLOG$_…, options ROWID/PRIMARY KEY/SEQUENCE, compteur de changements
incrémenté par le hook de staleness existant) ; parser `CREATE/DROP
MATERIALIZED VIEW LOG ON t` ; exécuteur : ORA-12006 doublon, ORA-12002
drop sans log, ORA-23413 à la création FAST sans log ET au refresh si le
log a disparu entre-temps ; le refresh FAST purge le compteur du log ;
`DBA_MVIEW_LOGS` branchée sur le registre vivant ;
`DBA_MVIEWS.REFRESH_METHOD` expose FAST.
**Limite assumée :** le « fast » re-matérialise (notre conteneur n'a pas
de delta par ligne) — le contrat visible (logs requis, purge, erreurs)
est celui du vrai Oracle.
**Validation :** `oracle-materialized-views.test.ts` 17/17 (+5).

### 2026-06-12 — Le port du listener obéit à listener.ora
**Défaillance :** le port TNS était la constante `ORACLE_CONFIG.PORT`
(1521) câblée dans le contrôleur du listener, la résolution Oracle Net,
l'unité systemd et les transcripts — éditer `listener.ora` (geste DBA
canonique) n'avait aucun effet, et tout port ≠ 1521 répondait ORA-12541
même correctement configuré.
**Correction :** `ListenerControl` porte le port ; `startListener()` lit
`(PORT = n)` de la section LISTENER du vrai listener.ora du device (via
le `deviceFileReader` déjà injecté) ; l'événement
`oracle.listener.event` transporte le port, l'unité
`oracle-listener-<SID>` déclare le bon socket (la projection de ports
bind/release le port effectif), la résolution client compare au port du
listener CIBLE, et les transcripts lsnrctl affichent le port réel.
**Validation :** suites listener-coherence (5 tests, +1 : édition du
fichier → stop/start → netstat sur 1530, plus de 1521, status l'affiche)
et tns-remote (20, +1 : depuis le client, :1521 → ORA-12541, :1530 →
Connected, tnsping cohérent) : 25/25.

### 2026-06-12 — V$SQL_PLAN_MONITOR générée par le vrai PlanGenerator (GAP §10.12)
**Défaillance :** la vue émettait une unique ligne factice « SELECT
STATEMENT » par curseur surveillé, déconnectée du moteur de plans que
EXPLAIN PLAN utilise depuis la correction du §10.2 — deux vues du même
sujet racontaient deux histoires.
**Correction :** `OracleRuntimeState.planProvider` injecté par
`OracleDatabase` (lexer+parser+`PlanGenerator.generate` sur le texte de
chaque curseur du sqlCache, avec son parsing schema) ; la vue émet une
ligne par étape réelle du plan (opération, options, owner/objet,
cardinalité, OUTPUT_ROWS réels au niveau racine), fallback sur la ligne
racine pour les textes non planifiables (DDL).
**Validation :** nouvelle suite `oracle-sql-plan-monitor.test.ts` (3
tests : TABLE ACCESS FULL sur le bon objet, chemin INDEX pour une
recherche par clé primaire, plans multi-lignes racine en tête).

### 2026-06-13 — Les index existent enfin à l'exécution (clôt GAP §10.3)
**Défaillance :** les index n'étaient que des métadonnées de catalogue
(`IndexMeta`) : chaque validation UNIQUE/PK, chaque lookup de parent FK et
chaque `WHERE col = x` était un scan linéaire complet — pendant qu'EXPLAIN
PLAN affichait fièrement des accès INDEX (deux vues du même sujet racontant
deux histoires, encore). Les insertions en masse dans une table à clé
étaient O(n²). Le scan linéaire portait en outre **un bug de fidélité** :
deux lignes à clé unique entièrement NULL levaient ORA-00001, alors que le
vrai Oracle ne stocke pas les clés toutes-NULL dans les index uniques (il
en accepte autant qu'on veut) ; et le message ORA-00001 omettait le schéma
du nom de contrainte.
**Correction :**
- Nouveau `engine/storage/RowIndexCache.ts` : index de hachage construits
  paresseusement, invalidés par *epoch* de table (séquence monotone jamais
  réutilisée — un DROP+CREATE du même nom ne peut pas servir un index
  périmé). Les **appends n'invalident pas** (la sonde indexe la queue
  incrémentalement) → un INSERT par ligne reste O(1) amorti ; UPDATE bumpe
  l'epoch **à chaque remplacement de ligne** (la validation d'unicité de la
  ligne n suivante doit voir les lignes déjà réécrites par le même UPDATE).
  Garantie contractuelle : jamais de faux négatif — quand le hachage ne
  peut pas reproduire les conversions implicites du comparateur (colonnes
  de types mélangés, sondes inter-types), la sonde répond null et l'appelant
  retombe sur le scan ; les candidats sont toujours re-vérifiés par le vrai
  `compareValues`. La conversion NLS chaîne→DATE est injectée par
  `OracleStorage` (`indexValueSemantics()`) — la couche engine reste
  agnostique du dialecte (DIP).
- `ConstraintValidator` : UNIQUE/PK et parent-FK sondent l'index (le
  PK/UNIQUE parent est toujours indexé, comme en vrai) ; clé toute-NULL
  ignorée (sémantique B-tree d'Oracle) ; message
  `unique constraint (SCHEMA.NAME) violated` fidèle. Le scan des FK enfants
  côté DELETE reste linéaire — fidèle au vrai Oracle (FK non indexée).
- `OracleExecutor.tryIndexAccessPath` : les SELECT mono-table dont les
  conjonctions d'égalité couvrent un index déclaré passent par la sonde ;
  l'identité de référence du tableau de lignes sert de verrou de sécurité
  (vues, redaction, AS OF, db links produisent des copies → scan inchangé) ;
  le WHERE complet est ré-appliqué sur les candidats.
- `PlanGenerator` : égalité sur toutes les colonnes d'un index UNIQUE →
  `INDEX UNIQUE SCAN` (cardinalité 1) comme le vrai optimiseur, RANGE SCAN
  sinon — le plan et l'exécution sont désormais d'accord, mesurable par les
  compteurs `getIndexRuntimeStats()`.
**Validation :** nouvelle suite `oracle-index-runtime.test.ts` (19 tests :
sémantique NULL ×4, exactitude des lookups après INSERT/UPDATE/DELETE/
ROLLBACK ×8 dont le piège d'index périmé au milieu d'un UPDATE à clés
permutées, types DATE/VARCHAR2/implicites ×3, FK ×2, et la preuve que le
runtime est réellement exercé — probes qui s'incrémentent, < 10 builds pour
60 insertions, accord EXPLAIN PLAN ↔ exécution) ; `unit/database/` :
**2794/2794** ; `unit/terminal*` + `unit/shell/` : 967/967 ; tsc + ESLint
propres.

### 2026-06-13 — Control files ⇄ VFS : ORA-00205 réel au MOUNT
**Défaillance :** le STARTUP vérifiait les datafiles (ORA-01157, série du
2026-06-12) mais jamais les control files : `rm control01.ctl` puis
STARTUP montait et ouvrait comme si de rien n'était — pire, la
resynchronisation sur chaque changement d'état **réécrivait** control
files et redo logs à chaque fois, ressuscitant le fichier supprimé
derrière le dos du DBA (les datafiles avaient déjà la doctrine
« matérialisation une seule fois », pas eux). Le vrai Oracle lit chaque
copie multiplexée du jeu de control files au MOUNT et échoue en ORA-00205
si une seule manque — c'est tout l'intérêt du multiplexage.
**Correction :**
- `OracleInstance.getControlFilePaths()` — chemins issus du paramètre
  `control_files` (ordre V$CONTROLFILE), source unique partagée avec
  l'adapter FS ; `missingControlFiles()` réutilise la sonde
  d'existence hôte injectée (renommée `setHostFileProbe` — elle sert
  désormais les deux contrôles, datafiles et control files).
- STARTUP et `ALTER DATABASE MOUNT` : copie manquante → ORA-00205 en
  sortie, détail réel `ORA-00210`/`ORA-00202` dans l'alert log,
  l'instance **reste NOMOUNT** (l'échelle d'erreur exacte du vrai CKPT).
- `OracleFilesystemSync` : control files et membres redo passent à la
  matérialisation une-seule-fois (même set `seen` que les datafiles,
  amorcé au boot par `primeDatafiles` étendu) — le VFS redevient
  l'autorité sur leur existence.
**Validation :** nouvelle suite `oracle-controlfile-coherence.test.ts`
(6 tests : provisioning des deux copies, non-résurrection après rm +
switch logfile + restart, STARTUP bloqué NOMOUNT avec ORA-00205 et alert
log 00210/00202, ALTER DATABASE MOUNT pareil, instance ouverte insensible
au rm (sémantique inode), récupération canonique `cp control02 control01`
→ MOUNT → OPEN) ; `unit/database/` : **2800/2800** ; `unit/terminal/` +
`debug/rman/` + `debug/oracle/` : 399/399 ; tsc propre.

### 2026-06-13 — Processus serveur dédiés : les sessions existent dans `ps`
**Défaillance :** trois incohérences liées entre la couche Oracle et la
couche process/OS. (1) V$PROCESS ne montrait que les background processes
et `ps` ignorait totalement les connexions — une session connectée n'avait
aucune empreinte OS, alors qu'un vrai Oracle fork un serveur dédié
`oracleSID (LOCAL=NO)` / bequeath `(LOCAL=YES)` par connexion. (2)
V$SESSION.PADDR et V$PROCESS.ADDR utilisaient chacun son propre schéma
d'adresse fabriqué, donc la jointure DBA canonique
`v$session s, v$process p WHERE s.paddr = p.addr` ne renvoyait rien. (3)
`OracleDatabase.closeSession` **n'avait aucun appelant** : chaque
`disconnect` laissait fuiter l'objet `OracleSession` à vie (la map des
sessions ne décroissait jamais) — y compris les sessions des installeurs
de schémas démo, qui restaient ouvertes après le boot et faisaient mentir
USERENV (OS_USER='oracle' de l'installeur au lieu de l'utilisateur réel).
**Correction :**
- `OracleInstance` : registre des serveurs dédiés (`spawnServerProcess` /
  `releaseServerProcess` / `getServerProcesses`), un par session, qui
  publie `oracle.instance.server-process-started/stopped` sur le bus —
  même mécanisme que les background processes. Teardown au SHUTDOWN
  (PMON nettoie les serveurs dédiés).
- `OracleDatabase.openSession` fork le serveur (bequeath/LOCAL=YES par
  défaut, LOCAL=NO quand `transport='tcp'`) ; `closeSession` le libère et
  est désormais appelé par `disconnect` (la fuite est colmatée).
- `connect()` reçoit un paramètre `ConnectTransport` ; les sessions
  db-link et le re-bind TNS de SQL*Plus le passent à `'tcp'`, le launch
  `sqlplus user/pass@alias` aussi (via `setTransport`).
- `OracleFilesystemSync` matérialise/retire ces process dans la table
  `ps` du device (réutilisation du `registerProcess`/`unregisterProcess`
  déjà câblé pour les background processes).
- Nouveau `views/_processAddr.ts` : encodage d'adresse unique dérivé du
  PID, partagé par V$PROCESS.ADDR et V$SESSION.PADDR (la jointure marche).
  Les serveurs dédiés apparaissent dans V$PROCESS (PNAME/BACKGROUND null,
  PROGRAM `oracle@SID`, comme le vrai 19c).
- Les trois installeurs de schémas démo (HR, SCOTT, FCUBSLIVE) ferment
  désormais leur session (`db.disconnect(sid)`) — un script one-shot
  ne laisse pas de session immortelle.
**Validation :** nouvelle suite `oracle-server-processes.test.ts` (8
tests : bequeath visible en LOCAL=YES dans `ps`, disparition au disconnect,
nettoyage au SHUTDOWN, ligne V$PROCESS du serveur dédié, jointure
s.paddr=p.addr résolue, connexion `tcp` trackée LOCAL=NO en moteur et via
`sqlplus@alias`, non-fuite de `getOpenSessions`) ; `unit/database/` :
**2808/2808** (USERENV ajusté : OS_USER reflète le vrai utilisateur shell
maintenant que la session de l'installeur ne fuite plus) ; `unit/terminal/`
+ `unit/shell/` + `debug/oracle/` : 910/910 ; tsc + ESLint propres.

### 2026-06-13 — `audit_trail` piloté : les `.aud` apparaissent comme en vrai
**Défaillance :** incohérence paramètre ↔ filesystem. Le paramètre seedé
est `audit_trail=DB` (défaut dbca), sous lequel les enregistrements d'audit
vivent dans la **base** (DBA_AUDIT_TRAIL) et **pas** sur disque. Pourtant
`OracleFilesystemSync` écrivait un fichier `adump/*.aud` pour **chaque**
action auditée (`oracle.audit.recorded`) et **chaque** connexion
(`oracle.security.connection-traced`) — un DBA lisant `SHOW PARAMETER
audit_trail` (=DB) ne s'attendrait à aucun fichier d'audit OS pour
l'activité utilisateur ordinaire, et flipper le paramètre vers OS ne
changeait rien (il était ignoré).
**Correction :** le sync honore le paramètre live, avec les règles
d'**audit obligatoire** du 19c qui écrivent toujours sur l'OS quel que
soit `audit_trail` :
- `oracle.audit.recorded` : écrit un `.aud` seulement si l'opération est
  une opération SYS (`audit_sys_operations` = TRUE par défaut → toute
  session AS SYSDBA est auditée OS) **ou** si `audit_trail` ∈ {OS, XML} ;
  sinon l'enregistrement reste dans le trail base.
- `oracle.security.connection-traced` : écrit un `.aud` si le logon est
  privilégié (SYSDBA/SYSOPER) **ou** s'il a échoué (tout échec de logon
  est en mandatory auditing) **ou** si `audit_trail` ∈ {OS, XML} ; un
  logon NORMAL réussi va dans DBA_AUDIT_SESSION (base).
- nouveau helper `auditsToOs(deviceId)` lit `audit_trail` via le
  `resolveDatabase` déjà injecté (aucune nouvelle dépendance).
**Validation :** nouvelle suite `oracle-audit-trail-coherence.test.ts` (4
tests : sous DB un logon NORMAL ne crée pas de `.aud` à son nom, les
opérations SYS en créent toujours, un logon échoué est audité OS ;
sous OS un logon NORMAL crée bien son `.aud`) ; suites existantes
préservées (`oracle-audit-filesystem-coherence`, `oracle-security-audit-
actor` : 22/22, toutes leurs connexions sont SYSDBA donc mandatory) ;
`unit/database/` : **2812/2812** ; `debug/oracle/` : 14/14 ; tsc + ESLint
propres.

### 2026-06-13 — DBMS_SCHEDULER : les jobs s'exécutent enfin tout seuls (CJQ0)
**Défaillance :** incohérence majeure entre la couche scheduler et le cycle
de vie de l'instance. `reattachRefreshActor()` — appelé par le câblage de
boot via `setEventBus()` puis `setDeviceId()`, tous deux **après** le
`attachScheduler()` du constructeur — stoppait le `SchedulerSweepActor`
(CJQ0) **et le mettait à `null`**, mais, contrairement à tous les autres
acteurs reconstruits juste en dessous, **ne le recréait jamais**. Sur un
vrai device, le sweeper finissait donc nul : un job créé via
`DBMS_SCHEDULER.CREATE_JOB` ne s'exécutait **jamais** automatiquement, seul
`RUN_JOB` manuel le déclenchait. Un cycle SHUTDOWN/STARTUP perdait aussi le
sweeper définitivement. Les tests moteur purs (`new OracleDatabase()` sans
`setDeviceId`) gardaient le sweeper du constructeur vivant → la régression
n'était pas visible côté moteur.
**Correction :** le cycle de vie du sweeper est aligné sur la sémantique
réelle de CJQ0 (actif seulement quand la base est OPEN), via un helper
idempotent `ensureSchedulerSweep()` :
- `reattachRefreshActor` recrée le sweeper s'il était actif (état OPEN) ;
- `markOpen()` le (re)démarre à chaque ouverture — y compris après un
  cycle SHUTDOWN/STARTUP qui le démontait sans le relancer ;
- `attachScheduler` ne le démarre qu'en OPEN (sinon `markOpen` s'en charge),
  et le passe à `null` proprement pour que `reattach` ne le laisse pas
  tomber dans le vide.
**Validation :** nouvelle suite `oracle-scheduler-autorun.test.ts` (3 tests
pilotant le tick CJQ0 via un `VirtualTimeScheduler` injecté comme scheduler
par défaut, donc déterministe sans attente d'horloge réelle : un job une
fois s'exécute au prochain balayage **sans `RUN_JOB`**, un job désactivé
n'est pas balayé, le sweeper survit à un SHUTDOWN/STARTUP) ;
`unit/database/` : **2815/2815** ; `unit/terminal/` + `debug/oracle/` :
394/394 ; tsc + ESLint propres.

### 2026-06-13 — CREATE PFILE/SPFILE : ORA-01565 quand la source manque
**Défaillance :** `CREATE PFILE FROM SPFILE` (et `CREATE SPFILE FROM
PFILE='…'`) lisait le fichier source sur le VFS, mais quand celui-ci était
absent (`readDeviceFile` → null) le code **retombait silencieusement sur le
jeu de paramètres live** et retournait « File created. ». Un DBA croyant
générer un pfile depuis un ancien spfile obtenait en réalité les paramètres
courants, sans le moindre avertissement — là où le vrai Oracle échoue avec
ORA-01565. Incohérence directe avec le filesystem : `rm spfileORCL.ora`
n'avait aucun effet observable sur la commande.
**Correction :** quand la lecture de la source rend null **et** qu'un
filesystem device est câblé (`OracleInstance.hasDeviceFilesystem()`, nouveau,
qui distingue « fichier réellement absent » de « pas de filesystem » des
tests moteur purs), la commande lève
`ORA-01565: error in identifying file '…'` + `ORA-27037: unable to obtain
file status`, l'échelle exacte du vrai Oracle. Les tests moteur sans device
gardent le fallback live (aucun disque d'où le fichier pourrait manquer).
**Validation :** `oracle-stubs-to-real.test.ts` étendu (+1 : `rm` du spfile
→ ORA-01565 sans « File created », et chemin source bidon → ORA-01565) ;
cas nominaux préservés (les fichiers seedés au boot existent) ;
`unit/database/` + `debug/oracle/` : **2830/2830** ; tsc + ESLint propres.

### 2026-06-13 — RMAN RESTORE vérifie l'existence physique des backup pieces
**Défaillance :** `RESTORE` choisissait un backup set dans le catalogue et
réécrivait les datafiles **sans vérifier que les fichiers backup pieces
étaient encore sur le disque**. Un DBA ayant `rm` un piece pouvait encore
« restaurer » depuis lui — le catalogue disait oui pendant que les octets
avaient disparu. Cause racine annexe : le `VfsAdapter` du contexte RMAN
lisait via `dev.readFile`, alors que l'écriture passait par
`dev.writeFileFromEditor` — surfaces asymétriques, donc `fileExists`
renvoyait toujours false (latent tant que `_doRestore` ne l'appelait pas).
**Correction :**
- `LinuxRmanContext` : lecture/existence/suppression alignées sur la paire
  éditeur (`readFileForEditor`/`deleteFileFromEditor`), avec repli sur
  `readFile`/`deleteFile`.
- `RmanJobEngine._doRestore` : ne retient que les sets dont **tous** les
  pieces existent sur le VFS ; quand il n'en reste aucun, abandon avec
  l'échelle réelle (RMAN-06026/06023 + ORA-19505/27037) — l'instance reste
  MOUNT, le datafile n'est pas faussement recréé.
**Validation :** nouvelle suite `oracle-rman-backup-piece-coherence.test.ts`
(2 tests : backup sain → restore OK ; rm des pieces → RESTORE échoue
RMAN-0602x, datafile absent, instance MOUNT) ; non-régression
`oracle-datafile-vfs-coherence` (le restore légitime marche enfin via la
bonne surface de lecture) ; `unit/database/` : **2818/2818** ;
`unit/terminal/` + `debug/rman/` + `debug/oracle/` : 399/399 ; tsc + ESLint
propres.

Note de style : à la demande de l'auteur, les commentaires de code ajoutés
au cours de cette série ont été retirés (le rationnel vit ici, dans le
journal, pas dans le code).

### 2026-06-13 — ALTER SYSTEM KILL SESSION libère le processus serveur dédié
**Défaillance :** suite directe du travail sur les processus serveur dédiés.
`ALTER SYSTEM KILL SESSION 'sid,serial'` retirait la session du tracker
(donc de V$SESSION) mais **ne libérait pas le processus serveur dédié** :
`ps` et V$PROCESS continuaient d'afficher le `oracleSID (LOCAL=…)` d'une
session pourtant tuée — deux vues du même fait en désaccord.
**Correction :** le handler KILL/DISCONNECT SESSION appelle
`instance.releaseServerProcess(sid)` après le retrait du tracker — l'événement
`server-process-stopped` retire le process de `ps` (via la FS sync) et de
V$PROCESS, comme PMON nettoie le serveur dédié sur le vrai Oracle.
**Validation :** nouvelle suite `oracle-kill-session-process.test.ts` (4
tests : process libéré au niveau instance, absent de V$PROCESS, session
absente de V$SESSION, kill d'une session inconnue rejeté) ;
`unit/database/` : **2822/2822** ; tsc + ESLint propres.

### 2026-06-13 — DROP USER libère les processus serveur des sessions tuées
**Défaillance :** même classe que KILL SESSION. `DROP USER` appelle
`dropUserCleanup` → `killUserSessions`, qui retirait les sessions de
l'utilisateur du tracker (donc de V$SESSION) mais **laissait leurs
processus serveur dédiés** dans `ps` et V$PROCESS.
**Correction :** `killUserSessions` retourne désormais les SID tués,
remontés par `dropUserCleanup` ; `executeDropUser` appelle
`instance.releaseServerProcess(sid)` pour chacun — les processus serveur
disparaissent de `ps`/V$PROCESS comme à la déconnexion.
**Validation :** nouvelle suite `oracle-drop-user-process.test.ts` (2
tests : process libéré + absent de V$PROCESS après DROP USER, sessions des
autres utilisateurs intactes) ; `unit/database/` : **2824/2824** ; tsc +
ESLint propres.

### 2026-06-13 — RMAN voit les vrais archived logs de l'instance
**Défaillance :** `LinuxRmanContext.getArchivelogPaths()` renvoyait une
liste **synthétique figée** de 3 chemins (`/u01/backup/archivelog/arch_1_N_SID.arc`),
quel que soit le nombre réel de switches, à un répertoire **différent** de
celui où l'instance écrit (`/u01/app/oracle/archivelog/1_N_arc.arc`, reflété
par V$ARCHIVED_LOG et matérialisé sur le VFS). Conséquence : `BACKUP
ARCHIVELOG ALL` / `DELETE ARCHIVELOG` opéraient sur des fichiers fantômes
sans rapport avec les vrais archived logs — les vrais n'étaient jamais ni
sauvegardés ni purgés.
**Correction :** quand une base Oracle est enregistrée, `getArchivelogPaths`
dérive du runtime vivant (`instance.getRuntimeState().archivedLogs`, la même
source que V$ARCHIVED_LOG). RMAN, la vue dictionnaire et les fichiers VFS
racontent enfin la même histoire ; la liste synthétique ne sert plus qu'aux
devices sans Oracle (tests).
**Validation :** nouvelle suite `oracle-rman-archivelog-coherence.test.ts`
(3 tests : chemins RMAN == V$ARCHIVED_LOG == fichiers VFS après switches,
aucun archived log avant le premier switch, plus aucun chemin fantôme
`/u01/backup`) ; non-régression `unit/database/` + `debug/rman/` :
**2832/2832** ; tsc + ESLint propres.

### 2026-06-13 — Le listener enregistre un service par PDB ouverte
**Défaillance :** incohérence multitenant ↔ réseau. Le `ListenerControl`
n'enregistrait **que** le service nommé d'après le SID : `lsnrctl status`/
`services` n'affichait jamais les PDB, et `attemptConnect` refusait
(ORA-12514) tout service ≠ SID — donc impossible de joindre une PDB ouverte
via `sqlplus user/pass@PDBNAME` ou de la voir dans le listener, alors que le
vrai Oracle fait enregistrer (LREG/PMON) un service par PDB ouverte.
**Correction :** l'env du listener gagne une callback `pdbServices()`
branchée sur `instance.multitenant.getAll()` (PDB en READ WRITE/READ ONLY,
`PDB$SEED` exclu). `registeredServices()` = SID + PDB ouvertes ;
`servicesSummary` émet un bloc par service, `attemptConnect` accepte tout
service enregistré (insensible à la casse). Ouvrir/fermer une PDB
ajoute/retire dynamiquement son service.
**Validation :** nouvelle suite `oracle-listener-pdb-services.test.ts` (5
tests : ORCLPDB1 seedée visible, PDB$SEED jamais annoncée, CREATE+OPEN d'une
PDB la fait apparaître, attemptConnect accepte une PDB ouverte et refuse un
service inconnu, CLOSE la retire) ; non-régression `unit/database/` +
`unit/terminal/` + `debug/oracle/` : 2832 + 394 verts ; tsc + ESLint propres.

### 2026-06-13 — Services PDB cohérents listener ↔ dictionnaire
**Défaillance :** suite directe de l'enregistrement des services PDB au
listener. Les vues de services (V$ACTIVE_SERVICES, V$SERVICES,
DBA_SERVICES), alimentées par `oracle.service.event`, ne recevaient un
événement que pour `[SID, SYS$USERS, SYS$BACKGROUND]` — pas pour les PDB.
Le listener annonçait donc ORCLPDB1 alors que le dictionnaire l'ignorait :
nouvelle incohérence interne à fermer.
**Correction :** `markOpen()` émet aussi un `service.event started` pour
chaque PDB ouverte (la ORCLPDB1 seedée apparaît dès le boot) ;
`execPluggableDatabase` émet `started`/`stopped` à l'OPEN/CLOSE/DROP d'une
PDB via le nouveau `instance.publishPdbServiceEvent`. Listener, vues
dynamiques et DBA_SERVICES racontent la même histoire.
**Validation :** `oracle-listener-pdb-services.test.ts` étendu (8 tests,
+3 : ORCLPDB1 dans V$ACTIVE_SERVICES + DBA_SERVICES, OPEN ajoute le service,
CLOSE le retire) ; non-régression `unit/database/` + `debug/oracle/` :
**2849** verts ; `unit/terminal/` : 380 ; tsc + ESLint propres.

### 2026-06-13 — La SGA apparaît en mémoire partagée de l'hôte (`free`)
**Défaillance :** V$SGA / SHOW SGA rapportaient la mémoire de l'instance,
mais `free`/`/proc/meminfo` sur l'hôte ne reflétaient **rien** : un DBA
lançant `free -m` avant/après un STARTUP ne voyait aucune mémoire partagée
allouée, alors qu'une vraie SGA est un segment de mémoire partagée visible
dans la colonne `shared` / `Shmem`.
**Correction :** `MemoryProfile.reserveShared/releaseShared` (segment de
mémoire partagée : monte `shared`+`used`, baisse `free`+`available`,
clampé). `OracleFilesystemSync` réserve la SGA (taille = `getSGAInfo()`,
512M par défaut) quand l'instance passe OPEN et la libère à l'arrêt, avec
suivi idempotent par device (pas de double-comptage sur STARTUP/SHUTDOWN).
Comme pour les datafiles, l'OPEN de boot précède l'enregistrement de la
base, donc `primeSgaMemory` amorce la réservation juste après le boot.
**Validation :** nouvelle suite `oracle-sga-memory-coherence.test.ts` (3
tests : `free` montre ~512M de plus à l'ouverture, libéré à SHUTDOWN, pas de
double-comptage sur un cycle) ; non-régression `unit/database/` +
`unit/terminal/` : **3218** verts ; tsc + ESLint propres.

### 2026-06-13 — ARCHIVE LOG LIST : ligne « Next log sequence » conforme
**Défaillance :** `ARCHIVE LOG LIST` affichait toujours la ligne
`Next log sequence to archive`, y compris en mode NOARCHIVELOG où le vrai
SQL*Plus l'omet (rien n'est archivé).
**Correction :** la ligne n'est émise qu'en mode ARCHIVELOG.
**Validation :** `oracle-journalization-views.test.ts` étendu (+2 : omise en
NOARCHIVELOG, présente en ARCHIVELOG) ; `unit/database/` : 2840 verts.

### 2026-06-13 — DML/DDL schéma exigent une base OPEN (ORA-01109)
**Défaillance :** aucune opération objet/DML ne vérifiait l'état de
l'instance. Une session SYSDBA en MOUNT/NOMOUNT (le seul moyen d'obtenir un
exécuteur avant l'ouverture) pouvait `CREATE TABLE`, `INSERT`,
`CREATE TABLESPACE`, etc. — le vrai Oracle refuse (ORA-01109 « database not
open »), le dictionnaire de données n'étant pas monté. Violation de la
machine d'état (cf. rapport d'exploration, défauts #2-#10).
**Correction :** garde unique dans `executeStatement` : un set
`REQUIRES_OPEN_DATABASE` (DML + DDL objet : tables, index, séquences, vues,
MV, triggers, synonymes, tablespaces, types, comments, analyze, db links)
lève ORA-01109 si `instance.state !== 'OPEN'`. Exclus volontairement : les
statements de contrôle d'instance (STARTUP/SHUTDOWN, ALTER SYSTEM/DATABASE,
ALTER PLUGGABLE DATABASE), TCL, ALTER SESSION et SELECT (les vues V$/GV$
restent interrogeables en MOUNT, comme le vrai Oracle).
**Validation :** nouvelle suite `oracle-not-open-guard.test.ts` (6 tests :
CREATE TABLE/INSERT/CREATE INDEX/CREATE TABLESPACE refusés hors OPEN,
réussite en OPEN, ALTER DATABASE OPEN toujours permis depuis MOUNT) ;
non-régression `unit/database/` 2840 + `unit/terminal/` + `debug/oracle/` +
`debug/rman/` 399 ; tsc + ESLint propres.

### 2026-06-13 — Type des colonnes d'agrégats (GROUP BY) inféré, plus VARCHAR2
**Défaillance :** `projectGroupedRows` typait **toutes** les colonnes d'une
requête GROUP BY en VARCHAR2, quel que soit l'agrégat. Conséquence visible :
un CTAS depuis une requête groupée (`CREATE TABLE t AS SELECT dept,
COUNT(*) … GROUP BY dept`) créait des colonnes VARCHAR2 là où Oracle donne
NUMBER, et la métadonnée de colonne mentait dans DBA_TAB_COLUMNS.
**Correction :** `inferGroupedColumnType` — COUNT/SUM/AVG → NUMBER,
MIN/MAX → type de la colonne argument, colonne de GROUP BY → son type
source, sinon VARCHAR2.
**Validation :** nouvelle suite `oracle-grouped-column-types.test.ts` (3
tests via CTAS + DBA_TAB_COLUMNS : COUNT/SUM/AVG en NUMBER, colonne GROUP BY
en VARCHAR2, MIN/MAX sur NUMBER en NUMBER) ; `unit/database/` : 2849 verts.

### 2026-06-13 — ORDER BY en collation BINARY (NLS_SORT par défaut)
**Défaillance :** le comparateur de chaînes `compareValues` retombait sur
`String(a).localeCompare(String(b))` — un tri sensible à la locale, alors
que le défaut d'Oracle est `NLS_SORT=BINARY` (ordre des octets). Un
`ORDER BY` sur des chaînes à casse mixte rendait un ordre non conforme
(localeCompare classe souvent 'apple' avant 'Banana' ; Oracle binaire met
les majuscules avant les minuscules, ASCII). L'équivalence (=== 0) n'était
pas affectée — seul le signe du tri l'était.
**Correction :** comparaison binaire (`sa < sb ? -1 : sa > sb ? 1 : 0`),
fidèle à NLS_SORT=BINARY. Au passage : purge de deux échappements de regex
inutiles préexistants (`[\-/]` → `[-/]`).
**Validation :** nouvelle suite `oracle-binary-sort.test.ts` (2 tests :
majuscules avant minuscules, chiffres avant lettres) ; **zéro régression**
sur `unit/database/` (2849) + `unit/terminal/` + `debug/oracle/` (394) — le
test data Oracle étant majoritairement en majuscules, le changement est
invisible ailleurs ; tsc + ESLint propres.

### 2026-06-13 — `top` lit la mémoire vivante (cohérent avec `free`, voit la SGA)
**Défaillance :** la ligne mémoire de `top` (`MiB Mem`) utilisait des
valeurs **codées en dur** (3981/1258/1468/1254), déconnectées du
`MemoryProfile` que `free` et `/proc/meminfo` lisent — `top` et `free`
pouvaient déjà se contredire, et `top` ignorait la réservation SGA
ajoutée juste avant.
**Correction :** `ProcessCmdContext` reçoit le `MemoryProfile` du device
(même source que `free`) ; `top` calcule total/used/free/buff-cache en MiB
depuis lui (repli sur les anciennes constantes si absent).
**Validation :** nouvelle suite `oracle-top-memory-coherence.test.ts` (2
tests : `top` et `free` d'accord sur total/used/free, la SGA fait monter
`top` used de ~512M puis redescend à SHUTDOWN) ; non-régression
process/hardware network-v2 (60) ; tsc propre (les 3 erreurs ESLint
`no-duplicate-case` de LinuxCommandExecutor.ts sont préexistantes et hors
périmètre).

### 2026-06-13 — `lsnrctl`/`tnsping` shell : un seul handler, plus de divergence
**Défaillance :** duplication + divergence entre les deux chemins
d'invocation. Le terminal interactif (`LinuxTerminalSession`) routait
`lsnrctl`/`tnsping` vers les vrais handlers (`OracleCommands.handleLsnrctl/
handleTnsping`, basés sur le `ListenerControl` réel — port live, services
PDB, état). Mais le chemin programmatique (`executeShellCommandSync`, SSH,
scripts) tombait sur : un `_oracleListener` **réimplémenté en dur** dans
LinuxServer (status simplifié, « Service ORCL » figé, port 1521 codé, pas
de PDB) et un `tnsping` **stub** qui répondait toujours TNS-03505. Même
commande, deux résultats selon la voie.
**Correction :** le hook `_oracleListener` délègue désormais à
`handleLsnrctl` (collecte des lignes), et un nouveau hook `_oracleTnsping`
délègue à `handleTnsping` ; l'exécuteur route `tnsping` dessus (comme
`lsnrctl`). Les deux chemins partagent une seule logique — fin de la
duplication et de la divergence.
**Validation :** nouvelle suite
`oracle-shell-lsnrctl-tnsping-coherence.test.ts` (3 tests : `lsnrctl
status` shell liste les services PDB, reflète l'arrêt du listener,
`tnsping` résout le service local au lieu de TNS-03505) ; non-régression
`unit/database/` 2853 + suites SSH/LAN network-v2 (251) + linux-oracle-tools
+ debug/oracle ; tsc + ESLint propres.

### 2026-06-13 — `sqlplus -s` shell exécute la vraie requête (plus de résultat factice)
**Défaillance :** le hook `_oracleBootstrap` (sqlplus depuis bash/SSH/script)
répondait à `sqlplus -s user/pass@conn "SELECT …"` par un résultat **codé
en dur** — toujours `1 row selected` avec une valeur `1` — quelle que soit
la requête. Un script DBA (`sqlplus -s … "SELECT COUNT(*) …"`) recevait un
mensonge constant, alors que le terminal interactif (SqlPlusSubShell) passe
par le vrai moteur.
**Correction :** la branche SELECT route désormais vers une vraie
`SQLPlusSession` (réutilisation de `createSQLPlusSession` — login,
résolution TNS, moteur SQL identiques au terminal) : extraction de
l'identifiant de connexion et du SQL (args + stdin), exécution
statement par statement, déconnexion en fin (pas de fuite de session),
et remontée de l'erreur réelle de login (ORA-01017) au lieu d'une fausse
ligne. Les chemins SHUTDOWN/STARTUP/`/ as sysdba` restent inchangés.
**Validation :** nouvelle suite `oracle-shell-sqlplus-real-query.test.ts`
(4 tests : SUM/COUNT/MAX réels via args et via stdin, mauvais mot de passe
→ ORA-01017) ; le test SSH existant `sqlplus -s … "SELECT 1 FROM DUAL"`
reste vert (1 est le vrai résultat) ; non-régression `unit/database/` +
`unit/shell/` (3376) + SSH/LAN network-v2 (317) ; tsc + ESLint propres.

### 2026-06-13 — `expdp`/`impdp`/`adrci` shell : vrais handlers, plus de stubs
**Défaillance :** suite du chantier d'unification terminal ↔ shell.
`expdp`/`impdp` n'étaient **même pas câblés** dans `LinuxCommandExecutor`
(→ « command not found » via SSH/script), et `adrci` répondait
« non-interactive batch mode not supported » — alors que le terminal
interactif route vers les vrais handlers (Data Pump réel sur le VFS, adrci
sur l'alert log). Un script DBA d'export/import via SSH échouait.
**Correction :** nouveau hook générique `_oracleUtil(cmd, args)` dans
l'exécuteur, branché sur `handleExpdp`/`handleImpdp`/`handleAdrci` (mêmes
handlers que le terminal). Les cases `expdp`/`impdp`/`adrci` y délèguent
(repli sur le message « interactif » uniquement sans hook) ; `dbca`/`orapwd`
restent des stubs (vraiment interactifs).
**Validation :** nouvelle suite `oracle-shell-datapump-adrci.test.ts` (3
tests : expdp shell exporte réellement + dump sur le VFS, round-trip
expdp→drop→impdp via shell, adrci shell lit l'alert log) ; les tests
Data Pump existants (appel direct du handler) restent verts ;
non-régression `unit/database/` + linux-oracle-tools (2929) ; tsc + ESLint
propres.

### 2026-06-13 — `rman` shell pilote le vrai moteur réactif (plus de banner seul)
**Défaillance :** dernier outil du pattern terminal ↔ shell. `rman` via
`executeShellCommandSync`/SSH/script ne renvoyait **que le banner**
(`Recovery Manager: Release …`), sans exécuter le moindre RUN/BACKUP/
RESTORE — alors que le terminal interactif utilise le vrai
`ReactiveRmanSubShell`. `echo "BACKUP DATABASE;" | rman target /` via SSH
ne sauvegardait rien.
**Correction :** nouveau hook `_oracleRman(args, stdin)` dans l'exécuteur,
branché sur `ReactiveRmanSubShell` : crée la session (target connecté),
exécute chaque ligne du script piped (`processLine`), accumule la sortie,
dispose en fin. `rman target /` sans script affiche toujours le banner de
connexion ; un script piped exécute réellement les commandes RMAN
(catalogue partagé par device, donc cohérent avec les backups précédents).
**Validation :** nouvelle suite `oracle-shell-rman.test.ts` (3 tests :
BACKUP DATABASE piped exécuté, LIST BACKUP montre le catalogue, banner seul
sans script) ; non-régression `unit/database/` + `debug/rman/` (2871) +
SSH/shell (732) ; tsc + ESLint propres.

### 2026-06-13 — `sqlplus / as sysdba` shell exécute aussi le SQL piped
**Défaillance :** gap découvert après le fix `sqlplus -s`. La branche
`/ as sysdba` nue retournait le banner **avant** l'exécution SQL, donc
`echo "SELECT … ;" | sqlplus / as sysdba` (geste DBA très courant)
**ignorait** le SQL piped.
**Correction :** l'exécution réelle gère désormais les deux formes de
connexion — `/ as sysdba` et `user/pass@conn` — quand du SQL est présent
(args ou stdin) ; la connexion nue sans SQL retombe sur le banner.
**Validation :** `oracle-shell-sqlplus-real-query.test.ts` étendu (+2 :
SELECT piped vers `/ as sysdba` exécuté, banner pour la connexion nue) ;
non-régression SSH/LAN + `unit/database/` (3119) ; tsc + ESLint propres.

### 2026-06-13 — TRUNCATE : ORA-00942 et ORA-02266 (FK enfant active)
**Défaillance :** `executeTruncate` ne vérifiait ni l'existence de la table
(ORA-00942) ni les FK enfants. Le vrai Oracle refuse de tronquer une table
parent référencée par une FK active (ORA-02266), même sans ligne enfant —
contrairement à DELETE.
**Correction :** `requireTableMeta` (ORA-00942) puis scan des tables du
schéma pour une FK active pointant vers la table → ORA-02266 (auto-référence
exclue ; comparaison robuste au préfixe schéma du refTable).
**Validation :** nouvelle suite `oracle-truncate-fk.test.ts` (4 tests :
parent → ORA-02266, enfant OK, parent OK après DROP de l'enfant, table
absente → ORA-00942) ; non-régression `unit/database/` 2872 ; tsc + ESLint
propres.

### 2026-06-13 — FK avec référence qualifiée (`REFERENCES schema.table`) enfin enforced
**Défaillance :** une FK déclarée avec une référence qualifiée
(`REFERENCES hr.dept`) stockait `refTable='HR.DEPT'`, mais le
`ConstraintValidator` cherchait le parent via `tableExists(schema, refTable)`
→ `tableExists('HR','HR.DEPT')` faux → la vérification ORA-02291 (INSERT/
UPDATE) et la règle DELETE (ORA-02292) étaient **silencieusement sautées**.
`REFERENCES dept` (non qualifié) fonctionnait, pas `REFERENCES hr.dept` :
intégrité référentielle perdue selon la syntaxe. (Le DDL régénéré par
MetadataExtractor produisait aussi `REFERENCES "HR"."HR.DEPT"`.)
**Correction :** normalisation de `refTable` en nom **non qualifié** aux
deux sites de construction de CREATE TABLE (cohérent avec l'hypothèse
même-schéma du validateur). Tous les consommateurs (FK INSERT/UPDATE/DELETE,
DDL, check TRUNCATE) sont désormais cohérents.
**Validation :** nouvelle suite `oracle-fk-qualified-ref.test.ts` (2 tests :
ORA-02291 sur INSERT d'un parent absent via ref qualifiée, ORA-02292 sur
DELETE du parent) ; non-régression `unit/database/` 2874 ; tsc + ESLint
propres.

### 2026-06-13 — DROP TABLE d'un parent référencé exige CASCADE CONSTRAINTS (ORA-02449)
**Défaillance :** `executeDropTable` supprimait toujours la table, sans
vérifier les FK enfants. Le vrai Oracle refuse de dropper un parent
référencé par une FK (ORA-02449) sauf `DROP TABLE … CASCADE CONSTRAINTS`,
qui supprime alors les FK référençantes.
**Correction :** scan des FK enfants pointant vers la table ; sans
`stmt.cascade` → ORA-02449 ; avec → retrait des contraintes FK des tables
enfants avant le drop. Comparaison robuste au préfixe schéma du refTable.
**Validation :** nouvelle suite `oracle-drop-table-fk.test.ts` (3 tests :
DROP nu → ORA-02449, CASCADE CONSTRAINTS droppe parent + FK enfant,
l'enfant non référencé droppe sans cascade) ; **zéro régression** sur
`unit/database/` (2874) + `unit/terminal/` + `unit/shell/` + debug (915) —
les tests droppent en ordre de dépendance ou avec CASCADE ; tsc + ESLint
propres.

### 2026-06-13 — ALTER TABLE ADD/DROP CONSTRAINT enforce réellement (était un no-op)
**Défaillance :** `executeAlterTable` ne gérait **ni** `ADD_CONSTRAINT` **ni**
`DROP_CONSTRAINT` — ces actions étaient parsées puis jetées, retournant
« Table altered. » sans rien faire. Ajouter une PK/UNIQUE/FK/CHECK via
ALTER n'avait aucun effet : les INSERT violant la contrainte réussissaient.
**Correction :** nouveau `addTableConstraint` (réutilise le mapping de
CREATE TABLE, refTable normalisé) : valide les lignes **existantes** avant
d'activer (ORA-00001/02290/02291…), pousse la contrainte sur la meta et crée
l'index PK/UNIQUE. `DROP_CONSTRAINT` retire la contrainte (et l'index
associé), ORA-02443 si inconnue, ORA-02264 sur doublon de nom à l'ajout.
**Validation :** nouvelle suite `oracle-alter-add-constraint.test.ts` (6
tests : UNIQUE/CHECK/FK ajoutées puis enforced, validation des lignes
existantes, DROP CONSTRAINT lève l'enforcement, ORA-02443) ; un test
« comprehensive » corrigé (il insérait des valeurs violant une FK
severity→departments qui ne « passait » que via le no-op) ; non-régression
`unit/database/` + `unit/terminal/` (3263) + `debug/oracle/` (14) ; tsc +
ESLint propres.

### 2026-06-13 — ALTER TABLE MODIFY (col NOT NULL) enforce vraiment (+ bug parser typeless)
**Défaillance :** double bug. (1) `MODIFY_COLUMN` ne posait que le flag
`dataType.nullable=false`, jamais une contrainte NOT_NULL → non enforced.
(2) Plus grave : `parseColumnDefinition` exigeait toujours un type, donc
`MODIFY (name NOT NULL)` (sans type) lisait **'NOT' comme type** et 'NULL'
comme contrainte — inversant le sens (NOT NULL devenait NULL) et corrompant
le type de colonne en « NOT ».
**Correction :**
- Parser : le type devient optionnel quand un mot-clé de contrainte
  (NOT/NULL/CONSTRAINT/UNIQUE/PRIMARY/CHECK/REFERENCES/DEFAULT) suit le nom
  → `TypeSpec` vide ; le MODIFY executor n'écrase alors plus le type.
- Executor : `MODIFY (col NOT NULL)` valide les lignes existantes
  (ORA-02296 si NULL présent) puis ajoute une vraie contrainte NOT_NULL ;
  `MODIFY (col NULL)` retire la contrainte.
**Validation :** nouvelle suite `oracle-modify-not-null.test.ts` (3 tests :
NULL rejeté après NOT NULL, ORA-02296 sur données existantes NULL, NULL
relève la contrainte) ; non-régression parser + `unit/database/` +
`unit/terminal/` (3266) + `debug/oracle/` (20) ; tsc + ESLint propres.

### 2026-06-13 — Les DEFAULT de colonne fonctionnent (CREATE ne les stockait pas) + bug parser `NOT NULL`
**Défaillance :** double bug majeur. (1) `executeCreateTable` ne transférait
**jamais** le DEFAULT analysé (`col.defaultValue`) vers la `ColumnMeta` —
aucune colonne n'avait de défaut, donc `INSERT` (VALUES **et** SELECT) ne
remplissait jamais les colonnes omises avec leur DEFAULT (resté NULL). (2)
Exposé au passage : `DEFAULT 0 NOT NULL` ne **parsait** même pas —
l'analyseur d'expression consommait `NOT` après `0` puis exigeait
BETWEEN/IN/LIKE (ORA-00900).
**Correction :**
- `ColumnMeta.defaultExpr` (AST, typé `object` pour éviter la dépendance
  parser→storage) ; CREATE TABLE le renseigne.
- `applyColumnDefaults` évalue le DEFAULT **par ligne** (donc SYSDATE /
  séquences corrects) pour les seules colonnes **omises** — un NULL
  explicite reste NULL ; partagé par les chemins VALUES et INSERT…SELECT.
- Parser : le `NOT` postfixe n'est consommé que si BETWEEN/IN/LIKE suit
  (lookahead), laissant `NOT NULL` à l'analyseur de contraintes.
**Validation :** nouvelle suite `oracle-insert-select-defaults.test.ts` (5
tests : DEFAULT appliqué via VALUES et INSERT…SELECT, NULL explicite
préservé, DEFAULT SYSDATE par ligne, NOT NULL+DEFAULT) ; non-régression
parser + `unit/database/` (2888) + `unit/terminal/` (380) ; tsc + ESLint
propres.

### 2026-06-13 — ALTER TABLE ADD COLUMN : DEFAULT et NOT NULL effectifs
**Défaillance :** suite du bug DEFAULT. `ADD_COLUMN` construisait la
ColumnMeta sans `defaultValue` ni `defaultExpr` ni contrainte — donc
`ALTER TABLE t ADD (col DEFAULT x)` laissait les lignes existantes à NULL,
n'appliquait pas le défaut aux futurs INSERT, et un `ADD (col NOT NULL)`
n'était pas enforced.
**Correction :** `ADD_COLUMN` évalue le DEFAULT une fois (remplit les
lignes existantes), conserve l'AST (`defaultExpr`) pour l'évaluation
par-ligne des futurs INSERT, ajoute la contrainte NOT_NULL, et lève
ORA-01758 pour un `NOT NULL` sans défaut sur table non vide.
**Validation :** nouvelle suite `oracle-add-column-default.test.ts` (4
tests : backfill des lignes existantes, défaut sur nouvel INSERT, NOT NULL
+ DEFAULT, ORA-01758) ; non-régression `unit/database/` (2891) +
`unit/terminal/` + `debug/oracle/` (394) ; tsc + ESLint propres.

### 2026-06-13 — MERGE : message « N rows merged. » conforme à SQL*Plus
**Défaillance :** `MERGE` retournait un message non conforme découpé par
clause (« 1 row merged (updated), 1 row merged (inserted) ») au lieu du
total unique « N rows merged. » du vrai SQL*Plus.
**Correction :** message unique `${total} row(s) merged.` (le comportement
upsert était déjà correct).
**Validation :** nouvelle suite `oracle-merge-message.test.ts` (2 tests :
message total sans découpage, upsert toujours correct) ; non-régression
`unit/database/` (2897) ; tsc + ESLint propres.

### 2026-06-13 — Conteneur de session multitenant : ALTER SESSION SET CONTAINER + connexion par service PDB
**Défaillance :** la simulation était mono-conteneur factice :
`SYS_CONTEXT('USERENV','CON_NAME'/'CON_ID')` renvoyait toujours
`CDB$ROOT`/1, `ALTER SESSION SET CONTAINER` était ignoré, et une connexion
à un service PDB atterrissait dans CDB$ROOT. Un DBA multitenant ne pouvait
pas savoir ni changer dans quel conteneur il se trouvait.
**Correction :** la session porte un conteneur courant (`OracleSession.
containerName/containerId`, défaut CDB$ROOT/1).
- `ALTER SESSION SET CONTAINER = <pdb>` déplace la session (ORA-65011 si
  inconnu/PDB$SEED, ORA-65040 si MOUNTED) ; retour via `CDB$ROOT`.
- `SYS_CONTEXT`/`USERENV` CON_NAME/CON_ID, `SHOW CON_NAME`/`CON_ID` et
  V$SESSION.CON_ID reflètent le conteneur vivant.
- Connexion `sqlplus user/pass@//host/ORCLPDB1` (service PDB ouvert) →
  la session démarre dans la PDB ; le service CDB reste en CDB$ROOT.
**Limite assumée :** l'isolation des **données** entre conteneurs n'est pas
modélisée (schémas/tables partagés) — c'est le **contexte** de session
(CON_NAME/CON_ID/V$SESSION) qui bascule, ce qu'un DBA inspecte.
**Validation :** nouvelle suite `oracle-pdb-container-session.test.ts` (9
tests : départ CDB$ROOT, switch ORCLPDB1↔root, SHOW, V$SESSION.CON_ID,
ORA-65011/65040, connexion par service PDB vs CDB) ; non-régression
`unit/database/` + `unit/terminal/` (3286) + `debug/oracle/` (34) ; tsc +
ESLint propres.

### 2026-06-13 — Verrouillage niveau ligne : SELECT … FOR UPDATE [NOWAIT|SKIP LOCKED] (ORA-00054)
**Défaillance :** `FOR UPDATE` ne posait qu'un verrou **TABLE** (TM mode 3,
Row-Exclusive) compatible entre sessions — donc deux sessions verrouillant
**la même ligne** ne se voyaient jamais, et `FOR UPDATE NOWAIT` ne levait
jamais ORA-00054. Aucune granularité ligne.
**Correction :** verrous de ligne (`LockManager.rowLocks`, clé PK ou contenu),
acquis dans l'exécuteur sur les lignes filtrées d'un SELECT mono-table :
- une ligne tenue par une autre session → `NOWAIT` lève ORA-00054,
  `SKIP LOCKED` l'exclut du résultat, un `FOR UPDATE` simple la renvoie
  sans voler le verrou (le sim synchrone ne peut pas bloquer-et-attendre) ;
- re-verrou par la même session : ré-entrant ;
- `FOR UPDATE` ouvre une transaction → COMMIT/ROLLBACK (via les événements
  transaction.* écoutés par le LockActor) libèrent les verrous ligne.
  `connect`/`connectAsSysdba` posent désormais le sessionId sur l'exécuteur
  (sinon deux sessions partageaient le même id → faux ré-entrant).
**Limite assumée :** verrou ligne sur SELECT mono-table ; jointures/DML
gardent le verrou TM table.
**Validation :** nouvelle suite `oracle-for-update-row-lock.test.ts` (6
tests : même ligne → ORA-00054, ligne différente OK, SKIP LOCKED, libération
au COMMIT et au ROLLBACK, ré-entrance) ; non-régression `unit/database/`
(2906) + `oracle-lock-manager` (11) + `unit/terminal/` (380) +
`debug/oracle/` ; tsc + ESLint propres.

### 2026-06-14 — Objets DIRECTORY réels (catalogue + DDL + dictionnaire vivant)
**Défaillance :** `DBA_DIRECTORIES` était une vue **cannée** renvoyant
toujours une unique ligne `DATA_PUMP_DIR` codée en dur ; `CREATE DIRECTORY`
/ `DROP DIRECTORY` n'étaient **ni parsés ni exécutés** nulle part (le
privilège `CREATE ANY DIRECTORY` existait pourtant déjà). Conséquence : aucun
objet répertoire ne pouvait être créé, et donc aucune fondation pour la
cohérence Oracle ↔ filesystem hôte (UTL_FILE, tables externes, Data Pump
résolvent tous leurs chemins via un objet DIRECTORY). C'est le pré-requis
structurel à une vraie implémentation d'UTL_FILE.
**Correction :** objet répertoire de première classe, sur le patron exact
des database links (déjà branchés au catalogue vivant en 10.7) :
- `OracleCatalog` : `DirectoryMeta` + `registerDirectory`/`getDirectory`/
  `getDirectories`/`dropDirectory`, Map ensemencée avec `DATA_PUMP_DIR`
  (chemin dérivé d'`ORACLE_CONFIG`, plus de littéral codé en dur dans la
  vue). Espace de noms global, propriétaire toujours `SYS` (fidèle à Oracle).
- AST `CreateDirectoryStatement`/`DropDirectoryStatement` ;
  `OracleParser` : `CREATE [OR REPLACE] DIRECTORY nom AS 'chemin'` et
  `DROP DIRECTORY nom`.
- `OracleExecutor` : `executeCreateDirectory`/`executeDropDirectory`
  enregistrés dans le switch et dans `DDL_STATEMENT_TYPES` (DDL =
  commit implicite) + `REQUIRES_OPEN_DATABASE`. Privilèges réels
  (`CREATE ANY DIRECTORY` → ORA-01031 sinon, `DROP ANY DIRECTORY`),
  ORA-00955 sans `OR REPLACE` sur un nom existant, ORA-04043 au DROP
  d'un inconnu. `CREATE OR REPLACE` rebinde le chemin en place.
- `DBA_DIRECTORIES` **et** `ALL_DIRECTORIES` rebranchées sur
  `catalog.getDirectories()` (OWNER = SYS), la vue cannée supprimée.
**Validation :** nouvelle suite `oracle-directory-objects.test.ts` (10
tests : création/visibilité DBA_DIRECTORIES, DATA_PUMP_DIR par défaut,
uppercase, ORA-00955, OR REPLACE, DROP + ORA-04043, ALL_DIRECTORIES,
ORA-01031 sans privilège, création après GRANT) ; non-régression
`unit/database/` (116 fichiers, 2922 tests) ; `tsc --noEmit` + ESLint
propres.

### 2026-06-14 — UTL_FILE réel : I/O serveur sur le filesystem hôte (cohérence Oracle ↔ OS)
**Défaillance :** `UTL_FILE` était un **stub intégral** — `FOPEN`/`PUT_LINE`/
`GET_LINE`/`FCLOSE` renvoyaient tous `null` (deux emplacements :
`ScalarFunctionEvaluator` pour le contexte SQL, swallow `UTL_FILE.*` dans
`routeBuiltinPackageCall` pour le contexte procédural, plus des entrées
mortes dans `packageFunctions`). Un PL/SQL qui exporte un rapport ou lit un
fichier d'entrée ne faisait **rien**, et il n'existait aucune cohérence entre
la base et le filesystem hôte que le reste du simulateur modélise pourtant
(c'est précisément la couche « cohérence Oracle ↔ filesystem » visée).
**Correction :** `UtlFileEngine` de première classe, adossé aux objets
DIRECTORY (entrée précédente) et au VFS de l'hôte :
- résolution 19c stricte : le 1er argument de `FOPEN` est un **objet
  DIRECTORY** (la forme `utl_file_dir`/chemin, désupportée, est rejetée par
  ORA-29280), résolu via `catalog.getDirectory`.
- accès filesystem synchrone injecté dans `OracleInstance`
  (`setDeviceFileWriter`/`setDeviceFileRemover`, symétriques du
  `setDeviceFileReader` existant) ; câblé dans `terminal/commands/database.ts`
  vers `writeFileFromEditor`/`deleteFileFromEditor` du device. Un fichier
  écrit par `UTL_FILE.PUT_LINE` est donc **immédiatement visible par `cat`**
  dans le shell Linux du serveur, et réciproquement.
- table de handles opaques (le `FILE_TYPE` d'Oracle est un record que le
  PL/SQL ne fait que transporter) ; modes R/W/A (variantes byte RB/WB/AB
  repliées) ; `FOPEN`/`IS_OPEN`/`GET_LINE`/`PUT`/`PUT_LINE`/`PUTF`/
  `NEW_LINE`/`FFLUSH`/`FCLOSE`/`FCLOSE_ALL`/`FREMOVE`/`FRENAME`/`FCOPY`.
- intégration interpréteur : `FOPEN`/`IS_OPEN` (fonctions) dans `evalCall`
  avant le fallback SQL ; les procédures dans `execCall` avant le routage
  builtin générique. **`GET_LINE` réécrit la ligne lue dans la variable OUT
  de l'appelant** via le même chemin `exprToTarget`/`execAssign` que les
  paramètres OUT d'un sous-programme.
- exceptions aux codes canoniques (ORA-29280 répertoire invalide, 29281 mode
  invalide, 29282 handle invalide, 29283 opération invalide / fichier
  absent, **01403 NO_DATA_FOUND** en fin de fichier — rattrapable par
  `WHEN NO_DATA_FOUND` dans les boucles de lecture).
- stubs supprimés (`ScalarFunctionEvaluator`, `packageFunctions`, swallow
  `routeBuiltinPackageCall`) : `UTL_FILE` en SQL est désormais un
  identifiant invalide (ORA-00904), conforme à Oracle (package PL/SQL-only).
**Validation :** nouvelle suite `oracle-utl-file.test.ts` (16 tests :
écriture visible sur le VFS hôte, PUT+NEW_LINE, append, troncature W,
GET_LINE depuis un fichier du shell, NO_DATA_FOUND rattrapable, round-trip
écriture↔lecture, IS_OPEN, ORA-29280/29281/29283, filename avec séparateur,
FREMOVE/FRENAME/FCOPY) ; `oracle-remaining-features` mis à jour (le test qui
figeait le stub `/tmp` valide maintenant ORA-29280) ; non-régression
`unit/database/` ; `tsc --noEmit` + ESLint propres.

### 2026-06-14 — Tables externes lisant le vrai fichier hôte (ORACLE_LOADER, read-on-query)
**Défaillance :** `CREATE TABLE … ORGANIZATION EXTERNAL` n'enregistrait que
des **métadonnées de catalogue** (DBA_EXTERNAL_TABLES/LOCATIONS) : aucune
table de stockage n'était créée et le fichier de données sur le filesystem
hôte n'était **jamais lu**. `SELECT * FROM table_externe` → ORA-00942. La
brique DIRECTORY + accès filesystem (entrées précédentes) rendait enfin
possible la vraie cohérence Oracle ↔ fichier hôte pour ce cas.
**Correction :** table externe réellement interrogeable, adossée au fichier :
- `createExternalTable` crée la table de stockage en **réutilisant le chemin
  CREATE TABLE standard** sur la seule liste de colonnes (préfixe avant
  `ORGANIZATION EXTERNAL`, extrait par appariement de parenthèses) — zéro
  duplication de la logique DDL/types — puis enregistre les métadonnées
  externes et fait un premier chargement.
- `loadExternalTableData` résout chaque LOCATION via l'objet DIRECTORY
  (`catalog.getDirectory`) + le VFS hôte (`instance.readDeviceFile`), parse
  selon les ACCESS PARAMETERS (FIELDS TERMINATED BY, OPTIONALLY ENCLOSED BY,
  SKIP n), coerce les colonnes numériques, et remplace les lignes du
  storage.
- **read-on-query** : `OracleExecutor.loadTable` appelle
  `commandHost.reloadExternalTable` avant le scan, donc une modification
  ultérieure du fichier hôte est reflétée au SELECT suivant (comportement
  réel d'une table externe).
- `DROP TABLE` purge aussi `ExternalTableRegistry` (cohérence
  DBA_EXTERNAL_TABLES). Fichier absent → table vide, sans erreur.
- Helpers libres testables (`extractBalancedParens`,
  `parseExternalAccessParameters`, `splitExternalRecord` enclosure-aware,
  `coerceExternalField`).
**Limite assumée :** colonnes DATE laissées en texte (pas de format de champ
DATE), ORACLE_DATAPUMP/HIVE/HDFS non lus (métadonnées seulement).
**Validation :** nouvelle suite `oracle-external-table.test.ts` (9 tests :
lecture+typage CSV, SUM sur colonne numérique, read-on-query, SKIP,
enclosure avec délimiteur embarqué, WHERE, fichier absent = vide,
DBA_EXTERNAL_TABLES, purge au DROP) ; `oracle-structural-views`
(enregistrement externe) toujours vert ; non-régression `unit/database/` ;
`tsc --noEmit` + ESLint propres.

### 2026-06-14 — Data Pump résout DIRECTORY= contre le vrai objet répertoire
**Défaillance :** `expdp`/`impdp` **ignoraient totalement le paramètre
`DIRECTORY=`** et codaient en dur le chemin
`/u01/app/oracle/admin/ORCL/dpdump/`. Donc `expdp … DIRECTORY=MON_DIR` écrivait
quand même dans le dpdump par défaut, et un répertoire inexistant ne levait
aucune erreur. Incohérent maintenant que les objets DIRECTORY sont réels : Data
Pump doit résoudre `DIRECTORY=` contre le même catalogue que UTL_FILE et les
tables externes.
**Correction :** `handleExpdp`/`handleImpdp` résolvent
`DIRECTORY=` (défaut DATA_PUMP_DIR) via `db.catalog.getDirectory` et construisent
le chemin du `.dmp`/`.log` à partir du chemin réel de l'objet (`joinDirectoryPath`).
Répertoire inconnu → fail-fast `ORA-39002` + `ORA-39070` + `ORA-39087: directory
name X is invalid` (avant tout export/import). Le dump écrit dans un répertoire
custom est donc lisible par `cat` au bon chemin et par UTL_FILE. Rétro-compatible :
DATA_PUMP_DIR (seedé au catalogue) pointe vers le même dpdump qu'avant. Conforme
à la consigne « zéro commentaire » pour le code produit.
**Validation :** nouvelle suite `oracle-datapump-directory.test.ts` (5 tests :
chemin custom résolu + `cat`, round-trip expdp→drop→impdp via répertoire custom,
ORA-39087 expdp et impdp sur répertoire inconnu, défaut DATA_PUMP_DIR inchangé) ;
non-régression `oracle-shell-datapump-adrci`, `oracle-linux-filesystem`,
`linux-commands-and-oracle-tools` (111) + `unit/database/` ; `tsc` + ESLint propres.

### 2026-06-14 — Objets DIRECTORY visibles dans DBA_OBJECTS/ALL_OBJECTS
**Défaillance :** les objets répertoire apparaissaient dans `DBA_DIRECTORIES`
mais **pas dans `DBA_OBJECTS`** — incohérence de dictionnaire : un script DBA
faisant `SELECT … FROM dba_objects WHERE object_type='DIRECTORY'` ne les voyait
pas, alors que tables/vues/index/séquences/synonymes/triggers y figurent tous.
**Correction :** `OracleCatalog.enumerateObjects` (source de DBA_OBJECTS/
ALL_OBJECTS) émet désormais une ligne par répertoire (OWNER='SYS',
OBJECT_TYPE='DIRECTORY', namespace 4) ; `DATA_PUMP_DIR` est marqué
ORACLE_MAINTAINED='Y', les répertoires créés par l'utilisateur 'N'. DROP les
retire. Code sans commentaire (consigne).
**Validation :** +3 tests dans `oracle-directory-objects.test.ts` (présence
SYS/DIRECTORY, DATA_PUMP_DIR Oracle-maintained, retrait au DROP) ;
non-régression `unit/database/` ; `tsc` + ESLint propres.

### 2026-06-14 — Privilèges objet sur répertoires : GRANT/REVOKE READ|WRITE ON DIRECTORY (1/2)
**Défaillance :** `GRANT READ|WRITE ON DIRECTORY x TO user` ne **parsait même
pas** (le mot-clé `DIRECTORY` était consommé comme nom d'objet, puis échec sur
`TO`). Aucun privilège de répertoire ne pouvait donc être accordé — préalable à
toute application d'accès (accès × filesystem) sur UTL_FILE / tables externes /
Data Pump.
**Correction :** sans nouvelle structure de catalogue — réutilisation du registre
de privilèges objet existant (`tabPrivileges`), qui gère déjà rôles/PUBLIC/DBA via
`hasObjectPrivilege` :
- `BaseParser.parseGrant`/`parseRevoke` reconnaissent `ON DIRECTORY nom`
  (`objectType='DIRECTORY'`, AST déjà prévu).
- `SecurityDclExecutor` : branche DIRECTORY → ORA-04043 si le répertoire
  n'existe pas, autorisation de grant déléguée à
  `requireGrantableObjectPrivileges('SYS', dir, …)` (SYS/DBA/WITH GRANT OPTION),
  stockage via `grantTablePrivilege(grantee, priv, 'SYS', dir, grantable)` ;
  REVOKE symétrique.
- `DBA_TAB_PRIVS.resolveType` rapporte `DIRECTORY` (OWNER=SYS) pour ces grants.
**Validation :** nouvelle suite `oracle-directory-privileges.test.ts` (7 tests :
READ visible en DBA_TAB_PRIVS type DIRECTORY, READ+WRITE, GRANTABLE, REVOKE,
ORA-04043, ORA-01031 sans grant option, propagation WITH GRANT OPTION) ;
non-régression `unit/database/` (2961) ; `tsc` + ESLint propres. (2/2 :
application dans UTL_FILE/tables externes/Data Pump — entrée suivante.)

### 2026-06-14 — UTL_FILE applique les privilèges READ/WRITE de répertoire (2/2)
**Défaillance :** UTL_FILE n'imposait **aucun contrôle d'accès** : n'importe quel
utilisateur pouvait lire/écrire dans n'importe quel répertoire, alors qu'Oracle
exige le privilège objet READ/WRITE sur le DIRECTORY (ORA-29289 sinon). Écart de
cohérence accès × filesystem.
**Correction :** enveloppe `makeAuthorizingUtlFile(executor)` construite par bloc
dans `buildPlsqlHost` : avant `FOPEN`/`FREMOVE`/`FRENAME`/`FCOPY`, elle vérifie
l'accès via `securityEngine.privileges.hasObjectPrivilege(user, 'READ'|'WRITE',
'SYS', dir)` — le **même** mécanisme que les privilèges de table, donc
SYS/owner/DBA/rôles/PUBLIC gérés gratuitement. Mode W/A → WRITE, R → READ ; échec
→ ORA-29289. L'`UtlFileEngine` reste pur (I/O), l'autorisation vit dans la couche
DB avec l'utilisateur courant lu en direct sur le contexte de l'exécuteur.
**Limite assumée :** appels imbriqués definer-rights → contrôle sur l'utilisateur
courant du contexte (invoker dans les blocs anonymes), suffisant pour le cas commun.
**Validation :** nouvelle suite `oracle-utl-file-privileges.test.ts` (8 tests :
ORA-29289 sans grant, WRITE autorise l'écriture, READ la lecture, READ seul refuse
l'écriture, grant à PUBLIC, REVOKE re-refuse, SYS sans grant, FREMOVE exige WRITE) ;
non-régression `unit/database/` ; `tsc` + ESLint propres.

### 2026-06-14 — Tables externes : READ de répertoire exigé à l'interrogation
**Défaillance :** un `SELECT` sur une table externe lisait le fichier hôte sans
vérifier que l'utilisateur détient READ sur le DIRECTORY (un vrai Oracle lève
ORA-29913/KUP/ORA-29289).
**Correction :** `reloadExternalTable(schema, table, requestingUser)` transmet
l'utilisateur courant depuis `OracleExecutor.loadTable` ; `loadExternalTableData`
vérifie `canAccessDirectory(user, dir, 'READ')` pour chaque LOCATION et lève
`ORA-29913` (enveloppant ORA-29289) en cas de refus. Le chargement *eager* au
CREATE ne contrôle pas (contexte de création, pas d'utilisateur). SYS/owner/DBA/
rôles/PUBLIC gérés par le même `hasObjectPrivilege`.
**Validation :** nouvelle suite `oracle-external-table-privileges.test.ts` (4
tests : refus sans READ, succès après GRANT, owner SYS sans grant, refus après
REVOKE) ; base `oracle-external-table` (SYS) inchangée ; non-régression
`unit/database/` ; `tsc` + ESLint propres.

### 2026-06-14 — Data Pump applique les privilèges de répertoire (expdp WRITE, impdp READ)
**Défaillance :** `expdp`/`impdp` ne vérifiaient pas que l'utilisateur connecté
détient WRITE (export) / READ (import) sur le DIRECTORY — n'importe qui pouvait
écrire/lire le dump.
**Correction :** `canAccessDirectory` exposée publiquement ; `handleExpdp`/
`handleImpdp` extraient l'utilisateur de `user/pass` (`connectUserOf`) et
vérifient WRITE/READ sur le répertoire après le contrôle d'existence — refus →
`ORA-39002` + `ORA-29289`. SYS/DBA/rôles/PUBLIC gérés par le même
`hasObjectPrivilege` ; rétro-compatible (`sys/oracle` bypass owner).
**Limite assumée :** les handlers ne valident pas le mot de passe ni les rôles
DATAPUMP_*_FULL_DATABASE — seul l'accès répertoire est imposé.
**Validation :** +4 tests dans `oracle-datapump-directory.test.ts` (expdp refusé
sans WRITE, autorisé après GRANT WRITE, impdp exige READ, SYS sans grant) ;
suites datapump existantes (`sys/oracle`) inchangées ; non-régression
`unit/database/` + `linux-commands-and-oracle-tools` ; `tsc` + ESLint propres.
Ceci clôt l'application des privilèges DIRECTORY (UTL_FILE + tables externes +
Data Pump).

### 2026-06-14 — BFILE / BFILENAME : locators LOB vers fichiers hôtes via répertoires
**Défaillance :** le type `BFILE` était reconnu (lexer, DataType, DBA_LOBS) mais
`BFILENAME` et les fonctions DBMS_LOB sur BFILE n'existaient pas — une colonne
BFILE ne pouvait pas réellement pointer un fichier hôte ni en lire la
taille/présence. Brique manquante de la cohérence répertoire → fichier hôte.
**Correction :** réutilise objets DIRECTORY + VFS hôte + privilège READ déjà en
place :
- `BFILENAME('DIR','file')` (fonction scalaire) → locator `BFILE:DIR/file`,
  stockable dans une colonne BFILE et relisible.
- `DBMS_LOB.FILEEXISTS` (1/0) et `DBMS_LOB.GETLENGTH` reconnaissent un locator
  BFILE et résolvent le fichier via `host.readBfile` (DIRECTORY + readDeviceFile) ;
  GETLENGTH garde le calcul de longueur CLOB pour les chaînes (rétro-compat).
- `readBfileContent` (exécuteur) impose l'existence du répertoire et le privilège
  READ (`hasObjectPrivilege`) → `ORA-22285` sinon ; fonctionne en SQL et en PL/SQL
  (le bloc PL/SQL passe par le pont SQL).
**Limite assumée :** `DBMS_LOB.FILEGETNAME` (OUT) et la lecture de contenu
(`READ`/`LOADCLOBFROMFILE`) non implémentées — présence/taille seulement.
**Validation :** nouvelle suite `oracle-bfile.test.ts` (9 tests : locator
stocké/relu, FILEEXISTS 1/0, GETLENGTH fichier, GETLENGTH CLOB inchangé,
ORA-22285 répertoire inconnu, pont PL/SQL, refus sans READ, succès après GRANT) ;
non-régression `unit/database/` ; `tsc` + ESLint propres.

### 2026-06-14 — Cohérence process : tuer le serveur dédié au niveau OS termine la session
**Défaillance :** `ALTER SYSTEM KILL SESSION` libérait bien le processus serveur
(disparaît de `ps`), mais le sens **inverse** manquait : un `kill`/`pkill` du
processus serveur dédié (`oracleORCL`) depuis le shell Linux ne tuait pas la
session Oracle — `ps` perdait le process mais V$SESSION et l'OracleDatabase
gardaient la session vivante. Incohérence process OS ↔ session.
**Correction :** symétrique de KILL SESSION→ps, via l'événement
`linux.process.signalled` déjà émis par le `LinuxProcessManager` :
- `OracleFilesystemSync` s'y abonne ; sur signal terminant (TERM/KILL/INT/QUIT/
  HUP) effectivement délivré, il remonte la chaîne de pid : `dev.externalPidForOsPid`
  (osPid → pid Oracle, via la map interne `registerProcess`), puis
  `instance.getServerProcessByPid` (pid → sessionSid).
- `OracleDatabase.endSessionByOsKill(sid)` tue V$SESSION (`SessionLimitTracker.
  killBySid`), purge la connexion et ferme la session (`closeSession` →
  `releaseServerProcess`), avec entrée alert log. Les processus d'arrière-plan
  (PMON/SMON…) ne sont pas des server processes → no-op naturel.
**Validation :** nouvelle suite `oracle-process-kill.test.ts` (2 tests : `pkill`
du serveur → session absente + `ps` nettoyé ; SIGCONT non terminant → session
intacte) ; non-régression `unit/database/` + `linux-commands-and-oracle-tools` ;
`tsc` + ESLint propres.

### 2026-06-14 — DBMS_SCHEDULER jobs EXECUTABLE : exécution réelle sur l'hôte
**Défaillance :** `SchedulerManager.runJob` exécutait **toujours** `job_action`
comme du SQL/PLSQL, en ignorant `job_type`. Un job `EXECUTABLE` (dont
`job_action` est une commande OS) échouait donc au lieu de lancer le programme
sur le serveur — le `extjob`/external job daemon n'était pas modélisé.
**Correction :** runner de commande OS injecté dans l'instance
(`setOsCommandRunner`/`runOsCommand`, comme `setDeviceFileReader`), câblé dans
`terminal/commands/database.ts` vers `device.runSshCommandSync('oracle', cmd)`
(exécution en tant qu'utilisateur OS oracle, retour `{output, exitCode}`).
`runJob` branche sur `jobType` : `EXECUTABLE` → exécution hôte réelle, sortie
capturée, `STATUS=SUCCEEDED` si exit 0, sinon `FAILED` + `ORA-27369` (exit code) ;
`ORA-27370` si le runner est absent. PLSQL_BLOCK/STORED_PROCEDURE conservent le
chemin SQL. La sortie/erreur remonte dans `DBA_SCHEDULER_JOB_RUN_DETAILS`.
**Validation :** nouvelle suite `oracle-scheduler-executable.test.ts` (4 tests :
echo → SUCCEEDED + output capturé, commande inexistante → FAILED/ORA-27369,
fichier écrit par le job visible via `cat` (preuve d'exécution hôte réelle),
PLSQL_BLOCK toujours en SQL) ; non-régression `unit/database/` ; `tsc` + ESLint
propres.

### 2026-06-16 — INACTIVE_ACCOUNT_TIME appliqué au login + raisons de verrouillage distinctes
**Défaillance (cohérence couche accès) :** `INACTIVE_ACCOUNT_TIME` (profil, 12c+)
n'était **jamais** appliqué dans le chemin d'authentification. Un compte dormant
restait connectable tant qu'aucun `DormantAccountAnalyzer.sweep()` manuel n'avait
été déclenché — alors que le vrai Oracle verrouille l'account au *connect time*
(le contrôle de fond a déjà posé le lock). Toute l'infrastructure existait pourtant
déjà : `ProfileManager.resolveInactiveAccountTimeDays`, et la date de dernier login.
Défaut connexe : `LoginTracker.lockAccount` servait indistinctement aux trois types
de verrou (échecs de login, lock DBA `ALTER USER … ACCOUNT LOCK`, inactivité), et
`shouldAutoUnlock` les déverrouillait **tous** après `PASSWORD_LOCK_TIME`. Or un
lock DBA et un lock d'inactivité ne doivent **jamais** s'auto-déverrouiller : ils
exigent un `ACCOUNT UNLOCK` explicite. Un `ACCOUNT LOCK` posé par un DBA se levait
donc tout seul au bout d'un jour — écart de fidélité.
**Correction (enhancement de l'existant, pas de duplication) :**
- `LoginAttemptRecord` enrichi de `lockReason: 'FAILED_LOGIN' | 'INACTIVITY' | 'DBA'`
  et de `lastSuccessAt` (timestamp du dernier login réussi).
- `LoginTracker` : `lockAccount(user, reason)` tague la raison ; `recordSuccess`
  estampille `lastSuccessAt` ; `shouldAutoUnlock` ne libère que les locks
  `FAILED_LOGIN` (les locks DBA/inactivité restent verrouillés) ; nouveau getter
  `getLastSuccessfulLogin`.
- `SecurityEngine.authenticate` : nouveau contrôle d'inactivité, placé avant la
  vérification du mot de passe (un compte dormant est refusé quel que soit le mot
  de passe, comme la branche LOCKED existante). Point de référence : dernier login
  réussi, à défaut date de création du compte (même règle que le
  `DormantAccountAnalyzer`). Dépassement → `catalog.lockUser` + lock `INACTIVITY`
  + `ORA-28000: the account is locked`.
- Les deux appelants existants alignés sur la raison correcte : `UserAdminExecutor`
  (`ACCOUNT LOCK` → `'DBA'`) et `DormantAccountAnalyzer.sweep` (→ `'INACTIVITY'`),
  sans dupliquer la logique de lock.
**Validation :** `oracle-security-engine.test.ts` étendu (81 tests verts) : nouveau
bloc d'intégration `INACTIVE_ACCOUNT_TIME` (CREATE PROFILE end-to-end, compte frais
OK, compte dormant → ORA-28000 + statut LOCKED, refus malgré mot de passe valide,
référence = dernier login et non création, réveil après `ACCOUNT UNLOCK`) + tests
unitaires `LoginTracker` des raisons de lock et du dernier login. Non-régression :
`unit/database/` complet (125 fichiers, 3004 tests verts) ; `tsc` + ESLint propres.

### 2026-06-16 — Le listener Oracle respecte le firewall (iptables) du host
**Défaillance (cohérence couche réseau) :** la résolution Oracle Net distante
(`resolveOracleConnectTarget`) vérifiait l'hôte, l'alimentation, le type de device,
le port et le service du listener — mais **jamais le firewall** du host cible. Comme
une connexion `sqlplus user/pass@//host/svc` se résout par référence vers la
`OracleDatabase` cible (sans forger de SYN qui traverserait la pile réseau), une
règle `iptables -A INPUT -p tcp --dport 1521 -j DROP` posée sur le serveur de base
**n'avait aucun effet** : le client se connectait quand même. Écart direct avec un
vrai hôte, où le SYN est filtré par netfilter avant toute négociation TNS.
**Correction (réutilisation de l'infrastructure existante, pas de duplication) :**
- Nouvelle capacité `LinuxMachine.firewallAcceptsInboundTcp(srcIP, dstIP, dstPort)`
  qui évalue la chaîne INPUT via le `LinuxIptablesManager` déjà en place
  (`executor.iptables.filterPacket`), en déduisant l'interface d'ingress du port
  portant l'adresse ciblée (pour que les règles `-i <iface>` matchent comme pour un
  vrai paquet). Aucune logique de filtrage réimplémentée.
- `oracleNet.resolveOracleConnectTarget` interroge cette capacité pour les
  connexions **distantes** uniquement (le bequest local ne traverse pas le réseau),
  et mappe le verdict sur l'échelle d'erreurs Oracle Net réelle : `DROP` → SYN avalé
  → `ORA-12170: TNS:Connect timeout occurred` ; `REJECT` → refus actif, indiscernable
  de l'absence de listener → `ORA-12541: TNS:no listener`. Le contrôle précède la
  négociation TNS, comme au niveau paquet.
**Validation :** `oracle-tns-remote.test.ts` étendu (24 tests verts) : DROP/1521 →
ORA-12170 puis reconnexion après `iptables -F`, REJECT/1521 → ORA-12541, règle sur
un autre port (22) sans effet, bequest local exempté. Non-régression :
`unit/database/` (3008 tests verts) + `network-v2/linux-iptables` (128) ; `tsc`
propre, ESLint propre sur les fichiers modifiés (l'avertissement `no-this-alias`
en `LinuxMachine.ts:1059` préexiste, hors périmètre).

### 2026-06-16 — Déduplication finale du parsing/formatage de dates Oracle
**Défaillance (duplication) :** quatre implémentations parallèles des mêmes
primitives de date subsistaient, au mot près :
- `ScalarFunctionEvaluator.coerceDate` ≡ `dateSupport.coerceDateValue` (identiques) ;
- `ScalarFunctionEvaluator.formatDate` ≡ `dateSupport.formatDateValue` (identiques) ;
- `OracleExecutor.formatOracleDate` ≡ `dateSupport.formatDateWithPattern` (identiques) ;
- `OracleExecutor.parseOracleDate` ≡ `dateSupport.parseDateWithPattern` (identiques) ;
- `OracleExecutor.coerceToDateMs` ré-implémentait encore le même `Date.parse`.
Risque concret : une correction de fidélité (p.ex. un nouveau token de format ou
un fuseau) appliquée à un seul exemplaire fait diverger silencieusement le rendu
SQL, le rendu PL/SQL et l'arithmétique de dates.
**Correction (source unique, pas de réécriture) :** `dateSupport` devient l'unique
implémentation. `ScalarFunctionEvaluator` importe `coerceDateValue`/`formatDateValue`
(et les ré-exporte sous leurs noms historiques `coerceDate`/`formatDate` pour ne pas
casser les consommateurs). `OracleExecutor.formatOracleDate`/`parseOracleDate`
délèguent à `formatDateWithPattern`/`parseDateWithPattern` ; `coerceToDateMs`
réutilise `coerceDateValue` tout en conservant son garde-fou plus strict (la
comparaison exige un timestamp complet, pas un `YYYY-MM-DD` nu). ~90 lignes
dupliquées supprimées, aucun changement de comportement.
**Validation :** `unit/database/` complet (125 fichiers, 3008 tests verts) couvrant
TO_DATE/TO_CHAR/SYSDATE, l'arithmétique de dates et le PL/SQL ; `tsc` + ESLint propres.

### 2026-06-16 — ALTER USER … IDENTIFIED BY : bon code ORA (28003 vs 28007)
**Défaillance (fidélité d'erreur) :** sur `ALTER USER … IDENTIFIED BY`,
`UserAdminExecutor` levait **toujours** `OracleError(28007, …)` (réutilisation) quand
`SecurityEngine.changePassword` échouait — y compris quand l'échec venait du
**vérificateur de complexité** (`PASSWORD_VERIFY_FUNCTION`), dont le vrai code est
`ORA-28003`. Comme `changePassword` ne renvoyait qu'une string, l'appelant devinait
le code. Résultat : un mot de passe trop faible rejeté avec un message
`ORA-28003: …` mais un `err.code = ORA-28007`, soit un rendu `format()`
incohérent « ORA-28007: ORA-28003: … ». (À l'inverse, `CREATE USER` levait déjà
correctement `ORA-28003`.)
**Correction (propagation structurée, pas de devinette) :** `changePassword`
retourne désormais `{ ok, error?, errorCode? }` — `28003` pour un échec du
vérificateur, `28007` pour une violation de réutilisation. L'appelant lève
`OracleError(result.errorCode ?? 28007, …)` en nettoyant le préfixe ORA- redondant.
Branches de réutilisation (`violatesReuseTime`/`violatesReuseMax`) fusionnées.
**Validation :** `oracle-security-enhancements.test.ts` étendu (mot de passe faible
sous profil vérificateur → ORA-28003 et **pas** 28007 ; réutilisation → ORA-28007) ;
non-régression auth/user (oracle-auth-integration, user-activity,
access-management-comprehensive : 844 tests verts) ; `tsc` + ESLint propres.

### 2026-06-16 — PASSWORD_ROLLOVER_TIME (19c) appliqué à l'authentification
**Défaillance (cohérence couche accès) :** le paramètre de profil
`PASSWORD_ROLLOVER_TIME` (19c) était stocké, listé dans `DBA_PROFILES` et résolu
(`resolvePasswordRolloverTimeDays`) mais **jamais appliqué**. Le vrai Oracle 19c, après
un changement de mot de passe sous un profil avec rollover, garde l'**ancien** mot de
passe valide pendant la fenêtre de rollover — ce qui permet à un parc de clients /
pool de connexions de basculer progressivement vers le nouveau credential sans
coupure. Ici, l'ancien mot de passe était immédiatement rejeté (ORA-01017).
**Correction (enhancement de l'existant) :**
- `PasswordManager.isWithinRollover(user, candidate, rolloverDays)` : `true` si
  `candidate` est le mot de passe *précédent* (history[1]) et que l'on est encore
  dans la fenêtre depuis le dernier changement (référence = `history[0].changedAt`,
  testable) ; fenêtre nulle/négative = désactivé ; `UNLIMITED` = toujours valide.
- `SecurityEngine.authenticate` : quand la comparaison au mot de passe courant
  échoue, on tente le rollover *avant* d'enregistrer un échec — un login en rollover
  n'incrémente donc pas `FAILED_LOGIN_ATTEMPTS`. Les autres mots de passe erronés
  restent en ORA-01017.
**Validation :** `oracle-security-engine.test.ts` étendu (90 tests verts) : 5 tests
unitaires `PasswordManager` (précédent accepté dans la fenêtre, courant non éligible,
fenêtre 0 désactivée, expiration après la fenêtre, absence de précédent) + 4 tests
d'intégration via `connect` (nouveau OK, ancien OK pendant la fenêtre, mot de passe
sans rapport → ORA-01017, profil sans rollover → ancien rejeté). Non-régression
sécurité/auth (91 tests) ; `tsc` + ESLint propres.

### 2026-06-16 — Suppression des copies mortes de date dans valueUtils (dedup, suite)
**Défaillance (duplication) :** après la consolidation précédente vers `dateSupport`,
`functions/valueUtils.ts` conservait encore un **5ᵉ exemplaire** au mot près de
`coerceDate`, `formatDate`, `formatOracleDate` et `parseOracleDate`. Pire : ces
quatre exports n'étaient **importés nulle part** (recherche projet : seuls
`compareValues` et `implicitToDate` de ce module sont consommés — par
`OracleExecutor`, `ConstraintValidator`, `OracleStorage`). Du code mort dupliqué
qui rouvrait la porte à la dérive corrigée juste avant.
**Correction :** suppression pure des quatre fonctions et des helpers devenus
inutilisés (`pad`, `MONTHS_LONG`, `DAYS_LONG`). `valueUtils` ne garde que ce qui lui
est propre — `implicitToDate` (conversion implicite NLS DD-MON-RR, logique RR) et
`compareValues` (comparaison Oracle 3-way). `dateSupport` reste l'unique source du
formatage/parsing de dates. ~70 lignes mortes retirées.
**Validation :** `tsc` + ESLint propres ; `unit/database/` complet (125 fichiers,
3019 tests verts).

### 2026-06-16 — AUDIT_SYSLOG_LEVEL : audit Oracle routé vers le syslog du host
**Défaillance (cohérence couche audit ↔ journalisation OS) :** l'audit Oracle
n'allait que dans la trail catalogue et les fichiers `.aud` (adump). Le vrai Oracle,
quand le paramètre `AUDIT_SYSLOG_LEVEL = facility.priority` est positionné, envoie
*en plus* les enregistrements d'audit OS au **syslog du système** (mécanisme
canonique de centralisation vers rsyslog/SIEM). Ce paramètre n'était ni appliqué ni
relié à la pile de logs de l'hôte (`LinuxLogManager`, qui gère pourtant déjà les
facilities `local0-7`/priorités et `/var/log/syslog`).
**Correction (multi-couches, réutilisation de l'existant, pattern adaptateur) :**
- `LinuxLogManager.logAt(facility.priority, tag, message)` : écriture publique à une
  facility/priorité arbitraire, en réutilisant le parseur `parsePriority` déjà
  présent (utilisé par la commande `logger`).
- `LinuxMachine.logSyslog(spec, tag, message)` : capacité device publique déléguant
  à `logMgr.logAt` (comme `firewallAcceptsInboundTcp` pour le firewall).
- Nouvel adaptateur `OracleAuditSyslogSync` (miroir de `OracleSystemdSync`/
  `OracleFilesystemSync`) : abonné à `oracle.audit.recorded`, il lit
  `audit_syslog_level` sur l'instance ; **si le paramètre est absent (défaut), rien
  n'est écrit** (fidèle) ; sinon il émet une ligne « Oracle Audit » structurée
  (`SESSIONID/DBUSERID/ACTION/RETURNCODE/OS$USERID/USERHOST/TERMINAL[/OBJ$NAME]`)
  vers le syslog. Câblé dans `terminal/commands/database.ts` (construction, start,
  teardown, reset) à côté des deux adaptateurs existants.
**Validation :** nouvelle suite `oracle-audit-syslog-coherence.test.ts` (3 tests :
DDL audité → ligne « Oracle Audit » dans `/var/log/syslog` quand le niveau est
positionné, **rien** quand il ne l'est pas, ligne portant `DBUSERID "SYS"` et
l'ACTION). Non-régression : `unit/database/` complet (126 fichiers, 3022 tests
verts) + `network-v2/logging-enhancements` (12) ; `tsc` propre, ESLint propre sur le
code modifié (warning `no-this-alias` `LinuxMachine.ts:1059` préexistant).

### 2026-06-21 — DBMS_SCHEDULER : jobs STORED_PROCEDURE réellement invoqués + statut FAILED fidèle
**Défaillance (fonctionnalité cassée + écart Oracle réel) :** trois défauts liés dans la
couche scheduler.
1. `DbmsScheduler.CreateJob` castait `job_type` en littéral `as 'PLSQL_BLOCK'`
   (`packages/DbmsScheduler.ts:19`) — un mensonge de type qui faisait croire que tout job
   était de type PLSQL_BLOCK, alors que la valeur runtime réelle (`STORED_PROCEDURE`,
   `EXECUTABLE`) était bien conservée. Smell masquant le défaut nº2.
2. `SchedulerManager.runJob` routait **tous** les jobs non-EXECUTABLE par
   `executeSql(job_action)` verbatim. Un job `STORED_PROCEDURE` ne porte qu'un **nom de
   procédure nu** dans `job_action` (les arguments passent par `SET_JOB_ARGUMENT_VALUE`) —
   Oracle l'invoque comme un appel. Passer ce nom nu à `executeSql` n'est pas du SQL valide,
   donc **tout job STORED_PROCEDURE échouait** (alors que la même procédure marche en `EXEC`).
   De plus le job s'exécutait dans le schéma `SYS` (via `connectAsSysdba`) au lieu du schéma
   de son **propriétaire**, donc un nom non-qualifié ne se résolvait pas chez le bon owner.
3. `runJob` ne marquait `FAILED` que sur exception **levée**. Or les erreurs PL/SQL/SQL
   remontent dans `result.message` (`ORA-`/`PLS-`), pas comme exceptions (cf. itération 2 :
   un bloc imparsable renvoie `ORA-06550`). Un job dont l'action levait une erreur était donc
   rapporté `SUCCEEDED` à tort dans `DBA_SCHEDULER_JOB_RUN_DETAILS`.
**Correction (enhancement de l'existant, pas de duplication) :**
- `packages/DbmsScheduler.ts` : `coerceJobType()` valide la valeur contre l'union
  `JobType` réelle (`PLSQL_BLOCK`/`STORED_PROCEDURE`/`EXECUTABLE`), défaut PLSQL_BLOCK — fin
  du cast trompeur, `job_type` correct dans `DBA_SCHEDULER_JOBS`.
- `scheduler/SchedulerManager.runJob` : la branche non-EXECUTABLE retarge le contexte
  d'exécution (`currentUser`/`currentSchema`) vers le **propriétaire** du job (fidèle : le
  slave tourne dans le schéma de l'owner avec ses privilèges, la connexion interne restant
  SYSDBA), et un job `STORED_PROCEDURE` est enveloppé en `BEGIN <action>; END;` — réutilisant
  la chaîne `routePlsql → executeProcedureCall` déjà en place (résolution de noms, droits
  EXECUTE, definer rights) plutôt que de dupliquer le dispatch.
- Détection d'échec : après `executeSql`, `runJob` scanne `result.message` pour un code
  `ORA-`/`PLS-` et bascule le run en `FAILED` avec le bon `ERROR#`. Cohérent avec la façon
  dont le moteur PL/SQL surface ses erreurs.
**Validation :** nouvelle suite `oracle-scheduler-stored-procedure.test.ts` (3 tests : un job
STORED_PROCEDURE invoque la procédure et **persiste** son INSERT + run SUCCEEDED ; `JOB_TYPE`
réel rendu dans `DBA_SCHEDULER_JOBS` ; procédure inexistante → run **FAILED**). Non-régression :
`unit/database/` complet (129 fichiers, 3041 tests verts), dont les suites scheduler
existantes (`autorun`, `executable`, `multitenant-dg`) ; `tsc` propre, ESLint propre sur le
code modifié.

### 2026-06-21 — I/O fichiers serveur Oracle soumis au DAC du host (utilisateur OS `oracle`)
**Défaillance (cohérence couche filesystem ↔ accès, majeure) :** tout l'I/O fichier
côté serveur Oracle — `UTL_FILE`, tables externes, `BFILE`, Data Pump, `CREATE PFILE/SPFILE` —
transitait par les hooks `setDeviceFileReader/Writer/Remover` (`terminal/commands/database.ts`)
câblés sur le **chemin éditeur** du device (`readFileForEditor`/`writeFileFromEditor`).
Conséquences, divergentes d'un vrai serveur :
1. **Lecture sans aucun contrôle de permission** : `readFileForEditor` fait un
   `vfs.readFile` brut. Oracle pouvait donc lire un fichier `root:root` en `0600` (p.ex.
   placé dans un DIRECTORY) que l'utilisateur OS `oracle` n'a normalement pas le droit de lire.
   Le privilège Oracle `READ ON DIRECTORY` était vérifié, mais **jamais** le DAC du host.
2. **Écriture mal attribuée** : `writeFileFromEditor` écrit avec l'uid du **shell interactif
   courant** (souvent root), pas celui d'`oracle`. Un fichier produit par `UTL_FILE.PUT_LINE`
   apparaissait donc `root:root` au lieu d'`oracle:oinstall`, et une écriture dans un
   répertoire interdit à `oracle` **réussissait** quand même.
**Correction (réutilisation de l'infra DAC existante, pas de réimplémentation) :**
- `LinuxMachine` expose trois capacités serveur — `readFileAsOracle`, `writeFileAsOracle`,
  `removeFileAsOracle` — qui résolvent l'identité de l'utilisateur OS `oracle` (uid/gid/groupes
  via le `LinuxUserManager`, repli 54321:54321) et appliquent le DAC du host via le modèle
  d'acteur `VfsPath`/`PathActor` **déjà en place** (mêmes `checkAccess`/ACL POSIX que le shell) :
  lecture = search(x) sur le répertoire + read(r) sur le fichier ; écriture = write sur un
  fichier existant ou write+search sur le répertoire parent à la création ; unlink = write+search
  sur le répertoire. Le fichier créé est possédé `oracle:oinstall`.
- `terminal/commands/database.ts` recâble les trois hooks Oracle sur ces capacités `*AsOracle`
  (repli sur le chemin éditeur pour les devices qui ne modélisent pas l'identité oracle). Le
  probe d'existence (`setHostFileProbe`) reste sur le chemin brut — l'existence d'un fichier
  ne dépend pas de la permission de lecture.
- `UtlFileEngine` : `flush` renvoie désormais le verdict d'écriture du host ; `FOPEN('W'/'A')`
  refusé → `ORA-29283`, `PUT/PUT_LINE/NEW_LINE/FFLUSH/FCLOSE` en échec d'écriture → `ORA-29285`.
  Le refus DAC, rendu possible par le point ci-dessus, est ainsi **observable** comme sur un
  vrai serveur, au lieu d'être silencieusement avalé.
**Validation :** nouvelle suite `oracle-server-file-dac.test.ts` pilotant un vrai `LinuxServer`
(VFS + DAC de bout en bout, pas le stand-in Map) : (1) un fichier écrit par `UTL_FILE` est
possédé par `oracle` et lisible par `cat` ; (2) Oracle lit un fichier world-readable mais se
voit refuser un `root:root 0600` (`ORA-29283`, pas de fuite) ; (3) une écriture `UTL_FILE` dans
`/root` (0700) échoue (`ORA-29285`, fichier non créé). Non-régression : `unit/database/` complet
(130 fichiers, 3044 tests verts) — dont `oracle-utl-file`, `-privileges`, `external-table`,
`bfile`, `datapump-directory` — + `debug/oracle/` (14 suites) ; `tsc` propre, ESLint propre sur
le code ajouté (les 2 `no-this-alias` de `LinuxMachine.ts` préexistent, hors périmètre).

### 2026-06-21 — Déduplication de la résolution de table dans ALTER TABLE (+ ORA-942 sur MOVE COMPRESS)
**Défaillance (duplication + incohérence mineure) :** `OracleExecutor.executeAlterTable`
ré-inlinait cinq fois le couple `storage.getTableMeta(...)` + `if (!meta) throw ORA-942`
(branches MODIFY_COLUMN, ENCRYPT_COLUMN, RENAME_COLUMN, RENAME_TABLE, MOVE_TABLESPACE) alors
que le helper privé `requireTableMeta(schema, table)` — déjà utilisé par TRUNCATE et la branche
ADD_COLUMN du même switch — fait exactement cela. Une correction de fidélité sur le message/code
d'erreur ORA-942 aurait dû être répétée six fois. Par ailleurs, la branche `MOVE_COMPRESS`
résolvait la table avec un `if (meta) { … }` **sans else** : un `ALTER TABLE … MOVE COMPRESS`
sur une table inexistante était un **no-op silencieux** au lieu de lever `ORA-00942`, à rebours
de toutes les autres branches.
**Correction (source unique, pas de réécriture) :** les cinq inlines deviennent
`const meta = this.requireTableMeta(schema, tableName);` ; `MOVE_COMPRESS` adopte le même helper
et applique la compression sans garde conditionnelle. Comportement inchangé sur le chemin nominal
(la table est déjà garantie existante par le `tableExists` en tête de méthode), code aligné et
ORA-942 désormais uniforme sur toutes les branches. ~10 lignes dupliquées retirées.
**Validation :** `unit/database/` complet (130 fichiers, 3044 tests verts), dont les suites
ALTER/MODIFY/TDE/tablespace ; `tsc` propre.

<!-- Format :
### YYYY-MM-DD — Titre court (commit <sha>)
**Défaillance :** description du problème (duplication, anti-pattern, écart Oracle réel).
**Correction :** ce qui a été fait, pattern appliqué.
**Validation :** tests exécutés.
-->
