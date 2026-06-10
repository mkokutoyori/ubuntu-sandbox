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
