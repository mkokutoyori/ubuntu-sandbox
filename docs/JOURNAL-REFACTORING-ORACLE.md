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
