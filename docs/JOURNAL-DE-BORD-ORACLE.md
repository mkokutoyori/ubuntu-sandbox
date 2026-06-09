# Journal de bord — Refactoring de la simulation Oracle

Ce journal documente chaque défaillance ou limite corrigée dans le sous-système Oracle
(`src/database/oracle/`, `src/database/engine/`, intégration SQL*Plus), avec le diagnostic,
la correction apportée et la justification par rapport au comportement du vrai Oracle Database.

État de référence avant intervention : 67 fichiers de tests, 2520 tests verts
(`npx vitest run src/__tests__/unit/database/`).

---

## Audit initial (2026-06-09)

Problèmes structurels identifiés, classés par priorité :

| # | Problème | Sévérité | Localisation |
|---|----------|----------|--------------|
| 1 | Sémantique ROWNUM fausse (compteur incrémenté pour chaque ligne scannée, pas seulement les lignes acceptées) | Critique (fidélité) | `OracleExecutor.ts` |
| 2 | `evaluateFunction` : switch monolithique de ~400 lignes pour ~80 fonctions SQL, sans registre extensible | Haute (design) | `OracleExecutor.ts:4007-4402` |
| 3 | Dispatch SQL*Plus : chaîne if/else linéaire de ~200 lignes au lieu d'un registre de commandes | Haute (design) | `SQLPlusSession.ts:251-445` |
| 4 | `COLUMN FORMAT` stocké mais jamais appliqué au rendu ; LINESIZE non appliqué | Moyenne (fidélité) | `SQLPlusSession.ts` |
| 5 | `SHOW ERRORS` retourne toujours « No errors. » sans tracker les erreurs de compilation PL/SQL | Moyenne (fidélité) | `SQLPlusSession.ts:831` |
| 6 | Trois implémentations divergentes de parsing/formatage de dates dans l'exécuteur | Moyenne (duplication) | `OracleExecutor.ts:4405,4429,4624,4649,4659,4720` |
| 7 | Fonctions scalaires (SUBSTR, UPPER, NVL…) dupliquées entre l'exécuteur SQL et l'interpréteur PL/SQL | Moyenne (duplication) | `OracleExecutor.ts` / `PlsqlInterpreter.ts:867+` |
| 8 | Modes de SHUTDOWN non différenciés (NORMAL n'attend pas, TRANSACTIONAL non géré) ; flag shutdown-pending jamais vérifié à la connexion (ORA-01089 manquant) | Moyenne (fidélité) | `OracleInstance.ts` |
| 9 | Contraintes CHECK re-parsées à chaque exécution au lieu d'être compilées une fois | Basse (perf) | `OracleExecutor.ts:4797` |

---

## Correction n°1 — Sémantique ROWNUM conforme à Oracle

**Défaillance.** Le compteur ROWNUM était incrémenté pour chaque ligne *scannée* pendant
le filtre WHERE, qu'elle satisfasse ou non le prédicat. Conséquences :

- `WHERE ROWNUM = 2` retournait la 2ᵉ ligne scannée — dans le vrai Oracle cette requête
  ne retourne **jamais** de ligne (la ligne candidate reçoit toujours ROWNUM = 1 tant
  qu'aucune ligne n'a été acceptée).
- `WHERE username = 'X' AND ROWNUM <= 2` comptait aussi les lignes rejetées par
  `username = 'X'`, donc pouvait retourner 0 ligne au lieu des 2 premières correspondantes.
- `SELECT ROWNUM, …` en projection utilisait la valeur résiduelle du compteur de la phase
  WHERE (toutes les lignes affichaient le même numéro).
- Une sous-requête écrasait le compteur de la requête englobante (pas de scope par bloc).

**Correction.** (`src/database/oracle/OracleExecutor.ts`)
- Phase WHERE : `ROWNUM` candidat = `lignes_acceptées + 1`, incrément implicite seulement
  quand le prédicat complet réussit — sémantique exacte d'Oracle.
- Phase projection : numérotation 1..N des lignes en sortie du filtre, avant ORDER BY
  (comme Oracle : ROWNUM est assigné avant le tri).
- `executeSelectInner` sauvegarde/restaure le compteur autour de chaque bloc de requête :
  chaque bloc (sous-requête comprise) possède son propre ROWNUM.

**Tests.** 6 tests de régression ajoutés dans `oracle-phase4.test.ts` (ROWNUM=1, ROWNUM=2,
ROWNUM>1, prédicat combiné, projection séquentielle, isolation sous-requête).

---

## Correction n°2 — Registre de fonctions SQL (pattern Registry/Strategy)

**Défaillance.** `OracleExecutor.evaluateFunction` était un switch monolithique de ~400 lignes
mélangeant ~80 fonctions (chaînes, numériques, dates, conversion, système, paquets DBMS_*).
Conséquences : impossible d'ajouter une fonction sans modifier le cœur de l'exécuteur
(violation Open/Closed), duplication massive du pattern null-safe, et un God class de
5167 lignes. De plus :

- Un appel qualifié sur un paquet inconnu pouvait exécuter la fonction non qualifiée
  homonyme (`FOO.SUBSTR(...)` exécutait `SUBSTR`) — le switch ne testait que `expr.name`.
- Les noms réservés aux paquets (`VALUE`, `GET_TIME`, `GATHER_TABLE_STATS`…) appelés sans
  qualification retournaient silencieusement NULL au lieu de lever ORA-00904.
- `GREATEST(1, NULL, 3)` retournait 3 et `LEAST(NULL, 5)` retournait 5 — dans le vrai
  Oracle, GREATEST/LEAST retournent NULL dès qu'un argument est NULL.

**Correction.** Nouveau module `src/database/oracle/functions/` :

- `SqlFunctionRegistry` : registre clé = nom qualifié (`UPPER`, `DBMS_RANDOM.VALUE`),
  insensible à la casse, extensible (`register`/`registerBundle`).
- Implémentations groupées par domaine : `stringFunctions`, `numericFunctions`,
  `dateFunctions`, `conversionFunctions`, `nullFunctions`, `systemFunctions`,
  `packageFunctions` — chaque fichier < 150 lignes.
- `SqlFunctionContext` : interface injectée (Dependency Inversion) exposant uniquement
  ce dont les fonctions ont besoin (comparaison Oracle, coercition de dates, USERENV,
  DDL métadonnées) sans coupler les fonctions à l'exécuteur.
- `evaluateFunction` ne garde que les agrégats (dépendants de l'AST) puis délègue au
  registre ; fonction inconnue → ORA-00904 avec le nom pleinement qualifié.

**Fidélité améliorée.** GREATEST/LEAST propagent NULL ; ORA-00904 levé pour les noms de
fonctions de paquets non qualifiés et pour les paquets inconnus.

**Mesure.** `OracleExecutor.ts` : 5180 → 4823 lignes. Les 13 erreurs ESLint restantes du
fichier préexistaient (aucune nouvelle).

**Tests.** Nouveau fichier `oracle-function-registry.test.ts` (20 tests : résolution du
registre, SUBSTR négatif, INSTR backward, NVL/NULLIF/DECODE, sémantique NULL de
GREATEST/LEAST, ORA-00904, fonctions de paquets). Suite complète : 2546 tests verts.

---

## Correction n°3 — Partage du registre avec PL/SQL + support de dates unifié

**Défaillances.**

1. *Duplication* : ~30 fonctions scalaires (SUBSTR, INSTR, LPAD, NVL, DECODE, MOD…)
   étaient implémentées deux fois — dans l'exécuteur SQL et dans
   `PlsqlInterpreter.callBuiltinFunction` — avec des sémantiques divergentes.
2. *Duplication* : le formatage/parsing de dates (`formatOracleDate`, `parseOracleDate`,
   `coerceDate`, `formatDate`) était privé à l'exécuteur, inaccessible aux autres modules.
3. *Fidélité SQL* (vs vrai Oracle) :
   - `LPAD('hello', 3)` retournait `hello` au lieu de `hel` (Oracle **tronque** à la
     longueur cible) ; `LPAD('x', 0)` doit retourner NULL.
   - `INITCAP('heLLo woRLD')` retournait `HeLLo WoRLD` au lieu de `Hello World`
     (Oracle minuscule le reste de chaque mot ; délimiteur = non-alphanumérique).
   - `ASCII('')` retournait NaN au lieu de NULL.
   - `MOD(7, 0)` retournait NaN au lieu de 7 (sémantique Oracle : diviseur 0 → dividende).
   - `REMAINDER` absent du moteur SQL.
4. *Fidélité PL/SQL* :
   - `INSTR` ignorait l'argument d'occurrence et la recherche arrière (position négative).
   - `DECODE(NULL, …, NULL, 'x')` ne matchait pas — dans le vrai Oracle, DECODE
     considère deux NULLs comme égaux.
   - `POWER(NULL, 2)` retournait NaN, `CHR(NULL)` retournait `'\0'`.

**Correction.**

- Nouveau module partagé `functions/dateSupport.ts` (`coerceDateValue`, `formatDateValue`,
  `formatDateWithPattern`, `parseDateWithPattern`) ; l'exécuteur y délègue (les statiques
  `OracleExecutor.coerceDate/formatDate` restent comme façade pour RMAN).
- `PlsqlInterpreter` délègue au `SqlFunctionRegistry` partagé en deux groupes :
  préservation de valeur (NVL, NVL2, COALESCE, NULLIF, DECODE, GREATEST, LEAST — les
  Dates restent des Dates) et conversion textuelle (UPPER…ASCII, ABS…REMAINDER).
  Les fonctions à sémantique PL/SQL spécifique restent natives (SQLCODE, SQLERRM,
  TO_NUMBER → PlsqlException, ROUND/TRUNC de dates, SYSDATE → objet Date).
- Helpers morts supprimés dans l'interpréteur (`nz`, `trimSet`, `pad`).
- Corrections de fidélité ci-dessus appliquées dans le registre (une seule source de vérité).

**Tests.** +13 tests registre (padding/INITCAP/ASCII/MOD/REMAINDER), +4 tests PL/SQL
(INSTR occurrence/backward, LPAD/INITCAP via registre, propagation NULL GREATEST/LEAST,
DECODE NULL-match). Suite database : 2560 tests verts. Suite unitaire globale : 13209
verts — les 10 échecs PowerShell/terminal préexistent sur main et sont hors périmètre.

---

## Correction n°4 — Rendu SQL*Plus fidèle (COLUMN FORMAT, alignement, wrap)

**Défaillances.** Le rendu des résultats dans `SQLPlusSession.formatQueryResult` ignorait
l'essentiel du modèle de formatage du vrai SQL*Plus :

- `COLUMN col FORMAT A10 / 999,990.00` était parsé et stocké… puis jamais appliqué.
- Toutes les colonnes étaient alignées à gauche — le vrai SQL*Plus aligne les **nombres à
  droite** (en-tête compris).
- Aucune gestion du débordement : pas de wrap à la largeur de colonne (WRAP ON), pas de
  troncature (WRAP OFF), pas de `#####` pour les nombres qui dépassent leur masque.
- `LINESIZE` jamais appliqué (un commentaire « Simple truncation for now » en tenait lieu).
- `HEADING` personnalisé et `NOPRINT` non honorés au rendu.

**Correction.** Nouvelle classe `commands/QueryResultRenderer.ts` (SRP : la session de
1415 lignes ne porte plus la logique de rendu) :

- Plan de colonnes : largeur issue de `FORMAT An` ou du masque numérique, sinon largeur
  naturelle, plafonnée à LINESIZE ; colonnes NOPRINT exclues ; HEADING substitué.
- Alignement : nombres à droite, chaînes à gauche (détection par type des valeurs).
- Masques numériques `[$]9/0/,/.` : séparateurs de milliers, décimales fixes, `$`,
  zéros obligatoires, débordement → `####` sur la largeur du masque (comme SQL*Plus).
- Débordement caractère : wrap multi-lignes si `SET WRAP ON`, troncature sinon.
- `handleColumn` parse désormais la largeur des masques numériques et NOPRINT/PRINT.

**Adaptations de tests.** Deux tests existants supposaient l'ancien rendu non réaliste
(valeur de 200 caractères non wrappée ; nombre aligné à gauche) — mis à jour pour
correspondre au comportement du vrai SQL*Plus.

**Tests.** +7 tests de rendu (troncature/wrap A-format, masque avec séparateurs,
débordement `###`, NOPRINT, alignement droit, HEADING). Suite database : 2567 verts.

---

## Correction n°5 — Vraies erreurs de compilation PL/SQL (SHOW ERRORS, USER_ERRORS)

**Défaillances.**

- `CREATE PROCEDURE/FUNCTION` acceptait n'importe quel corps (même du charabia) avec
  « Procedure created. » et statut VALID — aucun passage par le compilateur.
- `SHOW ERRORS` retournait toujours « No errors. » (chaîne en dur).
- `DBA_ERRORS` était synthétisée depuis le journal d'alertes (alert log) — sans rapport
  avec les vraies erreurs de compilation ; `USER_ERRORS` / `ALL_ERRORS` n'existaient pas.
- Bug latent dans la reconstruction du source des unités stockées : un corps de forme
  standard `AS <déclarations> BEGIN … END` (sans DECLARE) était ré-emballé dans un
  `BEGIN … END` supplémentaire → l'unité devenait inexécutable ; et un `;` final dans le
  corps produisait `END;;` imparsable.

**Correction.**

- `PlsqlLexParseError` porte désormais la ligne de l'erreur ; le parser la renseigne.
- Nouveau module `plsql/unitSource.ts` : `buildSubprogramSource` (reconstruction unique
  du source, corrigée pour les deux bugs ci-dessus, partagée avec l'interpréteur qui
  dupliquait cette logique) et `compileStoredUnit` (validation par le vrai parser PL/SQL).
- À la création : parse du corps → statut VALID/INVALID honnête, message réel d'Oracle
  (« Warning: Procedure created with compilation errors. »), erreurs enregistrées dans
  `OracleCatalog` (setCompilationErrors/clear/get), recompilation propre → purge.
- `SHOW ERRORS` affiche le format réel de SQL*Plus (« Errors for PROCEDURE SYS.X: »,
  table LINE/COL + texte PLS-xxxxx) pour la dernière unité compilée, et supporte
  `SHOW ERRORS PROCEDURE nom` / `schema.nom`.
- `DBA_ERRORS` rebranchée sur le vrai magasin avec les colonnes réelles d'Oracle
  (POSITION avant TEXT, ATTRIBUTE, MESSAGE_NUMBER) ; ajout de `USER_ERRORS` (filtrée
  par propriétaire) et `ALL_ERRORS`.
- `DBA_OBJECTS.STATUS` reflète désormais INVALID/VALID selon la compilation.

**Tests.** +8 tests (warning à la création, SHOW ERRORS format réel, ciblage par nom,
No errors après recompilation, USER_ERRORS, statut INVALID puis retour à VALID).

---

## Correction n°6 — Verifiers de mots de passe recalculés à chaque lecture de SYS.USER$

**Défaillance.** Chaque `SELECT … FROM SYS.USER$` recalculait les verifiers 10g/11g/12c
de **tous** les utilisateurs, dont un PBKDF2-SHA512 à 4096 itérations par compte (en JS
pur ≈ 50 ms+/compte). Une base avec ~20 comptes mettait ~1 s par requête sur USER$ —
c'était la cause du test instable observé dès l'état de référence (timeout 5 s
intermittent sur `SELECT * FROM sys.user$`). Le vrai Oracle dérive les verifiers une
seule fois au changement de mot de passe et les stocke dans USER$ — il ne re-dérive
jamais à la lecture du dictionnaire.

**Correction.** Architecture alignée sur le vrai Oracle : les verifiers sont dérivés
**à l'écriture du mot de passe** (`OracleCatalog.setPassword`, utilisé par CREATE USER,
ALTER USER et le seed des comptes par défaut) et stockés dans le catalogue ; la vue
`SYS.USER$` ne fait plus que lire. En complément, `deriveStoredVerifiers` est mémoïsée
(cache borné à 512 entrées, éviction FIFO) pour amortir les recréations d'instances
dans les tests. Mesure : `SELECT * FROM sys.user$` répété : ~1 s → ~7 ms.
