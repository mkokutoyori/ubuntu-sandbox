# Oracle & RMAN dans une vraie infrastructure : le lab « Lumière Boutique »

> **À qui s'adresse ce tutoriel ?**
> À toi qui veux **comprendre et maîtriser la sauvegarde et la restauration d'une base Oracle avec RMAN**, non pas sur une machine isolée, mais dans une entreprise réaliste : plusieurs sites, plusieurs constructeurs, un site de reprise, des journaux centralisés, des accès contrôlés. Si tu cherches le cours de référence sur RMAN lui-même (toutes les commandes, une par une), ouvre d'abord `docs/tuto_rman.md` : ici on **applique** RMAN à une infrastructure complète, on casse des choses, et on les répare.

> **Ce tutoriel n'a pas été écrit à la main.** Chaque bloc de sortie ci-dessous est la réponse **réelle** du simulateur, capturée en rejouant toutes les commandes sur le lab rouvert depuis `labs/ecommerce-lumiere/topology.json`. Un test (`src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts`) refait ce parcours à chaque modification du simulateur : si une commande cessait de produire ce que le tutoriel annonce, il échouerait. Les dates, les numéros de séquence et les noms de pièces de sauvegarde changent d'une exécution à l'autre ; la structure, elle, ne change pas.

---

## Table des matières

1. [L'entreprise et son problème](#1-lentreprise-et-son-problème)
2. [L'infrastructure du lab](#2-linfrastructure-du-lab)
3. [Cinq notions à avoir en tête](#3-cinq-notions-à-avoir-en-tête)
4. [Étape 1 — Reconnaissance : qu'est-ce qu'on protège ?](#4-étape-1--reconnaissance--quest-ce-quon-protège-)
5. [Étape 2 — Passer la base en ARCHIVELOG](#5-étape-2--passer-la-base-en-archivelog)
6. [Étape 3 — Configurer RMAN une bonne fois pour toutes](#6-étape-3--configurer-rman-une-bonne-fois-pour-toutes)
7. [Étape 4 — La première sauvegarde](#7-étape-4--la-première-sauvegarde)
8. [Étape 5 — Une stratégie : niveau 0, niveau 1, journaux, cron](#8-étape-5--une-stratégie--niveau-0-niveau-1-journaux-cron)
9. [Étape 6 — Vérifier : une sauvegarde non testée n'existe pas](#9-étape-6--vérifier--une-sauvegarde-non-testée-nexiste-pas)
10. [Scénario A — Un datafile disparaît](#10-scénario-a--un-datafile-disparaît)
11. [Scénario B — Les fichiers de contrôle disparaissent](#11-scénario-b--les-fichiers-de-contrôle-disparaissent)
12. [Scénario C — Un `DROP TABLE` en production : retour dans le temps](#12-scénario-c--un-drop-table-en-production--retour-dans-le-temps)
13. [Accès, audit et journaux : qui a le droit de sauvegarder ?](#13-accès-audit-et-journaux--qui-a-le-droit-de-sauvegarder-)
14. [Scénario D — Le siège brûle : le site de reprise](#14-scénario-d--le-siège-brûle--le-site-de-reprise)
15. [Exercices](#15-exercices)
16. [Les erreurs que tu rencontreras](#16-les-erreurs-que-tu-rencontreras)
17. [Aide-mémoire](#17-aide-mémoire)
18. [Ce que le simulateur ne fait pas (encore)](#18-ce-que-le-simulateur-ne-fait-pas-encore)
19. [Conclusion](#19-conclusion)

---

## 1. L'entreprise et son problème

**Lumière Boutique** vend en ligne. Son site web tourne sur deux frontaux (`WEB-1`, `WEB-2`) en DMZ ; les commandes, les clients, les paiements vivent dans **une base Oracle**, `ORCL`, sur le serveur `ORA-PRD` du siège. Si cette base disparaît, la boutique ne vend plus rien : plus de panier, plus de paiement, plus de suivi de commande.

Imagine les trois e-mails qu'un DBA peut recevoir un lundi matin :

| 📧 De | Sujet | Ce qui est arrivé | Ce qu'il te faut |
|---|---|---|---|
| **L'exploitant** | « Un disque a lâché cette nuit » | Un fichier de données (`shop_data01.dbf`) est illisible | Une **restauration** du fichier et un **rejeu des journaux** |
| **Le développeur** | « J'ai supprimé la table des paiements en prod » | Une erreur humaine, base ouverte et saine | Un **retour dans le temps** juste avant l'erreur |
| **Le réseau** | « Le siège est hors service » | Tout le site est perdu : serveurs, baies, base | Un **site de reprise** déjà prêt (Paris → Lyon… ici `DR`) |

Une bonne stratégie répond à trois chiffres :

| Objectif | Question | Réponse retenue pour Lumière |
|---|---|---|
| **RPO** (perte de données tolérée) | Combien de temps de commandes accepte-t-on de perdre ? | **≈ 0** si le siège brûle (la base du site de reprise reçoit les journaux en continu) ; **≤ 4 h** après une erreur logique (sauvegarde des journaux toutes les 4 h) |
| **RTO** (durée d'indisponibilité) | Combien de temps la boutique peut-elle être fermée ? | **Quelques minutes** pour basculer sur le site de reprise ; **quelques dizaines de minutes** pour restaurer un fichier |
| **Rétention** | Combien de temps garde-t-on les sauvegardes ? | **7 jours** de fenêtre de récupération sur le volume de sauvegarde |

> 💡 **Le point à retenir dès maintenant** : une sauvegarde et un site de reprise ne répondent **pas** à la même question. Le site de reprise copie *aussi* l'erreur (un `DROP TABLE` est rejoué sur la standby). Seule une **sauvegarde** te permet de revenir *avant* l'erreur. Il faut les deux.

---

## 2. L'infrastructure du lab

Le lab est un jeu de **35 équipements** — trois constructeurs réseau (Cisco, Huawei, Fortinet) et des serveurs Linux et Windows — construit en tapant les mêmes commandes qu'un administrateur. Le détail est dans `labs/ecommerce-lumiere/README.md` ; voici ce qui compte pour ce tutoriel :

```
        INTERNET (203.0.113.0/24)  ─  R-ISP, DNS public, client web, passerelle de paiement
              │
   ┌──────────┴───────────┐     tunnels IPsec IKEv2 (FortiGate en étoile)
   │                      │
 SIÈGE (HQ)  10.10.0.0/16   ══════════════════►  SITE DE REPRISE (DR)  10.20.0.0/16
 FGT-HQ  ── R-HQ (Cisco)                         FGT-DR  ── R-DR (Huawei)
   ├─ 10.10.10.0/24  DC1 (AD, DNS, DHCP)         ├─ 10.20.10.0/24  DC2 (AD, DNS)
   │                 LOG-HQ (rsyslog, RADIUS)    │
   ├─ 10.10.30.0/24  BASES                       ├─ 10.20.30.0/24  BASES
   │    ORA-PRD   10.10.30.10  ← la base ORCL    │    ORA-STB   10.20.30.10  ← future standby
   │    BKP-HQ    10.10.30.20  ← volume NFS      │    BKP-DR    10.20.30.20  ← volume NFS
   └─ DMZ 172.16.10.0/24  WEB-1, WEB-2, APP-1    └─ DMZ 172.17.10.0/24  WEB-DR
```

Les rôles à connaître :

| Machine | Rôle dans ce tutoriel |
|---|---|
| `ORA-PRD` | Serveur de production. Il porte la base `ORCL` (schéma `SHOP` : clients, produits, commandes, paiements) |
| `BKP-HQ` | Serveur de sauvegarde. Il **exporte** `/srv/backup/rman` en NFS ; `ORA-PRD` le monte sur `/backup` (déclaré dans `/etc/fstab`) |
| `ORA-STB` | Serveur Oracle du site de reprise. Il deviendra la **base de secours** (standby) de `ORCL` |
| `BKP-DR` | Volume de sauvegarde du site de reprise |
| `LOG-HQ` | Serveur de journaux (rsyslog UDP 514) : toutes les machines Oracle, sauvegarde et web lui envoient leurs journaux |
| `FGT-HQ` / `FGT-DR` | Les FortiGate qui portent le tunnel IPsec entre les deux sites : c'est par là que passeront les fichiers de données de la standby |

> ⚠️ **Règle du projet, et raison pour laquelle ce lab est instructif : tout ce qui circule entre deux machines passe par de vraies trames.** Quand `ORA-PRD` écrit une pièce de sauvegarde sur `/backup`, ce sont des appels NFSv3 qui traversent le câble jusqu'à `BKP-HQ`. Quand on construit la standby, ce sont les octets des fichiers de données qui traversent le tunnel IPsec. Tu pourras le **prouver** (étape 4).

### 2.1 Ouvrir le lab

1. Lance l'application : `npm run dev`, puis ouvre <http://localhost:8080>.
2. Barre d'outils → **Importer** → choisis `labs/ecommerce-lumiere/topology.json`.
3. Double-clique sur `ORA-PRD` pour ouvrir son terminal.

Le fichier d'export est « une machine qui tournait et qui redémarre » : adresses, services, scripts, schéma `SHOP` sont là. **Le montage NFS, lui, est à refaire** : c'est exactement ce qui se passe sur un vrai serveur qui démarre sans que le serveur de sauvegarde soit joignable, et c'est la première commande de l'étape 1.

> 💡 Dans les blocs qui suivent, l'invite te dit **qui tape quoi, et où** : `[oracle@ora-prd ~]$` est le shell de l'utilisateur `oracle` sur `ORA-PRD`, `[root@bkp-hq ~]#` celui de root sur `BKP-HQ`, `SQL>` une session SQL*Plus (`sqlplus / as sysdba`), `RMAN>` une session RMAN (`rman target /`). **En production, on sauvegarde en tant qu'`oracle`, jamais en root** : on le verra à l'œuvre à l'étape 4.

---

## 3. Cinq notions à avoir en tête

Pas de cours complet ici, seulement ce qu'il faut pour lire les sorties.

| Notion | Ce que c'est | Pourquoi ça compte |
|---|---|---|
| **Datafile / tablespace** | Les fichiers qui contiennent les données. Chez Lumière : `SHOP_DATA` (tables) et `SHOP_IDX` (index) | C'est ce qu'on sauvegarde et ce qui peut disparaître |
| **Redo / ARCHIVELOG** | Le journal de toutes les modifications. Quand un groupe de redo est plein, Oracle l'**archive** (`ARCHIVELOG`) au lieu de l'écraser | Sans journaux archivés, on ne peut restaurer qu'**au moment de la sauvegarde** ; avec, **jusqu'à la dernière transaction** |
| **SCN** | Le numéro de série du temps de la base : il augmente à chaque changement validé | C'est l'horloge de la récupération : `RECOVER ... UNTIL SCN n` |
| **Fichier de contrôle** | Le petit fichier qui sait où est tout le reste (fichiers, journaux, **historique des sauvegardes**) | Le perdre rend la base muette ; RMAN l'**auto-sauvegarde** pour cette raison |
| **Incarnation / RESETLOGS** | Après une récupération *incomplète*, Oracle repart d'une nouvelle numérotation des journaux : une nouvelle « incarnation » | Une règle simple : **récupération incomplète ⇒ `OPEN RESETLOGS`** |

Et le vocabulaire RMAN : un **backup set** contient une ou plusieurs **pièces** (`piece handle=...`, les vrais fichiers) ; un **niveau 0** est la base complète (la référence), un **niveau 1** ne contient que ce qui a changé depuis ; le **DBID** est l'identifiant numérique de la base (à noter **avant** le sinistre).

---

## 4. Étape 1 — Reconnaissance : qu'est-ce qu'on protège ?

On commence par savoir où l'on est. Tu es `oracle` sur `ORA-PRD`.

### 4.1 Qui suis-je, où suis-je ?

```
[oracle@ora-prd ~]$ id
uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba)
[oracle@ora-prd ~]$ hostname
ora-prd
```

`uid=54321(oracle)` : le propriétaire des logiciels Oracle, membre du groupe `dba` (celui qui a le droit de se connecter `AS SYSDBA` sans mot de passe).

### 4.2 Monter le volume de sauvegarde

Le volume est **déclaré** dans `/etc/fstab`, mais il n'est pas monté au démarrage de ce lab. Un `mount -a` (en root) monte tout ce qui est déclaré :

```
[root@ora-prd ~]# mount -a
[root@ora-prd ~]# mount | grep backup
10.10.30.20:/srv/backup/rman on /backup type nfs (rw,relatime)
[root@ora-prd ~]# ls -ldn /backup
drwxrwxr-x 2 54321 54321 4096 Nov 27 17:05 /backup
```

Trois choses à voir :

- la source est `10.10.30.20:/srv/backup/rman` : le **serveur de sauvegarde** (`BKP-HQ`), à travers le réseau ;
- le propriétaire du dossier est **54321** : l'utilisateur `oracle` *du serveur de sauvegarde*. Pour que `oracle` d'`ORA-PRD` puisse y écrire, il faut le **même uid** des deux côtés. C'est la raison pour laquelle le lab crée le compte `oracle` (uid 54321) sur `BKP-HQ` : NFS ne transporte pas des noms, il transporte des **numéros** ;
- l'export est `rw` pour le réseau des bases du siège, et `ro` (lecture seule) pour celui du site de reprise.

### 4.3 L'état de santé de la base

Un script livré avec le lab (`/home/oracle/scripts/health.sql`) résume l'essentiel :

```
SQL> @/home/oracle/scripts/health.sql
NAME LOG_MODE     FORCE_LOGGING OPEN_MODE
---- ------------ ------------- ----------
ORCL NOARCHIVELOG NO            READ WRITE

1 row selected.

TABLESPACE_NAME STATUS
--------------- ------
SHOP_DATA       ONLINE
SHOP_IDX        ONLINE
SYSAUX          ONLINE
SYSTEM          ONLINE
TEMP            ONLINE
UNDOTBS1        ONLINE
USERS           ONLINE

7 rows selected.

COMMANDES
---------
       12

1 row selected.

STATUS  NB MONTANT
------- -- -------
NEW      6   470.2
PAID     3   127.2
SHIPPED  3     343

3 rows selected.
Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
```

Deux lignes comptent : la base est en **`NOARCHIVELOG`** (la valeur par défaut, et l'erreur classique des bases « de test » qui finissent en production), et le schéma contient **12 commandes** réparties en `NEW`, `PAID`, `SHIPPED`.

### 4.4 Noter le DBID

```
SQL> SELECT name, dbid, log_mode, open_mode FROM v$database;
NAME       DBID LOG_MODE     OPEN_MODE
---- ---------- ------------ ----------
ORCL 1182751704 NOARCHIVELOG READ WRITE

1 row selected.
```

> 📝 **Note le DBID** (ici `1182751704`) quelque part **en dehors** de la base : dans le runbook, dans le coffre de l'équipe. Si tu perds le fichier de contrôle *et* le catalogue, c'est lui qui te permet de retrouver tes sauvegardes automatiques (scénario B).

### 4.5 Où sont les fichiers ?

```
SQL> SELECT file#, name FROM v$datafile ORDER BY 1;
SQL> SELECT name FROM v$controlfile;
SQL> SELECT group#, members, status FROM v$log;
FILE# NAME
----- --------------------------------------------
    1 /u01/app/oracle/oradata/ORCL/system01.dbf
    2 /u01/app/oracle/oradata/ORCL/sysaux01.dbf
    3 /u01/app/oracle/oradata/ORCL/undotbs01.dbf
    4 /u01/app/oracle/oradata/ORCL/users01.dbf
    5 /u01/app/oracle/oradata/ORCL/shop_data01.dbf
    6 /u01/app/oracle/oradata/ORCL/shop_idx01.dbf

6 rows selected.

NAME
------------------------------------------
/u01/app/oracle/oradata/ORCL/control01.ctl
/u01/app/oracle/oradata/ORCL/control02.ctl

2 rows selected.

GROUP# MEMBERS STATUS
------ ------- -------
     1       1 CURRENT
     2       1 UNUSED
     3       1 UNUSED

3 rows selected.
```

Retiens l'emplacement des **deux fichiers de contrôle** (`control01.ctl`, `control02.ctl` : Oracle les multiplexe) et des fichiers de données ; ce sont eux que les scénarios vont détruire.

---

## 5. Étape 2 — Passer la base en ARCHIVELOG

En `NOARCHIVELOG`, Oracle **écrase** les journaux quand ils sont pleins : on ne peut sauvegarder la base qu'**arrêtée proprement**, et on ne peut restaurer qu'au point de la sauvegarde. Pour une boutique ouverte 24 h/24, c'est inacceptable. Le passage en `ARCHIVELOG` demande un **redémarrage** (la commande n'est acceptée qu'en `MOUNT`) ; le lab livre le script `03_archivelog.sql` qui le fait :

```
SQL> @/home/oracle/scripts/03_archivelog.sql
Database closed.
Database dismounted.
ORACLE instance shut down.

[... 13 lignes omises ...]
Database altered.
Database log mode              Archive Mode
Automatic archival             Enabled
Archive destination            LOCATION=/u01/app/oracle/archivelog
Archive format                 arch_%t_%s_%r.arc
Oldest online log sequence     1
Next log sequence to archive   0
Current log sequence           0
Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
```

Ce que le script fait, ligne à ligne : `SHUTDOWN IMMEDIATE`, `STARTUP MOUNT`, `ALTER DATABASE ARCHIVELOG`, `ALTER DATABASE FORCE LOGGING` (aucune opération ne peut plus échapper au journal avec `NOLOGGING`, ce qui est indispensable pour une standby), `ALTER DATABASE OPEN`, puis `ARCHIVE LOG LIST`. On vérifie :

```
SQL> SELECT log_mode, force_logging FROM v$database;
LOG_MODE   FORCE_LOGGING
---------- -------------
ARCHIVELOG YES

1 row selected.
```

> ⚠️ **Limite du simulateur, à connaître.** Un vrai Oracle refuse `BACKUP DATABASE` sur une base **ouverte en `NOARCHIVELOG`** (`RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode`). Le simulateur l'accepte encore (des dizaines de tests historiques en dépendent ; c'est consigné dans `TODO.md`). Tu ne dois pas en conclure que c'est permis : **passe toujours en ARCHIVELOG d'abord**, comme on le fait ici.

---

## 6. Étape 3 — Configurer RMAN une bonne fois pour toutes

On lance `rman target /` (en tant qu'`oracle`). RMAN stocke sa configuration **dans le fichier de contrôle** : on la règle une fois, elle vaut pour tous les `BACKUP` suivants.

### 6.1 Ce que RMAN fait par défaut

```
RMAN> SHOW ALL;
connected to target database: ORCL (DBID=1182751704)

RMAN configuration parameters for database with db_unique_name ORCL are:
CONFIGURE RETENTION POLICY TO REDUNDANCY 1;
CONFIGURE BACKUP OPTIMIZATION OFF;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CONTROLFILE AUTOBACKUP OFF;
[... 8 lignes omises ...]
CONFIGURE EXCLUDE FOR TABLESPACE TEMP; # default, cleared if explicit
CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;
CONFIGURE SNAPSHOT CONTROLFILE NAME TO '/u01/app/oracle/product/19c/dbhome_1/dbs/snapcf_ORCL.f'; # default
```

Trois réglages par défaut ne nous conviennent pas : la rétention est de **1 sauvegarde** (`REDUNDANCY 1`), l'**auto-sauvegarde du fichier de contrôle est éteinte**, et les pièces iraient dans la zone de récupération locale (`fast_recovery_area`), c'est-à-dire **sur le même disque que la base**. Une sauvegarde qui meurt avec la base ne sert à rien.

### 6.2 Notre politique

```
RMAN> CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
RMAN> CONFIGURE CONTROLFILE AUTOBACKUP ON;
RMAN> CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
RMAN> CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/backup/%d_%T_%U.bkp';
connected to target database: ORCL (DBID=1182751704)

new RMAN configuration parameters are successfully stored
new RMAN configuration parameters are successfully stored
new RMAN configuration parameters are successfully stored
new RMAN configuration parameters are successfully stored
```

| Réglage | Pourquoi |
|---|---|
| `RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS` | On doit pouvoir revenir à n'importe quel instant des 7 derniers jours ; RMAN garde ce qu'il faut pour cela et déclare le reste **obsolète** |
| `CONTROLFILE AUTOBACKUP ON` | Après chaque sauvegarde, RMAN sauvegarde aussi le fichier de contrôle. C'est ce qui rend le scénario B possible |
| `CONTROLFILE AUTOBACKUP FORMAT ... '/backup/cf_%F'` | Le fichier de contrôle est sauvegardé **sur le volume NFS**, sous un nom qui contient le DBID (`%F`) |
| `CHANNEL ... FORMAT '/backup/%d_%T_%U.bkp'` | Toutes les pièces vont sur `/backup` ; `%d` nom de la base, `%T` date, `%U` identifiant unique |

```
RMAN> SHOW RETENTION POLICY;
RMAN> SHOW CONTROLFILE AUTOBACKUP FORMAT;
connected to target database: ORCL (DBID=1182751704)

CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;

CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
```

---

## 7. Étape 4 — La première sauvegarde

### 7.1 La commande

`BACKUP DATABASE PLUS ARCHIVELOG` sauvegarde les fichiers de données **et** les journaux archivés, ce qui est le strict minimum pour pouvoir récupérer jusqu'à la dernière transaction :

```
RMAN> BACKUP DATABASE PLUS ARCHIVELOG TAG 'PREMIERE';
connected to target database: ORCL (DBID=1182751704)

Starting backup at 27-NOV-2026 17:05:10
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/backup/ORCL_20261127_01tp67gm_1_1.bkp tag=PREMIERE
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 27-NOV-2026 17:05:49

Starting backup at 27-NOV-2026 17:05:49
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
channel ORA_DISK_1: starting archived log backup set
channel ORA_DISK_1: specifying archived log(s) in backup set
piece handle=/backup/ORCL_20261127_02tp67hp_1_1.bkp tag=TAG20261127T170549
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 27-NOV-2026 17:06:28

Starting backup at 27-NOV-2026 17:06:28
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=102 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
including current control file in backup set
piece handle=/backup/cf_c-1182751704-20261127-03 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 27-NOV-2026 17:06:29
```

Lis la sortie comme un journal de bord :

- `piece handle=/backup/ORCL_...bkp tag=PREMIERE` : **le fichier créé** et l'étiquette de la sauvegarde (le `tag`) ;
- trois blocs `Starting backup / Finished backup` : les fichiers de données, les journaux archivés, puis l'**auto-sauvegarde du fichier de contrôle** (`tag=AUTOBACKUP`, nommée `cf_c-<DBID>-<date>-<n>`).

### 7.2 Ce qu'il y a dans le catalogue

```
RMAN> LIST BACKUP SUMMARY;
RMAN> REPORT SCHEMA;
RMAN> REPORT NEED BACKUP;
connected to target database: ORCL (DBID=1182751704)

List of Backups
===============
Key     TY LV S Device Type Completion Time      #Pieces #Copies Compressed Tag
------- -- -- - ----------- -------------------- ------- ------- ---------- ------------------
1       B  F  A DISK        27-NOV-2026 17:05:49 1       1       NO         PREMIERE
2       B  A  A DISK        27-NOV-2026 17:06:28 1       1       NO         TAG20261127T170549
3       B  F  A DISK        27-NOV-2026 17:06:29 1       1       NO         AUTOBACKUP

Report of database schema for database with db_unique_name ORCL

List of Permanent Datafiles
===========================
[... 12 lignes omises ...]
---- -------- -------------------- ----------- --------------------
1    100      TEMP                 32768       /u01/app/oracle/oradata/ORCL/temp01.dbf

RMAN retention policy will be applied to the command
RMAN retention policy is set to recovery window of 7 days
Report of files that must be backed up to satisfy 7 days recovery window
File Days  Name
---- ----- -----------------------------------------------------
1    0     /u01/app/oracle/oradata/ORCL/system01.dbf
2    0     /u01/app/oracle/oradata/ORCL/sysaux01.dbf
3    0     /u01/app/oracle/oradata/ORCL/undotbs01.dbf
4    0     /u01/app/oracle/oradata/ORCL/users01.dbf
5    0     /u01/app/oracle/oradata/ORCL/shop_data01.dbf
6    0     /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
```

`LIST BACKUP SUMMARY` : une ligne par backup set (`TY` type — `B` backup set ; `LV` niveau — `F` full, `A` journaux ; `S` état — `A` available). `REPORT SCHEMA` liste ce qu'il y a à protéger. `REPORT NEED BACKUP` confronte chaque fichier à la politique de rétention : la colonne `Days` donne le nombre de jours écoulés depuis la dernière sauvegarde de ce fichier (ici 0 : on vient de les sauvegarder tous). Dans une supervision, c'est elle qu'on surveille : un fichier dont `Days` dépasse la fenêtre n'est plus protégé.

### 7.3 La preuve par le fil

Va sur **l'autre machine**, `BKP-HQ`, et regarde ce qui est arrivé :

```
[root@bkp-hq ~]# ls -ln /srv/backup/rman
total 280
-rw-r--r-- 1 54321 54321   3645 Nov 27 17:05 cf_c-1182751704-20261127-03
-rw-r--r-- 1 54321 54321 276574 Nov 27 17:05 ORCL_20261127_01tp67gm_1_1.bkp
-rw-r--r-- 1 54321 54321     45 Nov 27 17:05 ORCL_20261127_02tp67hp_1_1.bkp
```

Les pièces et les trois fichiers `cf_c-...` sont là, et ils appartiennent à l'uid **54321** : c'est bien `oracle` d'`ORA-PRD` qui les a créés, **à travers le réseau** (NFSv3 sur le port 2049, trames réelles), pas un fichier local qui prétend l'être. C'est la raison pour laquelle on sauvegarde en tant qu'`oracle` et non en root : en root, les pièces appartiendraient à `root` sur le serveur de sauvegarde.

### 7.4 Ce que la base sait de ses sauvegardes

Le catalogue de RMAN vit dans le fichier de contrôle ; la base l'expose par des vues `V$` :

```
SQL> SELECT handle, status FROM v$backup_piece;
SQL> SELECT session_key, input_type, status FROM v$rman_backup_job_details;
HANDLE                                 STATUS
-------------------------------------- ------
/backup/ORCL_20261127_01tp67gm_1_1.bkp A
/backup/ORCL_20261127_02tp67hp_1_1.bkp A
/backup/cf_c-1182751704-20261127-03    A

3 rows selected.

SESSION_KEY INPUT_TYPE  STATUS
----------- ----------- ---------
          1 FULL        COMPLETED
          2 ARCHIVELOG  COMPLETED
          3 CONTROLFILE COMPLETED

3 rows selected.
```

`V$BACKUP_PIECE` liste les fichiers, `V$RMAN_BACKUP_JOB_DETAILS` l'historique des travaux avec leur état. Ce sont les vues qu'on interroge pour **superviser** une chaîne de sauvegarde.

---

## 8. Étape 5 — Une stratégie : niveau 0, niveau 1, journaux, cron

Une seule sauvegarde ne fait pas une stratégie. Voici celle de Lumière :

| Quand | Quoi | Ce que ça protège |
|---|---|---|
| **Dimanche 02:00** | Niveau 0 (base complète) | La référence |
| **Lundi–samedi 02:00** | Niveau 1 (ce qui a changé) | La nuit précédente, à peu de frais |
| **Toutes les 4 heures** | Sauvegarde des journaux archivés, puis suppression de ceux qui sont sauvegardés | **Le RPO** : on ne perd au plus que 4 h de commandes |

### 8.1 Les scripts

Trois fichiers de commandes RMAN (`l0.rman`, `l1.rman`, `arc.rman`) et **un seul** script shell qui les lance, journalise leur sortie dans un fichier, et envoie le **code retour** au serveur de journaux avec `logger` :

```
[oracle@ora-prd ~]$ mkdir -p /home/oracle/logs
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/rman_job.sh <<'X'
#!/bin/bash
job=$1
rman target / cmdfile=/home/oracle/scripts/$job.rman log=/home/oracle/logs/$job.log
code=$?
logger -t rman-backup "job=$job code=$code"
exit $code
X
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/l0.rman <<'X'
RUN {
  BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DIMANCHE_L0';
}
X
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/l1.rman <<'X'
RUN {
  BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'QUOTIDIEN_L1';
}
X
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/arc.rman <<'X'
RUN {
  BACKUP ARCHIVELOG ALL DELETE INPUT TAG 'JOURNAUX';
}
X
[oracle@ora-prd ~]$ chmod 750 /home/oracle/scripts/rman_job.sh
[oracle@ora-prd ~]$ ls -l /home/oracle/scripts
total 32
-rw-r--r-- 1 oracle oinstall 1540 Nov 27 17:05 01_schema.sql
-rw-r--r-- 1 oracle oinstall 3018 Nov 27 17:05 02_seed.sql
-rw-r--r-- 1 oracle oinstall  133 Nov 27 17:05 03_archivelog.sql
-rw-r--r-- 1 oracle oinstall   61 Nov 27 17:06 arc.rman
-rw-r--r-- 1 oracle oinstall  314 Nov 27 17:05 health.sql
-rw-r--r-- 1 oracle oinstall   65 Nov 27 17:06 l0.rman
-rw-r--r-- 1 oracle oinstall   66 Nov 27 17:06 l1.rman
-rwxr-x--- 1 oracle oinstall  166 Nov 27 17:06 rman_job.sh
```

`rman target / cmdfile=... log=...` exécute un fichier de commandes sans intervention ; le code retour (`$?`) vaut 0 si tout va bien. C'est lui que l'ordonnanceur et la supervision regardent.

### 8.2 Un niveau 0, des données qui changent, un niveau 1

```
[oracle@ora-prd ~]$ /home/oracle/scripts/rman_job.sh l0
[oracle@ora-prd ~]$ echo "code retour : $?"
code retour : 0
[oracle@ora-prd ~]$ tail -4 /home/oracle/logs/l0.log
piece handle=/backup/cf_c-1182751704-20261127-05 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 27-NOV-2026 17:07:10
```

On modifie des données (les commandes `NEW` passent en `PAID`) et on force l'archivage du journal courant :

```
SQL> UPDATE shop.orders SET status = 'PAID' WHERE status = 'NEW';
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT status, COUNT(*) AS nb FROM shop.orders GROUP BY status ORDER BY 1;
6 rows updated.

Commit complete.

System altered.

STATUS  NB
------- --
PAID     9
SHIPPED  3

2 rows selected.
```

```
[oracle@ora-prd ~]$ /home/oracle/scripts/rman_job.sh l1
[oracle@ora-prd ~]$ echo "code retour : $?"
code retour : 0
[oracle@ora-prd ~]$ tail -3 /home/oracle/logs/l1.log
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 27-NOV-2026 17:07:13
```

Le niveau 1 est quasi instantané par rapport au niveau 0 : il ne contient que les changements.

Une dernière modification, **après** le niveau 1 (le stock de la lampe passe de 120 à 115, une vente) : elle ne sera dans **aucune sauvegarde de fichier de données**, seulement dans les journaux. C'est ce que le scénario A utilisera pour montrer à quoi servent les journaux :

```
SQL> UPDATE shop.products SET stock = stock - 5 WHERE product_id = 1;
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT stock FROM shop.products WHERE product_id = 1;
1 row updated.

Commit complete.

System altered.

STOCK
-----
  115

1 row selected.
```

### 8.3 Les journaux archivés

```
[oracle@ora-prd ~]$ /home/oracle/scripts/rman_job.sh arc
[oracle@ora-prd ~]$ echo "code retour : $?"
code retour : 0
[oracle@ora-prd ~]$ tail -3 /home/oracle/logs/arc.log
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 27-NOV-2026 17:07:54
```

`DELETE INPUT` supprime du disque les journaux **une fois sauvegardés** : sans cela, la zone d'archivage se remplit et la base **se bloque** (`ORA-00257`) quand elle ne peut plus archiver. C'est l'incident de production le plus banal d'Oracle.

```
RMAN> LIST BACKUP SUMMARY;
RMAN> LIST ARCHIVELOG ALL;
connected to target database: ORCL (DBID=1182751704)

List of Backups
===============
Key     TY LV S Device Type Completion Time      #Pieces #Copies Compressed Tag
------- -- -- - ----------- -------------------- ------- ------- ---------- ------------------
1       B  F  A DISK        27-NOV-2026 17:05:49 1       1       NO         PREMIERE
2       B  A  A DISK        27-NOV-2026 17:06:28 1       1       NO         TAG20261127T170549
3       B  F  A DISK        27-NOV-2026 17:06:29 1       1       NO         AUTOBACKUP
4       B  0  A DISK        27-NOV-2026 17:07:09 1       1       NO         DIMANCHE_L0
5       B  F  A DISK        27-NOV-2026 17:07:10 1       1       NO         AUTOBACKUP
6       B  1  A DISK        27-NOV-2026 17:07:12 1       1       NO         QUOTIDIEN_L1
7       B  F  A DISK        27-NOV-2026 17:07:13 1       1       NO         AUTOBACKUP
8       B  A  A DISK        27-NOV-2026 17:07:53 1       1       NO         JOURNAUX
9       B  F  A DISK        27-NOV-2026 17:07:54 1       1       NO         AUTOBACKUP

specification does not match any archived log in the repository
```

On lit maintenant la structure de la stratégie : `LV 0` (niveau 0), `LV 1` (niveau 1), `LV A` (journaux), `LV F` (les auto-sauvegardes du fichier de contrôle). `LIST ARCHIVELOG ALL` répond que plus aucun journal n'est sur le disque : ils ont tous été sauvegardés **puis supprimés** (on verra au scénario A que RMAN sait les **récupérer depuis la sauvegarde** au moment d'en avoir besoin).

### 8.4 La planification

```
[oracle@ora-prd ~]$ (crontab -l 2>/dev/null; echo "0 2 * * 0 /home/oracle/scripts/rman_job.sh l0"; echo "0 2 * * 1-6 /home/oracle/scripts/rman_job.sh l1"; echo "0 */4 * * * /home/oracle/scripts/rman_job.sh arc") | crontab -
[oracle@ora-prd ~]$ crontab -l
0 2 * * 0 /home/oracle/scripts/rman_job.sh l0
0 2 * * 1-6 /home/oracle/scripts/rman_job.sh l1
0 */4 * * * /home/oracle/scripts/rman_job.sh arc
```

Trois lignes de `crontab`, dans le crontab de l'utilisateur `oracle`. Le format est celui de cron : `minute heure jour-du-mois mois jour-de-la-semaine commande` (`0 2 * * 0` : à 02:00 le dimanche).

### 8.5 Le journal central

Chaque exécution du script a envoyé son code retour à `LOG-HQ` par rsyslog. Sur `LOG-HQ` :

```
[root@log-hq ~]# grep rman-backup /var/log/syslog
Nov 27 17:07:10 ora-prd rman-backup: job=l0 code=0
Nov 27 17:07:13 ora-prd rman-backup: job=l1 code=0
Nov 27 17:07:54 ora-prd rman-backup: job=arc code=0
```

C'est la **trace centrale** de la chaîne de sauvegarde : `ora-prd` est le nom de la machine émettrice, `job=l0 code=0` dit quel travail et avec quel résultat. Une supervision n'a qu'à chercher `code=` différent de `0`. Le lab configure cet envoi (`/etc/rsyslog.d/90-forward-lumiere.conf`, `*.* @10.10.10.40:514`) sur toutes les machines Oracle, sauvegarde et web.

---

## 9. Étape 6 — Vérifier : une sauvegarde non testée n'existe pas

Trois niveaux de vérification, du moins cher au plus cher.

**1. Les fichiers de la base sont-ils lisibles ?**

```
RMAN> VALIDATE DATABASE;
connected to target database: ORCL (DBID=1182751704)

Starting validate at 27-NOV-2026 17:07:54
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting validation of database
channel ORA_DISK_1: validating database
List of Datafiles
=================
[... 12 lignes omises ...]
6    OK     0              12799        12800           1000334
File Name: /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
channel ORA_DISK_1: validation complete, elapsed time: 00:00:01
Finished validate at 27-NOV-2026 17:07:54
```

**2. RMAN pourrait-il restaurer ?** (sans rien écrire : il lit les pièces)

```
RMAN> RESTORE DATABASE VALIDATE;
connected to target database: ORCL (DBID=1182751704)

Starting restore at 27-NOV-2026 17:07:54
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile backup set restore
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261127_01tp67gm_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261127_02tp67hp_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-1182751704-20261127-03
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261127_04tp67it_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-1182751704-20261127-05
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261127_06tp67jy_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-1182751704-20261127-07
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261127_08tp67k1_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-1182751704-20261127-09
channel ORA_DISK_1: validation complete, elapsed time: 00:00:01
Finished restore at 27-NOV-2026 17:07:55
```

`RESTORE DATABASE VALIDATE` lit **toutes les pièces nécessaires** à une restauration complète et vérifie qu'elles sont lisibles et cohérentes. C'est le test que tu mets dans ta supervision.

**3. Le catalogue correspond-il à la réalité ?**

```
RMAN> CROSSCHECK BACKUP;
RMAN> CROSSCHECK ARCHIVELOG ALL;
connected to target database: ORCL (DBID=1182751704)

Starting crosscheck at 27-NOV-2026 17:07:55
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
crosschecked backup piece: found to be 'AVAILABLE'
crosschecked backup piece: found to be 'AVAILABLE'
crosschecked backup piece: found to be 'AVAILABLE'
crosschecked backup piece: found to be 'AVAILABLE'
crosschecked backup piece: found to be 'AVAILABLE'
crosschecked backup piece: found to be 'AVAILABLE'
crosschecked backup piece: found to be 'AVAILABLE'
Crosschecked 7 objects
Finished crosscheck at 27-NOV-2026 17:07:56

Starting crosscheck at 27-NOV-2026 17:07:56
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
crosschecked archived log: found to be 'AVAILABLE'
crosschecked archived log: found to be 'AVAILABLE'
Crosschecked 2 objects
Finished crosscheck at 27-NOV-2026 17:07:57
```

`CROSSCHECK` compare ce que RMAN croit avoir et ce qu'il y a vraiment sur le disque : une pièce effacée à la main passerait en `EXPIRED`. Enfin, la politique de rétention :

```
RMAN> REPORT OBSOLETE;
RMAN> DELETE OBSOLETE NOPROMPT;
connected to target database: ORCL (DBID=1182751704)

RMAN retention policy will be applied to the command
RMAN retention policy is set to recovery window of 7 days
Report of obsolete backups and copies
Type                 Key    Completion Time    Filename/Handle
-------------------- ------ ------------------ --------------------
no obsolete backups found

Starting delete at 27-NOV-2026 17:07:57
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
RMAN retention policy will be applied to the command
using channel ORA_DISK_1
no obsolete backups found
Finished delete at 27-NOV-2026 17:07:57
```

`REPORT OBSOLETE` liste ce que la fenêtre de 7 jours permet de supprimer ; `DELETE OBSOLETE` le supprime. Tout est « récent » ici : rien n'est obsolète.

> 💡 **La règle d'or** : le seul test valable d'une sauvegarde est une **restauration**. Les trois scénarios qui suivent sont ce test.

---

## 10. Scénario A — Un datafile disparaît

*Un disque a lâché : le fichier de données `shop_data01.dbf` (le tablespace `SHOP_DATA`, avec toutes les tables de la boutique) n'existe plus.*

### 10.1 Avant

```
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
COMMANDES
---------
       12

1 row selected.
```

### 10.2 Le sinistre

```
[oracle@ora-prd ~]$ rm -f /u01/app/oracle/oradata/ORCL/shop_data01.dbf
[oracle@ora-prd ~]$ ls /u01/app/oracle/oradata/ORCL
control01.ctl  redo02.log      sysaux01.dbf  undotbs01.dbf
control02.ctl  redo03.log      system01.dbf  users01.dbf
redo01.log     shop_idx01.dbf  temp01.dbf
```

Rien ne se passe, et c'est **normal** : tant que la base est ouverte, Oracle a le fichier ouvert ; il ne s'aperçoit de sa disparition qu'à un redémarrage (ou à la prochaine lecture sur disque). On simule la panne la plus brutale : l'arrêt immédiat de l'instance.

```
SQL> SHUTDOWN ABORT
Database closed.
Database dismounted.
ORACLE instance shut down.
```

### 10.3 Le diagnostic

```
SQL> STARTUP MOUNT
SQL> ALTER DATABASE OPEN;
ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01157: cannot identify/lock data file 5 - see DBWR trace file
ORA-01110: data file 5: '/u01/app/oracle/oradata/ORCL/shop_data01.dbf'
```

C'est **LE** message à reconnaître : `ORA-01157` (impossible d'identifier le fichier), suivi de `ORA-01110` qui **nomme le fichier** : numéro 5, chemin complet. Remarque deux choses : l'instance est bien **montée** (`Database mounted.`, le fichier de contrôle est lisible : c'est lui qui connaît la liste des fichiers) ; c'est seulement l'**ouverture** qui échoue, parce qu'un fichier manque.

### 10.4 La réparation

Deux commandes RMAN, dans cet ordre, et **toujours** dans cet ordre :

```
RMAN> RESTORE DATAFILE 5;
RMAN> RECOVER DATAFILE 5;
connected to target database: ORCL (DBID=1182751704)

Starting restore at 27-NOV-2026 17:07:57
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile 5 restore
channel ORA_DISK_1: restoring datafile 00005 to /u01/app/oracle/oradata/ORCL/shop_data01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:25
Finished restore at 27-NOV-2026 17:07:58

Starting recover at 27-NOV-2026 17:07:58
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
starting media recovery
recovering datafile 5
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
media recovery complete, elapsed time: 00:00:03
Finished recover at 27-NOV-2026 17:07:59
```

- `RESTORE DATAFILE 5` : RMAN retrouve **la sauvegarde la plus récente du fichier 5** et la recopie à sa place (depuis `/backup`, c'est-à-dire à travers le réseau) ;
- `RECOVER DATAFILE 5` : le fichier restauré date de la sauvegarde ; RMAN lui **rejoue les journaux** pour le ramener au présent. Ici, ceux-ci ont été supprimés du disque après leur sauvegarde : RMAN les **extrait de la pièce de sauvegarde des journaux** avant de les rejouer.

> 💡 `RESTORE` ramène un état **ancien** ; `RECOVER` le **met à jour**. Sans `RECOVER`, le fichier est trop vieux par rapport au reste de la base et Oracle refuse de l'ouvrir.

```
SQL> ALTER DATABASE OPEN;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
SQL> SELECT COUNT(*) AS payees FROM shop.orders WHERE status = 'PAID';
SQL> SELECT stock FROM shop.products WHERE product_id = 1;
Database altered.

COMMANDES
---------
       12

1 row selected.

PAYEES
------
     9

1 row selected.

STOCK
-----
  115

1 row selected.
```

La base est ouverte, les 12 commandes sont là, neuf sont payées (la mise à jour de la journée est revenue avec le niveau 1) **et le stock de la lampe vaut 115** : cette vente a eu lieu **après** le niveau 1, elle n'était dans aucune sauvegarde de fichier de données, seulement dans le journal archivé que RMAN a retrouvé dans sa pièce. C'est exactement ce que valent les journaux archivés : sans eux, tu aurais retrouvé 120.

### 10.5 Variante : réparer pendant que la boutique tourne

Si **seul le tablespace** est en cause, on n'est pas obligé d'arrêter la base : on met **uniquement** `SHOP_DATA` hors ligne, on le restaure, on le remet en ligne. Les autres tablespaces (et donc, par exemple, la connexion des clients dans leurs tables d'index ou de sessions) continuent de fonctionner.

```
SQL> ALTER TABLESPACE shop_data OFFLINE IMMEDIATE;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
SQL> SELECT COUNT(*) FROM shop.customers;
Tablespace altered.
SELECT COUNT(*) AS commandes FROM shop.orders
*
ERROR at line 1:
ORA-00376: file 5 cannot be read at this time
ORA-01110: data file 5: '/u01/app/oracle/oradata/ORCL/shop_data01.dbf'
SELECT COUNT(*) FROM shop.customers
*
ERROR at line 1:
ORA-00376: file 5 cannot be read at this time
ORA-01110: data file 5: '/u01/app/oracle/oradata/ORCL/shop_data01.dbf'
```

Les deux erreurs sont celles qu'un utilisateur de la boutique verrait : `ORA-00376` (fichier illisible) et `ORA-01110` (lequel). Restauration, **en ligne** :

```
RMAN> RESTORE TABLESPACE shop_data;
RMAN> RECOVER TABLESPACE shop_data;
connected to target database: ORCL (DBID=1182751704)

Starting restore at 27-NOV-2026 17:07:59
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting tablespace SHOP_DATA restore
channel ORA_DISK_1: restoring datafile 00005 to /u01/app/oracle/oradata/ORCL/shop_data01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:25
Finished restore at 27-NOV-2026 17:08:01

Starting recover at 27-NOV-2026 17:08:01
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
starting media recovery
recovering tablespace SHOP_DATA
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
media recovery complete, elapsed time: 00:00:03
Finished recover at 27-NOV-2026 17:08:01
```

```
SQL> ALTER TABLESPACE shop_data ONLINE;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
Tablespace altered.

COMMANDES
---------
       12

1 row selected.
```

> 💡 Cette restauration « en ligne » n'est possible qu'en `ARCHIVELOG`. En `NOARCHIVELOG`, Oracle refuse de mettre un tablespace `OFFLINE IMMEDIATE` (`ORA-01145`) : encore une raison de l'étape 2.

---

## 11. Scénario B — Les fichiers de contrôle disparaissent

*Pire : les **deux** copies du fichier de contrôle sont perdues. La base ne peut plus ni se monter, ni dire où sont ses fichiers, ni où sont ses sauvegardes (le catalogue RMAN vivait dedans).*

C'est là que **le DBID noté à l'étape 1** et **l'auto-sauvegarde** servent.

### 11.1 Le contexte avant la panne

```
SQL> SELECT dbid FROM v$database;
SQL> SELECT name FROM v$controlfile;
      DBID
----------
1182751704

1 row selected.

NAME
------------------------------------------
/u01/app/oracle/oradata/ORCL/control01.ctl
/u01/app/oracle/oradata/ORCL/control02.ctl

2 rows selected.
```

### 11.2 Le sinistre

```
[oracle@ora-prd ~]$ rm -f /u01/app/oracle/oradata/ORCL/control01.ctl /u01/app/oracle/oradata/ORCL/control02.ctl
[oracle@ora-prd ~]$ ls /u01/app/oracle/oradata/ORCL | grep -c control
0
```

```
SQL> SHUTDOWN ABORT
Database closed.
Database dismounted.
ORACLE instance shut down.
```

```
SQL> STARTUP
ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
ORA-00205: error in identifying control file, check alert log for more info
```

`ORA-00205` : l'instance démarre (`ORACLE instance started`), mais ne peut pas lire son fichier de contrôle. Elle reste dans l'état `NOMOUNT`, ce qui est exactement ce qu'il faut pour la suite : RMAN peut se connecter à une instance non montée.

### 11.3 La restauration du fichier de contrôle

RMAN a **tout oublié** : sa configuration (stockée dans le fichier de contrôle) et son catalogue. Il faut donc lui dire qui il sauvegarde (`SET DBID`) et **où chercher** les auto-sauvegardes (`SET CONTROLFILE AUTOBACKUP FORMAT`, le même format que celui de l'étape 3) :

```
RMAN> SET DBID 1182751704;
RMAN> SET CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
RMAN> RESTORE CONTROLFILE FROM AUTOBACKUP;
connected to target database: ORCL (DBID=1182751704)

executing command: SET DBID
executing command: SET CONTROLFILE AUTOBACKUP FORMAT

Starting restore at 27-NOV-2026 17:08:01
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK

channel ORA_DISK_1: looking for AUTOBACKUP on day: 20261127
channel ORA_DISK_1: AUTOBACKUP found: /backup/cf_c-1182751704-20261127-09
channel ORA_DISK_1: restoring control file from AUTOBACKUP /backup/cf_c-1182751704-20261127-09
channel ORA_DISK_1: control file restore from AUTOBACKUP complete
output file name=/u01/app/oracle/oradata/ORCL/control01.ctl
Finished restore at 27-NOV-2026 17:08:01
```

RMAN a trouvé `cf_c-<DBID>-<date>-<n>`, **la plus récente**, et en a refait les deux fichiers de contrôle. Plus bas, `MOUNT` puis `RECOVER` : le fichier de contrôle restauré dit que la base est « plus ancienne » que ses fichiers de données ; les journaux comblent l'écart.

```
SQL> ALTER DATABASE MOUNT;
SQL> SELECT name, log_mode FROM v$database;
Database altered.

NAME LOG_MODE
---- ----------
ORCL ARCHIVELOG

1 row selected.
```

```
RMAN> RECOVER DATABASE;
connected to target database: ORCL (DBID=1182751704)

Starting recover at 27-NOV-2026 17:08:01
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
starting media recovery
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
media recovery complete, elapsed time: 00:00:03
Finished recover at 27-NOV-2026 17:08:01
```

### 11.4 L'ouverture : `RESETLOGS`

```
SQL> ALTER DATABASE OPEN;
SQL> ALTER DATABASE OPEN RESETLOGS;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01589: must use RESETLOGS or NORESETLOGS option for database open

Database altered.

COMMANDES
---------
       12

1 row selected.
```

Un fichier de contrôle **restauré** n'est plus « celui de la base vivante » : Oracle exige `OPEN RESETLOGS` (`ORA-01589` sinon) et crée une **nouvelle incarnation**. Les commandes sont toutes là.

> 📌 **Réflexe après tout `RESETLOGS`** : faire immédiatement une **nouvelle sauvegarde complète** (en dessous). La précédente est celle d'une incarnation antérieure : on peut s'en servir, mais on ne veut pas dépendre d'elle.

```
RMAN> LIST INCARNATION;
RMAN> BACKUP DATABASE PLUS ARCHIVELOG TAG 'POST_RESETLOGS';
connected to target database: ORCL (DBID=1182751704)

List of Database Incarnations
=============================
DB Key  Inc Key DB Name  DB ID            STATUS  Reset SCN  Reset Time
------- ------- -------- ---------------- ------- ---------- ----------
1       1       ORCL     1182751704       PARENT  1          2026-11-27
1       2       ORCL     1182751704       CURRENT 1000338    2026-11-27

Starting backup at 27-NOV-2026 17:08:01
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/backup/ORCL_20261127_0atp67ld_1_1.bkp tag=POST_RESETLOGS
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 27-NOV-2026 17:08:40

Starting backup at 27-NOV-2026 17:08:40
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
channel ORA_DISK_1: starting archived log backup set
channel ORA_DISK_1: specifying archived log(s) in backup set
piece handle=/backup/ORCL_20261127_0btp67mg_1_1.bkp tag=TAG20261127T170840
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 27-NOV-2026 17:09:20

Starting backup at 27-NOV-2026 17:09:20
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=102 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
including current control file in backup set
piece handle=/backup/cf_c-1182751704-20261127-12 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 27-NOV-2026 17:09:21
```

`LIST INCARNATION` montre l'incarnation d'origine (`PARENT`) et la nouvelle (`CURRENT`).

---

## 12. Scénario C — Un `DROP TABLE` en production : retour dans le temps

*Un développeur supprime la table des paiements. La base est saine, ouverte, tout fonctionne… sauf qu'il manque les paiements. Aucun fichier n'est perdu : il faut revenir **avant** l'erreur.*

C'est le cas que le site de reprise **ne résout pas** (il a rejoué le `DROP TABLE` aussi) et que la sauvegarde résout, grâce au **SCN**.

### 12.1 Noter l'instant juste avant

En pratique, on retrouve cet instant dans les journaux, dans l'audit, ou en demandant à l'utilisateur « vers quelle heure ? ». Ici, on le relève juste avant :

```
SQL> INSERT INTO shop.orders VALUES (2001, 1, SYSDATE, 'NEW', 99.5);
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT COUNT(*) AS paiements FROM shop.payments;
SQL> SELECT current_scn FROM v$database;
1 row created.

Commit complete.

System altered.

PAIEMENTS
---------
        6

1 row selected.

CURRENT_SCN
-----------
    1000344

1 row selected.
```

Le SCN `1000344` est notre **point de retour**.

### 12.2 L'erreur

```
SQL> DROP TABLE shop.payments CASCADE CONSTRAINTS PURGE;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT COUNT(*) FROM shop.payments;
Table dropped.

System altered.
SELECT COUNT(*) FROM shop.payments
*
ERROR at line 1:
ORA-00942: table or view does not exist
```

### 12.3 Revenir dans le temps

On arrête la base, on la monte, et on restaure **jusqu'à un SCN** précis. Les deux commandes sont dans un bloc `RUN { ... }` pour que le `SET UNTIL` s'applique aux deux :

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.
```

```
RMAN> RUN {
RMAN>   SET UNTIL SCN 1000344;
RMAN>   RESTORE DATABASE;
RMAN>   RECOVER DATABASE;
RMAN> }
connected to target database: ORCL (DBID=1182751704)

executing command: SET until clause

Starting restore at 27-NOV-2026 17:09:21
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile backup set restore
[... 17 lignes omises ...]
starting media recovery
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
archived log for thread 1 with sequence 3 is already on disk as file /u01/app/oracle/archivelog/1_3_arc.arc
archived log for thread 1 with sequence 4 is already on disk as file /u01/app/oracle/archivelog/1_4_arc.arc
media recovery complete, elapsed time: 00:00:03
Finished recover at 27-NOV-2026 17:09:23
```

`SET UNTIL SCN 1000344` borne le travail : RMAN choisit la sauvegarde la plus récente **antérieure** à ce SCN, la restaure, puis ne rejoue les journaux **que jusqu'à ce SCN**. Les modifications d'après (dont le `DROP TABLE`) sont ignorées.

### 12.4 L'ouverture avec `RESETLOGS`

```
SQL> ALTER DATABASE OPEN;
SQL> ALTER DATABASE OPEN RESETLOGS;
SQL> SELECT COUNT(*) AS paiements FROM shop.payments;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders WHERE order_id = 2001;
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01589: must use RESETLOGS or NORESETLOGS option for database open

Database altered.

PAIEMENTS
---------
        6

1 row selected.

COMMANDES
---------
        1

1 row selected.
```

La table `PAYMENTS` est revenue **avec son contenu**, la commande `2001` (créée *avant* l'erreur) aussi. Le premier `OPEN` est refusé (`ORA-01589`) : une récupération **incomplète** exige `RESETLOGS`.

### 12.5 Les incarnations, et la sauvegarde d'après

```
RMAN> LIST INCARNATION;
connected to target database: ORCL (DBID=1182751704)

List of Database Incarnations
=============================
DB Key  Inc Key DB Name  DB ID            STATUS  Reset SCN  Reset Time
------- ------- -------- ---------------- ------- ---------- ----------
1       1       ORCL     1182751704       PARENT  1          2026-11-27
1       2       ORCL     1182751704       PARENT  1000338    2026-11-27
1       3       ORCL     1182751704       CURRENT 1000348    2026-11-27
```

```
RMAN> BACKUP DATABASE PLUS ARCHIVELOG TAG 'APRES_PITR';
connected to target database: ORCL (DBID=1182751704)

Starting backup at 27-NOV-2026 17:09:24
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/backup/ORCL_20261127_0dtp67no_1_1.bkp tag=APRES_PITR
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 27-NOV-2026 17:10:03

Starting backup at 27-NOV-2026 17:10:03
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
channel ORA_DISK_1: starting archived log backup set
channel ORA_DISK_1: specifying archived log(s) in backup set
piece handle=/backup/ORCL_20261127_0etp67or_1_1.bkp tag=TAG20261127T171003
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 27-NOV-2026 17:10:43

Starting backup at 27-NOV-2026 17:10:43
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=102 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
including current control file in backup set
piece handle=/backup/cf_c-1182751704-20261127-15 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 27-NOV-2026 17:10:44
```

> 💡 **Ce que tu as perdu** en revenant au SCN `1000344` : tout ce qui est arrivé **après**, y compris des commandes légitimes passées entre-temps. Un retour dans le temps de toute la base est un instrument lourd ; en production on lui préfère souvent *Flashback Table* ou une restauration dans une **base auxiliaire** pour ne récupérer que la table. Ces deux techniques sortent du cadre de ce tutoriel.

---

## 13. Accès, audit et journaux : qui a le droit de sauvegarder ?

Une sauvegarde contient **toute la base**, mots de passe hachés compris. Ceux qui peuvent la lancer — ou la restaurer — sont aussi puissants que le DBA.

### 13.1 Un compte ordinaire essaie

Un stagiaire (compte `stagiaire`, simple utilisateur, **hors du groupe `dba`**) tente de lancer RMAN :

```
[root@ora-prd ~]# useradd -m stagiaire
[root@ora-prd ~]# sudo -u stagiaire rman target /
RMAN-00571: ===========================================================
RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============
RMAN-00571: ===========================================================
RMAN-00554: initialization of internal recovery manager package failed
RMAN-04005: error from target database:
ORA-01031: insufficient privileges
```

`ORA-01031: insufficient privileges`, enveloppé dans `RMAN-00554` / `RMAN-04005`. Sur la machine, la connexion « bequeath » (`rman target /` sans mot de passe) n'est possible que pour les membres du groupe **`dba`** ; c'est le système d'exploitation qui authentifie.

### 13.2 La trace

Cette tentative **n'est pas perdue** : elle est auditée côté base, et inscrite au journal d'alerte :

```
SQL> SELECT os_username, returncode FROM dba_audit_trail WHERE returncode = 1031;
OS_USERNAME RETURNCODE
----------- ----------
stagiaire         1031

1 row selected.
```

```
[oracle@ora-prd ~]$ grep -i "failed sysdba logon" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log | tail -2
2026-11-27 17:10:44: Failed SYSDBA logon: os_user=stagiaire not in dba group (ORA-01031)
```

Ligne à ligne : `stagiaire` est l'utilisateur système qui a essayé, `1031` le code d'erreur. Un contrôle de sécurité efficace commence par là : **chaque refus laisse une trace**, et la trace va au serveur de journaux (§8.5).

### 13.3 À retenir pour ton organisation

| Contrôle | Où |
|---|---|
| Qui peut lancer RMAN / se connecter `AS SYSDBA` ? | Les membres du groupe OS `dba` (et eux seuls) |
| Qui peut **écrire** les sauvegardes ? | Le volume NFS `rw` pour les bases du siège seulement ; `ro` pour le site de reprise |
| Qui voit passer les travaux ? | `LOG-HQ` (rsyslog) : code retour de chaque travail |
| Qui administre les équipements réseau ? | FreeRADIUS sur `LOG-HQ` (Cisco-AVPair `priv-lvl=15`) |

---

## 14. Scénario D — Le siège brûle : le site de reprise

*Le siège est perdu : `ORA-PRD`, `BKP-HQ`, tout. Les sauvegardes avaient été prises sur `BKP-HQ`… qui vient de brûler avec elles. Voilà pourquoi on a besoin d'un **site de reprise vivant**, qui reçoit les modifications **en continu**.*

La technique : une **base de secours physique** (*physical standby*) sur `ORA-STB`, créée par RMAN depuis la base active, alimentée par l'envoi des journaux, que l'on **promeut** en base primaire le jour du sinistre.

### 14.1 Le chemin est-il ouvert ?

Tout passe par le tunnel IPsec entre `FGT-HQ` et `FGT-DR` :

```
[root@fgt-hq ~]# get vpn ipsec tunnel summary
'to-dr' 203.0.113.2:0  selectors(total,up): 1/1  rx(pkt,err): 103/0  tx(pkt,err): 2/0
'to-ag1' 203.0.113.11:0  selectors(total,up): 1/1  rx(pkt,err): 8/0  tx(pkt,err): 0/0
'to-ag2' 203.0.113.12:0  selectors(total,up): 1/1  rx(pkt,err): 8/0  tx(pkt,err): 0/0
```

`'to-dr'` : `selectors(total,up): 1/1` : le tunnel est établi. C'est lui que traverseront, **en trames chiffrées**, les fichiers de la base.

### 14.2 Préparer la machine de secours

`ORA-STB` doit être une **instance démarrée mais sans base** : `NOMOUNT`.

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP NOMOUNT
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
```

### 14.3 Créer la standby depuis la base active

Depuis `ORA-PRD`, RMAN se connecte à la **cible** (la production) et à l'**auxiliaire** (la future standby, `10.20.30.10`), puis recopie toute la base à travers le tunnel :

```
RMAN> CONNECT AUXILIARY sys/oracle@10.20.30.10:1521/ORCL;
RMAN> DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;
connected to target database: ORCL (DBID=1182751704)

connected to auxiliary database: ORCL

Starting Duplicate Db at 27-NOV-2026 17:10:44
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
contents of Memory Script:
{
   restore clone standby controlfile;
   sql clone "alter database mount standby database";
}
[... 11 lignes omises ...]
channel ORA_DISK_1: restore complete, elapsed time: 00:00:25
channel ORA_DISK_1: restoring datafile 00006 to /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:25
sql statement: alter database mount standby database
recover clone database
Finished Duplicate Db at 27-NOV-2026 17:10:45
```

`DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE` : *« fais-moi une standby de cette base, en lisant directement les fichiers de la base ouverte »*, sans passer par une sauvegarde intermédiaire. `DORECOVER` rejoue les journaux disponibles, `NOFILENAMECHECK` autorise les mêmes noms de fichiers des deux côtés. Les octets des six fichiers de données ont **réellement traversé** le tunnel.

Sur `ORA-STB` :

```
SQL> SELECT database_role, open_mode, log_mode FROM v$database;
SQL> SELECT file#, name FROM v$datafile ORDER BY 1;
DATABASE_ROLE    OPEN_MODE LOG_MODE
---------------- --------- ----------
PHYSICAL STANDBY MOUNTED   ARCHIVELOG

1 row selected.

FILE# NAME
----- --------------------------------------------
    1 /u01/app/oracle/oradata/ORCL/system01.dbf
    2 /u01/app/oracle/oradata/ORCL/sysaux01.dbf
    3 /u01/app/oracle/oradata/ORCL/undotbs01.dbf
    4 /u01/app/oracle/oradata/ORCL/users01.dbf
    5 /u01/app/oracle/oradata/ORCL/shop_data01.dbf
    6 /u01/app/oracle/oradata/ORCL/shop_idx01.dbf

6 rows selected.
```

`PHYSICAL STANDBY` + `MOUNTED` : c'est une standby ; les six fichiers de données y sont. (Une standby est toujours en `ARCHIVELOG`, car elle reçoit des journaux archivés.)

### 14.4 Expédier les journaux, les appliquer

On dit à la production d'envoyer ses journaux vers la standby (`log_archive_dest_2`), et on démarre sur la standby le processus qui les **applique** (*managed recovery*) :

```
SQL> ALTER SYSTEM SET log_archive_dest_2='SERVICE=10.20.30.10:1521/ORCL ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=ORCL_STB' SCOPE=BOTH;
SQL> ALTER SYSTEM SET log_archive_dest_state_2=ENABLE SCOPE=BOTH;
System altered.

System altered.
```

```
SQL> ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
Database altered.
```

### 14.5 Une commande tombe, elle arrive de l'autre côté

```
SQL> INSERT INTO shop.orders VALUES (3001, 2, SYSDATE, 'NEW', 42);
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT dest_id, status, destination FROM v$archive_dest WHERE dest_id <= 2;
1 row created.

Commit complete.

System altered.

DEST_ID STATUS DESTINATION
------- ------ --------------------------
      1 VALID  /u01/app/oracle/archivelog
      2 VALID  10.20.30.10:1521/ORCL

2 rows selected.
```

Le deuxième `SELECT` montre la destination 2 (`10.20.30.10:1521/ORCL`) à l'état `VALID`. Maintenant, lisons côté standby (qu'on ouvre en **lecture seule** après avoir arrêté l'application) :

```
SQL> SELECT COUNT(*) AS logs_appliques FROM v$archived_log WHERE applied = 'YES';
SQL> ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
SQL> ALTER DATABASE OPEN READ ONLY;
SQL> SELECT COUNT(*) AS commande_3001 FROM shop.orders WHERE order_id = 3001;
LOGS_APPLIQUES
--------------
             1

1 row selected.

Database altered.

Database altered.

COMMANDE_3001
-------------
            1

1 row selected.
```

`APPLIED = 'YES'` : les journaux sont appliqués. La commande `3001`, passée sur la production **il y a quelques secondes**, est lisible sur le site de reprise : le RPO est de zéro pour ce scénario.

### 14.6 Le sinistre et la bascule

On éteint brutalement la production : le siège est perdu.

```
SQL> SHUTDOWN ABORT
Database closed.
Database dismounted.
ORACLE instance shut down.
```

Sur le site de reprise, on **promeut** la standby :

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
SQL> ALTER DATABASE FAILOVER TO ORCL;
SQL> ALTER DATABASE OPEN;
SQL> SELECT database_role, open_mode FROM v$database;
SQL> SELECT COUNT(*) AS commande_3001 FROM shop.orders WHERE order_id = 3001;
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.

Database altered.

Database altered.

DATABASE_ROLE OPEN_MODE
------------- ----------
PRIMARY       READ WRITE

1 row selected.

COMMANDE_3001
-------------
            1

1 row selected.
```

`ALTER DATABASE FAILOVER TO ORCL` fait de la standby la **base primaire**, ouverte en `READ WRITE`. La commande `3001` est là : **aucune transaction validée n'a été perdue**. Il ne reste qu'à pointer les frontaux web (`WEB-DR`) sur cette base.

> ⚠️ **Ce que ce scénario ne couvre pas** : la **protection de bout en bout** (`MAXIMUM PROTECTION`, `MAXIMUM AVAILABILITY`) n'est pas appliquée par le simulateur (le mode est stocké et affiché, jamais imposé) et il n'y a pas de *Data Guard Broker* (`DGMGRL`). La standby, elle, est réelle : octets, journaux, rôle et bascule.

---

## 15. Exercices

Chacun se fait dans le lab rouvert (importe `topology.json` pour repartir d'un état propre).

1. **Perte d'un fichier d'index.** Détruis `shop_idx01.dbf` (fichier 6), redémarre en `MOUNT`, restaure-le et récupère-le. Combien de commandes RMAN faut-il ? *Indice : c'est le scénario A pour un autre numéro de fichier.*
2. **Le niveau 1 sert-il à quelque chose ?** Après un niveau 0 et un niveau 1, restaure `SHOP_DATA`. Dans la sortie de `RESTORE`, quelles pièces RMAN lit-il ? *Indice : `LIST BACKUP SUMMARY` et la colonne `LV`.*
3. **Une pièce disparaît.** Supprime à la main (`rm` sur `BKP-HQ`) la pièce du niveau 0, puis lance `CROSSCHECK BACKUP`. Que passe-t-il à son statut ? Que répond `RESTORE DATABASE VALIDATE` ? *Indice : `EXPIRED`, puis `DELETE EXPIRED BACKUP`.*
4. **Retour à une heure plutôt qu'à un SCN.** Refais le scénario C avec `SET UNTIL TIME` au lieu de `SET UNTIL SCN`. *Indice : l'heure se lit dans `SELECT SYSDATE FROM dual` ; le format dépend de `NLS_DATE_FORMAT`.*
5. **Qui a lancé cette sauvegarde ?** Donne à `stagiaire` le groupe `dba` (`usermod -aG dba stagiaire`) et fais-lui lancer `rman target /`. Qu'est-ce qui a changé ? Et dans les journaux de `LOG-HQ` ? *Indice : il faut ouvrir une nouvelle session pour que les groupes soient pris en compte.*
6. **Repartir à zéro.** Après la bascule du scénario D, que faudrait-il faire pour que le siège reconstruit redevienne un site de secours de `ORA-STB` ? *Indice : c'est le même `DUPLICATE`, dans l'autre sens.*
7. **Mesurer ton RTO.** Chronomètre, dans le simulateur, chaque scénario (le temps simulé est indiqué dans les sorties : `elapsed time`). Lequel est le plus long ? Pourquoi ?

---

## 16. Les erreurs que tu rencontreras

| Code | Message | Cause | Solution |
|---|---|---|---|
| `ORA-01157` + `ORA-01110` | cannot identify/lock data file *n* | Le fichier *n* est absent ou illisible | `RESTORE DATAFILE n; RECOVER DATAFILE n` (base en `MOUNT`) |
| `ORA-00376` | file *n* cannot be read at this time | Le tablespace est hors ligne ou le fichier en attente de récupération | `RESTORE TABLESPACE ...; RECOVER TABLESPACE ...;` puis `ONLINE` |
| `ORA-00205` | error in identifying control file | Aucun fichier de contrôle lisible | `STARTUP NOMOUNT` puis `RESTORE CONTROLFILE FROM AUTOBACKUP` |
| `ORA-01589` | must use RESETLOGS or NORESETLOGS option | Récupération incomplète ou fichier de contrôle restauré | `ALTER DATABASE OPEN RESETLOGS` |
| `ORA-01139` | RESETLOGS option only valid after an incomplete database recovery | `OPEN RESETLOGS` sans récupération incomplète | `ALTER DATABASE OPEN` simplement |
| `ORA-01031` | insufficient privileges | L'utilisateur du système n'est pas dans le groupe `dba` | `usermod -aG dba` (en connaissance de cause !) |
| `RMAN-06172` | no autobackup found | `RESTORE CONTROLFILE FROM AUTOBACKUP` sans `SET DBID` ou mauvais format | `SET DBID`, `SET CONTROLFILE AUTOBACKUP FORMAT ... %F` |
| `RMAN-06026` | no backup or copy of the database is available to satisfy the requested SET UNTIL bound | Aucune sauvegarde **antérieure** au SCN demandé | Choisir un SCN plus récent, ou une sauvegarde plus ancienne |
| `RMAN-06023` | no backup found to restore | Le catalogue ne connaît aucune sauvegarde | `LIST BACKUP` ; `CATALOG START WITH '/backup'` |
| `RMAN-06053` / `RMAN-06025` | unable to perform media recovery because of missing log | Un journal est absent **et** introuvable dans une sauvegarde | Vérifier que `BACKUP ARCHIVELOG ... DELETE INPUT` a réussi *avant* de supprimer |
| `RMAN-04005` / `RMAN-00554` | error from target database | La connexion à la cible a échoué (privilèges, instance arrêtée) | Lire **la ligne `ORA-` qui suit** |
| `ORA-00257` | archiver error | La zone d'archivage est pleine | `BACKUP ARCHIVELOG ALL DELETE INPUT` |

> 💡 **Lire une erreur RMAN** : ignore l'encadré `RMAN-00571 / RMAN-00569` (c'est le décor). La **dernière** ligne numérotée dit la vraie raison, et très souvent elle est suivie d'un code `ORA-` qui donne la cause côté base.

---

## 17. Aide-mémoire

**Préparer**

```
sqlplus / as sysdba   ->  @03_archivelog.sql        (ARCHIVELOG + FORCE LOGGING)
rman target /         ->  CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
                          CONFIGURE CONTROLFILE AUTOBACKUP ON;
                          CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
                          CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/backup/%d_%T_%U.bkp';
```

**Sauvegarder**

```
BACKUP DATABASE PLUS ARCHIVELOG TAG '...';
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG '...';
BACKUP INCREMENTAL LEVEL 1 DATABASE TAG '...';
BACKUP ARCHIVELOG ALL DELETE INPUT;
```

**Vérifier**

```
LIST BACKUP SUMMARY;     LIST ARCHIVELOG ALL;     LIST INCARNATION;
REPORT SCHEMA;           REPORT NEED BACKUP;      REPORT OBSOLETE;
VALIDATE DATABASE;       RESTORE DATABASE VALIDATE;
CROSSCHECK BACKUP;       DELETE OBSOLETE NOPROMPT;
```

**Restaurer**

| Panne | Séquence |
|---|---|
| Un datafile, base arrêtée (`MOUNT`) | `RESTORE DATAFILE n; RECOVER DATAFILE n;` puis `ALTER DATABASE OPEN;` |
| Un tablespace, base ouverte | `ALTER TABLESPACE t OFFLINE IMMEDIATE;` → `RESTORE TABLESPACE t; RECOVER TABLESPACE t;` → `ALTER TABLESPACE t ONLINE;` |
| Les fichiers de contrôle | `STARTUP NOMOUNT` → `SET DBID n; SET CONTROLFILE AUTOBACKUP FORMAT ...; RESTORE CONTROLFILE FROM AUTOBACKUP;` → `ALTER DATABASE MOUNT;` → `RECOVER DATABASE;` → `ALTER DATABASE OPEN RESETLOGS;` |
| Retour à un instant | `RUN { SET UNTIL SCN n; RESTORE DATABASE; RECOVER DATABASE; }` → `ALTER DATABASE OPEN RESETLOGS;` |
| Sinistre de site | `DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE ...` (en amont) → `ALTER DATABASE FAILOVER TO ...;` → `ALTER DATABASE OPEN;` |

**Les trois réflexes**

1. **Note le DBID** hors de la base.
2. **Teste la restauration**, pas seulement la sauvegarde.
3. **Après tout `RESETLOGS`, sauvegarde.**

---

## 18. Ce que le simulateur ne fait pas (encore)

Un tutoriel honnête dit où s'arrête son terrain. Voici les écarts mesurés pendant la rédaction ; ceux qui ne sont pas fermés sont consignés dans `TODO.md` :

| Écart | Ce que fait un vrai Oracle | Ce que fait le simulateur |
|---|---|---|
| `BACKUP DATABASE` d'une base ouverte en `NOARCHIVELOG` | Refusé : `RMAN-06149` | Accepté |
| `df -h /backup` | Affiche la taille et l'occupation du volume NFS | Affiche des zéros |
| `touch` sur un fichier NFS qui existe déjà | Met à jour sa date | Ne change rien |
| `sqlplus / as sysdba` lancé par **root** | Refusé si root n'est pas dans `dba` | Accepté (tous les labs tournent en root) |
| `RECOVER DATABASE UNTIL ...` depuis SQL*Plus | Exige ensuite `RESETLOGS` | Seul le `RECOVER` de RMAN le marque |
| `CROSSCHECK BACKUP` / `CROSSCHECK ARCHIVELOG ALL` | Le premier couvre **toutes** les sauvegardes (journaux compris) ; le second contrôle les **fichiers** de journaux archivés | Le premier saute les sauvegardes de journaux ; le second contrôle ces sauvegardes (« 7 objets » au lieu de 9) |
| Protection maximale (`MAXIMUM PROTECTION`) et *broker* | Imposée / géré par `DGMGRL` | Le mode est affiché, jamais imposé ; pas de broker |
| Temps de sauvegarde | Dépend du disque et du réseau | Durées simulées (indicatives) |

---

## 19. Conclusion

Tu as, dans une infrastructure de 35 équipements :

- **préparé** une base pour la sauvegarde (`ARCHIVELOG`, `FORCE LOGGING`) et **configuré** RMAN (rétention, auto-sauvegarde, destination réseau) ;
- **sauvegardé** par niveaux, **planifié** (cron), **journalisé** de façon centrale, **vérifié** (`VALIDATE`, `RESTORE ... VALIDATE`, `CROSSCHECK`) ;
- **réparé** un fichier de données (base arrêtée et base ouverte), **reconstruit** les fichiers de contrôle depuis l'auto-sauvegarde, **remonté le temps** après un `DROP TABLE` ;
- **contrôlé** qui peut lancer une sauvegarde, et vu que chaque refus laisse une trace ;
- **monté** un site de reprise à travers un tunnel IPsec, et **basculé** dessus sans perdre une transaction validée.

Si tu sais refaire ces six gestes sans regarder le tutoriel — et expliquer pourquoi `RESTORE` précède `RECOVER`, pourquoi le DBID se note à l'avance, et pourquoi un site de reprise ne remplace pas une sauvegarde — tu maîtrises le processus.

> 🔁 Le lab est entièrement rejouable : `UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts` refait ce document à partir d'une exécution fraîche.
