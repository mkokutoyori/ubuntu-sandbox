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
