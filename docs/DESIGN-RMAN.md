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

## 2. Fondations : Result monad + RmanError

### 2.1 Pourquoi une monade Result ?

L'implementation actuelle de `RmanSubShell` retourne des `string[]` ou des messages codes en dur, sans distinction entre succes et echec. Cela rend impossible :
- la propagation d'erreurs typees depuis les couches profondes
- le test unitaire des cas d'echec sans capturer stdout
- la composition de commandes (`RUN {}` blocs) avec gestion d'erreur propre

La monade `Result<T, E>` est le fondement de toute l'architecture.

### 2.2 Le type Result<T, E> (module partage avec SSH)

```typescript
// src/network/protocols/ssh/result.ts  (deja existant apres implementation SSH)
// src/database/oracle/rman/result.ts   (re-export ou import direct)

export type Result<T, E = RmanError> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E }

// Constructeurs
export const ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

// Combinateurs — programmation fonctionnelle pure
export const map = <T, U, E>(
  r: Result<T, E>,
  f: (v: T) => U
): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r

export const flatMap = <T, U, E>(
  r: Result<T, E>,
  f: (v: T) => Result<U, E>
): Result<U, E> =>
  r.ok ? f(r.value) : r

export const mapError = <T, E, F>(
  r: Result<T, E>,
  f: (e: E) => F
): Result<T, F> =>
  r.ok ? r : err(f(r.error))

export const getOrElse = <T, E>(
  r: Result<T, E>,
  fallback: T
): T =>
  r.ok ? r.value : fallback

export const match = <T, E, U>(
  r: Result<T, E>,
  onOk: (v: T) => U,
  onErr: (e: E) => U
): U =>
  r.ok ? onOk(r.value) : onErr(r.error)

// Accumulation — sequencer plusieurs Result en une passe
export const sequence = <T, E>(
  results: ReadonlyArray<Result<T, E>>
): Result<ReadonlyArray<T>, E> => {
  const values: T[] = []
  for (const r of results) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
}
```

### 2.3 RmanError — union discriminee

Chaque code d'erreur RMAN officiel (RMAN-XXXXX) est modelise comme un variant distinct, garantissant l'exhaustivite au point de sortie :

```typescript
// src/database/oracle/rman/RmanError.ts

export type RmanErrorCode =
  // Erreurs de session / connexion
  | 'RMAN_03002'   // failure of command at line N
  | 'RMAN_03009'   // failure of allocate command on channel
  | 'RMAN_06004'   // oracle error from target database: ORA-01034
  | 'RMAN_06023'   // no backup or copy of datafile N found to restore
  | 'RMAN_06059'   // expected archived log not found
  | 'RMAN_08003'   // piece N expired
  | 'RMAN_08120'   // unable to find archive log
  // Erreurs de configuration
  | 'RMAN_06550'   // retention policy conflict
  // Erreurs de parsing / syntaxe
  | 'RMAN_00558'   // error encountered while parsing input command
  | 'RMAN_01009'   // syntax error: found X
  | 'RMAN_01007'   // at line N column M file: standard input
  // Erreurs de validation pre-execution
  | 'DB_NOT_OPEN'        // commande requiert instance OPEN
  | 'DB_NOT_MOUNT'       // commande requiert instance au moins MOUNT
  | 'DB_NOT_CONNECTED'   // pas de connexion TARGET active
  | 'NO_BACKUP_FOUND'    // aucun backup satisfait les criteres
  | 'CHANNEL_FAILED'     // canal de sauvegarde en echec
  | 'VFS_WRITE_ERROR'    // erreur d'ecriture sur le VFS
  | 'VFS_READ_ERROR'     // erreur de lecture sur le VFS
  | 'INVALID_FORMAT'     // format de piece invalide
  | 'CATALOG_CORRUPT'    // incoherence dans le catalog interne

export interface RmanError {
  readonly code: RmanErrorCode
  readonly message: string
  readonly line?: number
  /** Stack RMAN (RMAN-00571 + RMAN-00569 + code principal) */
  readonly stack: readonly string[]
}

// Constructeur helper — genere le stack RMAN realiste
export function makeRmanError(
  code: RmanErrorCode,
  message: string,
  line?: number
): RmanError {
  return {
    code,
    message,
    line,
    stack: [
      'RMAN-00571: ===========================================================',
      'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
      'RMAN-00571: ===========================================================',
      `RMAN-03002: failure of ${message.split(':')[0]} command at ${
        line !== undefined ? `line ${line}` : 'standard input'
      }`,
      `${code.replace('_', '-')}: ${message}`,
    ],
  }
}
```

### 2.4 RmanOutput — sortie structuree d'une commande

Toute commande RMAN produit un `RmanOutput` : les lignes texte a afficher + metadata de la commande executee.

```typescript
// src/database/oracle/rman/RmanOutput.ts

export interface RmanOutput {
  /** Lignes a afficher dans le terminal (incluant les lignes blanches) */
  readonly lines: readonly string[]
  /** true = la session doit se fermer apres cet output */
  readonly exit: boolean
  /** Nombre de backup sets crees (0 si pas une commande de backup) */
  readonly backupSetsCreated: number
  /** Nombre de fichiers restaures (0 si pas une commande de restore) */
  readonly filesRestored: number
  /** Duree simulee en secondes */
  readonly elapsedSeconds: number
}

export const emptyOutput: RmanOutput = {
  lines: [],
  exit: false,
  backupSetsCreated: 0,
  filesRestored: 0,
  elapsedSeconds: 0,
}

export function outputLines(
  lines: readonly string[],
  opts?: Partial<Omit<RmanOutput, 'lines'>>
): RmanOutput {
  return { ...emptyOutput, lines, ...opts }
}

export function outputError(error: RmanError): RmanOutput {
  return outputLines(error.stack)
}
```

### 2.5 Diagramme de dependances des types fondamentaux

```
Result<T, E>       (type generique — zero dependance)
     |
     +--- RmanError          (code + message + stack)
     |       |
     |       +--- makeRmanError()   (constructeur helper pur)
     |
     +--- RmanOutput         (lignes + metadata)
             |
             +--- outputLines()     (constructeur helper pur)
             +--- outputError()     (conversion RmanError -> RmanOutput)
```

Toutes ces definitions sont des **types purs** : aucun import de classe concrete, aucun effet de bord. Elles peuvent etre importees par n'importe quelle couche sans risque de couplage circulaire.

---

