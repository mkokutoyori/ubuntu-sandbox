# PRD — Gestion des accès Oracle (authentification, privilèges, rôles, audit)

**Version** : 1.0
**Date** : 2026-07-29
**Projet** : Ubuntu Sandbox — moteur Oracle
**Auteur** : Claude Code
**Références normatives** :
- *Oracle Database Security Guide* 19c — §4 (Configuring Privilege and Role Authorization), §10 (Virtual Private Database), §23-27 (Auditing)
- *Oracle Database SQL Language Reference* 19c — `GRANT`, `REVOKE`, `CREATE USER`, `ALTER USER`, `CREATE ROLE`, `SET ROLE`, `AUDIT`
- *Oracle Database PL/SQL Packages and Types Reference* — `DBMS_RLS`
- Codes d'erreur : ORA-01017, ORA-01031, ORA-01045, ORA-00942, ORA-01917, ORA-01919, ORA-01924, ORA-01934, ORA-01931, ORA-28000, ORA-28001

---

## 0. Contexte et portée du document

Ce PRD couvre la **gestion des accès** du moteur Oracle simulé : qui peut se
connecter, avec quoi, et ce qu'il a le droit de faire une fois connecté. Il
recouvre l'authentification (comptes, profils, mots de passe), l'autorisation
(privilèges système et objet, rôles), la restriction de données (privilèges
colonne, VPD/RLS) et la traçabilité (audit classique, audit unifié).

**Ce document ne repart pas de zéro, et c'est son principal message.** Le
socle est réel et se comporte déjà comme Oracle sur les points qui comptent :
la connexion est refusée sans `CREATE SESSION` (ORA-01045), un compte
verrouillé rend ORA-28000, un non-DBA ne peut ni créer un utilisateur ni
accorder un privilège, un `GRANT` vers un bénéficiaire inexistant échoue avant
toute mutation (ORA-01917), et le moteur choisit correctement entre ORA-00942
et ORA-01031 selon la doctrine de dissimulation d'information d'Oracle. Ces
comportements ont été **vérifiés en exécutant le moteur**, pas déduits du code.

Les manques sont donc précis, et quatre d'entre eux ont ceci de commun :
la commande est **acceptée**, l'état est **stocké**, la vue de dictionnaire
**l'affiche** — et rien ne l'applique. C'est la forme de défaut la plus
coûteuse pour un simulateur pédagogique : l'apprenant reçoit une confirmation
et une preuve apparente, alors que le contrôle n'existe pas.

Le `docs/PRD-Oracle-DBMS.md` existant est un document de progression d'une
autre génération (phases livrées, inventaire de fonctionnalités) ; il ne traite
pas la sécurité au-delà d'une ligne « GRANT/REVOKE: System privileges, table
privileges, roles ». Ce PRD-ci ne le remplace pas, il traite un sous-système
qu'il ne couvrait pas.

Aucune ligne de code de production n'est écrite dans le cadre de ce document ;
il sert de base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel |
|---|---|
| `src/database/oracle/security/SecurityEngine.ts` | Façade des sous-systèmes : profils, quotas, suivi de connexion, mots de passe, limites de session, privilèges. `authenticate()` porte la séquence complète (compte inexistant → ORA-01017 ; verrouillé → ORA-28000 avec auto-déverrouillage sur `PASSWORD_LOCK_TIME` ; expiré → ORA-28001 ; période de grâce) |
| `security/PrivilegeChecker.ts` | Lecture seule : `hasSystemPrivilege`, `hasObjectPrivilege`, `getGrantedRoles` (fermeture transitive en largeur d'abord), `isDba`. Les privilèges objet sont hérités par rôle **et** par `PUBLIC` |
| `security/PrivilegeEnforcer.ts` | Décisions d'erreur centralisées pour l'exécuteur : ORA-01031, ORA-00942, ORA-01917, ORA-01934. Contient la doctrine Oracle du choix ORA-00942 vs ORA-01031 |
| `security/ProfileManager.ts`, `QuotaManager.ts`, `LoginTracker.ts`, `PasswordManager.ts`, `PasswordVerifier.ts`, `SessionLimitTracker.ts` | Cycle de vie des mots de passe, `FAILED_LOGIN_ATTEMPTS`, quotas tablespace, `SESSIONS_PER_USER` |
| `security/classicProfiles.ts`, `classicRoles.ts`, `systemPrivileges.ts` | `DEFAULT`/`MONITORING_PROFILE`, `CONNECT`/`RESOURCE`/`DBA`/`SELECT_CATALOG_ROLE`…, catalogue des privilèges système |
| `security/OracleSession.ts` | État par session : utilisateur courant, schéma courant, contexte OS |
| `executor/SecurityDclExecutor.ts` | `GRANT`/`REVOKE` (système, objet, colonne, rôle, `DIRECTORY`), `AUDIT`/`NOAUDIT`, politiques d'audit unifié, `ADMINISTER KEY MANAGEMENT` |
| `executor/UserAdminExecutor.ts` | `CREATE`/`ALTER`/`DROP USER`, `CREATE`/`DROP ROLE`, `CREATE`/`ALTER`/`DROP PROFILE`, clause `DEFAULT ROLE`, `GRANT/REVOKE CONNECT THROUGH` |
| `OracleCatalog.ts` | Magasin : `sysPrivileges`, `tabPrivileges`, `colPrivileges`, `roleGrants`, `defaultRoleSpecs`, mots de passe de rôle, `proxyUsers`, `rlsPolicies`, `unifiedAuditPolicies`, options d'audit classique, `auditTrail` |
| `security/audit/AuditJournal.ts` + `SecurityAuditActor.ts` | Journal borné (FIFO par catégorie) alimenté **par de vrais événements de bus** : `oracle.security.connection-traced`, `oracle.ddl.executed`, `oracle.dml.executed`, `oracle.audit.recorded`, `oracle.error.raised`, `oracle.session.idle-sniped` |
| `security/audit/` (16 fichiers) | Traces de connexion, historiques DDL/DML, comptes dormants, anomalies, usage de privilèges, séparation des tâches (`SodEvaluator`/`SodPolicy`), registre d'objets sensibles |
| `security/DataRedactionManager.ts`, `NetworkAclManager.ts` | Redaction de données, ACL réseau (`DBMS_NETWORK_ACL_ADMIN`) |
| `views/` (~35 vues de sécurité) | `DBA_USERS`, `DBA_ROLES`, `DBA_SYS_PRIVS`, `DBA_TAB_PRIVS`, `DBA_COL_PRIVS`, `DBA_ROLE_PRIVS`, `SESSION_PRIVS`, `SESSION_ROLES`, `PROXY_USERS`, `DBA_POLICIES`, `AUDIT_UNIFIED_POLICIES`, `DBA_AUDIT_TRAIL`, `DBA_FGA_AUDIT_TRAIL`, `DBA_UNUSED_PRIVS`, `DBA_DV_*`… |
| `src/__tests__/unit/database/oracle-access-management*.test.ts` | 4 fichiers, 2 568 lignes : `-comprehensive` (1 627), `-syntax` (298), base (436), `-gaps` (207) |

### 1.2 Ce qui est réel et solide (à ne pas réécrire)

Chaque point ci-dessous a été **observé en exécutant le moteur** via
`SqlPlusSubShell`, pas seulement lu.

- **La porte d'entrée est vraie.** `CONNECT nosess/…` sur un compte sans
  `CREATE SESSION` rend `ORA-01045: user NOSESS lacks CREATE SESSION
  privilege; logon denied`, et la session **reste fermée** : la commande
  suivante rend `ORA-01012: not logged on`. Un simulateur qui laisserait
  passer là serait inutilisable pour enseigner quoi que ce soit.
- **Le refus d'administration est vrai.** Connecté en `bob` (simple
  `CREATE SESSION`), `GRANT SELECT ON SYS.secret TO nosess`, `DROP USER
  nosess` et `CREATE USER carl` rendent tous les trois ORA-01031.
- **La doctrine d'erreur d'Oracle est respectée**, ce qui est rare et subtil :
  `PrivilegeEnforcer.requireObjectAccess()` préfère **ORA-00942** (« table or
  view does not exist ») à ORA-01031 quand l'utilisateur ne détient *aucun*
  privilège sur l'objet — dissimulation d'information — et bascule sur
  ORA-01031 dès qu'il en détient un autre, puisqu'il sait déjà que l'objet
  existe.
- **Le DML est réellement gaté** : les quatre chemins `SELECT`/`INSERT`/
  `UPDATE`/`DELETE` de `OracleExecutor` appellent `requireObjectAccess`.
- **L'héritage par rôle fonctionne**, y compris transitivement et via
  `PUBLIC` : `GRANT SELECT ON SYS.emp TO reader; GRANT reader TO alice;`
  suffit à ce qu'`alice` lise la table.
- **Les garde-fous du DCL sont réels** : ORA-01917 arrête tout le `GRANT`
  avant la moindre mutation ; ORA-01934 détecte un cycle de rôles par
  fermeture transitive ; ORA-01931 refuse un octroi à `SYS`.
- **`WITH GRANT OPTION` est appliqué côté privilèges objet** :
  `requireGrantableObjectPrivileges` exige que le ré-octroyant détienne
  *chacun* des privilèges avec l'option.
- **`EXECUTE` est vérifié** avant d'exécuter une procédure ou un paquetage
  (`OracleDatabase.ts:1624` et `:1864`).
- **L'audit classique est vraiment conditionnel** :
  `OracleExecutor.recordAuditForStatement()` consulte les options d'objet
  (`AUDIT SELECT ON hr.emp`) et de statement avant d'écrire dans la trace, et
  retombe sur l'audit fin (FGA) sinon. Ce n'est pas un journal qui enregistre
  tout.
- **Le journal de sécurité est événementiel**, pas fabriqué : `SecurityAuditActor`
  est l'unique abonné au bus et alimente `AuditJournal`, que ~30 vues `DBA_*`
  lisent en direct.
- **`SESSION_PRIVS` est réel et par session** (vérifié : `bob` n'y voit que
  `CREATE SESSION`).

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`SET ROLE` n'est pas seulement absent : il répond faux.** Le lexème `ROLE` n'a pas de branche dans `BaseParser.parseSetStatement()` — dont le commentaire annonce pourtant `SET ROLE r \| NONE \| ALL EXCEPT …` — donc la ligne tombe dans la branche `SET TRANSACTION` et son `consumeRestOfStatement()`. **Vérifié en exécution** : `SET ROLE NONE;` et `SET ROLE reader;` répondent tous deux `Transaction set.` L'opérateur reçoit une confirmation pour une commande qui n'a rien fait, et le message désigne un autre objet. | `SET ROLE` (SQL Language Reference), qui doit rendre ORA-01924 sur un rôle non accordé | **Majeure** |
| 2 | **Les rôles ne sont jamais activés/désactivés par session.** `PrivilegeChecker.getGrantedRoles()` parcourt tous les `roleGrants` sans notion de rôle *actif*. `OracleCatalog.setDefaultRoleSpec()` enregistre la clause `ALTER USER … DEFAULT ROLE …` mais **`getDefaultRoleSpec()` n'a aucun appelant** ; idem pour `getRolePassword()`, dont le commentaire annonce pourtant « checked at SET ROLE ». **Vérifié** : après `SET ROLE NONE`, `SELECT * FROM SESSION_ROLES` liste toujours `READER`. Conséquence : un TP « rôle protégé par mot de passe » ou « DEFAULT ROLE NONE puis SET ROLE » est intégralement faux. | Modèle de rôles Oracle (rôles par défaut, rôles activés à la demande, rôles à mot de passe) | **Majeure** |
| 3 | **Les privilèges de colonne sont stockés, affichés, et jamais appliqués.** `GRANT UPDATE (salary) ON SYS.emp TO alice` est accepté et apparaît correctement dans `DBA_COL_PRIVS`. **Vérifié** : connectée, `alice` exécute `UPDATE SYS.emp SET id = 9` → `2 rows updated.` Elle a modifié une colonne qui ne lui a jamais été accordée. Le commentaire de `PrivilegeChecker.hasObjectPrivilege()` dit lui-même « the executor is responsible for refusing access to ungranted columns » — aucun exécuteur ne le fait. | `GRANT UPDATE (col)` réel, qui rend ORA-01031 sur une colonne non accordée | **Majeure** |
| 4 | **VPD / Row-Level Security : la politique est enregistrée, jamais appliquée.** `DBMS_RLS.ADD_POLICY` renseigne `OracleCatalog.rlsPolicies` (types d'instruction, `sec_relevant_cols`, groupes, `policy_type`) et `DBA_POLICIES` l'affiche. Les seuls consommateurs de `getRlsPolicies()` sont **des vues**. **Vérifié** : politique posée sur `SYS.EMP`, `SELECT * FROM SYS.emp` rend les deux lignes. Le commentaire du magasin l'admet à demi-mot (« a predicate transform *that the executor would apply* »). | `DBMS_RLS` réel : le prédicat rendu par la fonction de politique est ajouté à la requête | **Majeure** |
| 5 | **`WITH ADMIN OPTION` est asymétrique.** Les privilèges *objet* honorent `WITH GRANT OPTION` (§1.2). Les privilèges *système* et les *rôles* stockent bien l'option (`sysPrivileges.grantable`, `roleGrants.adminOption`, rendue par `DBA_ROLE_PRIVS`), mais `SecurityDclExecutor` exige `GRANT ANY PRIVILEGE`/`GRANT ANY ROLE` pour tout octroi : détenir un privilège *avec* l'option d'administration ne permet pas de le ré-accorder. | `GRANT … WITH ADMIN OPTION` réel | Moyenne |
| 6 | **`REVOKE` ne cascade pas.** `BaseCatalog.revokeTablePrivilege()` filtre exactement la ligne visée ; rien ne révoque les octrois que le révoqué avait lui-même consentis via `WITH GRANT OPTION`. Un privilège retiré au milieu d'une chaîne laisse le bout de chaîne actif. | Sémantique Oracle : la révocation d'un privilège objet cascade sur les octrois dépendants | Moyenne |
| 7 | **L'audit unifié ne produit aucune ligne de trace.** `CREATE AUDIT POLICY` / `AUDIT POLICY … BY user` sont acceptés, stockés (`unifiedAuditPolicies`) et rendus par `AUDIT_UNIFIED_POLICIES` — le seul consommateur. Aucun chemin d'écriture vers `UNIFIED_AUDIT_TRAIL` n'existe, alors que l'audit *classique* écrit réellement (§1.2). Deux modèles d'audit coexistent donc, l'un réel, l'autre décoratif, sans que rien ne le signale. | Audit unifié 12c+ | Moyenne |
| 8 | **L'authentification par proxy est de la comptabilité.** `ALTER USER alice GRANT CONNECT THROUGH bob` alimente `proxyUsers` et `PROXY_USERS`. Le magasin le documente lui-même : « the simulator does not actually arbitrate connection routing ». Aucune syntaxe `CONNECT bob[alice]/pw` ne consomme la table. | Proxy authentication réelle | Mineure |
| 9 | **`AUTHID DEFINER`/`CURRENT_USER` — à confirmer au chiffrage.** La colonne existe dans `DBA_PROCEDURES` mais aucune trace d'un basculement d'utilisateur effectif à l'appel d'une procédure n'a été trouvée dans `OracleCatalog`/`OracleDatabase`. À vérifier explicitement **avant** de décider de l'implémenter, plutôt que d'en supposer l'absence. | Droits du définisseur vs de l'appelant | Mineure (à confirmer) |

**Ce que la suite de tests dit déjà d'elle-même.** `oracle-access-management-gaps.test.ts`
annonce en tête de fichier son propre contrat : « implemented as real catalog
behaviour where the engine supports it, and **as parser tolerance (no-op +
accept) where it doesn't yet** ». Ses sections `DEFAULT ROLE`, `Column-level
GRANT/REVOKE` et `Proxy authentication (no-op tolerance)` n'affirment donc que
`/User altered/` ou `/Grant succeeded/` — elles épinglent l'acceptation, jamais
l'effet. Ce PRD ne les contredit pas : il propose de les **compléter** par des
assertions d'effet, en gardant leurs assertions d'acceptation intactes.

**Conclusion de la phase d'analyse** : le socle authentification/autorisation
est réel et n'a pas besoin d'être réécrit. Quatre manques majeurs partagent une
même signature — accepté, stocké, affiché, non appliqué — et se corrigent
chacun en branchant un magasin existant sur un point de décision existant,
sans nouveau modèle de données lourd.

---

## 2. Objectifs

### 2.1 Objectifs (ce PRD)

Chaque fonctionnalité est livrée **complète** : la commande, l'effet
observable, la vue de dictionnaire cohérente, et le code d'erreur Oracle réel.
Une commande dont l'effet n'est pas implémenté doit le **dire**, pas répondre
« succeeded ».

1. **`SET ROLE` réel, et rôles activés par session.** Branche dédiée au
   parseur (`SET ROLE r [,…] [IDENTIFIED BY pw] | NONE | ALL [EXCEPT …]`),
   liste des rôles actifs portée par `OracleSession`, initialisée à
   l'ouverture depuis `DEFAULT ROLE` (défaut `ALL`), consultée par
   `PrivilegeChecker.getGrantedRoles()`. ORA-01924 (« role not granted or does
   not exist ») sur un rôle non accordé, ORA-01979 sur un mot de passe de rôle
   erroné. `SESSION_ROLES` reflète l'état réel. Lève du même coup le code mort
   `getDefaultRoleSpec`/`getRolePassword`.
2. **Privilèges de colonne appliqués.** `GRANT SELECT|UPDATE|INSERT|REFERENCES
   (col…)` restreint réellement : un `UPDATE` touchant une colonne non
   accordée rend ORA-01031, un `SELECT` d'une colonne non accordée rend
   ORA-01031 — et l'utilisateur qui détient un privilège *table* complet n'est
   pas affecté. La restriction se pose au même endroit que la vérification
   objet existante, pas dans un second chemin parallèle.
3. **VPD/RLS : le prédicat est réellement appliqué.** À la lecture comme à
   l'écriture, une politique active sur l'objet fait appeler sa fonction de
   politique ; le prédicat rendu est composé (`AND`) avec celui de la requête.
   Respect des `statement_types` (une politique `SELECT` ne filtre pas un
   `DELETE`), de `sec_relevant_cols` (la politique ne s'active que si une
   colonne pertinente est référencée), et de `enable`/`disable`. `SYS` et le
   propriétaire y échappent, comme dans Oracle.
4. **`WITH ADMIN OPTION` appliqué pour les privilèges système et les rôles**,
   par symétrie avec `WITH GRANT OPTION` déjà réel côté objet — même forme de
   vérification, réutilisée, pas dupliquée.
5. **`REVOKE` cascade sur les octrois dépendants** consentis via
   `WITH GRANT OPTION`, en une seule traversée du graphe d'octrois.
6. **Audit unifié réellement écrivant.** Une politique activée produit des
   lignes dans `UNIFIED_AUDIT_TRAIL`, en réutilisant le point de décision de
   l'audit classique (`recordAuditForStatement`) plutôt qu'en ouvrant un second
   chemin. `BY`/`EXCEPT user` et `WHENEVER [NOT] SUCCESSFUL` respectés.
7. **Authentification par proxy effective.** `CONNECT proxy[client]/pw`
   authentifie le *proxy*, ouvre la session sous l'identité du *client*, et
   n'active que le rôle nommé par `WITH ROLE` s'il y en a un. Refus
   ORA-01017 si l'autorisation `CONNECT THROUGH` n'existe pas.
8. **Franchise sur ce qui reste non appliqué.** Toute commande de sécurité
   acceptée sans effet (après ce PRD : Database Vault, `DBA_DV_*`, chiffrement
   TDE) le déclare dans sa sortie, comme `PRD-PIM.md` P2 l'a fait pour le mode
   dense — plutôt que de répondre « succeeded » en silence.

### 2.2 Non-objectifs (hors périmètre)

- **Database Vault** (`DBA_DV_REALM`, `DBA_DV_COMMAND_RULE`…) : les vues
  existent et rendent vide, ce qui est une réponse honnête ; le modèle de
  royaumes et de règles de commande est un produit à part entière.
- **TDE / chiffrement au repos** : `V$ENCRYPTION_WALLET` et
  `DBA_ENCRYPTED_COLUMNS` restent des vues vides ; le simulateur n'a pas de
  stockage sur disque à chiffrer.
- **Label Security (OLS)**, **Data Redaction au-delà de l'existant**
  (`DataRedactionManager` est déjà là et n'est pas retouché).
- **Kerberos / authentification externe réelle** : `IDENTIFIED EXTERNALLY` et
  `GLOBALLY` restent acceptés et stockés ; brancher un vrai KDC dépasse ce
  périmètre (le simulateur en a un côté Windows, l'y relier est un autre PRD).
- **Isolation réelle entre PDB** : `CLAUDE.md` documente déjà que
  `OracleStorage` n'a aucune notion de CON_ID. Les privilèges communs
  (`GRANT … CONTAINER=ALL`) n'ont donc pas de sens tant que ce socle manque.
- **Réécriture du socle décrit en §1.2.**

---

## 3. Architecture cible

### 3.1 Principe directeur

**Un seul point de décision par question.** Le défaut de fond des quatre gaps
majeurs n'est pas l'absence de modèle de données — il est présent et correct —
mais l'absence de *consommateur* au point où la décision se prend. La cible
n'ajoute donc pas de moteur parallèle : elle branche des magasins existants sur
`PrivilegeEnforcer` (autorisation) et sur le pipeline de requête (VPD), qui
sont déjà les points de passage obligés.

### 3.2 Diagramme de flux

```
CONNECT user/pw[@svc]              CONNECT proxy[client]/pw
        |                                   |
+-------v-----------------------------------v-----------------+
|  SecurityEngine.authenticate()   (déjà réel)                 |
|  + arbitrage proxy (objectif 7) → identité effective         |
+-------v------------------------------------------------------+
|  OracleSession                                               |
|   · currentUser / currentSchema        (déjà réel)           |
|   · activeRoles  ← DEFAULT ROLE, muté par SET ROLE (obj. 1)  |
+-------v------------------------------------------------------+
        | chaque instruction
+-------v------------------------------------------------------+
|  PrivilegeEnforcer            (point de décision UNIQUE)     |
|   · requireSystemPrivilege        déjà réel                  |
|   · requireObjectAccess           déjà réel                  |
|   · requireColumnAccess           NOUVEAU (objectif 2)       |
|   · requireGrantable*             étendu système+rôle (obj.4)|
|      └─ PrivilegeChecker.getGrantedRoles(session)  ← actifs  |
+-------v------------------------------------------------------+
|  Pipeline de requête                                         |
|   · RlsPredicateApplier    NOUVEAU (objectif 3)              |
|     politique active ∧ statement_type ∧ sec_relevant_cols    |
|     → prédicat composé en AND avec le WHERE                  |
+-------v------------------------------------------------------+
|  recordAuditForStatement()   (déjà réel, classique + FGA)    |
|   + branche audit unifié     (objectif 6)                    |
+--------------------------------------------------------------+
```

### 3.3 Modules touchés

```
src/database/engine/parser/BaseParser.ts        # branche SET ROLE (objectif 1)
src/database/engine/parser/ASTNode.ts           # SetRoleStatement
src/database/oracle/security/OracleSession.ts   # activeRoles + API d'activation
src/database/oracle/security/PrivilegeChecker.ts# getGrantedRoles tient compte des actifs
src/database/oracle/security/PrivilegeEnforcer.ts # requireColumnAccess, admin option
src/database/oracle/security/RlsPredicateApplier.ts  # NOUVEAU (objectif 3)
src/database/oracle/OracleExecutor.ts           # appel colonne + RLS + audit unifié
src/database/oracle/executor/SecurityDclExecutor.ts  # admin option, revoke cascade
src/database/oracle/OracleCatalog.ts            # cascade d'octrois, trace unifiée
src/database/oracle/views/session_roles.ts      # lit les rôles actifs
src/database/oracle/views/unified_audit_trail.ts# NOUVEAU (objectif 6)
```

### 3.4 Design patterns retenus

| Pattern | Usage | Justification |
|---|---|---|
| **Decorator** | `RlsPredicateApplier` enveloppe le prédicat de la requête | Le prédicat VPD se compose avec le `WHERE` existant sans réécrire le planificateur |
| **Strategy** | Une stratégie par `policy_type` (`STATIC`, `CONTEXT_SENSITIVE`, `DYNAMIC`) | Oracle ré-évalue la fonction de politique à des fréquences différentes ; la différence est locale |
| **Single Source of Truth** | L'ensemble des rôles actifs vit sur `OracleSession`, et `PrivilegeChecker` le consulte | Supprime la divergence « rôle accordé » vs « rôle actif », origine des gaps 1 et 2 |
| **Chain of Responsibility** | `requireObjectAccess` → `requireColumnAccess` | La vérification colonne ne s'exécute que si l'accès objet est déjà accordé — l'ordre porte la sémantique Oracle |
| **Template Method** | `recordAuditForStatement` garde sa structure, l'audit unifié devient une étape | Un seul point de décision « faut-il auditer », deux destinations |

---

## 4. Modèle de données

### 4.1 Rôles actifs par session (objectif 1)

```
OracleSession {
  // … champs existants (currentUser, currentSchema, osContext) …
  activeRoles: Set<string>     // majuscules, fermeture transitive incluse
}
```

Initialisé à l'ouverture depuis `defaultRoleSpecs` (déjà stocké, aujourd'hui
mort) : `ALL` par défaut, `NONE` vide l'ensemble, `LIST`/`EXCEPT` filtrent.
`SET ROLE` remplace l'ensemble en bloc — jamais d'ajout incrémental, comme
Oracle. Un rôle protégé par mot de passe n'entre dans l'ensemble que si le
`IDENTIFIED BY` de la commande correspond à `getRolePassword()`.

**Point d'attention explicite** : `PrivilegeChecker.getGrantedRoles()` est
utilisé pour deux questions distinctes — « quels rôles cet utilisateur
détient-il » (vues `DBA_ROLE_PRIVS`, administration) et « quels rôles
comptent maintenant » (autorisation). Elles doivent être séparées en deux
méthodes, sans quoi corriger l'une casse l'autre.

### 4.2 Privilèges de colonne (objectif 2)

Aucun nouveau champ : `OracleCatalog.colPrivileges` porte déjà
`{ grantee, privilege, objectSchema, objectName, columnName, grantor,
grantable }`. Ce qui manque est la *question* posée au bon moment :

```
requireColumnAccess(schema, object, operation, columns: string[]): void
```

Sémantique Oracle à respecter : un privilège **table** couvre toutes les
colonnes ; un privilège **colonne** ne couvre que les siennes ; les deux
s'additionnent. `SELECT *` sur une table dont seules certaines colonnes sont
accordées rend ORA-01031, il n'élague pas silencieusement.

### 4.3 Prédicat VPD (objectif 3)

Aucun nouveau champ non plus : `rlsPolicies` porte déjà `statementTypes`,
`secRelevantCols`, `policyType`, `enabled`, `pfOwner`/`pfPackage`/`pfFunction`.
La fonction de politique est une vraie fonction PL/SQL du moteur ; elle rend
une chaîne de prédicat, composée en `AND` avec le `WHERE` de la requête.

Cas limites à traiter explicitement : prédicat vide ou `NULL` (aucun filtrage),
fonction inexistante (ORA-28110 « policy function has error »), politique sur
un objet dont le propriétaire exécute la requête (pas de filtrage).

### 4.4 Trace d'audit unifiée (objectif 6)

Structure alignée sur `UNIFIED_AUDIT_TRAIL` réel, restreinte aux colonnes que
le moteur peut honnêtement renseigner : `EVENT_TIMESTAMP`, `DBUSERNAME`,
`ACTION_NAME`, `OBJECT_SCHEMA`, `OBJECT_NAME`, `SQL_TEXT`, `RETURN_CODE`,
`UNIFIED_AUDIT_POLICIES`, `SESSIONID`. Bornée comme `AuditJournal` l'est déjà
(FIFO, budget mémoire explicite) — le simulateur tourne dans un navigateur.

---

## 5. Plan de mise en œuvre (TDD, par phases)

Chaque phase suit la méthode du projet : test d'abord (vraies instructions SQL
sur un vrai `SqlPlusSubShell`, aucun mock du moteur), puis implémentation
jusqu'au vert, puis régression avant commit. Aucun stub, aucune duplication.

| Phase | Contenu | Sortie testable |
|---|---|---|
| **P1** | `SET ROLE` au parseur + `activeRoles` sur `OracleSession` + séparation « rôles détenus » / « rôles actifs » dans `PrivilegeChecker` | `SET ROLE NONE` puis `SELECT` sur une table accessible par rôle → ORA-00942 ; `SESSION_ROLES` vide ; `SET ROLE reader` la rend de nouveau lisible ; `SET ROLE inconnu` → ORA-01924 |
| **P2** | `DEFAULT ROLE` réellement consulté à l'ouverture de session ; rôles à mot de passe | `ALTER USER alice DEFAULT ROLE NONE` puis reconnexion → aucun rôle actif ; `SET ROLE secure_role IDENTIFIED BY …` accepté, mot de passe faux → ORA-01979 |
| **P3** | `requireColumnAccess` branché sur les quatre chemins DML | `GRANT UPDATE (salary)` puis `UPDATE emp SET id = 9` → ORA-01031 ; `UPDATE emp SET salary = 1` → succès ; le détenteur du privilège table complet n'est pas gêné |
| **P4** | `RlsPredicateApplier` — lecture (`SELECT`) | Politique rendant `id = 1` sur `EMP` : `SELECT` rend une ligne au lieu de deux ; politique désactivée → deux lignes ; `SYS` et le propriétaire voient tout |
| **P5** | VPD en écriture (`INSERT`/`UPDATE`/`DELETE`), `statement_types`, `sec_relevant_cols` | Une politique `SELECT` seule ne filtre pas un `DELETE` ; une politique à `sec_relevant_cols` ne s'active que si la colonne est référencée |
| **P6** | `WITH ADMIN OPTION` (système + rôle) et cascade de `REVOKE` | Un utilisateur détenant `CREATE TABLE WITH ADMIN OPTION` peut le ré-accorder sans être DBA ; révoquer un privilège au milieu d'une chaîne d'octrois retire le bout de chaîne |
| **P7** | Audit unifié écrivant, branché sur le point de décision existant | Politique `ACTIONS UPDATE ON hr.emp` activée `BY alice` : un `UPDATE` d'`alice` produit une ligne dans `UNIFIED_AUDIT_TRAIL`, un `UPDATE` de `bob` non ; `EXCEPT` respecté |
| **P8** | Proxy réel (`CONNECT proxy[client]/pw`) | Connexion acceptée sous l'identité du client ; sans `CONNECT THROUGH` → ORA-01017 ; `WITH ROLE r` n'active que `r` |
| **P9** | Franchise sur le résiduel + audit anti-duplication + régression complète | Database Vault / TDE annoncent leur non-application ; les 4 suites existantes vertes ; aucune seconde implémentation d'une décision d'autorisation |

**P1 est le pivot** : sans notion de rôle actif, ni P2, ni la moitié des
scénarios de sécurité réalistes ne tiennent. P3 et P4 sont indépendantes l'une
de l'autre et de P1 — elles peuvent être menées en parallèle si besoin.

---

## 6. Stratégie de test

- **TDD strict**, sur le vrai chemin utilisateur : `SqlPlusSubShell` sur un
  `LinuxServer`, instructions SQL réelles, aucun accès direct au catalogue dans
  les assertions d'effet.
- **Chaque test d'effet est doublé d'un test de non-effet** : un privilège
  accordé doit ouvrir, un privilège absent doit fermer. C'est précisément ce
  qui manque aujourd'hui aux sections « no-op tolerance » de
  `oracle-access-management-gaps.test.ts` — dont les assertions d'acceptation
  sont **conservées**, non remplacées.
- **Codes d'erreur exacts** : chaque refus est asserté par son numéro ORA, pas
  par une expression régulière large. Un ORA-01031 rendu là où Oracle rend
  ORA-00942 est un échec.
- **Golden master** : les 2 568 lignes des 4 suites
  `oracle-access-management*` doivent rester vertes ; toute assertion qui
  change doit être justifiée dans le commit comme encodant une prémisse fausse,
  jamais « ajustée » pour passer.
- **Le scénario du non-régressé** : le socle §1.2 (ORA-01045, ORA-01012,
  ORA-01031 sur DDL d'administration, ORA-01917, arbitrage ORA-00942/01031)
  reçoit une suite dédiée *avant* la première modification, pour que sa
  préservation soit prouvée et non supposée.
- **Cohérence vue/effet** : pour chaque objectif, un test vérifie que la vue de
  dictionnaire et le comportement disent la même chose — c'est exactement la
  divergence que ce PRD corrige, elle ne doit pas se reformer ailleurs.

---

## 7. Risques et points d'attention

1. **`getGrantedRoles()` sert deux questions** (§4.1). Le séparer est la
   première chose à faire en P1 ; ne pas le faire ferait passer les tests
   d'autorisation en cassant silencieusement les vues d'administration.
2. **VPD et le planificateur.** Composer un prédicat suppose un point
   d'insertion propre dans le pipeline de requête. À repérer **avant** P4 : si
   `OracleExecutor` n'expose pas de couture, la créer est un préalable, pas un
   détail — et il vaut mieux le découvrir en lisant qu'en implémentant.
3. **Récursion des politiques VPD.** La fonction de politique est du PL/SQL qui
   peut lire la table qu'elle protège. Oracle exempte la fonction de sa propre
   politique ; il faut le faire aussi, sinon récursion infinie.
4. **La cascade de `REVOKE` peut être large.** Sur un graphe d'octrois profond,
   révoquer à la racine retire beaucoup. Le test doit couvrir le cas où deux
   chemins d'octroi indépendants mènent au même bénéficiaire : le privilège
   survit tant qu'un chemin subsiste.
5. **Le budget mémoire de la trace unifiée.** `AuditJournal` est borné pour de
   bonnes raisons ; la nouvelle trace doit l'être dès le premier commit, pas
   après le premier gonflement.
6. **Ne pas transformer une correction en régression.** Appliquer les
   privilèges de colonne rendra `ORA-01031` là où des TP existants passaient.
   C'est l'objectif — mais chaque suite qui casse doit être relue une par une :
   certaines exercent peut-être une prémisse fausse, d'autres un scénario
   légitime que le nouveau contrôle casse à tort.

---

## 8. Suite prévue

Une fois la gestion des accès solide, les extensions naturelles (hors de ce
PRD) : rattachement de `IDENTIFIED EXTERNALLY` au KDC Kerberos déjà simulé côté
Windows ; privilèges communs et locaux une fois qu'`OracleStorage` aura une
notion de CON_ID (préalable documenté dans `CLAUDE.md`) ; Database Vault, qui
ne prend son sens qu'au-dessus d'un modèle de rôles réellement activable —
c'est-à-dire au-dessus de la phase P1 de ce document.
