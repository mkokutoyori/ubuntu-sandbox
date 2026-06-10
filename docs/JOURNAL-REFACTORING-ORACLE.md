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

### Défaillances identifiées
(complété au fil de l'exploration — voir les entrées ci-dessous)

---

## Entrées

<!-- Format :
### YYYY-MM-DD — Titre court (commit <sha>)
**Défaillance :** description du problème (duplication, anti-pattern, écart Oracle réel).
**Correction :** ce qui a été fait, pattern appliqué.
**Validation :** tests exécutés.
-->
