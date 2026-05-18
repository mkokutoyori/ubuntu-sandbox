# Tutoriel RMAN — sandbox Oracle

Ce tutoriel couvre **toutes** les commandes RMAN supportées par le sous-shell
`rman` du simulateur Ubuntu-sandbox. Il est rédigé pour un DBA Oracle qui
connaît déjà la sémantique RMAN — on insiste sur les particularités du
sandbox (états Oracle observables, bus réactif, retranscription au format
Oracle canonique).

---

## 1. Démarrage rapide

### 1.1 Pré-requis

Il faut un `LinuxServer` (ou `LinuxPC`) qui héberge une instance Oracle. Le
binding est automatique dès qu'on lance `sqlplus` ou `rman` depuis le shell
de l'équipement.

```bash
# Depuis le terminal de l'équipement Linux :
$ rman target /
```

### 1.2 Bannière

À l'ouverture, RMAN imprime sa bannière canonique :

```
Recovery Manager: Release 19.0.0.0.0 - Production on 17-MAY-2026 14:23:01

Copyright (c) 1982, 2024, Oracle and/or its affiliates.  All rights reserved.

connected to target database: ORCL (DBID=1234567890)

RMAN>
```

Si vous lancez `rman` sans `target /`, vous obtenez le prompt vide et devez
saisir `CONNECT TARGET /` manuellement.

### 1.3 Sortir

`EXIT;` ou `QUIT;` (ou `Ctrl-D`) coupe la session, libère les canaux,
ferme le bus interne et publie un événement `DISCONNECTED`.

---

## 2. Le modèle d'états Oracle

RMAN se comporte différemment selon l'état de l'instance Oracle qu'il
pilote. Le sandbox respecte le contrat :

| État | CONNECT | BACKUP | RESTORE | RECOVER |
|------|---------|--------|---------|---------|
| SHUTDOWN  | `RMAN-04014` | `RMAN-04014` | `RMAN-04014` | `RMAN-04014` |
| NOMOUNT   | ✓ | refuse | refuse | refuse |
| MOUNT     | ✓ | ✓ | ✓ | ✓ |
| OPEN      | ✓ | ✓ | `RMAN-06403` | ✓ |

Pour faire transitionner l'instance vous passez par `sqlplus` :

```sql
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
SQL> ALTER DATABASE OPEN
```

Le sous-shell `rman` observe ces transitions via `OracleInstanceWatcherActor`
sur le bus partagé : si l'instance descend en `SHUTDOWN` pendant une session
RMAN, celle-ci est **automatiquement** disposée (comme un vrai client RMAN
qui perd sa cible).

---

## 3. CONNECT

```rman
CONNECT TARGET /                    -- target db, local OS auth
CONNECT TARGET sys/manager@ORCL     -- via TNS alias
CONNECT AUXILIARY /                 -- pour DUPLICATE
CONNECT CATALOG rman/rman@RCAT      -- recovery catalog distant (no-op sandbox)
```

Le sandbox **n'a pas** de vraie connexion réseau RMAN — `CONNECT CATALOG`
et `CONNECT AUXILIARY` sont acceptés comme no-op et émettent la ligne
canonique « connected to … » de sorte que vos scripts paste-and-run
fonctionnent tels quels.

---

## 4. CONFIGURE — paramètres persistants

```rman
-- Retention
CONFIGURE RETENTION POLICY TO REDUNDANCY 2;
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
CONFIGURE RETENTION POLICY TO NONE;

-- Device + parallélisme
CONFIGURE DEFAULT DEVICE TYPE TO DISK;            -- ou SBT
CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET;
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/backup/%d_%T_%U.bkp';
CONFIGURE CHANNEL 1 DEVICE TYPE DISK MAXOPENFILES 16;

-- Controlfile autobackup
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u01/backup/cf_%F.bkp';

-- Compression + chiffrement
CONFIGURE COMPRESSION ALGORITHM 'MEDIUM';         -- BASIC | LOW | MEDIUM | HIGH
CONFIGURE ENCRYPTION FOR DATABASE ON;
CONFIGURE ENCRYPTION ALGORITHM 'AES256';          -- AES128 | AES192 | AES256

-- Archivelog
CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 2 TIMES TO DEVICE TYPE DISK;
CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE DISK TO 2;

-- Backup-set sizing + optimisation
CONFIGURE MAXSETSIZE TO UNLIMITED;                -- ou 4G / 500M / 100K
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE DISK TO 2;
```

Chaque réussite émet `new RMAN configuration parameters are successfully stored`
et publie un événement `rman.config.changed` sur le bus.

---

## 5. SHOW — lecture de la configuration

```rman
SHOW ALL;                       -- toute la config en CONFIGURE-statements
SHOW RETENTION POLICY;
SHOW DEFAULT DEVICE TYPE;
SHOW CONTROLFILE AUTOBACKUP;
SHOW CHANNEL;                   -- canaux configurés + canaux explicites
SHOW CHANNEL FOR DEVICE TYPE DISK;
```

---

## 6. BACKUP

### 6.1 Granularité

```rman
BACKUP DATABASE;
BACKUP TABLESPACE USERS;
BACKUP TABLESPACE SYSTEM, USERS, SYSAUX;
BACKUP DATAFILE 4;
BACKUP SPFILE;
BACKUP CURRENT CONTROLFILE;
BACKUP ARCHIVELOG ALL;
BACKUP ARCHIVELOG FROM SCN 1000000;
```

### 6.2 Incrémentiel

```rman
BACKUP INCREMENTAL LEVEL 0 DATABASE;            -- baseline
BACKUP INCREMENTAL LEVEL 1 DATABASE;            -- différentiel
BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE; -- cumulatif
```

### 6.3 Options

| Clause | Effet |
|---|---|
| `TAG 'X'` | balise utilisateur (`MAYUSC`) |
| `FORMAT '<motif>'` | chemin de la piece (%d %T %U %s %p %F substitués) |
| `COMPRESSED` ou `COMPRESSED BACKUPSET` | active la compression `BASIC` (ou config) |
| `ENCRYPTED` | chiffrement AES (algo de la config) |
| `MAXPIECESIZE 100M` | split la backup-set en pieces de la taille indiquée |
| `KEEP FOREVER` | exempt de la retention policy à vie |
| `KEEP UNTIL TIME '2030-12-31'` | exempt jusqu'à la date |
| `PLUS ARCHIVELOG [DELETE INPUT]` | enchaîne un BACKUP ARCHIVELOG ALL après le DB |
| `DELETE INPUT` | (archivelog) supprime les redo logs consommés |
| `NOT BACKED UP n TIMES` | skip si déjà sauvegardé n fois (backup optimization) |
| `VALIDATE` | vérifie sans écrire — voir aussi la commande VALIDATE |

### 6.4 Exemples combinés

```rman
BACKUP DATABASE TAG 'WEEKLY' FORMAT '/u01/backup/%d_%T_%U.bkp' COMPRESSED;
BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
BACKUP DATABASE MAXPIECESIZE 200M KEEP FOREVER TAG 'LONG_TERM';
BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'NIGHTLY_CUM';
BACKUP NOT BACKED UP 2 TIMES DATABASE;
BACKUP ARCHIVELOG ALL DELETE INPUT TAG 'ARC_HOURLY';
BACKUP ARCHIVELOG FROM SCN 1500000 DELETE INPUT;
BACKUP COMPRESSED BACKUPSET DATABASE;
BACKUP DATABASE ENCRYPTED FORMAT '/u01/secure/%d_%T_%U.enc';
```

### 6.5 VALIDATE — vérification sans écriture

```rman
BACKUP VALIDATE DATABASE;          -- forme legacy

VALIDATE DATABASE;                 -- forme moderne (12c+)
VALIDATE TABLESPACE USERS;
VALIDATE DATAFILE 4;
VALIDATE BACKUPSET 7;              -- vérifie une backup-set existante
```

---

## 7. LIST — interrogation du catalog

```rman
LIST BACKUP;                       -- détaillé (BS + pieces + datafiles)
LIST BACKUP SUMMARY;               -- une ligne par set
LIST ARCHIVELOG ALL;
LIST EXPIRED BACKUP;               -- pieces marquées EXPIRED par CROSSCHECK
LIST OBSOLETE;                     -- selon la retention policy active
LIST COPY;                         -- datafile copies + image copies
LIST COPY OF DATABASE;
LIST COPY OF TABLESPACE USERS;
LIST INCARNATION OF DATABASE;
LIST DB_UNIQUE_NAME OF DATABASE;
LIST SCRIPT NAMES;
```

---

## 8. REPORT — synthèse + diagnostics

```rman
REPORT SCHEMA;                     -- liste des datafiles + tempfiles
REPORT NEED BACKUP;                -- selon la retention courante
REPORT NEED BACKUP REDUNDANCY 2;
REPORT NEED BACKUP RECOVERY WINDOW OF 7 DAYS;
REPORT OBSOLETE;
REPORT OBSOLETE REDUNDANCY 1;
REPORT OBSOLETE RECOVERY WINDOW OF 3 DAYS;
REPORT UNRECOVERABLE;              -- vide tant qu'aucun NOLOGGING n'est tracé
```

Les filtres `REDUNDANCY n` / `RECOVERY WINDOW OF n DAYS` n'altèrent pas la
config — ils n'appliquent la politique qu'à ce seul report.

---

## 9. CROSSCHECK + DELETE + CHANGE

### 9.1 Crosscheck

Vérifie que chaque piece du catalog existe encore sur le VFS, marque
`EXPIRED` celles qui manquent et publie `CROSSCHECK_DONE`.

```rman
CROSSCHECK BACKUP;
CROSSCHECK ARCHIVELOG ALL;
```

### 9.2 Delete

```rman
DELETE NOPROMPT EXPIRED BACKUP;
DELETE NOPROMPT OBSOLETE;
DELETE NOPROMPT OBSOLETE REDUNDANCY 1;
DELETE NOPROMPT OBSOLETE RECOVERY WINDOW OF 1 DAYS;
DELETE NOPROMPT BACKUP TAG 'WEEKLY';
DELETE NOPROMPT BACKUPSET 7;
DELETE NOPROMPT ARCHIVELOG ALL;
```

### 9.3 Change (basculer la disponibilité)

```rman
CHANGE BACKUPSET 7 UNAVAILABLE;
CHANGE BACKUPSET 7 AVAILABLE;
CHANGE BACKUP TAG 'WEEKLY' DELETE;   -- équivaut à DELETE BACKUP TAG
```

### 9.4 CATALOG — enregistrer une piece existante

```rman
CATALOG DATAFILECOPY '/u01/copies/users01.dbf';
CATALOG BACKUPPIECE  '/u01/backup/df_1_1.bkp';
```

Si le fichier n'existe pas sur le VFS, vous obtenez `RMAN-06004`.

---

## 10. RESTORE + RECOVER

### 10.1 RESTORE

Requiert un état **MOUNT** ou **NOMOUNT** pour `DATABASE` (sinon
`RMAN-06403`).

```rman
RESTORE DATABASE;
RESTORE TABLESPACE USERS;
RESTORE DATAFILE 4;
RESTORE DATABASE FROM TAG 'WEEKLY';
RESTORE DATABASE PREVIEW;           -- liste sans restaurer
RESTORE DATABASE VALIDATE;          -- vérifie l'intégrité de la backup-set
```

### 10.2 RECOVER

Requiert **MOUNT** ou **OPEN**.

```rman
RECOVER DATABASE;
RECOVER DATABASE UNTIL SCN 1900000;
RECOVER DATABASE UNTIL TIME '2026-06-01 12:00:00';
RECOVER DATABASE UNTIL CANCEL;
RECOVER TABLESPACE USERS;
RECOVER DATAFILE 4;
RECOVER COPY OF DATABASE;
RECOVER COPY OF DATAFILE 1;
BLOCKRECOVER DATAFILE 1 BLOCK 1234;
BLOCKRECOVER CORRUPTION LIST;
```

### 10.3 Point-in-time recovery (PITR)

La forme canonique passe par un bloc `RUN` avec `SET UNTIL`. Le binding
est valable pour tous les `RESTORE`/`RECOVER` suivants du même bloc, puis
disparaît à la fin du bloc :

```rman
RUN {
  SET UNTIL TIME '2026-06-01 12:00:00';
  RESTORE DATABASE;
  RECOVER DATABASE;
}

RUN {
  SET UNTIL SCN 1900000;
  RESTORE DATABASE;
  RECOVER DATABASE;
}
```

### 10.4 SET NEWNAME — déplacer un datafile

```rman
RUN {
  SET NEWNAME FOR DATAFILE 1 TO '/u02/oradata/system01.dbf';
  SET NEWNAME FOR DATAFILE 4 TO '/u02/oradata/users01.dbf';
  RESTORE DATABASE;
  SWITCH DATAFILE ALL;
  RECOVER DATABASE;
}
```

`SWITCH DATAFILE ALL` (ou `SWITCH DATAFILE 4`) bascule le pointeur du
controlfile vers la nouvelle path après restore.

### 10.5 Ouvrir la base après PITR

```rman
ALTER DATABASE OPEN RESETLOGS;
LIST INCARNATION OF DATABASE;
RESET DATABASE TO INCARNATION 2;
```

---

## 11. DUPLICATE

Clone la base vers une instance auxiliaire.

```rman
CONNECT AUXILIARY /;
DUPLICATE TARGET DATABASE TO DUP1;
DUPLICATE DATABASE TO DUP1;          -- forme courte
DUPLICATE TARGET DATABASE TO STBY FOR STANDBY;
DUPLICATE TARGET DATABASE TO STBY FOR STANDBY FROM ACTIVE DATABASE;
DUPLICATE TARGET DATABASE TO DUP2 UNTIL TIME '2026-01-01 00:00:00';
DUPLICATE TARGET DATABASE TO DUP3 UNTIL SCN 1900000;
DUPLICATE TARGET DATABASE TO DUP4 SKIP READONLY;
DUPLICATE TARGET DATABASE TO DUP5 SKIP TABLESPACE TEMP;
DUPLICATE TARGET DATABASE TO DUP6 NOFILENAMECHECK;

-- Avec canaux explicites :
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
  DUPLICATE TARGET DATABASE TO DUP_RUN;
  RELEASE CHANNEL c1;
  RELEASE CHANNEL aux1;
}
```

Le résultat est observable : événements `JOB_STARTED` /
`RESTORE_DATAFILE_STARTED` (avec destinations renommées sur le dbname
auxiliaire) / `JOB_COMPLETED`.

---

## 12. RUN — blocs multi-instructions

### 12.1 Forme multi-ligne

```rman
RUN
{
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_FULL';
  BACKUP ARCHIVELOG ALL DELETE INPUT;
  RELEASE CHANNEL c1;
}
```

### 12.2 Forme inline (canonique Oracle)

```rman
RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; BACKUP DATABASE; RELEASE CHANNEL c1; }
```

### 12.3 Canaux explicites

```rman
ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
ALLOCATE CHANNEL t1 DEVICE TYPE SBT;
-- ...
RELEASE CHANNEL c2;
RELEASE CHANNEL c1;
RELEASE CHANNEL aux1;
RELEASE CHANNEL t1;
```

Vous ne pouvez allouer un canal que dans un bloc `RUN` ; en dehors, la
session utilise les canaux automatiques (`ORA_DISK_n`) selon la
parallélisme configurée.

### 12.4 Scripts stockés

```rman
CREATE SCRIPT daily_backup { BACKUP DATABASE; BACKUP ARCHIVELOG ALL DELETE INPUT; }
REPLACE SCRIPT daily_backup { BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT; }
PRINT SCRIPT daily_backup;
EXECUTE SCRIPT daily_backup;
EXECUTE SCRIPT 'daily_backup';
LIST SCRIPT NAMES;
DELETE SCRIPT daily_backup;
```

---

## 13. Catalog de récupération (no-op sandbox)

```rman
CREATE CATALOG;
CREATE VIRTUAL CATALOG vcdb1;
GRANT CATALOG FOR DATABASE ORCL TO vcdb1;
REGISTER DATABASE;
UNREGISTER DATABASE ORCL NOPROMPT;
RESYNC CATALOG;
LIST DB_UNIQUE_NAME OF DATABASE;
```

Ces commandes sont acceptées comme no-op (le sandbox n'a pas de second
process Oracle) mais émettent le message canonique pour que vos scripts
DBA s'exécutent identiquement.

---

## 14. SQL macro

```rman
SQL "ALTER SYSTEM SWITCH LOGFILE";
SQL "ALTER DATABASE OPEN";
```

---

## 15. HELP + EXIT

```rman
HELP;        -- liste toutes les verbes RMAN supportées
EXIT;        -- ou QUIT
```

---

## 16. Scénarios end-to-end

### 16.1 Cycle complet quotidien

```rman
CONNECT TARGET /;
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DAILY';
BACKUP ARCHIVELOG ALL DELETE INPUT;
BACKUP CURRENT CONTROLFILE;
CROSSCHECK BACKUP;
DELETE NOPROMPT OBSOLETE;
LIST BACKUP SUMMARY;
EXIT;
```

### 16.2 Cadence hebdomadaire L0+L1

```rman
-- Dimanche
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_L0' PLUS ARCHIVELOG DELETE INPUT;

-- Lundi-Vendredi
BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DAILY_L1' PLUS ARCHIVELOG DELETE INPUT;

-- Samedi (cumulatif pour réduire le restore time)
BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'WEEKLY_CUM';
```

### 16.3 Point-in-time recovery

```sql
-- Côté sqlplus
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
```

```rman
-- Côté rman
CONNECT TARGET /;
RUN {
  SET UNTIL TIME '2026-06-01 12:00:00';
  RESTORE DATABASE;
  RECOVER DATABASE;
}
ALTER DATABASE OPEN RESETLOGS;
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'POST_PITR_L0';
```

### 16.4 Failover DR (cross-site)

```rman
-- Sur le site DR (instance en MOUNT)
CONNECT TARGET /;
LIST BACKUP SUMMARY;
CROSSCHECK BACKUP;

RUN {
  SET NEWNAME FOR DATAFILE 1 TO '/u02/dr/system01.dbf';
  SET NEWNAME FOR DATAFILE 2 TO '/u02/dr/sysaux01.dbf';
  SET NEWNAME FOR DATAFILE 3 TO '/u02/dr/undotbs01.dbf';
  SET NEWNAME FOR DATAFILE 4 TO '/u02/dr/users01.dbf';
  RESTORE DATABASE;
  SWITCH DATAFILE ALL;
  RECOVER DATABASE;
}

ALTER DATABASE OPEN RESETLOGS;
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DR_PROMOTED_L0';
```

### 16.5 Clone à des fins de test

```rman
CONNECT TARGET /;
CONNECT AUXILIARY /;
DUPLICATE TARGET DATABASE TO DEV_CLONE
  UNTIL TIME '2026-06-01 00:00:00'
  SKIP TABLESPACE TEMP;
```

---

## 17. Référence des codes d'erreur

Le sandbox émet **les vraies codes Oracle** (RMAN-NNNNN, hyphène) :

| Code | Sens | Quand |
|---|---|---|
| `RMAN-01007` | trailer de syntaxe (line/column) | accompagne 01009 |
| `RMAN-01009` | syntax error | commande inconnue, clause inattendue |
| `RMAN-00558` | error parsing input command | wrapper de 01009 |
| `RMAN-00569` / `00571` | bannière `ERROR MESSAGE STACK FOLLOWS` | toute erreur RMAN |
| `RMAN-03002` | target database is not connected | session dans `DISCONNECTED` |
| `RMAN-03009` | channel timeout / IO error | canal mort |
| `RMAN-03014` | implicit command did not succeed | wrapper de JOB_FAILED |
| `RMAN-04014` | Oracle instance is not started | `CONNECT TARGET` contre SHUTDOWN |
| `RMAN-06004` | backup piece not found | CATALOG / VALIDATE BACKUPSET / restore |
| `RMAN-06023` | no backup found to restore | catalog vide ou tag introuvable |
| `RMAN-06024` | no backup or copy of <…> found | CHANGE BACKUPSET inconnu |
| `RMAN-06026` | unable to find datafile from catalog | SCN_INVALID |
| `RMAN-06091` | no channel allocated for catalog op | CATALOG_WRITE_ERROR |
| `RMAN-06403` | database must be mounted (not open) | RESTORE DATABASE contre OPEN |
| `RMAN-08137` | retention warning | retention engine |
| `RMAN-19625` | error identifying file | VFS_READ/WRITE_ERROR |
| `RMAN-19811` | out of space in the FRA | VFS_NO_SPACE |

Toute erreur produit la bannière encadrée puis le code+message :

```
RMAN-00571: ===========================================================
RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============
RMAN-00571: ===========================================================
RMAN-06403: database must be mounted (not open)
```

---

## 18. Topics du bus partagé (avancé)

Quand un sub-shell est créé via `ReactiveRmanSubShell.create(device, args)`,
chaque événement interne est re-publié sur l'`IEventBus` du projet sous le
namespace `rman.*` (préfixé par le `sessionId`). Cela permet à un dashboard,
un logger, ou un acteur externe de consommer la télémétrie RMAN sans
coupler aux internes :

| Topic | Payload |
|---|---|
| `rman.session.state-changed` | `from`, `to` (`IDLE`/`CONNECTING`/`CONNECTED`/`RUNNING_JOB`/`DISCONNECTED`) |
| `rman.session.connected` | `dbId`, `dbName`, `connectedAt` |
| `rman.session.disconnected` | |
| `rman.job.started` | `jobId`, `operation`, `startedAt` |
| `rman.job.completed` | `jobId`, `operation`, `elapsedMs` |
| `rman.job.failed` | `jobId`, `operation`, `error`, `elapsedMs` |
| `rman.job.progress` | `jobId`, `stepName`, `pct`, `message` |
| `rman.backup.piece-created` | `jobId`, `channelId`, `key`, `path`, `sizeBytes`, `tag` |
| `rman.backup.set-complete` | `jobId`, `bsKey`, `tag`, `sizeBytes` |
| `rman.channel.allocated` | `channelId`, `sid`, `deviceType` |
| `rman.channel.released` | `channelId` |
| `rman.catalog.updated` | `operation` (`INSERT`/`DELETE`/`EXPIRE`), `bsKey`, `bpKey` |
| `rman.config.changed` | `key`, `oldValue`, `newValue` |

Acteurs fournis :

- **`RmanSignalRefreshActor`** — projette les events dans un
  `RmanSignalStore` (4 `WritableSignal` : `session`, `activeJob`,
  `activeChannels`, `metrics`).
- **`RmanLoggerActor`** — émet un `log` event scopé sur le bus pour
  chaque event RMAN.
- **`OracleInstanceWatcherActor`** — dispose la session RMAN quand
  l'instance Oracle bound passe en `SHUTDOWN`.

Voir `docs/DESIGN-RMAN-REACTIVE.md` pour le diagramme de classes complet.

---

## 19. Aller plus loin

- **Suites de debug** (200+ commandes par scénario) :
  `src/__tests__/debug/rman/` — relancez avec
  `npx vitest run src/__tests__/debug/rman/`
  et inspectez les transcripts générés sous
  `debug-output/rman/<scenario>_results_debug.txt`.
- **Tests unitaires** (250+ tests) : `src/__tests__/unit/terminal/subshells/rman/`
- **Design technique** : `docs/DESIGN-RMAN-REACTIVE.md`
- **Liste des défauts adressés** : `docs/DESIGN-RMAN.md` §1.2
