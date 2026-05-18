# RMAN de Zéro à Héros : Sauvegarder et Restaurer Oracle comme un Pro

> **À qui s'adresse ce tutoriel ?**
> À toi qui sais à peu près ce qu'est une base Oracle (sinon, fais d'abord un crochet par `docs/tutoriel-oracle.md`) et qui veux apprendre à la sauvegarder, la restaurer, et faire face à un sinistre — sans paniquer. On part vraiment de zéro : tu n'as jamais ouvert RMAN ? Parfait, c'est exactement pour toi. 🛡️

---

## Table des matières

1. [Pourquoi sauvegarder une base de données ?](#1-pourquoi-sauvegarder-une-base-de-données-)
2. [Les concepts clés à connaître avant de toucher à RMAN](#2-les-concepts-clés-à-connaître-avant-de-toucher-à-rman)
3. [Qu'est-ce que RMAN exactement ?](#3-quest-ce-que-rman-exactement-)
4. [L'architecture RMAN en coulisses](#4-larchitecture-rman-en-coulisses)
5. [Les états Oracle et leur impact sur RMAN](#5-les-états-oracle-et-leur-impact-sur-rman)
6. [Présentation de notre laboratoire](#6-présentation-de-notre-laboratoire)
7. [Premier contact : ouvrir RMAN](#7-premier-contact--ouvrir-rman)
8. [Ta première sauvegarde](#8-ta-première-sauvegarde)
9. [Configurer RMAN une bonne fois pour toutes](#9-configurer-rman-une-bonne-fois-pour-toutes)
10. [BACKUP en profondeur](#10-backup-en-profondeur)
11. [Inspecter le catalog : LIST et REPORT](#11-inspecter-le-catalog--list-et-report)
12. [La maintenance du catalog : CROSSCHECK, DELETE, CHANGE, CATALOG](#12-la-maintenance-du-catalog--crosscheck-delete-change-catalog)
13. [RESTORE et RECOVER : remettre la base sur pied](#13-restore-et-recover--remettre-la-base-sur-pied)
14. [Le Point-in-Time Recovery (PITR)](#14-le-point-in-time-recovery-pitr)
15. [Les blocs RUN, les canaux et les scripts](#15-les-blocs-run-les-canaux-et-les-scripts)
16. [DUPLICATE : cloner une base](#16-duplicate--cloner-une-base)
17. [Cas pratiques de bout en bout](#17-cas-pratiques-de-bout-en-bout)
18. [Les erreurs RMAN les plus courantes](#18-les-erreurs-rman-les-plus-courantes)
19. [Aide-mémoire des commandes](#19-aide-mémoire-des-commandes)
20. [Conclusion](#20-conclusion)

---

## 1. Pourquoi sauvegarder une base de données ?

Avant même de parler de RMAN, prenons cinq minutes pour répondre à *la* vraie question : **pourquoi se donner cette peine ?**

### 1.1 Trois scénarios qui finissent mal sans backup

Imagine que tu es DBA dans une banque. Tu rentres lundi matin. Voici trois e-mails dans ta boîte :

| 📧 De | Sujet | Conséquence sans backup |
|---|---|---|
| **Le SysAdmin** | « *Le disque de la baie SAN a lâché cette nuit.* » | Tous les datafiles `users01.dbf`, `sysaux01.dbf`… sont perdus. La base ne démarre plus. |
| **Le développeur junior** | « *J'ai lancé un DROP TABLE par erreur en prod, j'ai cliqué sur OK trop vite, désolé 🙃* » | La table `clients` (12 millions de lignes) n'existe plus. |
| **Le RSSI** | « *Un ransomware a chiffré tout le serveur. On a 48h pour décider de payer ou pas.* » | Tout. Pas juste la base : tout. |

Dans chacun de ces cas, **sans sauvegarde**, c'est game over. Le métier s'arrête, les clients ne peuvent plus retirer d'argent, la banque perd des millions par heure, et toi, tu cherches du travail dès la semaine prochaine. 😬

### 1.2 Ce que doit garantir une stratégie de sauvegarde

Une bonne stratégie répond à **trois objectifs** :

| Objectif | Question | Mesuré par |
|----------|----------|------------|
| **RPO** (Recovery Point Objective) | « Combien de minutes de données accepte-t-on de perdre ? » | Fréquence des backups + archivelog |
| **RTO** (Recovery Time Objective) | « Combien de temps tolère-t-on que la base soit down ? » | Stratégie de restore + bande passante |
| **Rétention** | « Combien de temps garde-t-on les vieilles sauvegardes ? » | Politique légale + coût stockage |

> 💡 **Exemple concret** :
> Une banque exige *RPO = 0* (zéro perte), *RTO = 15 min*, rétention 7 ans pour le fisc. Une boutique en ligne tolère *RPO = 1h*, *RTO = 4h*, rétention 30 jours.

### 1.3 Et c'est là que RMAN entre en scène

RMAN (**R**ecovery **MAN**ager) est l'outil **officiel d'Oracle** pour faire des sauvegardes intelligentes, fiables et restaurables. Il sait :

- Sauvegarder à chaud (sans arrêter la base) ✅
- Ne sauvegarder *que les blocs modifiés* depuis la dernière fois (incrémentiel)
- Vérifier l'intégrité de ce qu'il a sauvegardé
- Restaurer jusqu'à un instant précis dans le passé (au SCN près !)
- Gérer automatiquement la rétention (supprimer les vieux backups obsolètes)
- Tout ça en parallèle sur plusieurs canaux pour aller vite

Bref, c'est le couteau suisse de la sauvegarde Oracle. Et c'est ce qu'on va apprendre à manier ensemble. 🔧

---

## 2. Les concepts clés à connaître avant de toucher à RMAN

Avant d'attaquer la ligne de commande, six notions à avoir en tête. Pas plus. Promis.

### 2.1 Datafile, redo log, archivelog, control file — qui fait quoi ?

Une base Oracle, physiquement, ce sont trois familles de fichiers :

```
                ┌─────────────────────────────────────┐
                │      BASE DE DONNÉES ORACLE         │
                └─────────────────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
   DATAFILES             REDO LOGS              CONTROL FILES
  (les données)        (les changements)      (la carte d'identité)
       │                      │                      │
  system01.dbf            redo01.log              control01.ctl
  sysaux01.dbf            redo02.log
  users01.dbf             redo03.log
  undotbs01.dbf
```

| Fichier | Rôle | Analogie |
|---|---|---|
| **Datafile** | Les vraies données : tables, index, procédures | Le grand livre comptable 📚 |
| **Redo log** | Journal de TOUTES les modifs (avant écriture sur datafile) | Le brouillon de notes du comptable ✍️ |
| **Archivelog** | Une copie *archivée* d'un redo log déjà rempli | Les anciens brouillons rangés dans un classeur 📦 |
| **Control file** | L'index : noms/chemins/SCN de tous les fichiers | La page de titre du grand livre |

> 🔑 **Pourquoi c'est important pour les backups ?**
> RMAN sauvegarde **les trois** : datafiles, control file, et archivelogs. Sans datafile, pas de données. Sans control file, Oracle ne sait pas où sont les datafiles. Sans archivelogs, impossible de restaurer à un instant T entre deux backups.

### 2.2 Le SCN — l'horloge logique d'Oracle

**SCN** = **S**ystem **C**hange **N**umber. C'est un compteur qui s'incrémente à *chaque* modification de la base. Tu peux le voir comme l'horloge interne d'Oracle.

```
T1 : INSERT INTO clients VALUES (...);   → SCN = 1_000_001
T2 : UPDATE comptes SET solde = ...;     → SCN = 1_000_002
T3 : COMMIT;                             → SCN = 1_000_003
T4 : DROP TABLE produits;  ← OUPS 😱      → SCN = 1_000_004
```

> 🎯 **Le truc puissant** : RMAN peut restaurer la base **jusqu'au SCN 1_000_003**, c'est-à-dire *juste avant la bêtise*. C'est ça, le point-in-time recovery.

### 2.3 Hot backup vs cold backup

| Type | Base ouverte ? | Service interrompu ? | Quand ? |
|---|---|---|---|
| **Hot** (à chaud) | OUI, OPEN | NON, transparent | Production 24/7 |
| **Cold** (à froid) | NON, SHUTDOWN | OUI, fenêtre maintenance | Test, dev, base archivée |

RMAN sait faire les deux. En prod, on fait **toujours du hot backup**. C'est sa raison d'être.

### 2.4 Full vs incremental

| Type | Quoi | Taille | Fréquence |
|---|---|---|---|
| **Full (LEVEL 0)** | Tous les blocs de la base | 100 % (lourd) | 1 fois par semaine |
| **Differential L1** | Blocs modifiés depuis le **dernier L0/L1** | ~5-10 % | Tous les jours |
| **Cumulative L1** | Blocs modifiés depuis le **dernier L0** | ~10-30 % | Variante de L1 |

> 💡 **Analogie** : Si tu déménages tous tes meubles le lundi (FULL), ensuite tu n'as plus qu'à transporter les nouveaux achats chaque jour (DIFFERENTIAL), ou tous les achats depuis lundi (CUMULATIVE).

### 2.5 Le catalog RMAN

RMAN tient un **catalog** : un inventaire de tous les backups qu'il a faits (chemins, dates, tags, tailles, SCN de checkpoint…). Deux variantes :

| Variante | Où | Quand |
|---|---|---|
| **Control file** | Dans le control file de la base elle-même | Petites/moyennes bases, mono-instance |
| **Recovery catalog** | Dans une base Oracle séparée dédiée | Multi-instances, multi-sites, audit |

Dans le sandbox, le catalog est **en mémoire** (rattaché à la session). Pour un vrai Oracle de prod, on utilise généralement le control file ou un recovery catalog distant.

### 2.6 Rétention : REDUNDANCY vs RECOVERY WINDOW

Comment RMAN décide qu'un backup est *obsolète* (à supprimer) ?

| Politique | Logique | Exemple |
|---|---|---|
| **REDUNDANCY n** | Garde les **n derniers** backups, supprime le reste | `REDUNDANCY 2` → garde les 2 derniers |
| **RECOVERY WINDOW n DAYS** | Garde tout ce qui permet de restaurer **n jours en arrière** | `RECOVERY WINDOW OF 7 DAYS` → tout ce qu'il faut pour PITR sur 7j |
| **NONE** | Ne supprime jamais rien (tu gères à la main) | À éviter en prod |

> 🔑 **Recommandation** : pour la prod, `RECOVERY WINDOW OF 7 DAYS` (ou 30 selon le métier) est la valeur saine.

---

## 3. Qu'est-ce que RMAN exactement ?

**RMAN** (Recovery Manager) est un **client en ligne de commande** fourni avec Oracle Database depuis Oracle 8 (1997). Il se connecte à une instance Oracle et orchestre les sauvegardes via les processus Oracle eux-mêmes — il n'écrit pas directement sur les disques de données.

### 3.1 Un peu d'histoire

| Année | Version Oracle | Apport RMAN |
|---|---|---|
| 1997 | Oracle 8 | Naissance de RMAN — backup/recovery au niveau bloc |
| 2001 | Oracle 9i | Incrémentiel, parallélisme, compression basique |
| 2003 | Oracle 10g | Block change tracking, DUPLICATE, flashback |
| 2007 | Oracle 11g | Compression avancée, encryption, active database duplication |
| 2013 | Oracle 12c | Multi-section backup, container/pluggable databases, SQL command |
| 2019 | Oracle 19c | Stable LTS — c'est ce qu'on simule ici ✅ |

### 3.2 Ce que RMAN sait faire (et qu'un script bash ne sait pas faire)

- **Backup à chaud** sans verrouiller la base
- **Backup incrémentiel intelligent** (lit le SCN de chaque bloc et ne copie que ceux modifiés)
- **Vérification d'intégrité** : à chaque lecture/écriture, contrôle de checksum (DBV intégré)
- **Restauration au SCN/timestamp près**
- **Parallélisme** : 4, 8, 16 canaux simultanés vers des disques différents
- **Compression et chiffrement** transparents
- **Catalog persistant** : tu peux interroger l'historique
- **Optimisation** : ne re-sauvegarde pas les datafiles qui n'ont pas bougé (`BACKUP OPTIMIZATION ON`)
- **DUPLICATE** : cloner une base entière vers une autre instance pour faire un standby/test

### 3.3 Ce que RMAN n'est pas

- **Pas une sauvegarde au sens fichier** : RMAN ne lit pas les `.dbf` au niveau OS. Il dialogue avec l'instance Oracle pour récupérer les blocs cohérents.
- **Pas un orchestrateur** : il ne planifie pas les jobs (utilise cron, Oracle Scheduler ou un outil tiers).
- **Pas une solution de réplication temps réel** : pour ça, c'est **Data Guard**.

---

## 4. L'architecture RMAN en coulisses

Voyons ce qui se passe vraiment quand tu tapes `BACKUP DATABASE`.

### 4.1 Les acteurs en présence

```
   ┌──────────┐         ┌───────────────────────┐
   │ Toi      │  CLI    │  RMAN Client          │
   │ (DBA)    │──────►  │  (rman target /)      │
   └──────────┘         └───────┬───────────────┘
                                │
                                │ SQL*Net
                                ▼
                        ┌───────────────┐
                        │  TARGET DB    │
                        │  (Oracle      │
                        │   Instance)   │
                        └───┬─────┬─────┘
                            │     │
                            │     │ allocate channels
                            ▼     ▼
                       ┌─────────┐   ┌─────────┐
                       │CHANNEL 1│   │CHANNEL 2│  ← processus
                       │ORA_DISK1│   │ORA_DISK2│    serveurs
                       └────┬────┘   └────┬────┘
                            │             │
                ┌───────────┴────┐  ┌─────┴──────────┐
                │ DATAFILES      │  │ BACKUP PIECES  │
                │ (lecture)      │  │ (écriture)     │
                └────────────────┘  └────────────────┘
```

| Acteur | Rôle |
|---|---|
| **Client RMAN** | Parse tes commandes, dialogue avec l'instance |
| **Target database** | L'instance Oracle qu'on sauvegarde |
| **Channels** | Sous-processus serveur (un par lien I/O) qui font le vrai travail |
| **Backup piece** | Le fichier de sortie (un `.bkp` ou plusieurs en cas de `MAXPIECESIZE`) |
| **Catalog** | L'inventaire (control file ou recovery catalog) |

### 4.2 Le cycle de vie d'un job

Quand tu tapes `BACKUP DATABASE`, voici ce qui se passe :

```
   1. Parse                  RMAN traduit ta commande en plan d'exécution
        │
        ▼
   2. Allocate channel       Un ou plusieurs processus serveur démarrent
        │
        ▼
   3. Read datafiles         Le canal lit les blocs (Buffer Cache si possible)
        │
        ▼
   4. Check integrity        Chaque bloc est validé (checksum)
        │
        ▼
   5. Write backup piece     Le canal écrit le .bkp (compressé si demandé)
        │
        ▼
   6. Update catalog         Le backup set est enregistré dans le catalog
        │
        ▼
   7. Release channel        Le processus serveur se termine
```

> 💡 **Analogie** : Imagine un déménagement. **Toi** (RMAN client) tu dis « *On charge le camion ce matin* ». **Les déménageurs** (channels) montent les meubles (datafiles) dans le camion (backup pieces). Le **chef d'équipe** (catalog) note dans son carnet *quel camion contient quoi*. Quand tu auras besoin de remettre les meubles, le chef d'équipe saura exactement où aller chercher. 🚚

### 4.3 Le format d'une backup piece

Une backup piece, c'est un fichier (par défaut sous `$ORACLE_HOME/dbs/` ou la `FAST_RECOVERY_AREA`) avec un nom du genre :

```
ORCL_jppjc4qu_1_1.bkp
│    │        │ │
│    │        │ └── numéro de copie (si plusieurs copies du même set)
│    │        └──── numéro de piece dans le set (si MAXPIECESIZE)
│    └───────────── identifiant unique généré par RMAN
└────────────────── nom de la base
```

À l'intérieur : des blocs Oracle binaires, dans un format propriétaire. **Inutile d'essayer de l'éditer à la main** — seul RMAN sait le relire.

---

## 5. Les états Oracle et leur impact sur RMAN

C'est **la** notion qui fait dérailler les débutants. RMAN ne peut pas tout faire dans n'importe quel état.

### 5.1 Rappel express des 4 états

```
SHUTDOWN ──startup──► NOMOUNT ──mount──► MOUNT ──open──► OPEN
   ▲                                                       │
   └───────────────── shutdown immediate ──────────────────┘
```

| État | Ce qui est vivant | Ce qui ne l'est pas |
|---|---|---|
| **SHUTDOWN** | Rien | Tout |
| **NOMOUNT** | SGA + processus background | Control file pas lu |
| **MOUNT** | + control file lu, datafiles localisés | Datafiles pas ouverts |
| **OPEN** | + datafiles + redo logs ouverts | (tout fonctionne) |

### 5.2 La matrice de compatibilité RMAN

| État → | SHUTDOWN | NOMOUNT | MOUNT | OPEN |
|---|---|---|---|---|
| `CONNECT TARGET` | ❌ RMAN-04014 | ✅ | ✅ | ✅ |
| `BACKUP DATABASE` | ❌ | ❌ | ✅ | ✅ |
| `RESTORE DATABASE` | ❌ | ❌ | ✅ | ❌ **RMAN-06403** |
| `RECOVER DATABASE` | ❌ | ❌ | ✅ | ✅ |
| `DUPLICATE` | ❌ | ❌ | ✅ | ✅ |

> ⚠️ **Le piège classique** : tu veux restaurer une base en pleine prod, tu tapes `RESTORE DATABASE` sans réfléchir → `RMAN-06403: database must be mounted (not open)`. Il faut **d'abord** descendre à `MOUNT` :
> ```sql
> SQL> SHUTDOWN IMMEDIATE
> SQL> STARTUP MOUNT
> ```

> 🎯 **Dans le sandbox** : un acteur réactif (`OracleInstanceWatcherActor`) observe l'instance Oracle sur le bus partagé. Si tu fais un `SHUTDOWN IMMEDIATE` depuis `sqlplus` pendant que `rman` tourne, **la session RMAN est automatiquement coupée** — comme dans la vraie vie quand le serveur perd sa connexion réseau.

---

## 6. Présentation de notre laboratoire

Construisons un labo simple pour les exercices.

### 6.1 Le schéma

```
    ┌────────────────────────────────────┐
    │  oracle-srv-A   (LinuxServer)      │
    │  10.0.0.10/24                      │
    │                                    │
    │  ┌──────────────────────────────┐  │
    │  │  Oracle 19c — DB "ORCL"      │  │
    │  │  /u01/app/oracle/oradata/ORCL│  │
    │  │  /u01/backup/                │  │
    │  └──────────────────────────────┘  │
    └────────────────────────────────────┘
```

### 6.2 Mise en place dans le simulateur

1. Glisse un **LinuxServer** sur le canvas, renomme-le `oracle-srv-A`.
2. Ouvre son terminal (double-clic).
3. La première fois que tu tapes `sqlplus` ou `rman`, Oracle démarre automatiquement en `OPEN` avec une base nommée `ORCL`. Magique. 🪄

### 6.3 Vérifier qu'Oracle tourne

```bash
oracle@oracle-srv-A:~$ sqlplus / as sysdba
SQL> SELECT status FROM v$instance;

STATUS
------------
OPEN

SQL> exit
```

Si tu vois `OPEN`, tout est prêt pour la suite. 👍

---

## 7. Premier contact : ouvrir RMAN

Depuis le terminal Linux, tape simplement :

```bash
oracle@oracle-srv-A:~$ rman target /
```

Et là, magie de l'Oracle :

```
Recovery Manager: Release 19.0.0.0.0 - Production on 17-MAY-2026 14:23:01

Copyright (c) 1982, 2024, Oracle and/or its affiliates.  All rights reserved.

connected to target database: ORCL (DBID=1234567890)

RMAN>
```

🎉 Tu es dans RMAN. Le prompt est `RMAN>` (au lieu de `SQL>`). On parle un autre langage maintenant — pas du SQL pur, mais des commandes RMAN.

### 7.1 Comprendre la commande de lancement

```bash
rman    target    /
 │        │       │
 │        │       └── credentials : "/" = OS authentication (sysdba)
 │        └────────── on se connecte à la "target database" (celle à sauvegarder)
 └─────────────────── le binaire RMAN
```

Variantes courantes :

```bash
rman target sys/manager@ORCL            # via TNS
rman target /                           # OS auth (le plus simple en local)
rman target / catalog rman/rman@RCAT    # avec recovery catalog distant
rman target / nocatalog                 # explicit : pas de catalog
```

### 7.2 Premier coup d'œil : que sait RMAN faire ?

```rman
RMAN> HELP
```

Tu verras la liste de toutes les commandes (`BACKUP`, `RESTORE`, `RECOVER`, `LIST`, `REPORT`, `CONFIGURE`, `SHOW`, etc.). On va toutes les voir, sans exception.

### 7.3 Sortir proprement

```rman
RMAN> EXIT
Recovery Manager complete.
```

Ou `QUIT`, ou `Ctrl+D`. C'est équivalent.

---

## 8. Ta première sauvegarde

Sans plus attendre : sauvegardons la base entière. **Une seule commande.**

```rman
RMAN> BACKUP DATABASE;
```

### 8.1 Ce que tu vas voir défiler

```
Starting backup at 17-MAY-2026 14:25:01
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=142 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/u01/backup/ORCL_jppjc4qu_1_1.bkp tag=TAG20260517T142501
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15
Finished backup at 17-MAY-2026 14:25:16
```

🎊 **Bravo, ta base est sauvegardée.** Lis ces lignes avec moi :

| Ligne | Sens |
|---|---|
| `Starting backup at …` | Top départ |
| `allocated channel: ORA_DISK_1` | RMAN a créé un canal vers le disque |
| `SID=142 device type=DISK` | Détails techniques du processus serveur |
| `starting full datafile backup set` | On commence un *full* (pas un incrémentiel) |
| `specifying datafile(s)…` | RMAN choisit quels fichiers entrent dans ce backup set |
| `backing up database` | Lecture + écriture en cours |
| `piece handle=…` | Le chemin du fichier généré + son `tag` |
| `backup set complete` | Le set est complet (1 piece dans ce cas) |
| `Finished backup at …` | Top arrivée |

### 8.2 Vérifier ce qu'on vient de faire

```rman
RMAN> LIST BACKUP SUMMARY;

List of Backups
===============
Key     TY LV S Device Type Completion Time     #Pieces #Copies Compressed Tag
------- -- -- - ----------- ------------------- ------- ------- ---------- ---
1       B  F  A DISK        17-MAY-2026 14:25:16  1       1       NO         TAG20260517T142501
```

Décortique cette ligne :

| Colonne | Sens |
|---|---|
| `Key` | bsKey = identifiant interne du backup set |
| `TY` | Type : `B` = backupset |
| `LV` | Level : `F` = Full (sinon `0`, `1`, `A` pour archivelog) |
| `S` | Status : `A` = Available |
| `Device Type` | DISK ou SBT (tape) |
| `Completion Time` | Quand le set est devenu utilisable |
| `Tag` | Étiquette auto-générée (ou celle que tu as fournie) |

### 8.3 Et physiquement, où est le fichier ?

Quitte RMAN un instant et va voir :

```bash
RMAN> EXIT

oracle@oracle-srv-A:~$ ls -la /u01/backup/
total 8
drwxr-xr-x 2 oracle dba 4096 May 17 14:25 .
drwxr-xr-x 4 oracle dba 4096 May 17 14:24 ..
-rw-r----- 1 oracle dba 1024 May 17 14:25 ORCL_jppjc4qu_1_1.bkp
```

> 💡 **Dans le sandbox**, le contenu de la backup piece est un marqueur textuel (genre `[ORACLE RMAN BACKUP PIECE - 1500000 bytes]`) — on simule le métadonnée, pas les vrais blocs binaires. La logique RMAN (catalog, restore, recovery) marche identiquement.

### 8.4 Un backup, et après ?

C'est bien beau d'avoir un backup, mais il faut **aussi** sauvegarder :
- Les **archivelogs** (sinon, pas de PITR)
- Le **control file** (sinon, pas moyen de restaurer)

La commande qui fait *tout d'un coup* :

```rman
RMAN> BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
```

| Mot | Effet |
|---|---|
| `BACKUP DATABASE` | Sauve les datafiles |
| `PLUS ARCHIVELOG` | …puis enchaîne avec un BACKUP ARCHIVELOG ALL |
| `DELETE INPUT` | …et supprime les redo logs archivés une fois sauvegardés (libère de la place) |

> 🎯 **C'est la commande "Saint Graal" du backup quotidien.** Apprends-la par cœur.

---

## 9. Configurer RMAN une bonne fois pour toutes

Plutôt que de répéter les mêmes options à chaque `BACKUP`, on les fixe une fois pour toutes avec `CONFIGURE`. C'est persistant : ça survit aux redémarrages.

### 9.1 Voir la configuration actuelle

```rman
RMAN> SHOW ALL;

RMAN configuration parameters for database with db_unique_name ORCL are:
CONFIGURE RETENTION POLICY TO REDUNDANCY 1;
CONFIGURE BACKUP OPTIMIZATION OFF;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '%F';
CONFIGURE DEVICE TYPE DISK PARALLELISM 1 BACKUP TYPE TO BACKUPSET;
CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE DISK TO 1;
CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE DISK TO 1;
CONFIGURE MAXSETSIZE TO UNLIMITED;
CONFIGURE ENCRYPTION FOR DATABASE OFF;
CONFIGURE ENCRYPTION ALGORITHM 'AES128';
CONFIGURE COMPRESSION ALGORITHM 'BASIC' AS OF RELEASE 'DEFAULT' OPTIMIZE FOR LOAD TRUE;
CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;
```

C'est dense, mais lisons calmement.

### 9.2 Les réglages clés à connaître

#### 🟢 Rétention

```rman
RMAN> CONFIGURE RETENTION POLICY TO REDUNDANCY 2;
-- "garde les 2 derniers backups, jette les vieux"

RMAN> CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
-- "garde tout ce qu'il faut pour restaurer 7 jours en arrière"

RMAN> CONFIGURE RETENTION POLICY TO NONE;
-- "garde tout, à toi de gérer"  ⚠️ pas recommandé en prod
```

#### 🟢 Autobackup du control file

Très important :

```rman
RMAN> CONFIGURE CONTROLFILE AUTOBACKUP ON;
```

Avec ça, **après chaque BACKUP**, RMAN sauve aussi le control file et le spfile. Sans ça, si tu perds ton control file, tu es coincé. **À activer toujours.** ✅

#### 🟢 Parallélisme

```rman
RMAN> CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET;
```

→ Désormais, chaque `BACKUP` utilisera 4 canaux en parallèle (4× plus rapide si tu as 4 disques).

#### 🟢 Compression

```rman
RMAN> CONFIGURE COMPRESSION ALGORITHM 'MEDIUM';
-- BASIC (gratuit, peu rapide) | LOW | MEDIUM | HIGH (Advanced Compression Option)
```

#### 🟢 Chiffrement

```rman
RMAN> CONFIGURE ENCRYPTION FOR DATABASE ON;
RMAN> CONFIGURE ENCRYPTION ALGORITHM 'AES256';
```

#### 🟢 Format des fichiers de backup

```rman
RMAN> CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/backup/%d_%T_%U.bkp';
```

Les *substitutions* :

| Token | Sens |
|---|---|
| `%d` | nom de la DB |
| `%T` | date YYYYMMDD |
| `%U` | suffixe unique |
| `%s` | numéro de set |
| `%p` | numéro de piece |
| `%F` | `c-<dbid>-<date>-<seq>` (usuel pour autobackup CF) |

#### 🟢 Politique de suppression des archivelogs

```rman
RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
-- Ne supprime un archivelog que quand le standby l'a appliqué

RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 2 TIMES TO DEVICE TYPE DISK;
-- Garde jusqu'à 2 backups
```

### 9.3 Une configuration "standard prod" recommandée

```rman
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u01/backup/cf_%F.bkp';
CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET;
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/backup/%d_%T_%U.bkp';
CONFIGURE COMPRESSION ALGORITHM 'MEDIUM';
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
```

Tape-la, puis `SHOW ALL` — tu verras tout enregistré. 👌

### 9.4 SHOW ciblé

Si tu ne veux que voir une option :

```rman
RMAN> SHOW RETENTION POLICY;
RMAN> SHOW DEFAULT DEVICE TYPE;
RMAN> SHOW CONTROLFILE AUTOBACKUP;
RMAN> SHOW CHANNEL;
```

---

## 10. BACKUP en profondeur

`BACKUP DATABASE` n'est que la pointe de l'iceberg. Voyons toute la palette.

### 10.1 Le menu — sauvegarder quoi ?

```rman
BACKUP DATABASE;                       -- toute la base
BACKUP TABLESPACE USERS;               -- un tablespace
BACKUP TABLESPACE SYSTEM, USERS;       -- plusieurs
BACKUP DATAFILE 4;                     -- un datafile précis
BACKUP SPFILE;                         -- le fichier de paramètres serveur
BACKUP CURRENT CONTROLFILE;            -- le control file manuel
BACKUP ARCHIVELOG ALL;                 -- tous les archivelogs
BACKUP ARCHIVELOG FROM SCN 1000000;    -- depuis un SCN
```

### 10.2 Les sauvegardes incrémentielles

Pour économiser temps et espace :

```rman
-- Dimanche soir : baseline
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_BASE';

-- Lundi-vendredi : différentiel
BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DAILY_DIFF';

-- Variante cumulative (plus lourd mais restore plus rapide)
BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'DAILY_CUM';
```

> 💡 **Différentiel vs Cumulatif** :
> - **Différentiel L1** = blocs modifiés depuis le **dernier L0 ou L1** → fichiers plus petits, mais restore = `L0 + L1[mar] + L1[mer] + L1[jeu]…`
> - **Cumulatif L1** = blocs modifiés depuis le **dernier L0** → fichiers plus gros, mais restore = `L0 + L1[jeu]` (un seul L1)

### 10.3 Les options qui font la différence

Toutes ces clauses se combinent. C'est ça qui rend `BACKUP` si puissant :

```rman
BACKUP DATABASE
  TAG 'WEEKLY_FULL'                    -- étiquette (en majuscules en interne)
  FORMAT '/u01/backup/%d_%T_%U.bkp'    -- chemin custom
  COMPRESSED                           -- compression activée
  ENCRYPTED                            -- chiffrement activé
  MAXPIECESIZE 200M                    -- découpe en pieces de 200 Mo max
  KEEP FOREVER                         -- exempt de retention policy
  PLUS ARCHIVELOG DELETE INPUT;        -- enchaîne avec backup archivelog
```

| Clause | Quand t'en servir |
|---|---|
| `TAG 'X'` | Toujours — pour retrouver tes backups par nom |
| `FORMAT '…'` | Si tu veux ranger les fichiers dans une arborescence précise |
| `COMPRESSED` | Si tu manques d'espace de backup |
| `ENCRYPTED` | Si les backups partent sur cloud / hors-site |
| `MAXPIECESIZE 4G` | Pour respecter une limite de taille de fichier (vieux file systems) |
| `KEEP FOREVER` | Archive légale (rétention 10 ans) |
| `KEEP UNTIL TIME '…'` | Conservation jusqu'à une date donnée |
| `PLUS ARCHIVELOG` | Quand tu veux les redo en plus dans la même opération |
| `DELETE INPUT` | (archivelog) libère le FRA après sauvegarde |
| `NOT BACKED UP n TIMES` | Backup *optimization* : ne re-sauve pas un fichier déjà sauvegardé n fois |

### 10.4 BACKUP VALIDATE et VALIDATE — vérifier sans écrire

```rman
RMAN> BACKUP VALIDATE DATABASE;        -- forme legacy
RMAN> VALIDATE DATABASE;               -- forme moderne 12c+
RMAN> VALIDATE TABLESPACE USERS;
RMAN> VALIDATE DATAFILE 4;
RMAN> VALIDATE BACKUPSET 7;            -- vérifie une backup-set existante
```

Aucun fichier n'est écrit. C'est *lis tout, vérifie les checksums, signale les corruptions*. À programmer une fois par semaine sur les bases critiques.

### 10.5 Exemples typiques

```rman
-- Quotidien classique
BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;

-- Quotidien optimisé (compressé + incrémentiel)
BACKUP INCREMENTAL LEVEL 1 DATABASE COMPRESSED PLUS ARCHIVELOG DELETE INPUT;

-- Sauvegarde mensuelle long-terme
BACKUP DATABASE KEEP FOREVER TAG 'MONTHLY_ARCHIVE';

-- Sauvegarde sécurisée pour le cloud
BACKUP DATABASE ENCRYPTED COMPRESSED FORMAT '/u01/cloud/%d_%T_%U.enc';

-- Re-sauvegarder uniquement ce qui manque (gain de temps énorme)
BACKUP NOT BACKED UP 1 TIMES DATABASE;
```

---

## 11. Inspecter le catalog : LIST et REPORT

Le catalog est ton inventaire. Tu dois savoir l'interroger.

### 11.1 LIST — la vue brute

```rman
LIST BACKUP;                       -- détaillé (BS + pieces + datafiles)
LIST BACKUP SUMMARY;               -- une ligne par set
LIST ARCHIVELOG ALL;
LIST EXPIRED BACKUP;               -- pieces marquées EXPIRED par CROSSCHECK
LIST OBSOLETE;                     -- selon la retention policy active
LIST COPY;                         -- image copies + datafile copies
LIST COPY OF DATABASE;
LIST COPY OF TABLESPACE USERS;
LIST INCARNATION OF DATABASE;      -- historique des resetlogs
LIST DB_UNIQUE_NAME OF DATABASE;
LIST SCRIPT NAMES;                 -- scripts stockés
```

### 11.2 Le format détaillé

```rman
RMAN> LIST BACKUP;

List of Backup Sets
===================
BS Key  Type LV Size       Device Type Elapsed Time Completion Time
------- ---- -- ---------- ----------- ------------ ---------------
1       Full    1.43G      DISK        00:00:15     17-MAY-2026 14:25:16
        BP Key: 1   Status: AVAILABLE  Compressed: NO  Encrypted: NO  Tag: TAG20260517T142501
          Piece Name: /u01/backup/ORCL_jppjc4qu_1_1.bkp
  List of Datafiles in backup set 1
  File LV Type Ckp SCN    Ckp Time        Name
  ---- -- ---- ---------- --------------- ----
     1    Full 1892354    17-MAY-2026 14:25:01  /u01/app/oracle/oradata/ORCL/system01.dbf
     2    Full 1892354    17-MAY-2026 14:25:01  /u01/app/oracle/oradata/ORCL/sysaux01.dbf
     ...
```

### 11.3 REPORT — la vue analytique

`REPORT` répond à des **questions DBA précises** :

```rman
RMAN> REPORT SCHEMA;
-- "Donne-moi la liste de tous les datafiles, leur taille, leur tablespace"

RMAN> REPORT NEED BACKUP;
-- "Quels fichiers n'ont pas de backup récent (selon la retention) ?"

RMAN> REPORT NEED BACKUP REDUNDANCY 2;
-- "…en supposant qu'on veut 2 backups"

RMAN> REPORT NEED BACKUP RECOVERY WINDOW OF 7 DAYS;
-- "…en supposant une recovery window de 7 jours"

RMAN> REPORT OBSOLETE;
-- "Quels backups peuvent être supprimés selon la retention ?"

RMAN> REPORT OBSOLETE REDUNDANCY 1;
RMAN> REPORT OBSOLETE RECOVERY WINDOW OF 3 DAYS;

RMAN> REPORT UNRECOVERABLE;
-- "Quels datafiles ont des opérations NOLOGGING non sauvegardées ?"
```

> 💡 **Workflow typique** :
> ```rman
> REPORT NEED BACKUP;   -- "qu'est-ce que je dois sauver ?"
> BACKUP DATABASE;      -- (action)
> REPORT OBSOLETE;      -- "qu'est-ce que je peux supprimer ?"
> DELETE NOPROMPT OBSOLETE;
> ```

---

## 12. La maintenance du catalog : CROSSCHECK, DELETE, CHANGE, CATALOG

Avec le temps, le catalog et les fichiers physiques peuvent se désynchroniser. Quatre commandes pour gérer ça.

### 12.1 CROSSCHECK — vérifier la cohérence catalog ↔ disque

```rman
RMAN> CROSSCHECK BACKUP;
-- Pour chaque backup piece du catalog, vérifie qu'elle existe sur le VFS.
-- Si elle n'existe plus → marquée EXPIRED.

RMAN> CROSSCHECK ARCHIVELOG ALL;
```

> 🎯 **Usage** : à programmer toutes les semaines, surtout si tes backups sont sur NFS / cloud (risque que des fichiers disparaissent).

### 12.2 DELETE — supprimer pour de bon

```rman
DELETE NOPROMPT EXPIRED BACKUP;
-- Supprime les pieces marquées EXPIRED par CROSSCHECK (= catalog uniquement)

DELETE NOPROMPT OBSOLETE;
-- Supprime selon la retention policy active

DELETE NOPROMPT OBSOLETE REDUNDANCY 1;
DELETE NOPROMPT OBSOLETE RECOVERY WINDOW OF 1 DAYS;

DELETE NOPROMPT BACKUP TAG 'WEEKLY_OLD';
-- Supprime tous les sets avec un tag donné

DELETE NOPROMPT BACKUPSET 7;
-- Supprime un set par bsKey (vu dans LIST BACKUP SUMMARY)

DELETE NOPROMPT ARCHIVELOG ALL;
-- Supprime tous les archivelogs (libère le FRA)
```

> ⚠️ Le `NOPROMPT` évite la confirmation interactive. **Toujours** l'utiliser dans les scripts automatisés.

### 12.3 CHANGE — modifier la disponibilité

```rman
CHANGE BACKUPSET 7 UNAVAILABLE;
-- "ce backup existe encore mais ne l'utilise pas pour restaurer"

CHANGE BACKUPSET 7 AVAILABLE;
-- "OK, il est de nouveau utilisable"

CHANGE BACKUP TAG 'WEEKLY_OLD' DELETE;
-- Alias pour DELETE BACKUP TAG
```

> 💡 **Usage** : tu déplaces les vieux backups sur une bande lente. Tu les marques `UNAVAILABLE` pour que RMAN ne tente pas de les lire depuis le disque rapide.

### 12.4 CATALOG — enregistrer un fichier existant

Imagine que tu as copié manuellement un `users01.dbf` depuis un autre serveur. RMAN ne le connaît pas. Pour qu'il puisse l'utiliser :

```rman
CATALOG DATAFILECOPY '/u01/copies/users01.dbf';
CATALOG BACKUPPIECE  '/u01/backup/external_001.bkp';
```

RMAN vérifie que le fichier existe (sinon `RMAN-06004`) et l'ajoute à son inventaire.

---

## 13. RESTORE et RECOVER : remettre la base sur pied

C'est **le** moment de vérité. Sans backup, pas de restore. Avec backup mais sans archivelog, restore tronqué. Le tout, c'est de bien préparer l'état Oracle.

### 13.1 La séquence canonique d'une restauration

```
1. SHUTDOWN IMMEDIATE          (en sqlplus)
2. STARTUP MOUNT               (en sqlplus, monte mais n'ouvre pas)
3. RESTORE DATABASE            (en rman, copie les datafiles depuis le backup)
4. RECOVER DATABASE            (en rman, applique les redo/archivelogs)
5. ALTER DATABASE OPEN         (en sqlplus, base accessible)
```

Si tu fais un PITR, ajoute `RESETLOGS` à la fin (étape 5).

### 13.2 RESTORE — récupérer les datafiles

```rman
RESTORE DATABASE;                  -- toute la base
RESTORE TABLESPACE USERS;          -- un tablespace
RESTORE DATAFILE 4;                -- un datafile
RESTORE DATABASE FROM TAG 'WEEKLY_BASE';  -- depuis un backup précis
RESTORE DATABASE PREVIEW;          -- "que vas-tu faire ?" sans rien restaurer
RESTORE DATABASE VALIDATE;         -- vérifie l'intégrité du backup
```

> ⚠️ Si tu lances `RESTORE DATABASE` quand la base est `OPEN`, tu obtiens :
> ```
> RMAN-06403: database must be mounted (not open)
> ```
> Descends à `MOUNT` d'abord (`SHUTDOWN IMMEDIATE; STARTUP MOUNT;`).

### 13.3 RECOVER — réappliquer les changements

Le restore te ramène à *l'état du backup*. Mais entre le moment du backup et celui du crash, il y a eu des transactions ! Pour les rejouer :

```rman
RECOVER DATABASE;
-- Applique tous les archivelogs + redo logs disponibles → état le plus récent

RECOVER DATABASE UNTIL SCN 1900000;
-- Stop au SCN donné

RECOVER DATABASE UNTIL TIME '2026-06-01 12:00:00';
-- Stop à la date donnée

RECOVER DATABASE UNTIL CANCEL;
-- Mode interactif : à toi de taper "CANCEL" pour stopper

RECOVER TABLESPACE USERS;
RECOVER DATAFILE 4;
```

### 13.4 Scénario complet : restauration d'urgence

```sql
-- Côté SQL*Plus
SQL> SHUTDOWN ABORT
SQL> STARTUP MOUNT
```

```rman
-- Côté RMAN
RMAN> RESTORE DATABASE;
RMAN> RECOVER DATABASE;
```

```sql
-- Côté SQL*Plus
SQL> ALTER DATABASE OPEN;
```

🎉 Base de nouveau opérationnelle.

---

## 14. Le Point-in-Time Recovery (PITR)

PITR = restaurer la base **à un instant T précis dans le passé**. Sans archivelog c'est impossible — d'où l'importance de toujours les sauvegarder.

### 14.1 Le scénario type

Lundi 12h00, un développeur a fait `DROP TABLE clients`. Il est 13h. Tu veux la base **telle qu'elle était à 11h59**.

```sql
-- 1. Couper et passer en MOUNT
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
```

```rman
-- 2. PITR en un bloc RUN
RMAN> RUN {
        SET UNTIL TIME '2026-05-17 11:59:00';
        RESTORE DATABASE;
        RECOVER DATABASE;
      }
```

```sql
-- 3. Ouvrir avec RESETLOGS (nouvelle incarnation)
SQL> ALTER DATABASE OPEN RESETLOGS;
```

✅ Ta table `clients` est de retour.

### 14.2 SET UNTIL — le précurseur réutilisable

`SET UNTIL` à l'intérieur d'un `RUN` block est *hérité* par tous les `RESTORE`/`RECOVER` suivants du même bloc. C'est la **forme canonique du PITR** :

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

### 14.3 SET NEWNAME — déplacer un datafile pendant le restore

Tu restaures sur un nouveau serveur où les disques s'appellent différemment ? Renomme à la volée :

```rman
RUN {
  SET NEWNAME FOR DATAFILE 1 TO '/u02/oradata/system01.dbf';
  SET NEWNAME FOR DATAFILE 2 TO '/u02/oradata/sysaux01.dbf';
  SET NEWNAME FOR DATAFILE 3 TO '/u02/oradata/undotbs01.dbf';
  SET NEWNAME FOR DATAFILE 4 TO '/u02/oradata/users01.dbf';
  RESTORE DATABASE;
  SWITCH DATAFILE ALL;       -- met à jour le control file avec les nouveaux chemins
  RECOVER DATABASE;
}
```

### 14.4 RESETLOGS et les incarnations

Après un PITR, la "ligne temporelle" de la base change. Oracle parle d'**incarnation** :

```rman
RMAN> LIST INCARNATION OF DATABASE;

List of Database Incarnations
=============================
DB Key  Inc Key DB Name  DB ID            STATUS  Reset SCN  Reset Time
------- ------- -------- ---------------- ------- ---------- ----------
1       1       ORCL     1234567890       PARENT  1          16-MAY-2026
1       2       ORCL     1234567890       CURRENT 1892354    17-MAY-2026

RMAN> RESET DATABASE TO INCARNATION 2;
```

### 14.5 Récupération par bloc (BLOCKRECOVER)

Pour réparer juste **un bloc corrompu** :

```rman
RMAN> BLOCKRECOVER DATAFILE 1 BLOCK 1234;
RMAN> BLOCKRECOVER CORRUPTION LIST;
-- Récupère tous les blocs listés dans V$DATABASE_BLOCK_CORRUPTION
```

C'est de la chirurgie : pas besoin de tout restaurer pour réparer un bloc.

---

## 15. Les blocs RUN, les canaux et les scripts

Pour des opérations complexes, on enchaîne plusieurs commandes dans un **bloc RUN**.

### 15.1 Pourquoi un bloc RUN ?

```rman
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
  BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_FULL';
  BACKUP ARCHIVELOG ALL DELETE INPUT;
  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}
```

Trois raisons :

1. **Canaux explicites** : tu choisis combien, où, avec quel format
2. **SET UNTIL/NEWNAME** : les bindings ne sont valables qu'à l'intérieur du bloc
3. **Atomicité visuelle** : c'est plus lisible qu'une cascade de commandes isolées

### 15.2 Forme multi-ligne vs inline

```rman
-- Multi-ligne (le plus lisible)
RUN
{
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  BACKUP DATABASE;
  RELEASE CHANNEL c1;
}

-- Inline (Oracle canonique, plus court)
RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; BACKUP DATABASE; RELEASE CHANNEL c1; }
```

Les deux marchent. Choisis selon le contexte.

### 15.3 Les canaux explicites

```rman
ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
ALLOCATE CHANNEL t1 DEVICE TYPE SBT;          -- bande
ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;   -- pour DUPLICATE
```

Tu peux allouer **jusqu'à 254 canaux** simultanément. Pour vraiment paralléliser sur du SAN moderne, 8-16 canaux est un bon point de départ.

### 15.4 SHOW CHANNEL

```rman
RMAN> SHOW CHANNEL;
```

Liste les canaux configurés *et* les canaux explicites alloués.

### 15.5 Les scripts stockés

Pour ne pas réécrire toujours la même chose :

```rman
RMAN> CREATE SCRIPT daily_backup {
        BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
        DELETE NOPROMPT OBSOLETE;
      }

RMAN> EXECUTE SCRIPT daily_backup;

RMAN> PRINT SCRIPT daily_backup;       -- affiche le contenu
RMAN> LIST SCRIPT NAMES;
RMAN> REPLACE SCRIPT daily_backup { ... }
RMAN> DELETE SCRIPT daily_backup;
```

> 💡 Ces scripts vivent dans le recovery catalog (en prod) ou dans le control file. Dans le sandbox, ils sont acceptés en no-op (pratique pour valider la syntaxe).

---

## 16. DUPLICATE : cloner une base

`DUPLICATE` copie une base entière vers une **autre instance** (dite *auxiliaire*). C'est l'outil pour :

- Créer un environnement de test à partir de la prod
- Mettre en place un **standby** Data Guard
- Promouvoir un site DR

### 16.1 Forme la plus simple

```rman
RMAN> CONNECT AUXILIARY /;             -- ouvre la connexion vers l'aux instance
RMAN> DUPLICATE TARGET DATABASE TO DUP1;
```

### 16.2 Les variantes

```rman
DUPLICATE DATABASE TO DUP1;                              -- forme courte
DUPLICATE TARGET DATABASE TO STBY FOR STANDBY;           -- pour Data Guard
DUPLICATE TARGET DATABASE TO STBY FOR STANDBY FROM ACTIVE DATABASE;
                                                         -- via réseau, sans backup intermédiaire
DUPLICATE TARGET DATABASE TO DUP2 UNTIL TIME '2026-01-01';
DUPLICATE TARGET DATABASE TO DUP3 UNTIL SCN 1900000;
DUPLICATE TARGET DATABASE TO DUP4 SKIP TABLESPACE TEMP;
DUPLICATE TARGET DATABASE TO DUP5 NOFILENAMECHECK;
```

### 16.3 Avec canaux explicites

```rman
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
  DUPLICATE TARGET DATABASE TO DUP_TEST;
  RELEASE CHANNEL aux1;
  RELEASE CHANNEL c1;
}
```

---

## 17. Cas pratiques de bout en bout

Mettons tout ensemble dans des scénarios réalistes.

### 17.1 La sauvegarde quotidienne standard

À programmer dans un cron à 3h du matin :

```rman
CONNECT TARGET /;
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
BACKUP INCREMENTAL LEVEL 1 DATABASE PLUS ARCHIVELOG DELETE INPUT TAG 'DAILY';
CROSSCHECK BACKUP;
CROSSCHECK ARCHIVELOG ALL;
DELETE NOPROMPT EXPIRED BACKUP;
DELETE NOPROMPT OBSOLETE;
LIST BACKUP SUMMARY;
EXIT;
```

### 17.2 La cadence hebdomadaire L0 + L1

```rman
-- Dimanche soir
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_L0' PLUS ARCHIVELOG DELETE INPUT;

-- Lundi à vendredi
BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DAILY_L1' PLUS ARCHIVELOG DELETE INPUT;

-- Samedi (cumulatif, plus lourd mais restore rapide)
BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'WEEKLY_CUM';
```

### 17.3 Le sinistre — disque perdu

Le SAN a rendu l'âme cette nuit. La base ne démarre plus.

```sql
SQL> STARTUP MOUNT
ORA-01157: cannot identify/lock data file 4
```

→ Le datafile 4 (`users01.dbf`) est perdu. On va le restaurer **sans toucher au reste** :

```rman
CONNECT TARGET /;
RESTORE DATAFILE 4;
RECOVER DATAFILE 4;
```

```sql
SQL> ALTER DATABASE OPEN;
```

3 commandes, base sauvée. 🎉

### 17.4 Le PITR — DROP TABLE par erreur

```
12h00 : Un dev fait DROP TABLE clients en prod
12h05 : Le DBA est alerté
12h06 : Le DBA agit
```

```sql
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
```

```rman
CONNECT TARGET /;
RUN {
  SET UNTIL TIME '2026-05-17 11:59:00';
  RESTORE DATABASE;
  RECOVER DATABASE;
}
```

```sql
SQL> ALTER DATABASE OPEN RESETLOGS;
```

Et on enchaîne :

```rman
-- Toujours, après un PITR : nouveau backup L0 immédiat
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'POST_PITR_BASE';
```

### 17.5 Le failover DR — site primaire mort

Le datacenter primaire est inaccessible (incendie, inondation, coupure). Tu bascules sur le site DR.

```rman
-- Sur le site DR (instance déjà en MOUNT, prête à reprendre)
CONNECT TARGET /;

LIST BACKUP SUMMARY;     -- vérifie ce qu'on a sous la main
CROSSCHECK BACKUP;       -- vérifie l'intégrité

RUN {
  SET NEWNAME FOR DATAFILE 1 TO '/u02/dr/system01.dbf';
  SET NEWNAME FOR DATAFILE 2 TO '/u02/dr/sysaux01.dbf';
  SET NEWNAME FOR DATAFILE 3 TO '/u02/dr/undotbs01.dbf';
  SET NEWNAME FOR DATAFILE 4 TO '/u02/dr/users01.dbf';
  RESTORE DATABASE;
  SWITCH DATAFILE ALL;
  RECOVER DATABASE;
}
```

```sql
SQL> ALTER DATABASE OPEN RESETLOGS;
```

```rman
-- Premier backup de la nouvelle prod DR
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DR_PROMOTED_L0';
```

### 17.6 Le clone pour test/dev

Tu veux un environnement de test avec les vraies données d'il y a 3 jours :

```rman
CONNECT TARGET /;
CONNECT AUXILIARY /;

DUPLICATE TARGET DATABASE TO DEV_CLONE
  UNTIL TIME 'SYSDATE - 3'
  SKIP TABLESPACE TEMP;
```

Une seule commande, un clone complet. 🪄

---

## 18. Les erreurs RMAN les plus courantes

| Code | Message | Cause | Solution |
|---|---|---|---|
| `RMAN-04014` | Oracle instance is not started | Tu fais `CONNECT TARGET` contre une instance SHUTDOWN | `STARTUP NOMOUNT` (ou plus) côté SQL*Plus |
| `RMAN-06403` | database must be mounted (not open) | `RESTORE DATABASE` quand la base est OPEN | `SHUTDOWN IMMEDIATE; STARTUP MOUNT;` |
| `RMAN-06023` | No backup found to restore | Le catalog est vide (ou tag introuvable) | `LIST BACKUP` pour vérifier ; faire un backup d'abord |
| `RMAN-06024` | no backup or copy of <…> found | `CHANGE BACKUPSET` sur un bsKey inconnu | `LIST BACKUP SUMMARY` pour trouver le bon Key |
| `RMAN-06004` | backup piece not found | `CATALOG BACKUPPIECE '/path'` sur un fichier inexistant | Vérifier le chemin avec `ls -la` |
| `RMAN-03002` | target database is not connected | Session disconnectée (l'instance s'est éteinte ?) | Refaire `rman target /` |
| `RMAN-01009` | syntax error | Faute de frappe ou mot-clé non supporté | Vérifier la syntaxe avec `HELP` |
| `RMAN-03014` | implicit command did not succeed | Wrapper autour d'une erreur sous-jacente | Lire le code/message qui suit |

> 💡 **Astuce pour lire une erreur RMAN** : ignore la bannière `RMAN-00571 / 00569 / 00571` (c'est juste le décor). Concentre-toi sur la **dernière ligne** numérique — c'est elle qui contient la vraie cause.
> ```
> RMAN-00571: ===========================================================
> RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============
> RMAN-00571: ===========================================================
> RMAN-06403: database must be mounted (not open)    ← LA VRAIE INFO
> ```

---

## 19. Aide-mémoire des commandes

### Connexion

```rman
rman target /                            # OS auth
rman target sys/manager@ORCL             # via TNS
CONNECT TARGET /
CONNECT AUXILIARY /
CONNECT CATALOG rman/rman@RCAT
EXIT  |  QUIT
```

### Configuration

```rman
SHOW ALL
CONFIGURE RETENTION POLICY TO REDUNDANCY n
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF n DAYS
CONFIGURE RETENTION POLICY TO NONE
CONFIGURE CONTROLFILE AUTOBACKUP {ON|OFF}
CONFIGURE DEFAULT DEVICE TYPE TO {DISK|SBT}
CONFIGURE DEVICE TYPE DISK PARALLELISM n BACKUP TYPE TO BACKUPSET
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/path/%d_%T_%U.bkp'
CONFIGURE COMPRESSION ALGORITHM '{BASIC|LOW|MEDIUM|HIGH}'
CONFIGURE ENCRYPTION FOR DATABASE {ON|OFF}
CONFIGURE ENCRYPTION ALGORITHM '{AES128|AES192|AES256}'
CONFIGURE BACKUP OPTIMIZATION {ON|OFF}
CONFIGURE ARCHIVELOG DELETION POLICY TO {NONE | APPLIED ON ALL STANDBY | BACKED UP n TIMES TO DEVICE TYPE DISK}
```

### Backup

```rman
BACKUP DATABASE [PLUS ARCHIVELOG [DELETE INPUT]]
BACKUP TABLESPACE name [, name2…]
BACKUP DATAFILE n
BACKUP SPFILE
BACKUP CURRENT CONTROLFILE
BACKUP ARCHIVELOG ALL [DELETE INPUT]
BACKUP ARCHIVELOG FROM SCN n
BACKUP INCREMENTAL LEVEL 0|1 [CUMULATIVE] DATABASE
BACKUP COMPRESSED BACKUPSET DATABASE
BACKUP DATABASE ENCRYPTED
BACKUP DATABASE MAXPIECESIZE 200M
BACKUP DATABASE KEEP FOREVER
BACKUP DATABASE KEEP UNTIL TIME '2030-12-31'
BACKUP DATABASE TAG 'WEEKLY' FORMAT '/path/%d_%U.bkp'
BACKUP NOT BACKED UP n TIMES DATABASE
BACKUP VALIDATE DATABASE
VALIDATE DATABASE | TABLESPACE | DATAFILE | BACKUPSET n
```

### Liste / Rapport

```rman
LIST BACKUP [SUMMARY]
LIST ARCHIVELOG ALL
LIST EXPIRED BACKUP
LIST OBSOLETE
LIST COPY [OF DATABASE | OF TABLESPACE name]
LIST INCARNATION OF DATABASE
LIST DB_UNIQUE_NAME OF DATABASE
LIST SCRIPT NAMES
REPORT SCHEMA
REPORT NEED BACKUP [REDUNDANCY n | RECOVERY WINDOW OF n DAYS]
REPORT OBSOLETE [REDUNDANCY n | RECOVERY WINDOW OF n DAYS]
REPORT UNRECOVERABLE
```

### Maintenance

```rman
CROSSCHECK BACKUP
CROSSCHECK ARCHIVELOG ALL
DELETE NOPROMPT EXPIRED BACKUP
DELETE NOPROMPT OBSOLETE [REDUNDANCY n | RECOVERY WINDOW OF n DAYS]
DELETE NOPROMPT BACKUP TAG 'X'
DELETE NOPROMPT BACKUPSET n
DELETE NOPROMPT ARCHIVELOG ALL
CHANGE BACKUPSET n {AVAILABLE|UNAVAILABLE}
CHANGE BACKUP TAG 'X' DELETE
CATALOG DATAFILECOPY '/path/file.dbf'
CATALOG BACKUPPIECE '/path/piece.bkp'
```

### Restore / Recover / PITR

```rman
RESTORE DATABASE [PREVIEW | VALIDATE] [FROM TAG 'X']
RESTORE TABLESPACE name
RESTORE DATAFILE n
RECOVER DATABASE [UNTIL SCN n | UNTIL TIME '…' | UNTIL CANCEL]
RECOVER TABLESPACE name
RECOVER DATAFILE n
BLOCKRECOVER DATAFILE n BLOCK b
BLOCKRECOVER CORRUPTION LIST
ALTER DATABASE OPEN RESETLOGS
LIST INCARNATION OF DATABASE
RESET DATABASE TO INCARNATION n
```

### RUN + canaux + scripts

```rman
RUN { … }
ALLOCATE CHANNEL alias DEVICE TYPE DISK
ALLOCATE AUXILIARY CHANNEL alias DEVICE TYPE DISK
RELEASE CHANNEL alias
SET UNTIL TIME '…' | SET UNTIL SCN n
SET NEWNAME FOR DATAFILE n TO '/new/path'
SWITCH DATAFILE ALL | n
CREATE SCRIPT name { … }
REPLACE SCRIPT name { … }
EXECUTE SCRIPT name
PRINT SCRIPT name
DELETE SCRIPT name
```

### DUPLICATE

```rman
DUPLICATE [TARGET] DATABASE TO newdb
                  [FOR STANDBY] [FROM ACTIVE DATABASE]
                  [UNTIL TIME '…' | UNTIL SCN n]
                  [SKIP TABLESPACE name] [SKIP READONLY]
                  [NOFILENAMECHECK]
```

### Recovery catalog

```rman
CREATE CATALOG
CREATE VIRTUAL CATALOG vcname
GRANT CATALOG FOR DATABASE name TO user
REGISTER DATABASE
UNREGISTER DATABASE [name] [NOPROMPT]
RESYNC CATALOG
```

---

## 20. Conclusion

Tu sais maintenant :

- ✅ **Pourquoi** RMAN est indispensable en prod Oracle
- ✅ **Comment** lancer une sauvegarde simple, incrémentielle, compressée, chiffrée
- ✅ **Comment** interroger le catalog avec `LIST` et `REPORT`
- ✅ **Comment** maintenir le catalog propre avec `CROSSCHECK` + `DELETE` + `CHANGE`
- ✅ **Comment** restaurer un datafile, un tablespace, ou la base entière
- ✅ **Comment** faire un PITR (le scénario *DROP TABLE par erreur*)
- ✅ **Comment** cloner une base avec `DUPLICATE`
- ✅ **Comment** lire et déboguer les erreurs `RMAN-NNNNN`

### Pour aller plus loin

- **Les vraies docs Oracle** : *Database Backup and Recovery User's Guide* (gratuit sur docs.oracle.com)
- **Le bouquin de référence** : *Oracle RMAN 12c Backup and Recovery* (Robert G. Freeman)
- **Le design technique du sandbox** : `docs/DESIGN-RMAN-REACTIVE.md`
- **Les suites de test (à débrancher en local pour expérimenter)** : `src/__tests__/debug/rman/` — lancer avec `npx vitest run src/__tests__/debug/rman/` et lire les transcripts dans `debug-output/rman/`

### Le mot de la fin

Un DBA qui sait sauvegarder n'a pas peur des sinistres. **Tu en fais partie maintenant.** 💪

Souviens-toi de la règle d'or : **un backup non testé n'est pas un backup**. Fais des restores de test régulièrement sur une instance de jeu — c'est le seul moyen de vérifier que ta stratégie marche vraiment. 🎯

Bons backups ! 🛡️
