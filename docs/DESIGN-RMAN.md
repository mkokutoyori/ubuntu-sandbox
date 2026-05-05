# DESIGN — Architecture Technique RMAN (Recovery Manager)

**Version** : 1.0  
**Date** : 2026-05-05  
**Projet** : Ubuntu Sandbox — Module Oracle RMAN  
**Auteur** : Claude Code  
**Reference** : BRD-SSH-SFTP.md (precedent), OracleInstance.ts, RmanSubShell.ts

---

## Table des matieres

1. [Vue d'ensemble architecturale](#1-vue-densemble-architecturale)
2. [Fondations : Result monad + RmanError](#2-fondations--result-monad--rmanerror)
3. [Value Objects et utilitaires purs (FP)](#3-value-objects-et-utilitaires-purs-fp)
4. [Backup Catalog — Repository + Factory](#4-backup-catalog--repository--factory)
5. [Canaux de sauvegarde — Composite + Strategy](#5-canaux-de-sauvegarde--composite--strategy)
6. [Politique de retention — Strategy Pattern](#6-politique-de-retention--strategy-pattern)
7. [Commandes RMAN — Command Pattern + Open/Closed](#7-commandes-rman--command-pattern--openclosed)
8. [Session RMAN — Facade + State Machine + Builder](#8-session-rman--facade--state-machine--builder)
9. [Integration : OracleInstance, VFS, SubShell](#9-integration--oracleinstance-vfs-subshell)
10. [Flux complets et scenarios](#10-flux-complets-et-scenarios)
11. [Recapitulatif des principes appliques](#11-recapitulatif-des-principes-appliques)

---

## 1. Vue d'ensemble architecturale

### 1.1 Diagramme de couches

```
+-------------------------------------------------------------------------+
|                        COUCHE PRESENTATION                              |
|  RmanSubShell (refactorise)   LinuxTerminalSession (wiring)             |
|  (ISubShell — prompt, multi-ligne, RUN-block, script @file)             |
+--------------------------------+----------------------------------------+
                                 |  depend via IRmanSession
+--------------------------------v----------------------------------------+
|                       COUCHE SESSION (Facade)                           |
|                                                                         |
|   RmanSession (IRmanSession)                                            |
|   - connect(target) / disconnect()                                      |
|   - execute(command: string): RmanOutput                                |
|   - executeScript(lines: string[]): RmanOutput                          |
|   - getConfig(): RmanConfig                                             |
|   - getState(): RmanSessionState                                        |
+--------+-------------------+--------------------------------------------+
         |                   |
+--------v-------+  +--------v-----------+  +-----------------------------+
|  SCRIPT LAYER  |  |  COMMAND LAYER     |  |  CONFIG LAYER               |
|                |  |                    |  |                             |
| RmanScript     |  | IRmanCommand<T>    |  | RmanConfig (immutable)      |
| Parser         |  | - BackupCmd        |  | RmanConfigStore             |
| (multi-line,   |  | - RestoreCmd       |  | ConfigureCommand            |
|  RUN {})       |  | - RecoverCmd       |  | ShowCommand                 |
|                |  | - ListCmd          |  |                             |
+--------+-------+  | - ReportCmd        |  +----+------------------------+
         |          | - CrosscheckCmd    |       |
         |          | - DeleteCmd        |       |
         |          | - CatalogCmd       |       |
         |          | RmanCmdDispatcher  |       |
         |          +--------+-----------+       |
         |                   |                   |
+--------v-------------------v-------------------v------------------------+
|                     COUCHE METIER RMAN                                  |
|                                                                         |
|   RmanCommandContext                                                    |
|   - catalog: IRmanCatalogRepository                                     |
|   - channels: ChannelPool                                               |
|   - retentionEngine: RmanRetentionEngine                                |
|   - oracleCtx: IRmanOracleContext                                       |
|   - config: RmanConfig                                                  |
|   - eventBus: IRmanEventBus                                             |
+--------+-------------------+--------------------------------------------+
         |                   |
+--------v-------+  +--------v-----------+  +-----------------------------+
| CATALOG LAYER  |  |  CHANNEL LAYER     |  |  RETENTION LAYER            |
|                |  |                    |  |                             |
| IRmanCatalog   |  | IBackupChannel     |  | IRetentionPolicy            |
| Repository     |  | - DiskChannel      |  | - RedundancyPolicy          |
|                |  | - SbtChannel       |  | - RecoveryWindowPolicy      |
| BackupSet      |  | ChannelAllocator   |  | - NonePolicy                |
| BackupPiece    |  | ChannelPool        |  | RmanRetentionEngine         |
| ArchivedLog    |  | (Composite)        |  | (pure functions)            |
| ImageCopy      |  +--------------------+  +-----------------------------+
+--------+-------+
         |  depends via IRmanOracleContext
+--------v----------------------------------------------------------------+
|                   COUCHE ORACLE / FILESYSTEM                            |
|                                                                         |
|   IRmanOracleContext                                                    |
|     +-- LinuxRmanContext  --> OracleInstance + VirtualFileSystem        |
|                                                                         |
|   OracleInstance  (state machine: SHUTDOWN/NOMOUNT/MOUNT/OPEN)         |
|   VirtualFileSystem  (backup pieces physically ecrites sur VFS)        |
+-------------------------------------------------------------------------+
```

### 1.2 Defauts identifies dans l'implementation actuelle

L'analyse de `RmanSubShell.ts` (382 lignes) revele les defauts suivants :

| ID | Composant | Defaut | Impact |
|---|---|---|---|
| DEF-RMAN-01 | RmanSubShell | Aucun backup catalog — chaque session repart de zero | Irrealiste : `LIST BACKUP` ne montre jamais les backups precedents |
| DEF-RMAN-02 | RmanSubShell | `SHOW ALL` retourne des strings hardcodees | CONFIGURE n'a aucun effet |
| DEF-RMAN-03 | RmanSubShell | `BACKUP DATABASE` genere un piece name aleatoire mais n'ecrit rien sur le VFS | `CROSSCHECK` ne peut pas valider |
| DEF-RMAN-04 | RmanSubShell | Pas de `BACKUP INCREMENTAL LEVEL 0/1` | Commande RMAN fondamentale absente |
| DEF-RMAN-05 | RmanSubShell | Pas de clause `FORMAT`, `TAG`, `MAXPIECESIZE` | Syntaxe RMAN incomplete |
| DEF-RMAN-06 | RmanSubShell | Pas de commandes `CONFIGURE` | Politique de retention non parametrable |
| DEF-RMAN-07 | RmanSubShell | Pas de `ALLOCATE CHANNEL` / `RELEASE CHANNEL` | Gestion des canaux absente |
| DEF-RMAN-08 | RmanSubShell | `LIST BACKUP` montre des donnees statiques codees en dur | Incoherent avec les backups effectues |
| DEF-RMAN-09 | RmanSubShell | `RESTORE`/`RECOVER` sans controle de l'etat de l'instance | Sur un vrai RMAN, RESTORE necessite MOUNT |
| DEF-RMAN-10 | RmanSubShell | Commandes mono-ligne uniquement | `BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;` impossible |
| DEF-RMAN-11 | RmanSubShell | Pas de blocs `RUN { ... }` | Scritps RMAN impossibles |
| DEF-RMAN-12 | RmanSubShell | `CROSSCHECK BACKUP` ne verifie pas le VFS | Retourne toujours "AVAILABLE" |
| DEF-RMAN-13 | RmanSubShell | `DELETE EXPIRED/OBSOLETE` ne supprime rien | Retourne "no obsolete backups found" en dur |
| DEF-RMAN-14 | RmanSubShell | Pas de support `BACKUP CURRENT CONTROLFILE` | Sauvegarde du controlfile absente |
| DEF-RMAN-15 | RmanSubShell | Pas de `BACKUP VALIDATE` | Verification sans ecriture absente |
| DEF-RMAN-16 | RmanSubShell | Pas de `CATALOG DATAFILECOPY/BACKUPPIECE` | Re-enregistrement de pieces absent |
| DEF-RMAN-17 | RmanSubShell | Pas de `DUPLICATE DATABASE` | Clone de base absent |
| DEF-RMAN-18 | RmanSubShell | Pas de recovery base sur SCN ou timestamp | `RECOVER DATABASE UNTIL SCN` absent |
| DEF-RMAN-19 | RmanSubShell | `CONNECT TARGET` n'interroge pas `OracleInstance` | Pas de validation de l'etat de l'instance |
| DEF-RMAN-20 | RmanSubShell | `BACKUP ARCHIVELOG ALL DELETE INPUT` ignore le `DELETE INPUT` | Les archivelogs ne sont pas supprimes apres backup |

### 1.3 Objectifs de la refonte

1. **Realisme** : chaque commande RMAN produit un effet observable — les pieces s'ecrivent sur le VFS, le catalog se met a jour, `LIST BACKUP` reflète l'historique.
2. **Open/Closed** : ajouter une nouvelle commande RMAN = implementer `IRmanCommand<T>` et l'enregistrer dans le dispatcher — zero modification du code existant.
3. **Testabilite** : `IRmanOracleContext` et `IRmanCatalogRepository` sont injectables ; les tests n'ont pas besoin d'une instance Oracle complete.
4. **Immutabilite** : `RmanConfig`, `BackupSet`, `BackupPiece`, `Scn` — tous immuables.
5. **Programmation fonctionnelle** : `RmanRetentionEngine`, `RmanPureUtils` — fonctions pures sans effet de bord.
6. **State machine explicite** : `RmanSessionState` discriminated union ; les transitions sont visibles et testables.

### 1.4 Perimetres hors-scope

- Vraie cryptographie pour `BACKUP ENCRYPTION` (simule avec marqueur textuel)
- Sauvegarde sur bande physique (SBT simule uniquement)
- `DUPLICATE DATABASE TO standby` via reseau (hors perimetre simulateur)
- Recovery Catalog sur base separee (catalog en memoire uniquement)

---
