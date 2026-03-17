# BRD — Implementation Oracle DBMS (Simulateur)

**Version** : 1.0
**Date** : 2026-03-16
**Projet** : Ubuntu Sandbox — Module SGBD Oracle
**Auteur** : Claude Code

---

## 1. Objectif

Implémenter un simulateur Oracle Database réaliste au sein de l'Ubuntu Sandbox, permettant
aux utilisateurs d'interagir avec un environnement Oracle via le terminal Linux simulé.
L'architecture doit être conçue en **POO** avec des patterns réutilisables pour faciliter
l'ajout futur de PostgreSQL, MySQL, SQL Server, etc.

---

## 2. Architecture Générale (POO — Réutilisable)

### 2.1 Couche Abstraite Commune (Shared SQL Engine)

```
src/database/
├── engine/                      # Moteur SQL générique (réutilisable)
│   ├── lexer/
│   │   ├── Token.ts             # Interface Token { type, value, position }
│   │   ├── TokenType.ts         # Enum TokenType (SELECT, INSERT, IDENTIFIER, etc.)
│   │   └── BaseLexer.ts         # Classe abstraite — tokenisation SQL standard
│   ├── parser/
│   │   ├── ASTNode.ts           # Interfaces AST (SelectNode, InsertNode, etc.)
│   │   ├── BaseParser.ts        # Classe abstraite — parsing SQL standard
│   │   └── ParserError.ts       # Classe d'erreurs de parsing
│   ├── executor/
│   │   ├── BaseExecutor.ts      # Classe abstraite — exécution SQL
│   │   ├── QueryPlan.ts         # Interface plan d'exécution
│   │   └── ResultSet.ts         # Interface résultat (rows, columns, metadata)
│   ├── catalog/
│   │   ├── BaseCatalog.ts       # Classe abstraite — catalogue système
│   │   ├── SchemaObject.ts      # Types : Table, View, Index, Sequence, etc.
│   │   └── DataType.ts          # Types de données SQL communs
│   ├── storage/
│   │   ├── BaseStorage.ts       # Classe abstraite — stockage en mémoire
│   │   ├── Row.ts               # Interface ligne
│   │   └── Page.ts              # Interface page (simulation)
│   ├── optimizer/
│   │   ├── BaseOptimizer.ts     # Classe abstraite — optimiseur de requêtes
│   │   └── Statistics.ts        # Interface statistiques de table
│   ├── transaction/
│   │   ├── TransactionManager.ts # Gestionnaire de transactions
│   │   ├── IsolationLevel.ts    # Enum niveaux d'isolation
│   │   └── LockManager.ts       # Gestionnaire de verrous
│   └── types/
│       ├── SQLDialect.ts        # Enum : 'oracle' | 'postgres' | 'mysql' | 'sqlserver'
│       ├── DatabaseConfig.ts    # Interface configuration commune
│       └── DatabaseError.ts     # Hiérarchie d'erreurs (ORA-, PG-, MY-)
│
├── oracle/                      # Implémentation Oracle spécifique
│   ├── OracleLexer.ts           # Lexer Oracle (extensions: ROWNUM, SYSDATE, etc.)
│   ├── OracleParser.ts          # Parser Oracle (PL/SQL, CONNECT BY, etc.)
│   ├── OracleExecutor.ts        # Exécuteur Oracle
│   ├── OracleCatalog.ts         # Catalogue Oracle (V$, DBA_, ALL_, USER_)
│   ├── OracleStorage.ts         # Tablespaces, Segments, Extents
│   ├── OracleOptimizer.ts       # CBO (Cost-Based Optimizer)
│   ├── OracleInstance.ts        # Instance Oracle (SGA, PGA, processus)
│   ├── OracleDatabase.ts        # Classe principale — orchestrateur
│   ├── config/
│   │   ├── InitParams.ts        # Paramètres d'initialisation (init.ora/spfile)
│   │   ├── TnsNames.ts          # Parser tnsnames.ora
│   │   └── Listener.ts          # Simulation listener.ora
│   ├── plsql/
│   │   ├── PLSQLLexer.ts        # Lexer PL/SQL
│   │   ├── PLSQLParser.ts       # Parser PL/SQL (blocs, procédures, fonctions)
│   │   └── PLSQLExecutor.ts     # Exécuteur PL/SQL
│   └── commands/
│       ├── SQLPlusSession.ts    # Session SQL*Plus complète
│       ├── LsnrctlSession.ts    # Session lsnrctl
│       └── RmanSession.ts       # Session RMAN (stub)
│
├── postgres/                    # (Futur) Implémentation PostgreSQL
├── mysql/                       # (Futur) Implémentation MySQL
└── sqlserver/                   # (Futur) Implémentation SQL Server
```

### 2.2 Hiérarchie de Classes

```
BaseLexer (abstract)
  ├── OracleLexer
  ├── PostgresLexer      (futur)
  └── MySQLLexer          (futur)

BaseParser (abstract)
  ├── OracleParser
  ├── PostgresParser      (futur)
  └── MySQLParser          (futur)

BaseExecutor (abstract)
  ├── OracleExecutor
  ├── PostgresExecutor    (futur)
  └── MySQLExecutor        (futur)

BaseCatalog (abstract)
  ├── OracleCatalog
  ├── PostgresCatalog     (futur)
  └── MySQLCatalog         (futur)

BaseStorage (abstract)
  ├── OracleStorage
  ├── PostgresStorage     (futur)
  └── MySQLStorage         (futur)
```

---

## 3. Commandes Système Oracle

### 3.1 SQL*Plus (`sqlplus`)

| Commande | Description | Priorité |
|----------|-------------|----------|
| `sqlplus / as sysdba` | Connexion en tant que SYSDBA | P0 |
| `sqlplus user/password` | Connexion standard | P0 |
| `sqlplus user/password@tns_alias` | Connexion via TNS | P1 |
| `CONNECT user/password` | Changement de session | P0 |
| `DISCONNECT` | Déconnexion | P0 |
| `SET LINESIZE n` | Largeur d'affichage | P0 |
| `SET PAGESIZE n` | Nombre de lignes par page | P0 |
| `SET SERVEROUTPUT ON/OFF` | Activer DBMS_OUTPUT | P0 |
| `SET TIMING ON/OFF` | Afficher le temps d'exécution | P1 |
| `SET FEEDBACK ON/OFF` | Afficher le nombre de lignes | P0 |
| `SET ECHO ON/OFF` | Écho des commandes | P1 |
| `SET AUTOCOMMIT ON/OFF` | Auto-commit | P1 |
| `SHOW parameter_name` | Afficher un paramètre | P0 |
| `SHOW USER` | Afficher l'utilisateur courant | P0 |
| `SHOW SGA` | Afficher les infos SGA | P1 |
| `SHOW ERRORS` | Afficher les erreurs PL/SQL | P1 |
| `DESC table_name` | Décrire une table | P0 |
| `DESCRIBE table_name` | Alias de DESC | P0 |
| `@script.sql` | Exécuter un script | P2 |
| `SPOOL filename` | Rediriger la sortie | P2 |
| `SPOOL OFF` | Arrêter la redirection | P2 |
| `EXIT` / `QUIT` | Quitter SQL*Plus | P0 |
| `CLEAR SCREEN` | Effacer l'écran | P0 |
| `COLUMN col FORMAT fmt` | Formater une colonne | P2 |
| `PROMPT text` | Afficher du texte | P1 |
| `DEFINE var = value` | Définir une variable | P2 |
| `VARIABLE var TYPE` | Déclarer une variable bind | P2 |
| `PRINT var` | Afficher une variable bind | P2 |
| `HOST command` | Exécuter une commande OS | P2 |
| `EDIT` | Ouvrir l'éditeur | P2 |
| `/` | Ré-exécuter la dernière commande SQL | P1 |

### 3.2 Listener Control (`lsnrctl`)

| Commande | Description | Priorité |
|----------|-------------|----------|
| `lsnrctl start` | Démarrer le listener | P0 |
| `lsnrctl stop` | Arrêter le listener | P0 |
| `lsnrctl status` | Statut du listener | P0 |
| `lsnrctl services` | Services enregistrés | P1 |
| `lsnrctl reload` | Recharger la configuration | P1 |

### 3.3 Administration Base

| Commande | Description | Priorité |
|----------|-------------|----------|
| `startup` | Démarrer l'instance (NOMOUNT → MOUNT → OPEN) | P0 |
| `startup mount` | Démarrer en mode MOUNT | P1 |
| `startup nomount` | Démarrer en mode NOMOUNT | P1 |
| `startup restrict` | Démarrer en mode restreint | P2 |
| `shutdown immediate` | Arrêt immédiat | P0 |
| `shutdown abort` | Arrêt forcé | P1 |
| `shutdown normal` | Arrêt normal | P1 |
| `shutdown transactional` | Arrêt transactionnel | P2 |
| `ALTER SYSTEM SET param=value` | Modifier paramètre système | P1 |
| `ALTER SYSTEM FLUSH SHARED_POOL` | Vider le shared pool | P2 |
| `ALTER SYSTEM FLUSH BUFFER_CACHE` | Vider le buffer cache | P2 |
| `ALTER SYSTEM SWITCH LOGFILE` | Basculer le redo log | P2 |
| `ALTER DATABASE OPEN` | Ouvrir la base | P1 |
| `ALTER DATABASE MOUNT` | Monter la base | P1 |
| `ALTER DATABASE BACKUP CONTROLFILE TO 'path'` | Backup control file | P2 |

### 3.4 Commandes OS (Linux side)

| Commande | Description | Priorité |
|----------|-------------|----------|
| `export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1` | Variable d'environnement | P0 |
| `export ORACLE_SID=ORCL` | SID de l'instance | P0 |
| `export PATH=$ORACLE_HOME/bin:$PATH` | PATH Oracle | P0 |
| `export LD_LIBRARY_PATH=$ORACLE_HOME/lib` | Libraries | P1 |
| `export TNS_ADMIN=$ORACLE_HOME/network/admin` | Config réseau | P1 |
| `dbca` | Database Configuration Assistant (simplifié) | P2 |
| `orapwd file=... password=...` | Créer fichier de mots de passe | P2 |
| `tnsping service_name` | Tester la connectivité TNS | P1 |
| `adrci` | Automatic Diagnostic Repository (stub) | P2 |

---

## 4. Fichiers de Configuration Clés

### 4.1 `init.ora` / `spfile.ora` (Paramètres d'initialisation)

```
# Fichier : $ORACLE_HOME/dbs/initORCL.ora
db_name                  = ORCL
db_domain                = localdomain
db_block_size            = 8192
db_cache_size            = 128M
shared_pool_size         = 256M
pga_aggregate_target     = 128M
sga_target               = 512M
sga_max_size             = 1G
processes                = 300
sessions                 = 472
open_cursors             = 300
undo_management          = AUTO
undo_tablespace          = UNDOTBS1
undo_retention           = 900
log_archive_dest_1       = 'LOCATION=/u01/app/oracle/archivelog'
log_archive_format       = 'arch_%t_%s_%r.arc'
db_recovery_file_dest    = '/u01/app/oracle/fast_recovery_area'
db_recovery_file_dest_size = 4G
audit_file_dest          = '/u01/app/oracle/admin/ORCL/adump'
audit_trail              = DB
diagnostic_dest          = /u01/app/oracle
control_files            = ('/u01/app/oracle/oradata/ORCL/control01.ctl',
                            '/u01/app/oracle/oradata/ORCL/control02.ctl')
compatible               = 19.0.0
remote_login_passwordfile = EXCLUSIVE
```

**Paramètres simulés** : ~50 paramètres clés parmi les 300+ réels.

### 4.2 `tnsnames.ora` (Configuration réseau client)

```
# Fichier : $ORACLE_HOME/network/admin/tnsnames.ora
ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
    )
  )

ORCLPDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCLPDB)
    )
  )
```

### 4.3 `listener.ora` (Configuration listener)

```
# Fichier : $ORACLE_HOME/network/admin/listener.ora
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = 0.0.0.0)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = ORCL)
      (ORACLE_HOME = /u01/app/oracle/product/19c/dbhome_1)
      (SID_NAME = ORCL)
    )
  )

ADR_BASE_LISTENER = /u01/app/oracle
```

### 4.4 `sqlnet.ora` (Configuration réseau)

```
# Fichier : $ORACLE_HOME/network/admin/sqlnet.ora
NAMES.DIRECTORY_PATH = (TNSNAMES, LDAP)
SQLNET.AUTHENTICATION_SERVICES = (NTS)
SQLNET.EXPIRE_TIME = 10
```

### 4.5 `oratab`

```
# Fichier : /etc/oratab
ORCL:/u01/app/oracle/product/19c/dbhome_1:Y
```

### 4.6 `alert_ORCL.log` (Fichier d'alerte)

```
# Fichier : $ORACLE_BASE/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log
# Généré dynamiquement lors des opérations startup/shutdown/erreurs
```

### 4.7 Arborescence Oracle simulée

```
/u01/app/oracle/
├── product/19c/dbhome_1/       # ORACLE_HOME
│   ├── bin/                     # sqlplus, lsnrctl, dbca, orapwd, tnsping
│   ├── dbs/                     # initORCL.ora, spfileORCL.ora, orapwORCL
│   ├── network/admin/           # tnsnames.ora, listener.ora, sqlnet.ora
│   ├── lib/                     # Libraries (stub)
│   └── rdbms/admin/             # Scripts admin (catalog.sql, catproc.sql - stubs)
├── oradata/ORCL/                # Fichiers de données
│   ├── system01.dbf             # Tablespace SYSTEM
│   ├── sysaux01.dbf             # Tablespace SYSAUX
│   ├── undotbs01.dbf            # Tablespace UNDO
│   ├── users01.dbf              # Tablespace USERS
│   ├── temp01.dbf               # Tablespace TEMP
│   ├── redo01.log               # Redo log group 1
│   ├── redo02.log               # Redo log group 2
│   ├── redo03.log               # Redo log group 3
│   ├── control01.ctl            # Control file 1
│   └── control02.ctl            # Control file 2
├── admin/ORCL/
│   ├── adump/                   # Audit dump
│   ├── bdump/                   # Background dump
│   ├── cdump/                   # Core dump
│   └── udump/                   # User dump
├── diag/rdbms/orcl/ORCL/trace/  # Alert log & traces
├── archivelog/                   # Archived redo logs
└── fast_recovery_area/           # FRA
```

---

## 5. Tables et Vues Système Clés

### 5.1 Vues Dynamiques de Performance (`V$`)

| Vue | Description | Priorité |
|-----|-------------|----------|
| `V$SESSION` | Sessions actives | P0 |
| `V$PROCESS` | Processus background | P1 |
| `V$DATABASE` | Informations base de données | P0 |
| `V$INSTANCE` | Informations de l'instance | P0 |
| `V$SGA` | Statistiques SGA | P1 |
| `V$SGASTAT` | Détails SGA par composant | P2 |
| `V$PGA_TARGET_ADVICE` | Conseil PGA | P2 |
| `V$PARAMETER` / `V$SYSTEM_PARAMETER` | Paramètres système | P0 |
| `V$TABLESPACE` | Tablespaces | P0 |
| `V$DATAFILE` | Fichiers de données | P1 |
| `V$TEMPFILE` | Fichiers temporaires | P2 |
| `V$LOG` | Groupes redo log | P1 |
| `V$LOGFILE` | Membres redo log | P1 |
| `V$ARCHIVED_LOG` | Logs archivés | P2 |
| `V$LOCK` | Verrous actifs | P1 |
| `V$LOCKED_OBJECT` | Objets verrouillés | P2 |
| `V$TRANSACTION` | Transactions actives | P1 |
| `V$SQL` | SQL en cache | P1 |
| `V$SQLAREA` | Zone SQL partagée | P2 |
| `V$SQL_PLAN` | Plans d'exécution | P2 |
| `V$SYSSTAT` | Statistiques système | P2 |
| `V$SESSTAT` | Statistiques par session | P2 |
| `V$OPEN_CURSOR` | Curseurs ouverts | P2 |
| `V$VERSION` | Version Oracle | P0 |
| `V$OPTION` | Options installées | P2 |
| `V$CONTROLFILE` | Control files | P1 |
| `V$RECOVER_FILE` | Fichiers à récupérer | P2 |
| `V$BACKUP` | Statut backup | P2 |
| `V$ASM_DISKGROUP` | ASM disk groups | P2 |
| `V$DIAG_INFO` | Répertoires diagnostic | P2 |

### 5.2 Vues du Dictionnaire de Données (`DBA_`, `ALL_`, `USER_`)

| Vue | Description | Priorité |
|-----|-------------|----------|
| `DBA_USERS` / `ALL_USERS` | Utilisateurs | P0 |
| `DBA_ROLES` | Rôles | P0 |
| `DBA_ROLE_PRIVS` | Attributions de rôles | P0 |
| `DBA_SYS_PRIVS` | Privilèges système | P0 |
| `DBA_TAB_PRIVS` | Privilèges sur tables | P0 |
| `DBA_TABLES` / `ALL_TABLES` / `USER_TABLES` | Tables | P0 |
| `DBA_TAB_COLUMNS` / `ALL_TAB_COLUMNS` | Colonnes | P0 |
| `DBA_VIEWS` / `ALL_VIEWS` / `USER_VIEWS` | Vues | P1 |
| `DBA_INDEXES` / `ALL_INDEXES` / `USER_INDEXES` | Index | P0 |
| `DBA_IND_COLUMNS` | Colonnes d'index | P1 |
| `DBA_CONSTRAINTS` / `ALL_CONSTRAINTS` | Contraintes | P0 |
| `DBA_CONS_COLUMNS` | Colonnes de contraintes | P1 |
| `DBA_SEQUENCES` / `ALL_SEQUENCES` / `USER_SEQUENCES` | Séquences | P1 |
| `DBA_SYNONYMS` / `ALL_SYNONYMS` | Synonymes | P2 |
| `DBA_OBJECTS` / `ALL_OBJECTS` / `USER_OBJECTS` | Tous les objets | P0 |
| `DBA_SOURCE` / `ALL_SOURCE` / `USER_SOURCE` | Code source PL/SQL | P1 |
| `DBA_PROCEDURES` | Procédures/fonctions | P1 |
| `DBA_TRIGGERS` / `ALL_TRIGGERS` / `USER_TRIGGERS` | Triggers | P1 |
| `DBA_TABLESPACES` | Tablespaces | P0 |
| `DBA_DATA_FILES` | Fichiers de données | P1 |
| `DBA_TEMP_FILES` | Fichiers temporaires | P2 |
| `DBA_FREE_SPACE` | Espace libre | P1 |
| `DBA_SEGMENTS` | Segments | P2 |
| `DBA_EXTENTS` | Extents | P2 |
| `DBA_JOBS` / `DBA_SCHEDULER_JOBS` | Jobs planifiés | P2 |
| `DBA_AUDIT_TRAIL` | Trail d'audit | P1 |
| `DBA_DB_LINKS` / `ALL_DB_LINKS` | DB Links | P2 |
| `DBA_DIRECTORIES` | Objets DIRECTORY | P2 |
| `DBA_PROFILES` | Profils de sécurité | P1 |
| `DBA_TAB_STATISTICS` | Statistiques des tables | P2 |
| `DICTIONARY` / `DICT` | Catalogue des vues | P0 |
| `DUAL` | Table utilitaire | P0 |
| `TAB` / `CAT` | Tables de l'utilisateur | P1 |

### 5.3 Tables Système Internes

| Table | Description | Priorité |
|-------|-------------|----------|
| `SYS.OBJ$` | Catalogue des objets | P2 |
| `SYS.TAB$` | Métadonnées tables | P2 |
| `SYS.COL$` | Métadonnées colonnes | P2 |
| `SYS.IND$` | Métadonnées index | P2 |
| `SYS.USER$` | Utilisateurs internes | P2 |
| `SYS.TS$` | Tablespaces internes | P2 |
| `SYS.AUD$` | Données d'audit brutes | P2 |

---

## 6. Gestion des Accès et Sécurité

### 6.1 Utilisateurs Prédéfinis

| Utilisateur | Rôle | Mot de passe par défaut |
|-------------|------|------------------------|
| `SYS` | SYSDBA — superadmin | `oracle` |
| `SYSTEM` | DBA — administration courante | `oracle` |
| `DBSNMP` | Monitoring | `dbsnmp` |
| `HR` | Schema exemple (demo) | `hr` |
| `SCOTT` | Schema classique (demo) | `tiger` |

### 6.2 Rôles Prédéfinis

| Rôle | Description | Priorité |
|------|-------------|----------|
| `CONNECT` | Connexion de base | P0 |
| `RESOURCE` | Création d'objets | P0 |
| `DBA` | Administration complète | P0 |
| `SYSDBA` | Privilège super-admin | P0 |
| `SYSOPER` | Opérations d'instance | P1 |
| `SELECT_CATALOG_ROLE` | Lecture du dictionnaire | P1 |
| `EXECUTE_CATALOG_ROLE` | Exécution packages système | P2 |
| `EXP_FULL_DATABASE` | Export complet | P2 |
| `IMP_FULL_DATABASE` | Import complet | P2 |

### 6.3 Privilèges Système

| Privilège | Description | Priorité |
|-----------|-------------|----------|
| `CREATE SESSION` | Se connecter | P0 |
| `CREATE TABLE` | Créer des tables | P0 |
| `CREATE VIEW` | Créer des vues | P0 |
| `CREATE SEQUENCE` | Créer des séquences | P1 |
| `CREATE PROCEDURE` | Créer des procédures | P1 |
| `CREATE TRIGGER` | Créer des triggers | P1 |
| `CREATE INDEX` | Créer des index (implicite) | P0 |
| `CREATE USER` | Créer des utilisateurs | P0 |
| `ALTER USER` | Modifier des utilisateurs | P0 |
| `DROP USER` | Supprimer des utilisateurs | P0 |
| `CREATE ROLE` | Créer des rôles | P1 |
| `GRANT ANY PRIVILEGE` | Accorder tout privilège | P1 |
| `GRANT ANY ROLE` | Accorder tout rôle | P1 |
| `SELECT ANY TABLE` | Lecture de toute table | P1 |
| `INSERT ANY TABLE` | Insertion dans toute table | P1 |
| `UPDATE ANY TABLE` | Mise à jour de toute table | P1 |
| `DELETE ANY TABLE` | Suppression dans toute table | P1 |
| `CREATE TABLESPACE` | Créer un tablespace | P1 |
| `ALTER TABLESPACE` | Modifier un tablespace | P1 |
| `DROP TABLESPACE` | Supprimer un tablespace | P1 |
| `ALTER SYSTEM` | Modifier les paramètres | P1 |
| `ALTER DATABASE` | Modifier la base | P1 |
| `CREATE ANY DIRECTORY` | Créer un objet DIRECTORY | P2 |
| `UNLIMITED TABLESPACE` | Quotas illimités | P1 |
| `CREATE PUBLIC SYNONYM` | Créer synonyme public | P2 |
| `CREATE DATABASE LINK` | Créer DB link | P2 |

### 6.4 Privilèges Objet

```sql
GRANT SELECT ON schema.table TO user;
GRANT INSERT, UPDATE, DELETE ON schema.table TO user;
GRANT EXECUTE ON schema.package TO user;
GRANT ALL ON schema.table TO user;
GRANT SELECT ON schema.table TO user WITH GRANT OPTION;
REVOKE SELECT ON schema.table FROM user;
```

### 6.5 Commandes de Gestion des Accès

```sql
-- Utilisateurs
CREATE USER username IDENTIFIED BY password
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA 100M ON users
  PROFILE default
  ACCOUNT UNLOCK;

ALTER USER username IDENTIFIED BY new_password;
ALTER USER username ACCOUNT LOCK;
ALTER USER username ACCOUNT UNLOCK;
ALTER USER username DEFAULT TABLESPACE tablespace_name;
ALTER USER username QUOTA UNLIMITED ON tablespace_name;
ALTER USER username PASSWORD EXPIRE;
DROP USER username CASCADE;

-- Rôles
CREATE ROLE role_name;
GRANT privilege TO role_name;
GRANT role_name TO user;
SET ROLE role_name;
SET ROLE ALL;
SET ROLE NONE;
DROP ROLE role_name;

-- Profils
CREATE PROFILE secure_profile LIMIT
  FAILED_LOGIN_ATTEMPTS 5
  PASSWORD_LOCK_TIME 1
  PASSWORD_LIFE_TIME 90
  PASSWORD_REUSE_MAX 10
  PASSWORD_GRACE_TIME 7
  SESSIONS_PER_USER 3
  IDLE_TIME 30;

ALTER USER username PROFILE secure_profile;
DROP PROFILE secure_profile CASCADE;
```

---

## 7. Logs et Audit

### 7.1 Alert Log

- **Fichier** : `$ORACLE_BASE/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log`
- **Contenu simulé** : startup/shutdown, erreurs ORA-, switchs de redo log, checkpoints
- **Commandes** :
  ```sql
  -- Via SQL
  SELECT * FROM V$DIAG_INFO WHERE NAME = 'Diag Trace';
  -- Via adrci (stub)
  adrci> show alert
  ```

### 7.2 Redo Logs

| Composant | Description |
|-----------|-------------|
| Online Redo Logs | 3 groupes (redo01.log, redo02.log, redo03.log) |
| `V$LOG` | Statut des groupes (CURRENT, ACTIVE, INACTIVE) |
| `V$LOGFILE` | Membres physiques |
| `ALTER SYSTEM SWITCH LOGFILE` | Forcer la bascule |
| `ALTER SYSTEM CHECKPOINT` | Forcer un checkpoint |
| Archive Mode | `ALTER DATABASE ARCHIVELOG` / `NOARCHIVELOG` |

### 7.3 Audit Trail

```sql
-- Activer l'audit
AUDIT CREATE SESSION;
AUDIT CREATE TABLE BY ACCESS;
AUDIT SELECT ON schema.table BY ACCESS;
AUDIT INSERT, UPDATE, DELETE ON schema.table;
AUDIT ALL ON schema.table;

-- Consultation
SELECT * FROM DBA_AUDIT_TRAIL
 WHERE username = 'HR'
 ORDER BY timestamp DESC;

-- Nettoyage
DELETE FROM SYS.AUD$
 WHERE timestamp < SYSDATE - 90;

-- Désactiver
NOAUDIT CREATE SESSION;
NOAUDIT ALL ON schema.table;
```

### 7.4 Listener Log

- **Fichier** : `$ORACLE_BASE/diag/tnslsnr/<hostname>/listener/trace/listener.log`
- **Contenu** : connexions entrantes, erreurs TNS

---

## 8. Grammaire SQL (Dialecte Oracle)

### 8.1 Lexer — Tokens

#### 8.1.1 Mots-clés réservés (Oracle-specific en plus du SQL standard)

```
-- DDL
CREATE, ALTER, DROP, TRUNCATE, RENAME, COMMENT, PURGE, FLASHBACK

-- DML
SELECT, INSERT, UPDATE, DELETE, MERGE, UPSERT

-- Clauses SELECT
FROM, WHERE, GROUP BY, HAVING, ORDER BY, CONNECT BY, START WITH,
PRIOR, LEVEL, ROWNUM, ROWID, FETCH FIRST, OFFSET, ONLY, PERCENT,
WITH (CTE), PIVOT, UNPIVOT, MODEL, PARTITION BY, SAMPLE

-- Joins
JOIN, INNER, LEFT, RIGHT, FULL, OUTER, CROSS, NATURAL,
ON, USING, (+)  -- Oracle outer join syntax

-- Set Operations
UNION, UNION ALL, INTERSECT, MINUS  -- (Oracle uses MINUS, not EXCEPT)

-- Subquery
IN, EXISTS, ANY, ALL, SOME

-- Conditions
AND, OR, NOT, BETWEEN, LIKE, LIKE2, LIKE4, LIKEC,
IS NULL, IS NOT NULL, IS NAN, IS INFINITE,
REGEXP_LIKE, MULTISET

-- Types de données
NUMBER, VARCHAR2, CHAR, NCHAR, NVARCHAR2, CLOB, NCLOB, BLOB,
DATE, TIMESTAMP, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH LOCAL TIME ZONE,
INTERVAL YEAR TO MONTH, INTERVAL DAY TO SECOND,
RAW, LONG, LONG RAW, BFILE, XMLType, SDO_GEOMETRY,
BINARY_FLOAT, BINARY_DOUBLE, BOOLEAN (21c+)

-- Fonctions intégrées (built-in)
-- Chaînes
SUBSTR, INSTR, LENGTH, UPPER, LOWER, INITCAP, TRIM, LTRIM, RTRIM,
LPAD, RPAD, REPLACE, TRANSLATE, CONCAT, ASCII, CHR, REGEXP_SUBSTR,
REGEXP_REPLACE, REGEXP_INSTR, REGEXP_COUNT, SOUNDEX, DUMP, REVERSE

-- Numériques
ABS, CEIL, FLOOR, ROUND, TRUNC, MOD, POWER, SQRT, SIGN,
GREATEST, LEAST, WIDTH_BUCKET, REMAINDER, NANVL

-- Dates
SYSDATE, SYSTIMESTAMP, CURRENT_DATE, CURRENT_TIMESTAMP,
ADD_MONTHS, MONTHS_BETWEEN, LAST_DAY, NEXT_DAY,
EXTRACT, TO_DATE, TO_TIMESTAMP, TO_CHAR, TO_NUMBER,
NUMTODSINTERVAL, NUMTOYMINTERVAL, TRUNC(date), ROUND(date)

-- Conversion
TO_CHAR, TO_DATE, TO_NUMBER, TO_TIMESTAMP, TO_CLOB, TO_BLOB,
CAST, CONVERT, HEXTORAW, RAWTOHEX, UTL_RAW

-- Agrégation
COUNT, SUM, AVG, MIN, MAX, MEDIAN, STDDEV, VARIANCE,
LISTAGG, COLLECT, XMLAGG, FIRST, LAST, PERCENTILE_CONT,
PERCENTILE_DISC, CUME_DIST, DENSE_RANK, RANK, ROW_NUMBER,
NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE

-- Analytiques (OVER clause)
OVER, PARTITION BY, ORDER BY, ROWS, RANGE, UNBOUNDED,
PRECEDING, FOLLOWING, CURRENT ROW

-- Null/Condition
NVL, NVL2, NULLIF, COALESCE, DECODE, CASE WHEN, LNNVL

-- Système
USER, UID, SYS_CONTEXT, SYS_GUID, USERENV, ORA_HASH,
DBMS_RANDOM.VALUE, DBMS_RANDOM.STRING

-- Autres
SEQUENCE_NAME.NEXTVAL, SEQUENCE_NAME.CURRVAL,
OBJECT_VALUE, OBJECT_ID, ROWID, ROWNUM, LEVEL
```

#### 8.1.2 Opérateurs

```
=   <>  !=  <   >   <=  >=
+   -   *   /   ||  -- concaténation
:=  =>  ..  @   :   -- PL/SQL et bind variables
(+)     -- Oracle outer join (deprecated but supported)
```

#### 8.1.3 Littéraux

```
-- Numériques
42, 3.14, 1.5e10, .5, 0xFF (pas en Oracle standard)

-- Chaînes
'Hello World', 'It''s', q'[It's]', q'{bracket}', N'Unicode'

-- Dates
DATE '2024-01-15', TIMESTAMP '2024-01-15 10:30:00'

-- Intervalles
INTERVAL '5' DAY, INTERVAL '2-6' YEAR TO MONTH
```

### 8.2 Parser — Productions grammaticales clés

#### 8.2.1 SELECT

```
select_statement
  : subquery [for_update_clause]
  ;

subquery
  : query_block
    [order_by_clause]
    [fetch_clause]
  | '(' subquery ')'
  | subquery set_operator subquery
  ;

query_block
  : [with_clause]
    SELECT [hint] [DISTINCT | UNIQUE | ALL] select_list
    FROM table_reference_list
    [where_clause]
    [hierarchical_query_clause]
    [group_by_clause]
    [having_clause]
    [model_clause]
    [window_clause]
  ;

with_clause
  : WITH query_name AS '(' subquery ')' [',' query_name AS '(' subquery ')']...
  ;

hierarchical_query_clause
  : CONNECT BY [NOCYCLE] condition [START WITH condition]
  | START WITH condition CONNECT BY [NOCYCLE] condition
  ;

select_list
  : '*'
  | select_item [',' select_item]...
  ;

select_item
  : expression [[AS] alias]
  | table_alias '.' '*'
  ;

table_reference
  : table_name [[AS] alias]
  | '(' subquery ')' [[AS] alias]
  | table_reference join_clause
  | table_name [PARTITION '(' partition_name ')']
  | table_name [SAMPLE [BLOCK] '(' percent ')']
  | TABLE '(' expression ')'
  | LATERAL '(' subquery ')'
  ;

join_clause
  : [INNER | LEFT [OUTER] | RIGHT [OUTER] | FULL [OUTER] | CROSS | NATURAL]
    JOIN table_reference [ON condition | USING '(' column_list ')']
  ;

fetch_clause
  : OFFSET n {ROW | ROWS}
    FETCH {FIRST | NEXT} n {ROW | ROWS} {ONLY | WITH TIES}
  ;
```

#### 8.2.2 INSERT

```
insert_statement
  : INSERT [hint] INTO table_reference
    ['(' column_list ')']
    { VALUES '(' value_list ')'
    | subquery
    }
    [returning_clause]
  | INSERT [ALL | FIRST]
    [WHEN condition THEN into_clause]+
    [ELSE into_clause]
    subquery                           -- Multi-table INSERT
  ;

returning_clause
  : RETURNING expression_list INTO variable_list
  ;
```

#### 8.2.3 UPDATE

```
update_statement
  : UPDATE [hint] table_reference [[AS] alias]
    SET update_list
    [where_clause]
    [returning_clause]
  ;

update_list
  : column '=' expression [',' column '=' expression]...
  | '(' column_list ')' '=' '(' subquery ')'
  ;
```

#### 8.2.4 DELETE

```
delete_statement
  : DELETE [hint] FROM table_reference [[AS] alias]
    [where_clause]
    [returning_clause]
  ;
```

#### 8.2.5 MERGE

```
merge_statement
  : MERGE [hint] INTO target_table [[AS] alias]
    USING source ON '(' condition ')'
    [WHEN MATCHED THEN UPDATE SET update_list [where_clause] [DELETE where_clause]]
    [WHEN NOT MATCHED THEN INSERT '(' column_list ')' VALUES '(' value_list ')' [where_clause]]
    [error_logging_clause]
  ;
```

#### 8.2.6 CREATE TABLE

```
create_table
  : CREATE [GLOBAL TEMPORARY] TABLE table_name
    '(' column_definition [',' column_definition | table_constraint]... ')'
    [TABLESPACE tablespace_name]
    [PCTFREE n] [PCTUSED n]
    [STORAGE '(' storage_clause ')']
    [ON COMMIT {DELETE | PRESERVE} ROWS]  -- temp tables
    [AS subquery]
  ;

column_definition
  : column_name datatype
    [DEFAULT expression]
    [GENERATED {ALWAYS | BY DEFAULT [ON NULL]} AS IDENTITY ['(' sequence_options ')']]
    [ENCRYPT]
    [constraint_clause]...
  ;

constraint_clause
  : [CONSTRAINT constraint_name]
    { NOT NULL
    | NULL
    | UNIQUE
    | PRIMARY KEY
    | CHECK '(' condition ')'
    | REFERENCES table_name ['(' column_name ')']
      [ON DELETE {CASCADE | SET NULL}]
    }
    [ENABLE | DISABLE]
    [VALIDATE | NOVALIDATE]
    [DEFERRABLE | NOT DEFERRABLE]
    [INITIALLY {DEFERRED | IMMEDIATE}]
  ;

table_constraint
  : [CONSTRAINT constraint_name]
    { UNIQUE '(' column_list ')'
    | PRIMARY KEY '(' column_list ')'
    | FOREIGN KEY '(' column_list ')' REFERENCES table_name ['(' column_list ')']
      [ON DELETE {CASCADE | SET NULL}]
    | CHECK '(' condition ')'
    }
  ;
```

#### 8.2.7 PL/SQL (Blocs de base)

```
plsql_block
  : [DECLARE declaration_section]
    BEGIN
      statement_list
    [EXCEPTION exception_handler_list]
    END [label_name] ';'
  ;

declaration_section
  : (variable_declaration | type_declaration | cursor_declaration
     | exception_declaration | pragma_declaration)...
  ;

variable_declaration
  : variable_name [CONSTANT] datatype [NOT NULL] [{:= | DEFAULT} expression] ';'
  | variable_name table_name.column_name%TYPE [{:= | DEFAULT} expression] ';'
  | variable_name table_name%ROWTYPE ';'
  ;

cursor_declaration
  : CURSOR cursor_name ['(' parameter_list ')']
    IS select_statement ';'
  ;

-- Procédure
CREATE [OR REPLACE] PROCEDURE procedure_name
  ['(' parameter_list ')']
  {IS | AS}
  [declaration_section]
  BEGIN
    statement_list
  [EXCEPTION exception_handler_list]
  END [procedure_name] ';'

-- Fonction
CREATE [OR REPLACE] FUNCTION function_name
  ['(' parameter_list ')']
  RETURN datatype
  {IS | AS}
  [declaration_section]
  BEGIN
    statement_list
  [EXCEPTION exception_handler_list]
  END [function_name] ';'

-- Package
CREATE [OR REPLACE] PACKAGE package_name
  {IS | AS}
  (type_spec | variable_declaration | procedure_spec | function_spec)...
  END [package_name] ';'

CREATE [OR REPLACE] PACKAGE BODY package_name
  {IS | AS}
  (type_body | variable_declaration | procedure_body | function_body)...
  [BEGIN initialization_section]
  END [package_name] ';'

-- Trigger
CREATE [OR REPLACE] TRIGGER trigger_name
  {BEFORE | AFTER | INSTEAD OF}
  {INSERT | UPDATE [OF column_list] | DELETE}
  ON table_name
  [FOR EACH ROW]
  [WHEN '(' condition ')']
  plsql_block
  ;
```

### 8.3 AST (Abstract Syntax Tree) — Interfaces TypeScript

```typescript
// Types de noeuds AST — extraits clés
interface ASTNode { type: string; position: SourcePosition; }

interface SelectStatement extends ASTNode {
  type: 'SelectStatement';
  withClause?: WithClause;
  distinct?: boolean;
  columns: SelectItem[];
  from: TableReference[];
  joins?: JoinClause[];
  where?: Expression;
  connectBy?: HierarchicalClause;
  groupBy?: Expression[];
  having?: Expression;
  orderBy?: OrderByItem[];
  fetch?: FetchClause;
  forUpdate?: ForUpdateClause;
}

interface InsertStatement extends ASTNode {
  type: 'InsertStatement';
  table: TableReference;
  columns?: string[];
  values?: Expression[][];   // VALUES clause
  query?: SelectStatement;   // INSERT ... SELECT
  returning?: ReturningClause;
}

interface UpdateStatement extends ASTNode {
  type: 'UpdateStatement';
  table: TableReference;
  assignments: Assignment[];
  where?: Expression;
  returning?: ReturningClause;
}

interface DeleteStatement extends ASTNode {
  type: 'DeleteStatement';
  table: TableReference;
  where?: Expression;
  returning?: ReturningClause;
}

interface MergeStatement extends ASTNode {
  type: 'MergeStatement';
  target: TableReference;
  source: TableReference;
  on: Expression;
  whenMatched?: MergeUpdateClause;
  whenNotMatched?: MergeInsertClause;
}

interface CreateTableStatement extends ASTNode {
  type: 'CreateTableStatement';
  tableName: QualifiedName;
  columns: ColumnDefinition[];
  constraints: TableConstraint[];
  tablespace?: string;
  temporary?: boolean;
  asSelect?: SelectStatement;
}

interface PLSQLBlock extends ASTNode {
  type: 'PLSQLBlock';
  declarations: Declaration[];
  body: Statement[];
  exceptionHandlers: ExceptionHandler[];
}
```

---

## 9. Instance Oracle Simulée

### 9.1 Architecture Mémoire (SGA + PGA)

```
┌─────────────────────────────────────────────────┐
│                  SGA (System Global Area)         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────┐ │
│  │ Shared Pool   │ │ Buffer Cache │ │ Redo Log  │ │
│  │ (Library +    │ │ (Data Blocks)│ │ Buffer    │ │
│  │  Data Dict    │ │              │ │           │ │
│  │  Cache)       │ │              │ │           │ │
│  └──────────────┘ └──────────────┘ └──────────┘ │
│  ┌──────────────┐ ┌──────────────┐              │
│  │ Java Pool     │ │ Large Pool   │              │
│  └──────────────┘ └──────────────┘              │
│  ┌──────────────┐ ┌──────────────┐              │
│  │ Streams Pool  │ │ Result Cache │              │
│  └──────────────┘ └──────────────┘              │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                  PGA (par session)                │
│  ┌──────────────┐ ┌──────────────┐              │
│  │ Sort Area     │ │ Hash Area    │              │
│  └──────────────┘ └──────────────┘              │
│  ┌──────────────┐                               │
│  │ Session Mem   │                               │
│  └──────────────┘                               │
└─────────────────────────────────────────────────┘
```

**Simulation** : Les tailles SGA/PGA seront des valeurs configurables mais la mémoire réelle sera un simple `Map<string, any>` en TypeScript.

### 9.2 Processus Background (simulés)

| Processus | Description | Simulé |
|-----------|-------------|--------|
| PMON | Process Monitor | Nom + PID |
| SMON | System Monitor | Nom + PID |
| DBWn | Database Writer | Nom + PID |
| LGWR | Log Writer | Nom + PID |
| CKPT | Checkpoint | Nom + PID |
| RECO | Recovery | Nom + PID |
| ARCn | Archiver | Nom + PID (si archivelog) |
| MMON | Manageability Monitor | Nom + PID |
| MMNL | Manageability Monitor Light | Nom + PID |

### 9.3 États de l'Instance

```
SHUTDOWN → NOMOUNT → MOUNT → OPEN
                              ↕
                          READ ONLY
                              ↕
                          RESTRICTED
```

| État | Control File | Data Files | Redo Logs | Dictionnaire |
|------|:---:|:---:|:---:|:---:|
| SHUTDOWN | — | — | — | — |
| NOMOUNT | — | — | — | — |
| MOUNT | Ouvert | — | — | — |
| OPEN | Ouvert | Ouverts | Ouverts | Accessible |

---

## 10. Packages PL/SQL Intégrés (Built-in)

| Package | Procédures/Fonctions clés | Priorité |
|---------|--------------------------|----------|
| `DBMS_OUTPUT` | `PUT_LINE`, `PUT`, `GET_LINE`, `ENABLE`, `DISABLE` | P0 |
| `DBMS_LOCK` | `SLEEP` | P1 |
| `DBMS_RANDOM` | `VALUE`, `STRING`, `SEED` | P1 |
| `DBMS_UTILITY` | `FORMAT_ERROR_BACKTRACE`, `FORMAT_ERROR_STACK`, `GET_TIME` | P2 |
| `UTL_FILE` | `FOPEN`, `GET_LINE`, `PUT_LINE`, `FCLOSE` | P2 |
| `DBMS_STATS` | `GATHER_TABLE_STATS`, `GATHER_SCHEMA_STATS` | P2 |
| `DBMS_METADATA` | `GET_DDL` | P2 |
| `DBMS_SCHEDULER` | `CREATE_JOB`, `RUN_JOB`, `DROP_JOB` | P2 |
| `DBMS_SESSION` | `SET_ROLE`, `SET_NLS` | P2 |
| `DBMS_SQL` | Dynamic SQL | P2 |
| `DBMS_LOB` | `READ`, `WRITE`, `GETLENGTH`, `SUBSTR` | P2 |
| `DBMS_FLASHBACK` | `ENABLE_AT_TIME` | P2 |
| `DBMS_SPACE` | `SPACE_USAGE` | P2 |

---

## 11. Gestion des Tablespaces

```sql
-- Créer un tablespace
CREATE TABLESPACE app_data
  DATAFILE '/u01/app/oracle/oradata/ORCL/app_data01.dbf'
  SIZE 100M AUTOEXTEND ON NEXT 50M MAXSIZE 2G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Tablespace temporaire
CREATE TEMPORARY TABLESPACE temp2
  TEMPFILE '/u01/app/oracle/oradata/ORCL/temp02.dbf'
  SIZE 50M AUTOEXTEND ON;

-- Tablespace undo
CREATE UNDO TABLESPACE undotbs2
  DATAFILE '/u01/app/oracle/oradata/ORCL/undotbs02.dbf'
  SIZE 200M;

-- Modifier
ALTER TABLESPACE app_data ADD DATAFILE '...' SIZE 100M;
ALTER TABLESPACE app_data READ ONLY;
ALTER TABLESPACE app_data READ WRITE;
ALTER TABLESPACE app_data OFFLINE;
ALTER TABLESPACE app_data ONLINE;

-- Supprimer
DROP TABLESPACE app_data INCLUDING CONTENTS AND DATAFILES;

-- Consultation
SELECT tablespace_name, status, contents, block_size
  FROM DBA_TABLESPACES;

SELECT file_name, tablespace_name, bytes/1024/1024 AS size_mb,
       autoextensible, maxbytes/1024/1024 AS max_mb
  FROM DBA_DATA_FILES;

SELECT tablespace_name,
       SUM(bytes)/1024/1024 AS free_mb
  FROM DBA_FREE_SPACE
  GROUP BY tablespace_name;
```

---

## 12. Transactions et Verrouillage

### 12.1 Transactions

```sql
-- Commit / Rollback
COMMIT;
ROLLBACK;
SAVEPOINT sp1;
ROLLBACK TO SAVEPOINT sp1;

-- Isolation
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;    -- default
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET TRANSACTION READ ONLY;
```

### 12.2 Verrouillage

```sql
-- Verrouillage explicite
SELECT ... FOR UPDATE [OF column_list] [WAIT n | NOWAIT | SKIP LOCKED];
LOCK TABLE table_name IN {ROW SHARE | ROW EXCLUSIVE | SHARE | SHARE ROW EXCLUSIVE | EXCLUSIVE} MODE [NOWAIT];

-- Consultation
SELECT s.sid, s.serial#, s.username, l.type, l.lmode, l.request
  FROM V$SESSION s JOIN V$LOCK l ON s.sid = l.sid
  WHERE l.request > 0;
```

---

## 13. Schémas d'Exemple (Demo Data)

### 13.1 Schema HR (Human Resources)

```sql
-- Tables pré-remplies
REGIONS        (region_id, region_name)
COUNTRIES      (country_id, country_name, region_id)
LOCATIONS      (location_id, street_address, postal_code, city, state_province, country_id)
DEPARTMENTS    (department_id, department_name, manager_id, location_id)
JOBS           (job_id, job_title, min_salary, max_salary)
EMPLOYEES      (employee_id, first_name, last_name, email, phone_number,
                hire_date, job_id, salary, commission_pct, manager_id, department_id)
JOB_HISTORY    (employee_id, start_date, end_date, job_id, department_id)

-- ~20 lignes par table pour un jeu de données réaliste
```

### 13.2 Schema SCOTT (Classique)

```sql
DEPT    (deptno, dname, loc)
EMP     (empno, ename, job, mgr, hiredate, sal, comm, deptno)
BONUS   (ename, job, sal, comm)
SALGRADE (grade, losal, hisal)
```

---

## 14. Messages d'Erreur Oracle (ORA-)

| Code | Message | Contexte |
|------|---------|----------|
| ORA-00001 | unique constraint violated | INSERT/UPDATE dupliqué |
| ORA-00904 | invalid identifier | Colonne inexistante |
| ORA-00907 | missing right parenthesis | Syntaxe |
| ORA-00911 | invalid character | Caractère illégal |
| ORA-00918 | column ambiguously defined | JOIN ambigu |
| ORA-00923 | FROM keyword not found | Syntaxe |
| ORA-00932 | inconsistent datatypes | Type incompatible |
| ORA-00933 | SQL command not properly ended | Syntaxe |
| ORA-00936 | missing expression | Syntaxe |
| ORA-00942 | table or view does not exist | Objet introuvable |
| ORA-00955 | name is already used | Objet existant |
| ORA-01000 | maximum open cursors exceeded | Trop de curseurs |
| ORA-01017 | invalid username/password | Authentification |
| ORA-01031 | insufficient privileges | Droits insuffisants |
| ORA-01034 | ORACLE not available | Instance arrêtée |
| ORA-01035 | ORACLE only available to users with RESTRICTED SESSION | Restricted mode |
| ORA-01400 | cannot insert NULL into (column) | NOT NULL violé |
| ORA-01407 | cannot update to NULL | NOT NULL violé |
| ORA-01438 | value larger than precision | Dépassement NUMBER |
| ORA-01476 | divisor is equal to zero | Division par zéro |
| ORA-01555 | snapshot too old | Undo insuffisant |
| ORA-01652 | unable to extend temp segment | Tablespace plein |
| ORA-01722 | invalid number | Conversion invalide |
| ORA-01843 | not a valid month | Format date |
| ORA-02291 | integrity constraint violated - parent key not found | FK violation |
| ORA-02292 | integrity constraint violated - child record found | FK cascade |
| ORA-04031 | unable to allocate shared memory | Shared pool |
| ORA-06502 | PL/SQL: numeric or value error | PL/SQL runtime |
| ORA-06512 | at line N | PL/SQL backtrace |
| ORA-12154 | TNS:could not resolve the connect identifier | TNS erreur |
| ORA-12170 | TNS:Connect timeout occurred | Timeout |
| ORA-12541 | TNS:no listener | Listener arrêté |
| ORA-12545 | Connect failed because target host or object does not exist | Hôte invalide |
| ORA-28000 | the account is locked | Compte verrouillé |
| ORA-28001 | the password has expired | Mot de passe expiré |

---

## 15. Fonctionnalités Additionnelles

### 15.1 Index

```sql
CREATE [UNIQUE] INDEX index_name ON table_name (column_list)
  [TABLESPACE tablespace_name]
  [COMPUTE STATISTICS];
CREATE BITMAP INDEX idx ON table (column);  -- bitmap index
CREATE INDEX idx ON table (UPPER(column));  -- function-based index
DROP INDEX index_name;
ALTER INDEX index_name REBUILD;
ALTER INDEX index_name REBUILD ONLINE;
```

### 15.2 Séquences

```sql
CREATE SEQUENCE seq_name
  START WITH 1 INCREMENT BY 1
  MINVALUE 1 MAXVALUE 999999999
  CACHE 20 [NOCACHE]
  [CYCLE | NOCYCLE]
  [ORDER | NOORDER];

SELECT seq_name.NEXTVAL FROM DUAL;
SELECT seq_name.CURRVAL FROM DUAL;
ALTER SEQUENCE seq_name INCREMENT BY 10;
DROP SEQUENCE seq_name;
```

### 15.3 Vues

```sql
CREATE [OR REPLACE] [FORCE | NOFORCE] VIEW view_name AS
  select_statement
  [WITH CHECK OPTION [CONSTRAINT constraint_name]]
  [WITH READ ONLY];

CREATE [OR REPLACE] MATERIALIZED VIEW mv_name
  [BUILD {IMMEDIATE | DEFERRED}]
  [REFRESH {FAST | COMPLETE | FORCE} ON {DEMAND | COMMIT}]
  AS select_statement;
```

### 15.4 Synonymes

```sql
CREATE [OR REPLACE] [PUBLIC] SYNONYM syn_name FOR schema.object_name;
DROP [PUBLIC] SYNONYM syn_name;
```

### 15.5 DB Links

```sql
CREATE [PUBLIC] DATABASE LINK link_name
  CONNECT TO user IDENTIFIED BY password
  USING 'tns_alias';

SELECT * FROM table_name@link_name;
DROP [PUBLIC] DATABASE LINK link_name;
```

### 15.6 Flashback

```sql
SELECT * FROM table_name AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' HOUR);
FLASHBACK TABLE table_name TO TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' HOUR);
```

---

## 16. Plan d'Implémentation (Phases)

### Phase 1 — Fondations (Core SQL Engine + Oracle Base)

1. Moteur SQL générique : `Token`, `BaseLexer`, `ASTNode`, `BaseParser`, `BaseExecutor`
2. Oracle Lexer/Parser pour : SELECT, INSERT, UPDATE, DELETE de base
3. Storage en mémoire : tables, lignes, colonnes
4. Catalog de base : `DUAL`, `DBA_TABLES`, `DBA_USERS`, `V$VERSION`, `V$SESSION`
5. SQL*Plus session : connexion, `DESC`, `SHOW USER`, `EXIT`
6. Types de données : `NUMBER`, `VARCHAR2`, `DATE`, `TIMESTAMP`
7. Schéma SCOTT + HR (données de base)

### Phase 2 — DDL + Contraintes

1. `CREATE TABLE` avec contraintes (PK, FK, UNIQUE, CHECK, NOT NULL)
2. `ALTER TABLE` (ADD, MODIFY, DROP COLUMN, ADD CONSTRAINT)
3. `DROP TABLE`, `TRUNCATE TABLE`
4. `CREATE INDEX`, `DROP INDEX`
5. `CREATE SEQUENCE`, `DROP SEQUENCE`
6. `CREATE VIEW`, `DROP VIEW`
7. Tablespaces (CREATE, ALTER, DROP)

### Phase 3 — DML Avancé + Fonctions

1. `JOIN` (INNER, LEFT, RIGHT, FULL, CROSS)
2. Sous-requêtes (IN, EXISTS, correlated)
3. `GROUP BY`, `HAVING`, fonctions d'agrégation
4. Fonctions intégrées (chaînes, numériques, dates, conversion)
5. `MERGE`, multi-table INSERT
6. `CONNECT BY` (hiérarchique)
7. Fonctions analytiques (OVER, PARTITION BY)
8. `WITH` (CTE - Common Table Expressions)

### Phase 4 — PL/SQL + Packages

1. Blocs anonymes PL/SQL
2. Procédures et fonctions stockées
3. Packages (spec + body)
4. Curseurs (implicites et explicites)
5. Gestion d'exceptions
6. `DBMS_OUTPUT`, `DBMS_RANDOM`, `DBMS_LOCK`
7. Triggers (BEFORE/AFTER, ROW/STATEMENT)

### Phase 5 — Administration + Sécurité

1. Gestion des utilisateurs (CREATE/ALTER/DROP USER)
2. Rôles et privilèges (GRANT/REVOKE)
3. Profils de sécurité
4. Instance lifecycle (STARTUP/SHUTDOWN)
5. Listener (lsnrctl)
6. Configuration (init.ora, tnsnames.ora, listener.ora)
7. Alert log simulation
8. Audit trail
9. Backup/Recovery concepts (RMAN stub)

### Phase 6 — Optimisation + Avancé

1. `EXPLAIN PLAN`
2. Statistiques de table (DBMS_STATS)
3. Transactions et verrouillage
4. Niveaux d'isolation
5. Flashback query
6. Materialized views
7. DB Links (simulation)
8. Partitionnement (stub)

---

## 17. Intégration avec l'Architecture Existante

### 17.1 Nouveaux Types de Device

```typescript
// Ajouter dans src/network/core/types.ts
type DeviceType = ... | 'db-oracle' | 'db-postgres' | 'db-mysql' | 'db-sqlserver';
```

### 17.2 Nouveau Device : OracleDatabaseServer

```typescript
// src/network/devices/OracleDatabaseServer.ts
// Extends LinuxServer + contient une OracleInstance
class OracleDatabaseServer extends LinuxServer {
  private oracleInstance: OracleInstance;

  constructor(id, name) {
    super(id, name);
    this.oracleInstance = new OracleInstance(this);
    this.initOracleFilesystem();  // crée /u01/app/oracle/...
    this.initOracleUsers();       // oracle user, dba group
    this.initOracleEnvironment(); // ENV vars dans /etc/profile.d/
  }
}
```

### 17.3 Session Terminal Oracle

Le terminal Linux standard intercepte les commandes `sqlplus`, `lsnrctl`, `tnsping` et
délègue vers le module database. L'entrée dans le mode SQL*Plus change le prompt et
le mode de parsing (SQL multi-ligne avec `;` comme terminateur).

### 17.4 DeviceFactory

```typescript
// Ajouter dans src/network/devices/DeviceFactory.ts
case 'db-oracle':
  return new OracleDatabaseServer(id, name);
```

---

## 18. Conventions de Développement

1. **TDD** : Chaque composant doit avoir ses tests unitaires (vitest)
2. **POO** : Classes abstraites pour le moteur SQL, extensions par SGBD
3. **Immutabilité** : AST et résultats en lecture seule
4. **Typage strict** : TypeScript strict, pas de `any`
5. **Separation of Concerns** :
   - Lexer : texte → tokens
   - Parser : tokens → AST
   - Executor : AST → résultats
   - Catalog : métadonnées
   - Storage : données en mémoire
6. **Erreurs typées** : `OracleError` avec code ORA-, message, position
7. **Réutilisabilité** : Le moteur SQL de base doit fonctionner pour tout SGBD

---

## 19. Critères d'Acceptation

- [ ] Connexion SQL*Plus en tant que SYS, SYSTEM, HR, SCOTT
- [ ] Exécution de requêtes SELECT/INSERT/UPDATE/DELETE sur les schémas de démo
- [ ] `DESC` et `SHOW` fonctionnels
- [ ] Création d'utilisateurs, rôles et attribution de privilèges
- [ ] Tables systèmes V$ et DBA_ consultables
- [ ] Gestion des tablespaces (CREATE/ALTER/DROP)
- [ ] PL/SQL de base (blocs anonymes, DBMS_OUTPUT)
- [ ] Instance startup/shutdown
- [ ] lsnrctl start/stop/status
- [ ] Messages d'erreur ORA- réalistes
- [ ] Arborescence fichiers Oracle sur le système de fichiers Linux
- [ ] 90%+ de couverture de tests sur le moteur SQL
