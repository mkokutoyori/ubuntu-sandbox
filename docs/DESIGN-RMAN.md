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

## 3. Value Objects et utilitaires purs (FP)

### 3.1 Principes des Value Objects

Un Value Object est :
- **immuable** — aucune methode ne modifie ses champs
- **compare par valeur** — deux objets avec les memes champs sont egaux
- **autonome** — porte sa propre logique de validation et de comparaison

Dans RMAN, les entites suivantes sont des Value Objects : `Scn`, `RmanTag`, `BackupKey`, `DbId`, `RmanTimestamp`.

### 3.2 Scn — System Change Number

Le SCN est la notion de temps logique d'Oracle. Il doit etre opaque, comparable et serialisable.

```typescript
// src/database/oracle/rman/values/Scn.ts

export type Scn = Readonly<{ readonly _tag: 'Scn'; readonly value: number }>

export const Scn = {
  of(n: number): Scn {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`SCN must be a non-negative integer, got: ${n}`)
    }
    return Object.freeze({ _tag: 'Scn', value: n })
  },

  zero: Object.freeze({ _tag: 'Scn' as const, value: 0 }),

  compare(a: Scn, b: Scn): number {
    return a.value - b.value
  },

  lt(a: Scn, b: Scn): boolean { return a.value < b.value },
  lte(a: Scn, b: Scn): boolean { return a.value <= b.value },
  eq(a: Scn, b: Scn): boolean { return a.value === b.value },

  toString(scn: Scn): string { return scn.value.toString() },

  fromString(s: string): Scn | null {
    const n = parseInt(s, 10)
    return isNaN(n) || n < 0 ? null : Scn.of(n)
  },
}
```

### 3.3 RmanTag — etiquette de backup

Le TAG identifie un backup set de maniere unique et lisible. Format Oracle : `TAGYYYYMMDDTHHMMSS` ou personnalise.

```typescript
// src/database/oracle/rman/values/RmanTag.ts

export type RmanTag = Readonly<{ readonly _tag: 'RmanTag'; readonly value: string }>

const TAG_REGEX = /^[A-Za-z0-9_\-\.]{1,30}$/

export const RmanTag = {
  of(value: string): RmanTag {
    const v = value.trim().toUpperCase()
    if (!TAG_REGEX.test(v)) {
      throw new Error(`Invalid RMAN tag format: "${value}" (max 30 alphanum/underscore chars)`)
    }
    return Object.freeze({ _tag: 'RmanTag', value: v })
  },

  /** Genere un tag Oracle standard base sur la date courante */
  generate(now: Date): RmanTag {
    const y  = now.getFullYear()
    const mo = String(now.getMonth() + 1).padStart(2, '0')
    const d  = String(now.getDate()).padStart(2, '0')
    const h  = String(now.getHours()).padStart(2, '0')
    const mi = String(now.getMinutes()).padStart(2, '0')
    const s  = String(now.getSeconds()).padStart(2, '0')
    return RmanTag.of(`TAG${y}${mo}${d}T${h}${mi}${s}`)
  },

  toString(t: RmanTag): string { return t.value },
}
```

### 3.4 BackupKey — cle primaire d'un backup set

```typescript
// src/database/oracle/rman/values/BackupKey.ts

export type BackupKey = Readonly<{ readonly _tag: 'BackupKey'; readonly value: number }>

let _keyCounter = 1

export const BackupKey = {
  next(): BackupKey {
    return Object.freeze({ _tag: 'BackupKey', value: _keyCounter++ })
  },

  of(n: number): BackupKey {
    return Object.freeze({ _tag: 'BackupKey', value: n })
  },

  toString(k: BackupKey): string { return String(k.value) },

  /** Remet le compteur a une valeur donnee (pour les tests uniquement) */
  _resetForTests(n = 1): void { _keyCounter = n },
}
```

### 3.5 DbId — identifiant Oracle de la base

```typescript
// src/database/oracle/rman/values/DbId.ts

export type DbId = Readonly<{ readonly _tag: 'DbId'; readonly value: number }>

export const DbId = {
  of(n: number): DbId {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`DBID must be a positive integer`)
    }
    return Object.freeze({ _tag: 'DbId', value: n })
  },

  /** DBID simulee deterministe a partir du nom de la base (fnv32) */
  fromDbName(name: string): DbId {
    let h = 0x811c9dc5
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i)
      h = (h * 0x01000193) >>> 0
    }
    return DbId.of(h || 1)
  },

  toString(id: DbId): string { return String(id.value) },
}
```

### 3.6 RmanPureUtils — fonctions pures sans effet de bord

Ce module regroupe toutes les fonctions de calcul, formatage et parsing qui n'ont aucun effet de bord. Conforme au principe de separation des preoccupations : la logique metier pure est separee des effets (I/O, VFS, Date).

```typescript
// src/database/oracle/rman/RmanPureUtils.ts

import type { Scn } from './values/Scn'
import type { RmanTag } from './values/RmanTag'

// ─── Formatage de la taille ───────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0'
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(2)}K`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(2)}M`
  const gb = mb / 1024
  return `${gb.toFixed(2)}G`
}

// ─── Formatage du temps ecoule ────────────────────────────────────────────

export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

// ─── Formatage de la date Oracle ──────────────────────────────────────────

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN',
                'JUL','AUG','SEP','OCT','NOV','DEC']

export function formatOracleDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0')
  const mon = MONTHS[d.getMonth()]
  const y   = d.getFullYear()
  const h   = String(d.getHours()).padStart(2, '0')
  const mi  = String(d.getMinutes()).padStart(2, '0')
  const s   = String(d.getSeconds()).padStart(2, '0')
  return `${day}-${mon}-${y} ${h}:${mi}:${s}`
}

// ─── Generation du nom de piece ───────────────────────────────────────────

/**
 * Genere un chemin de backup piece conforme au format Oracle.
 * %d = db_name, %s = set count, %p = piece number, %t = timestamp
 * %F = auto-unique name (ORCL-1234567890-20260505-01.bkp)
 */
export function expandPieceFormat(
  fmt: string,
  ctx: {
    dbName:    string
    setCount:  number
    pieceNum:  number
    timestamp: number
    tag:       string
  }
): string {
  return fmt
    .replace(/%d/gi, ctx.dbName.toUpperCase())
    .replace(/%s/gi, String(ctx.setCount).padStart(8, '0'))
    .replace(/%p/gi, String(ctx.pieceNum).padStart(2, '0'))
    .replace(/%t/gi, String(ctx.timestamp))
    .replace(/%T/gi, String(ctx.timestamp))
    .replace(/%g/gi, '1')
    .replace(/%F/gi,
      `${ctx.dbName.toUpperCase()}-${ctx.timestamp}-${
        String(ctx.setCount).padStart(8, '0')
      }-${String(ctx.pieceNum).padStart(2, '0')}`)
}

/** Format par defaut si aucun FORMAT n'est specifie dans CONFIGURE */
export const DEFAULT_PIECE_FORMAT = '/u01/app/oracle/fast_recovery_area/%d/%F.bkp'

// ─── Calcul de la duree simulee ───────────────────────────────────────────

/**
 * Simule une duree de backup realiste en fonction de la taille en octets.
 * ~100 MB/s pour DISK, ~50 MB/s pour SBT.
 */
export function simulateBackupSeconds(bytes: number, deviceType: 'DISK' | 'SBT'): number {
  const throughput = deviceType === 'DISK' ? 100 * 1024 * 1024 : 50 * 1024 * 1024
  return Math.max(1, Math.ceil(bytes / throughput))
}

// ─── Parsing du checkpoint SCN ───────────────────────────────────────────

/**
 * Renvoie le SCN de checkpoint le plus ancien parmi les datafiles —
 * represente le SCN minimum jusqu'auquel on peut recuperer.
 */
export function computeMinCkpScn(ckpScns: ReadonlyArray<Scn>): Scn | null {
  if (ckpScns.length === 0) return null
  return ckpScns.reduce((min, s) =>
    s.value < min.value ? s : min
  )
}

// ─── Validation de tag ────────────────────────────────────────────────────

export function isValidTag(s: string): boolean {
  return /^[A-Za-z0-9_\-\.]{1,30}$/.test(s)
}

// ─── Padding pour les tableaux LIST BACKUP ────────────────────────────────

export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}
```

### 3.7 Diagramme des Value Objects

```
RmanPureUtils (module de fonctions pures — zero classe)
  formatBytes()        formatElapsed()     formatOracleDate()
  expandPieceFormat()  simulateBackupSeconds()
  computeMinCkpScn()   padRight()          padLeft()

  +--------- utilise ---------> Scn
  +--------- utilise ---------> RmanTag

Scn            (value object — comparable, serialisable)
RmanTag        (value object — 30 chars max, uppercase)
BackupKey      (value object — auto-incrementing integer)
DbId           (value object — FNV-32 hash du db_name)
```

Invariant cle : **aucun de ces types n'importe depuis le DOM, le VFS, ou une classe Oracle**. Ils sont testables en isolation totale avec `vitest`.

---

## 4. Backup Catalog — Repository + Factory

### 4.1 Pourquoi le pattern Repository ?

Le catalog RMAN (aussi appele "RMAN Repository") est le coeur de toute session RMAN. Il enregistre chaque backup set, chaque piece, chaque archived log et chaque image copy. Dans l'implementation actuelle, ce catalog n'existe pas — tout est recalcule a la volee ou code en dur.

Le **Repository Pattern** (DDD) isole la persistence du domaine : les commandes RMAN travaillent avec l'interface `IRmanCatalogRepository` sans savoir si les donnees viennent de la memoire, d'un fichier JSON, ou d'une vraie base Oracle.

### 4.2 Entites du catalog — Value Objects immuables

```typescript
// src/database/oracle/rman/catalog/types.ts

import type { Scn }       from '../values/Scn'
import type { RmanTag }   from '../values/RmanTag'
import type { BackupKey } from '../values/BackupKey'
import type { DbId }      from '../values/DbId'

// ─── BackupPiece ──────────────────────────────────────────────────────────

export interface BackupPiece {
  readonly bpKey:       number
  readonly bsKey:       number       // FK vers BackupSet
  readonly pieceNum:    number       // 1..N
  readonly handle:      string       // chemin complet sur le VFS
  readonly tag:         RmanTag
  readonly deviceType:  'DISK' | 'SBT'
  readonly sizeBytes:   number
  readonly compressed:  boolean
  readonly encrypted:   boolean
  readonly status:      'AVAILABLE' | 'EXPIRED' | 'DELETED'
  readonly completionTime: Date
}

// ─── BackupSet ────────────────────────────────────────────────────────────

export type BackupType = 'FULL' | 'INCREMENTAL_0' | 'INCREMENTAL_1_DIFF' | 'INCREMENTAL_1_CUM'
export type BackupObject = 'DATABASE' | 'TABLESPACE' | 'DATAFILE' | 'ARCHIVELOG' | 'CONTROLFILE' | 'SPFILE'

export interface BackupSet {
  readonly bsKey:          BackupKey
  readonly dbId:           DbId
  readonly backupType:     BackupType
  readonly backupObject:   BackupObject
  readonly objectNames:    readonly string[]  // tablespace names, datafile paths, etc.
  readonly tag:            RmanTag
  readonly ckpScn:         Scn                // SCN de checkpoint au moment du backup
  readonly ckpTime:        Date
  readonly completionTime: Date
  readonly elapsedSeconds: number
  readonly sizeBytes:      number
  readonly compressed:     boolean
  readonly encrypted:      boolean
  readonly deviceType:     'DISK' | 'SBT'
  readonly pieces:         readonly BackupPiece[]
  readonly status:         'AVAILABLE' | 'EXPIRED' | 'OBSOLETE' | 'DELETED'
  /** true = backup specifie avec KEEP clause */
  readonly keepForever:    boolean
}

// ─── ArchivedLog ──────────────────────────────────────────────────────────

export interface ArchivedLog {
  readonly recid:        number
  readonly stamp:        number        // Oracle internal timestamp
  readonly name:         string        // chemin complet
  readonly thread:       number        // 1 (single instance)
  readonly sequence:     number
  readonly firstScn:     Scn
  readonly firstTime:    Date
  readonly nextScn:      Scn
  readonly nextTime:     Date
  readonly sizeBytes:    number
  readonly status:       'A' | 'D'    // Available / Deleted
  readonly backedUp:     boolean
}

// ─── DatafileCopy ─────────────────────────────────────────────────────────

export interface DatafileCopy {
  readonly recid:        number
  readonly name:         string
  readonly fileNum:      number        // datafile # (1=SYSTEM, 2=SYSAUX, ...)
  readonly ckpScn:       Scn
  readonly ckpTime:      Date
  readonly sizeBytes:    number
  readonly status:       'A' | 'X'    // Available / Expired
  readonly completionTime: Date
  readonly tag:          RmanTag | null
}
```

### 4.3 Interface du Repository

Segregation d'interface (ISP) : le repository est decoupage en operations de lecture et d'ecriture. Les commandes `LIST`/`REPORT` n'ont besoin que des methodes de lecture.

```typescript
// src/database/oracle/rman/catalog/IRmanCatalogRepository.ts

import type { BackupSet, BackupPiece, ArchivedLog, DatafileCopy, BackupType } from './types'
import type { BackupKey } from '../values/BackupKey'
import type { Scn }       from '../values/Scn'
import type { RmanTag }   from '../values/RmanTag'

// ─── Lecture ─────────────────────────────────────────────────────────────

export interface IRmanCatalogReader {
  getAllBackupSets(): readonly BackupSet[]
  getBackupSet(key: BackupKey): BackupSet | null
  findBackupSetsByTag(tag: RmanTag): readonly BackupSet[]
  findBackupSetsByType(type: BackupType): readonly BackupSet[]
  /** Retourne les backup sets disponibles pour restaurer jusqu'au SCN donne */
  findBackupSetsForScn(targetScn: Scn): readonly BackupSet[]
  getArchivedLogs(): readonly ArchivedLog[]
  getArchivedLogBySequence(seq: number): ArchivedLog | null
  getArchivedLogsForRecovery(fromScn: Scn, toScn: Scn): readonly ArchivedLog[]
  getDatafileCopies(): readonly DatafileCopy[]
}

// ─── Ecriture ─────────────────────────────────────────────────────────────

export interface IRmanCatalogWriter {
  addBackupSet(bs: BackupSet): void
  updateBackupSetStatus(key: BackupKey, status: BackupSet['status']): void
  addArchivedLog(log: ArchivedLog): void
  deleteArchivedLog(recid: number): void
  addDatafileCopy(copy: DatafileCopy): void
  updateDatafileCopyStatus(recid: number, status: DatafileCopy['status']): void
  /** Vide completement le catalog (tests uniquement) */
  clear(): void
}

// ─── Interface complete ───────────────────────────────────────────────────

export interface IRmanCatalogRepository
  extends IRmanCatalogReader, IRmanCatalogWriter {}
```

### 4.4 Implementation InMemoryRmanCatalog

```typescript
// src/database/oracle/rman/catalog/InMemoryRmanCatalog.ts

import type { IRmanCatalogRepository } from './IRmanCatalogRepository'
import type { BackupSet, ArchivedLog, DatafileCopy, BackupType } from './types'
import type { BackupKey } from '../values/BackupKey'
import type { Scn }       from '../values/Scn'
import type { RmanTag }   from '../values/RmanTag'

export class InMemoryRmanCatalog implements IRmanCatalogRepository {
  private readonly backupSets   = new Map<number, BackupSet>()
  private readonly archivedLogs = new Map<number, ArchivedLog>()
  private readonly dfCopies     = new Map<number, DatafileCopy>()

  // ── Lecture ────────────────────────────────────────────────────────────

  getAllBackupSets(): readonly BackupSet[] {
    return [...this.backupSets.values()]
  }

  getBackupSet(key: BackupKey): BackupSet | null {
    return this.backupSets.get(key.value) ?? null
  }

  findBackupSetsByTag(tag: RmanTag): readonly BackupSet[] {
    return [...this.backupSets.values()]
      .filter(bs => bs.tag.value === tag.value)
  }

  findBackupSetsByType(type: BackupType): readonly BackupSet[] {
    return [...this.backupSets.values()]
      .filter(bs => bs.backupType === type)
  }

  findBackupSetsForScn(targetScn: Scn): readonly BackupSet[] {
    // Retourne les full + incrementaux dont le ckpScn <= targetScn
    return [...this.backupSets.values()]
      .filter(bs =>
        bs.status === 'AVAILABLE' &&
        bs.ckpScn.value <= targetScn.value &&
        (bs.backupObject === 'DATABASE' ||
         bs.backupObject === 'DATAFILE' ||
         bs.backupObject === 'TABLESPACE')
      )
      .sort((a, b) => a.ckpScn.value - b.ckpScn.value)
  }

  getArchivedLogs(): readonly ArchivedLog[] {
    return [...this.archivedLogs.values()]
  }

  getArchivedLogBySequence(seq: number): ArchivedLog | null {
    for (const log of this.archivedLogs.values()) {
      if (log.sequence === seq) return log
    }
    return null
  }

  getArchivedLogsForRecovery(fromScn: Scn, toScn: Scn): readonly ArchivedLog[] {
    return [...this.archivedLogs.values()]
      .filter(l =>
        l.status === 'A' &&
        l.firstScn.value >= fromScn.value &&
        l.nextScn.value  <= toScn.value
      )
      .sort((a, b) => a.sequence - b.sequence)
  }

  getDatafileCopies(): readonly DatafileCopy[] {
    return [...this.dfCopies.values()]
  }

  // ── Ecriture ───────────────────────────────────────────────────────────

  addBackupSet(bs: BackupSet): void {
    this.backupSets.set(bs.bsKey.value, bs)
  }

  updateBackupSetStatus(key: BackupKey, status: BackupSet['status']): void {
    const existing = this.backupSets.get(key.value)
    if (existing) {
      this.backupSets.set(key.value, { ...existing, status })
    }
  }

  addArchivedLog(log: ArchivedLog): void {
    this.archivedLogs.set(log.recid, log)
  }

  deleteArchivedLog(recid: number): void {
    const log = this.archivedLogs.get(recid)
    if (log) this.archivedLogs.set(recid, { ...log, status: 'D' })
  }

  addDatafileCopy(copy: DatafileCopy): void {
    this.dfCopies.set(copy.recid, copy)
  }

  updateDatafileCopyStatus(recid: number, status: DatafileCopy['status']): void {
    const existing = this.dfCopies.get(recid)
    if (existing) this.dfCopies.set(recid, { ...existing, status })
  }

  clear(): void {
    this.backupSets.clear()
    this.archivedLogs.clear()
    this.dfCopies.clear()
  }
}
```

### 4.5 BackupSetFactory — Factory Pattern

La creation d'un `BackupSet` necessite plusieurs parametres calcules (taille, SCN, tag...). Le Factory Pattern encapsule cette logique et garantit que chaque `BackupSet` est coherent des sa creation.

```typescript
// src/database/oracle/rman/catalog/BackupSetFactory.ts

import type { BackupSet, BackupPiece, BackupType, BackupObject } from './types'
import { BackupKey }     from '../values/BackupKey'
import { RmanTag }       from '../values/RmanTag'
import { Scn }           from '../values/Scn'
import type { DbId }     from '../values/DbId'

export interface BackupSetInput {
  dbId:           DbId
  backupType:     BackupType
  backupObject:   BackupObject
  objectNames:    readonly string[]
  tag?:           string
  ckpScn:         number
  ckpTime:        Date
  completionTime: Date
  elapsedSeconds: number
  sizeBytes:      number
  compressed:     boolean
  encrypted:      boolean
  deviceType:     'DISK' | 'SBT'
  pieces:         readonly BackupPiece[]
  keepForever?:   boolean
}

export function createBackupSet(input: BackupSetInput): BackupSet {
  const key = BackupKey.next()
  const tag = input.tag
    ? RmanTag.of(input.tag)
    : RmanTag.generate(input.completionTime)

  return Object.freeze({
    bsKey:          key,
    dbId:           input.dbId,
    backupType:     input.backupType,
    backupObject:   input.backupObject,
    objectNames:    Object.freeze([...input.objectNames]),
    tag,
    ckpScn:         Scn.of(input.ckpScn),
    ckpTime:        input.ckpTime,
    completionTime: input.completionTime,
    elapsedSeconds: input.elapsedSeconds,
    sizeBytes:      input.sizeBytes,
    compressed:     input.compressed,
    encrypted:      input.encrypted,
    deviceType:     input.deviceType,
    pieces:         Object.freeze([...input.pieces]),
    status:         'AVAILABLE' as const,
    keepForever:    input.keepForever ?? false,
  })
}
```

### 4.6 Diagramme de classe du catalog

```
IRmanCatalogRepository
  extends IRmanCatalogReader
  extends IRmanCatalogWriter
         |
         v
InMemoryRmanCatalog   (Map<number, BackupSet>, Map<number, ArchivedLog>)

BackupSetFactory.createBackupSet(input) --> BackupSet (immuable, Object.freeze)
                                         --> BackupPiece[] (immuable)

BackupSet       1 --* BackupPiece    (pieces embeddees, pas de FK externe)
BackupSet       *--1 DbId
BackupSet       *--1 RmanTag
BackupSet       *--1 Scn (ckpScn)

ArchivedLog     *--1 Scn (firstScn, nextScn)
DatafileCopy    *--1 Scn (ckpScn)
DatafileCopy    *--0..1 RmanTag
```

### 4.7 Principe Repository : separation domaine / persistence

```
COMMAND LAYER            DOMAIN                  PERSISTENCE
    |                      |                          |
BackupCommand  ------>  IRmanCatalogRepository  <---- InMemoryRmanCatalog
    |                      |                          |
ListCommand    ------>  IRmanCatalogReader       <---- (meme impl.)
    |                                                 |
                   Test doubles possible :            |
                   MockRmanCatalog()                  |
                   (sans VFS, sans Oracle)            |
```

Le catalog est **injecte** dans chaque commande via `RmanCommandContext` (section 7). Aucune commande ne connait `InMemoryRmanCatalog` directement — DIP respecte.

---

## 5. Canaux de sauvegarde — Composite + Strategy

### 5.1 Modele de canal RMAN

Un **canal** (channel) est l'unite de travail RMAN : il represente une connexion a un device type (DISK ou SBT/tape) sur lequel les backup pieces sont ecrites. Les canaux sont alloues avant un backup (automatiquement ou manuellement dans un bloc `RUN {}`), et liberes a la fin.

Caracteristiques reelles d'un canal Oracle :
- Parallelisme : N canaux = N pieces ecrites simultanement (simule sequentiellement ici)
- Chaque canal porte un SID Oracle unique
- Un canal DISK ecrit sur le filesystem local
- Un canal SBT utilise la Media Management Library (bande, OSB, etc.)

### 5.2 Strategy Pattern — IBackupDeviceStrategy

```typescript
// src/database/oracle/rman/channels/IBackupDeviceStrategy.ts

import type { Result } from '../result'
import type { RmanError } from '../RmanError'

export interface BackupWriteRequest {
  readonly handle:    string    // chemin/identifiant de la piece
  readonly content:   string    // contenu simule (metadata textuelle)
  readonly sizeHint:  number    // taille en octets (pour simulation)
}

export interface BackupReadRequest {
  readonly handle: string
}

/**
 * Strategie d'acces au device de sauvegarde.
 * DISK ecrit sur le VFS ; SBT simule un media manager.
 */
export interface IBackupDeviceStrategy {
  readonly deviceType: 'DISK' | 'SBT'

  /** Ecrit une piece de backup. Retourne l'handle confirme. */
  writePiece(req: BackupWriteRequest): Result<string, RmanError>

  /** Verifie qu'une piece existe (pour CROSSCHECK). */
  pieceExists(handle: string): boolean

  /** Supprime une piece (pour DELETE). */
  deletePiece(handle: string): Result<void, RmanError>
}
```

### 5.3 DiskDeviceStrategy — ecriture sur VFS

```typescript
// src/database/oracle/rman/channels/DiskDeviceStrategy.ts

import type { IBackupDeviceStrategy, BackupWriteRequest } from './IBackupDeviceStrategy'
import type { Result } from '../result'
import type { RmanError } from '../RmanError'
import { ok, err } from '../result'
import { makeRmanError } from '../RmanError'
import type { IRmanOracleContext } from '../integration/IRmanOracleContext'

export class DiskDeviceStrategy implements IBackupDeviceStrategy {
  readonly deviceType = 'DISK' as const

  constructor(private readonly ctx: IRmanOracleContext) {}

  writePiece(req: BackupWriteRequest): Result<string, RmanError> {
    // Cree les repertoires intermediaires si necessaire
    const dir = req.handle.substring(0, req.handle.lastIndexOf('/'))
    this.ctx.mkdirp(dir)

    const written = this.ctx.writeFile(req.handle, this.buildPieceContent(req))
    if (!written) {
      return err(makeRmanError('VFS_WRITE_ERROR',
        `writePiece: cannot write to ${req.handle}`))
    }
    return ok(req.handle)
  }

  pieceExists(handle: string): boolean {
    return this.ctx.fileExists(handle)
  }

  deletePiece(handle: string): Result<void, RmanError> {
    const deleted = this.ctx.deleteFile(handle)
    if (!deleted) {
      return err(makeRmanError('VFS_WRITE_ERROR',
        `deletePiece: cannot delete ${handle}`))
    }
    return ok(undefined)
  }

  private buildPieceContent(req: BackupWriteRequest): string {
    // Contenu simule : entete Oracle backup piece
    return [
      `RMAN BACKUP PIECE`,
      `Handle: ${req.handle}`,
      `Size: ${req.sizeHint} bytes`,
      `Created: ${new Date().toISOString()}`,
      `[Binary backup data — ${req.sizeHint} bytes]`,
    ].join('\n')
  }
}
```

### 5.4 SbtDeviceStrategy — simulation media manager

```typescript
// src/database/oracle/rman/channels/SbtDeviceStrategy.ts

import type { IBackupDeviceStrategy, BackupWriteRequest } from './IBackupDeviceStrategy'
import type { Result } from '../result'
import type { RmanError } from '../RmanError'
import { ok } from '../result'

/**
 * SBT (System Backup to Tape) — simule un media manager.
 * Les pieces SBT sont enregistrees en memoire (pas de VFS).
 * Reproduit le comportement d'Oracle Secure Backup ou NetBackup.
 */
export class SbtDeviceStrategy implements IBackupDeviceStrategy {
  readonly deviceType = 'SBT' as const
  private readonly _pieces = new Map<string, { size: number; created: Date }>()

  writePiece(req: BackupWriteRequest): Result<string, RmanError> {
    this._pieces.set(req.handle, { size: req.sizeHint, created: new Date() })
    return ok(req.handle)
  }

  pieceExists(handle: string): boolean {
    return this._pieces.has(handle)
  }

  deletePiece(handle: string): Result<void, RmanError> {
    this._pieces.delete(handle)
    return ok(undefined)
  }
}
```

### 5.5 IBackupChannel — interface d'un canal

```typescript
// src/database/oracle/rman/channels/IBackupChannel.ts

import type { Result } from '../result'
import type { RmanError } from '../RmanError'
import type { BackupPiece } from '../catalog/types'
import type { BackupWriteRequest } from './IBackupDeviceStrategy'
import type { Scn } from '../values/Scn'

export interface ChannelAllocationOptions {
  readonly name:        string           // ex. 'ORA_DISK_1'
  readonly deviceType:  'DISK' | 'SBT'
  readonly format?:     string           // format de piece (%d, %s, %p, %t)
  readonly maxpiecesize?: number         // bytes
  readonly parallelism?: number          // nb de pieces en parallele
}

export interface IBackupChannel {
  readonly name:       string
  readonly deviceType: 'DISK' | 'SBT'
  readonly sid:        number            // SID Oracle simule
  readonly isAllocated: boolean

  /** Alloue le canal (ouvre une connexion) */
  allocate(): Result<void, RmanError>

  /** Ecrit une piece et retourne les metadata de la piece */
  writePiece(
    req: BackupWriteRequest,
    pieceNum: number,
    bsKey: number,
    ckpScn: Scn,
  ): Result<BackupPiece, RmanError>

  /** Verifie qu'une piece existe (CROSSCHECK) */
  crosscheck(handle: string): 'AVAILABLE' | 'EXPIRED'

  /** Supprime une piece du device */
  deletePiece(handle: string): Result<void, RmanError>

  /** Libere le canal */
  release(): void

  /** Representation pour l'affichage (ex. "channel ORA_DISK_1: SID=142 device type=DISK") */
  toStatusLine(): string
}
```

### 5.6 ConcreteBackupChannel — implementation

```typescript
// src/database/oracle/rman/channels/ConcreteBackupChannel.ts

import type { IBackupChannel, ChannelAllocationOptions } from './IBackupChannel'
import type { IBackupDeviceStrategy, BackupWriteRequest } from './IBackupDeviceStrategy'
import type { Result } from '../result'
import type { RmanError } from '../RmanError'
import type { BackupPiece } from '../catalog/types'
import type { Scn } from '../values/Scn'
import type { RmanTag } from '../values/RmanTag'
import { ok, err } from '../result'
import { makeRmanError } from '../RmanError'

let _sidCounter = 100

export class ConcreteBackupChannel implements IBackupChannel {
  readonly name:       string
  readonly deviceType: 'DISK' | 'SBT'
  readonly sid:        number
  private _allocated   = false
  private readonly _format: string
  private readonly _strategy: IBackupDeviceStrategy

  constructor(opts: ChannelAllocationOptions, strategy: IBackupDeviceStrategy) {
    this.name       = opts.name
    this.deviceType = opts.deviceType
    this.sid        = _sidCounter++
    this._format    = opts.format ?? ''
    this._strategy  = strategy
  }

  get isAllocated(): boolean { return this._allocated }

  allocate(): Result<void, RmanError> {
    if (this._allocated) return ok(undefined)
    this._allocated = true
    return ok(undefined)
  }

  writePiece(
    req: BackupWriteRequest,
    pieceNum: number,
    bsKey: number,
    ckpScn: Scn,
  ): Result<BackupPiece, RmanError> {
    if (!this._allocated) {
      return err(makeRmanError('RMAN_03009',
        `allocate command on channel ${this.name}: channel not allocated`))
    }

    const result = this._strategy.writePiece(req)
    if (!result.ok) return result

    const piece: BackupPiece = {
      bpKey:          bsKey * 100 + pieceNum,
      bsKey,
      pieceNum,
      handle:         result.value,
      tag:            { _tag: 'RmanTag', value: '' } as RmanTag,  // sera rempli par la commande
      deviceType:     this.deviceType,
      sizeBytes:      req.sizeHint,
      compressed:     false,
      encrypted:      false,
      status:         'AVAILABLE',
      completionTime: new Date(),
    }
    return ok(piece)
  }

  crosscheck(handle: string): 'AVAILABLE' | 'EXPIRED' {
    return this._strategy.pieceExists(handle) ? 'AVAILABLE' : 'EXPIRED'
  }

  deletePiece(handle: string): Result<void, RmanError> {
    return this._strategy.deletePiece(handle)
  }

  release(): void {
    this._allocated = false
  }

  toStatusLine(): string {
    return `channel ${this.name}: SID=${this.sid} device type=${this.deviceType}`
  }
}
```

### 5.7 ChannelPool — Composite Pattern

Le `ChannelPool` gere une collection de canaux et permet les operations en lot : allouer tous les canaux d'un `RUN {}` bloc, ecrire en parallele (simule), liberer apres la commande.

```typescript
// src/database/oracle/rman/channels/ChannelPool.ts

import type { IBackupChannel, ChannelAllocationOptions } from './IBackupChannel'
import type { Result } from '../result'
import type { RmanError } from '../RmanError'
import { ok, err } from '../result'
import { makeRmanError } from '../RmanError'
import { sequence } from '../result'

export class ChannelPool {
  private readonly _channels: IBackupChannel[] = []

  add(channel: IBackupChannel): void {
    this._channels.push(channel)
  }

  /** Alloue tous les canaux. Arrete a la premiere erreur. */
  allocateAll(): Result<readonly IBackupChannel[], RmanError> {
    const results = this._channels.map(ch => ch.allocate().ok
      ? { ok: true as const, value: ch }
      : ch.allocate()
    )
    // Retourne les canaux ou la premiere erreur
    for (const ch of this._channels) {
      const r = ch.allocate()
      if (!r.ok) return r
    }
    return ok([...this._channels])
  }

  /** Libere tous les canaux (appele en fin de bloc RUN ou de commande) */
  releaseAll(): void {
    for (const ch of this._channels) ch.release()
  }

  /** Premier canal disponible pour une operation (parallelisme simule = round-robin) */
  getChannel(index = 0): IBackupChannel | null {
    return this._channels[index % this._channels.length] ?? null
  }

  get count(): number { return this._channels.length }
  get all(): readonly IBackupChannel[] { return [...this._channels] }
  clear(): void { this._channels.length = 0 }
}
```

### 5.8 ChannelAllocator — fabrique de canaux selon la configuration

```typescript
// src/database/oracle/rman/channels/ChannelAllocator.ts

import { ConcreteBackupChannel } from './ConcreteBackupChannel'
import { DiskDeviceStrategy }    from './DiskDeviceStrategy'
import { SbtDeviceStrategy }     from './SbtDeviceStrategy'
import { ChannelPool }           from './ChannelPool'
import type { RmanConfig }       from '../config/RmanConfig'
import type { IRmanOracleContext } from '../integration/IRmanOracleContext'

export class ChannelAllocator {
  constructor(
    private readonly config: RmanConfig,
    private readonly ctx: IRmanOracleContext,
  ) {}

  /**
   * Cree un ChannelPool automatique base sur la configuration RMAN.
   * Reproduit le comportement de CONFIGURE DEFAULT DEVICE TYPE et
   * CONFIGURE DEVICE TYPE DISK PARALLELISM N.
   */
  createAutoPool(): ChannelPool {
    const pool = new ChannelPool()
    const parallelism = this.config.parallelism
    const deviceType  = this.config.defaultDeviceType

    for (let i = 1; i <= parallelism; i++) {
      const strategy = deviceType === 'DISK'
        ? new DiskDeviceStrategy(this.ctx)
        : new SbtDeviceStrategy()

      const channel = new ConcreteBackupChannel(
        { name: `ORA_${deviceType}_${i}`, deviceType, format: this.config.pieceFormat },
        strategy,
      )
      pool.add(channel)
    }
    return pool
  }

  /** Cree un canal unique avec des options explicites (bloc RUN ALLOCATE CHANNEL) */
  createExplicitChannel(
    name: string,
    deviceType: 'DISK' | 'SBT',
    format?: string,
  ): ConcreteBackupChannel {
    const strategy = deviceType === 'DISK'
      ? new DiskDeviceStrategy(this.ctx)
      : new SbtDeviceStrategy()
    return new ConcreteBackupChannel({ name, deviceType, format }, strategy)
  }
}
```

### 5.9 Diagramme du sous-systeme canaux

```
ChannelAllocator
  - createAutoPool()      --> ChannelPool (Composite)
  - createExplicitChannel --> ConcreteBackupChannel

ChannelPool (Composite)
  +-- IBackupChannel[]
  - allocateAll()  releaseAll()  getChannel()

ConcreteBackupChannel implements IBackupChannel
  |
  +-- IBackupDeviceStrategy (Strategy)
        |
        +-- DiskDeviceStrategy   --> IRmanOracleContext.writeFile() / fileExists()
        +-- SbtDeviceStrategy    --> Map<string, PieceInfo> (in-memory)

Strategy Pattern : ajouter NFS, SMB, OSB = implementer IBackupDeviceStrategy
                   zero modification dans ConcreteBackupChannel
```

---

