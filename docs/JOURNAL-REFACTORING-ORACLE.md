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

<!-- Format :
### YYYY-MM-DD — Titre court (commit <sha>)
**Défaillance :** description du problème (duplication, anti-pattern, écart Oracle réel).
**Correction :** ce qui a été fait, pattern appliqué.
**Validation :** tests exécutés.
-->
