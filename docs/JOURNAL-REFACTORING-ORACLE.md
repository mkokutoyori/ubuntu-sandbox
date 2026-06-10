# Journal de bord — Refactoring du simulateur Oracle DBMS

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

<!-- Format :
### YYYY-MM-DD — Titre court (commit <sha>)
**Défaillance :** description du problème (duplication, anti-pattern, écart Oracle réel).
**Correction :** ce qui a été fait, pattern appliqué.
**Validation :** tests exécutés.
-->
