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

## 6. Politique de retention — Strategy Pattern

### 6.1 Contexte Oracle

La politique de retention RMAN (`CONFIGURE RETENTION POLICY`) determine quels backups sont consideres comme **obsoletes** et peuvent etre supprimes. Oracle supporte deux strategies mutuellement exclusives :

- `REDUNDANCY n` : garde au moins N copies completes de chaque datafile
- `RECOVERY WINDOW OF n DAYS` : garantit la possibilite de restaurer jusqu'a N jours en arriere
- `NONE` : ne supprime rien (conservation indefinie)

Le choix de la strategie n'impacte aucune autre logique — c'est le cas d'ecole du **Strategy Pattern**.

### 6.2 RmanConfig — objet de configuration immuable

La configuration RMAN est un objet de valeur. Chaque `CONFIGURE` produit un nouvel objet.

```typescript
// src/database/oracle/rman/config/RmanConfig.ts

export type RetentionPolicyType = 'REDUNDANCY' | 'RECOVERY_WINDOW' | 'NONE'
export type DeviceType          = 'DISK' | 'SBT'
export type BackupTypeConfig    = 'BACKUPSET' | 'COPY'

export interface RmanConfig {
  readonly retentionPolicyType:  RetentionPolicyType
  readonly retentionValue:       number     // redondance N ou fenetre N jours
  readonly defaultDeviceType:    DeviceType
  readonly parallelism:          number
  readonly backupType:           BackupTypeConfig
  readonly pieceFormat:          string     // format CONFIGURE ... FORMAT
  readonly archivelogFormat:     string
  readonly controlfileAutobackup: boolean
  readonly controlfileAutobackupFormat: string
  readonly compressionAlgorithm: 'BASIC' | 'LOW' | 'MEDIUM' | 'HIGH' | 'NONE'
  readonly encryptionEnabled:    boolean
  readonly encryptionAlgorithm:  'AES128' | 'AES192' | 'AES256'
  readonly maxsetsize:           number     // 0 = UNLIMITED
  readonly archivelogDeletionPolicy: 'NONE' | 'APPLIED ON ALL STANDBY' | 'SHIPPED TO ALL STANDBY'
  readonly datafileBackupCopies: number
  readonly archivelogBackupCopies: number
  readonly backupOptimization:   boolean
  readonly channel1Format?:      string     // CONFIGURE CHANNEL 1 FORMAT
}

export const DEFAULT_RMAN_CONFIG: RmanConfig = Object.freeze({
  retentionPolicyType:          'REDUNDANCY',
  retentionValue:               1,
  defaultDeviceType:            'DISK',
  parallelism:                  1,
  backupType:                   'BACKUPSET',
  pieceFormat:                  '%F',
  archivelogFormat:             '%F',
  controlfileAutobackup:        true,
  controlfileAutobackupFormat:  '%F',
  compressionAlgorithm:         'NONE',
  encryptionEnabled:            false,
  encryptionAlgorithm:          'AES128',
  maxsetsize:                   0,
  archivelogDeletionPolicy:     'NONE',
  datafileBackupCopies:         1,
  archivelogBackupCopies:       1,
  backupOptimization:           false,
})

/** Produit un nouveau RmanConfig avec les champs modifies (immuable) */
export function withConfig(
  base: RmanConfig,
  overrides: Partial<RmanConfig>
): RmanConfig {
  return Object.freeze({ ...base, ...overrides })
}
```

### 6.3 IRetentionPolicy — interface Strategy

```typescript
// src/database/oracle/rman/retention/IRetentionPolicy.ts

import type { BackupSet } from '../catalog/types'
import type { Scn } from '../values/Scn'

export interface RetentionContext {
  /** Tous les backup sets disponibles dans le catalog */
  readonly allBackupSets: readonly BackupSet[]
  /** SCN courant de la base */
  readonly currentScn: Scn
  /** Date courante (injectee pour testabilite) */
  readonly now: Date
  /** Dbids des datafiles (pour calculer la couverture par fichier) */
  readonly datafileCount: number
}

/**
 * Calcule quels BackupSets sont obsoletes selon la politique.
 * Fonction pure : RetentionContext en entree, ensemble de cles obsoletes en sortie.
 */
export interface IRetentionPolicy {
  readonly type: string
  /** Retourne les keys des backup sets obsoletes selon cette politique */
  computeObsolete(ctx: RetentionContext): ReadonlySet<number>
  /** Description lisible pour SHOW ALL */
  toConfigString(): string
}
```

### 6.4 RedundancyPolicy — REDUNDANCY N

```typescript
// src/database/oracle/rman/retention/RedundancyPolicy.ts

import type { IRetentionPolicy, RetentionContext } from './IRetentionPolicy'
import type { BackupSet } from '../catalog/types'

/**
 * Strategie REDUNDANCY N :
 * Pour chaque datafile, garde les N backups les plus recents.
 * Tout backup plus ancien que le Neme est obsolete.
 *
 * Algorithme Oracle : trie par completionTime desc,
 * marque comme obsolete tout backup au-dela du N-eme rang.
 */
export class RedundancyPolicy implements IRetentionPolicy {
  readonly type = 'REDUNDANCY'

  constructor(private readonly n: number) {}

  computeObsolete(ctx: RetentionContext): ReadonlySet<number> {
    const obsolete = new Set<number>()

    // Filtre les backups de type DATABASE/DATAFILE/TABLESPACE (pas ARCHIVELOG)
    const databaseBackups = ctx.allBackupSets
      .filter(bs =>
        bs.status === 'AVAILABLE' &&
        !bs.keepForever &&
        (bs.backupObject === 'DATABASE' ||
         bs.backupObject === 'DATAFILE' ||
         bs.backupObject === 'TABLESPACE')
      )
      .sort((a, b) => b.completionTime.getTime() - a.completionTime.getTime())

    // Si on a plus de N backups, les plus anciens sont obsoletes
    const toKeep = databaseBackups.slice(0, this.n)
    const toKeepKeys = new Set(toKeep.map(bs => bs.bsKey.value))

    for (const bs of databaseBackups) {
      if (!toKeepKeys.has(bs.bsKey.value)) {
        obsolete.add(bs.bsKey.value)
      }
    }
    return obsolete
  }

  toConfigString(): string {
    return `CONFIGURE RETENTION POLICY TO REDUNDANCY ${this.n};`
  }
}
```

### 6.5 RecoveryWindowPolicy — RECOVERY WINDOW OF N DAYS

```typescript
// src/database/oracle/rman/retention/RecoveryWindowPolicy.ts

import type { IRetentionPolicy, RetentionContext } from './IRetentionPolicy'

/**
 * Strategie RECOVERY WINDOW OF N DAYS :
 * Tout backup qui n'est plus necessaire pour garantir la restauration
 * jusqu'a (now - N jours) est obsolete.
 *
 * Un backup est "necessaire" si :
 *   1. C'est le backup le plus recent avant la fenetre de recovery
 *   2. Ou il est dans la fenetre de recovery
 */
export class RecoveryWindowPolicy implements IRetentionPolicy {
  readonly type = 'RECOVERY_WINDOW'

  constructor(private readonly days: number) {}

  computeObsolete(ctx: RetentionContext): ReadonlySet<number> {
    const obsolete = new Set<number>()
    const cutoff = new Date(ctx.now.getTime() - this.days * 86_400_000)

    const databaseBackups = ctx.allBackupSets
      .filter(bs =>
        bs.status === 'AVAILABLE' &&
        !bs.keepForever &&
        (bs.backupObject === 'DATABASE' ||
         bs.backupObject === 'DATAFILE' ||
         bs.backupObject === 'TABLESPACE')
      )
      .sort((a, b) => b.completionTime.getTime() - a.completionTime.getTime())

    // Trouve le backup le plus recent qui couvre la fenetre
    let foundAnchor = false
    for (const bs of databaseBackups) {
      if (!foundAnchor && bs.completionTime <= cutoff) {
        // Ce backup est l'ancre — il est necessaire, tous les suivants sont obsoletes
        foundAnchor = true
        continue
      }
      if (foundAnchor) {
        obsolete.add(bs.bsKey.value)
      }
    }
    return obsolete
  }

  toConfigString(): string {
    return `CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF ${this.days} DAYS;`
  }
}
```

### 6.6 NonePolicy et RetentionPolicyFactory

```typescript
// src/database/oracle/rman/retention/NonePolicy.ts

import type { IRetentionPolicy, RetentionContext } from './IRetentionPolicy'

/** NONE : aucun backup n'est jamais obsolete */
export class NonePolicy implements IRetentionPolicy {
  readonly type = 'NONE'
  computeObsolete(_ctx: RetentionContext): ReadonlySet<number> {
    return new Set()
  }
  toConfigString(): string {
    return 'CONFIGURE RETENTION POLICY TO NONE;'
  }
}

// src/database/oracle/rman/retention/RetentionPolicyFactory.ts

import type { RmanConfig } from '../config/RmanConfig'
import type { IRetentionPolicy } from './IRetentionPolicy'
import { RedundancyPolicy }    from './RedundancyPolicy'
import { RecoveryWindowPolicy } from './RecoveryWindowPolicy'
import { NonePolicy }          from './NonePolicy'

export function createRetentionPolicy(config: RmanConfig): IRetentionPolicy {
  switch (config.retentionPolicyType) {
    case 'REDUNDANCY':      return new RedundancyPolicy(config.retentionValue)
    case 'RECOVERY_WINDOW': return new RecoveryWindowPolicy(config.retentionValue)
    case 'NONE':            return new NonePolicy()
  }
}
```

### 6.7 RmanRetentionEngine — orchestration pure

```typescript
// src/database/oracle/rman/retention/RmanRetentionEngine.ts

import type { IRmanCatalogReader } from '../catalog/IRmanCatalogRepository'
import type { IRetentionPolicy, RetentionContext } from './IRetentionPolicy'
import type { BackupSet } from '../catalog/types'
import type { Scn } from '../values/Scn'

/**
 * Moteur de retention — fonctions pures sans etat propre.
 * Calcule les obsoletes, les expired, le rapport NEED BACKUP.
 */
export const RmanRetentionEngine = {

  /** Retourne les BackupSets obsoletes selon la politique courante */
  getObsolete(
    catalog: IRmanCatalogReader,
    policy: IRetentionPolicy,
    currentScn: Scn,
    now: Date,
  ): readonly BackupSet[] {
    const ctx: RetentionContext = {
      allBackupSets: catalog.getAllBackupSets(),
      currentScn,
      now,
      datafileCount: 4, // SYSTEM, SYSAUX, UNDOTBS, USERS
    }
    const obsoleteKeys = policy.computeObsolete(ctx)
    return catalog.getAllBackupSets()
      .filter(bs => obsoleteKeys.has(bs.bsKey.value))
  },

  /** Retourne les BackupSets marques EXPIRED (crosscheck a echoue) */
  getExpired(catalog: IRmanCatalogReader): readonly BackupSet[] {
    return catalog.getAllBackupSets().filter(bs => bs.status === 'EXPIRED')
  },

  /**
   * REPORT NEED BACKUP : datafiles qui n'ont pas de backup recant
   * selon la politique courante.
   */
  getFilesNeedingBackup(
    catalog: IRmanCatalogReader,
    policy: IRetentionPolicy,
    currentScn: Scn,
    now: Date,
    datafiles: readonly { num: number; name: string; sizeBytes: number }[],
  ): readonly { fileNum: number; backups: number; name: string }[] {
    const allBs = catalog.getAllBackupSets()
      .filter(bs => bs.status === 'AVAILABLE')

    return datafiles
      .map(df => {
        const backupsForFile = allBs.filter(bs =>
          bs.backupObject === 'DATABASE' ||
          (bs.backupObject === 'DATAFILE' && bs.objectNames.includes(df.name)) ||
          (bs.backupObject === 'TABLESPACE')
        ).length

        return { fileNum: df.num, backups: backupsForFile, name: df.name }
      })
      .filter(entry => {
        if (policy.type === 'REDUNDANCY') return entry.backups === 0
        return entry.backups === 0
      })
  },
}
```

### 6.8 Diagramme Strategy de retention

```
IRetentionPolicy
  +-- RedundancyPolicy(n)          CONFIGURE RETENTION POLICY TO REDUNDANCY N
  +-- RecoveryWindowPolicy(days)   CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF N DAYS
  +-- NonePolicy                   CONFIGURE RETENTION POLICY TO NONE

RetentionPolicyFactory.createRetentionPolicy(config) --> IRetentionPolicy

RmanRetentionEngine (module de fonctions pures)
  getObsolete(catalog, policy, scn, now) --> BackupSet[]
  getExpired(catalog)                    --> BackupSet[]
  getFilesNeedingBackup(...)             --> FileNeedBackup[]

Principe Open/Closed :
  ajouter REDUNDANCY + RECOVERY WINDOW combine = nouvelle classe KeepWindowPolicy
  zero modification dans RmanRetentionEngine ou dans les commandes
```

---

## 7. Commandes RMAN — Command Pattern + Open/Closed

### 7.1 Pourquoi le Command Pattern ?

L'implementation actuelle de `RmanSubShell` est un `switch` monolithique de 300+ lignes. Ajouter une nouvelle commande (`BACKUP INCREMENTAL`) necessite modifier ce switch — violation directe de l'**Open/Closed Principle**.

Avec le **Command Pattern** :
- Chaque commande RMAN est une classe independante implementant `IRmanCommand`
- `RmanCommandDispatcher` est un registre statique
- Ajouter une commande = creer un fichier, l'enregistrer — zero modification ailleurs

### 7.2 RmanCommandContext — contexte d'execution injecte

```typescript
// src/database/oracle/rman/commands/RmanCommandContext.ts

import type { IRmanCatalogRepository } from '../catalog/IRmanCatalogRepository'
import type { ChannelPool }            from '../channels/ChannelPool'
import type { ChannelAllocator }       from '../channels/ChannelAllocator'
import type { RmanConfig }             from '../config/RmanConfig'
import type { IRetentionPolicy }       from '../retention/IRetentionPolicy'
import type { RmanRetentionEngine }    from '../retention/RmanRetentionEngine'
import type { IRmanOracleContext }     from '../integration/IRmanOracleContext'
import type { IRmanEventBus }          from '../events/IRmanEventBus'
import type { DbId }                   from '../values/DbId'
import type { Scn }                    from '../values/Scn'

/**
 * Contexte immuable passe a chaque commande RMAN.
 * Toutes les dependances sont des interfaces — DIP respecte.
 */
export interface RmanCommandContext {
  readonly catalog:          IRmanCatalogRepository
  readonly channelPool:      ChannelPool
  readonly channelAllocator: ChannelAllocator
  readonly config:           RmanConfig
  readonly retentionPolicy:  IRetentionPolicy
  readonly oracleCtx:        IRmanOracleContext
  readonly eventBus:         IRmanEventBus
  readonly dbId:             DbId
  readonly currentScn:       Scn
  readonly now:              Date
  /** Met a jour la config (retourne nouvelle config immuable, stockee dans RmanSession) */
  readonly updateConfig:     (fn: (c: RmanConfig) => RmanConfig) => void
}
```

### 7.3 IRmanCommand<T> — interface generique

```typescript
// src/database/oracle/rman/commands/IRmanCommand.ts

import type { Result }           from '../result'
import type { RmanError }        from '../RmanError'
import type { RmanOutput }       from '../RmanOutput'
import type { RmanCommandContext } from './RmanCommandContext'

/**
 * Contrat de toute commande RMAN.
 * T = type de la valeur de retour (void pour la plupart).
 *
 * La methode execute retourne un Result<RmanOutput, RmanError> :
 * - ok(output)  = commande executee avec succes (peut contenir des warnings)
 * - err(error)  = echec ; RmanSession affichera le stack d'erreur
 */
export interface IRmanCommand<T = void> {
  /** Identifiant unique de la commande pour le registre */
  readonly op: string

  /**
   * Execute la commande avec les arguments tokenises et le contexte injecte.
   * @param tokens  Tableau de tokens (deja tokenise par RmanScriptParser)
   * @param ctx     Contexte d'execution injecte
   */
  execute(
    tokens: readonly string[],
    ctx: RmanCommandContext,
  ): Result<RmanOutput, RmanError>
}
```

### 7.4 Commandes principales : catalogue des implementations

#### BackupCommand — BACKUP DATABASE/TABLESPACE/ARCHIVELOG

```typescript
// src/database/oracle/rman/commands/BackupCommand.ts
// op: 'BACKUP'

// Syntaxe supportee :
//   BACKUP [INCREMENTAL LEVEL 0|1] [CUMULATIVE]
//          (DATABASE | TABLESPACE name,... | DATAFILE n,... |
//           ARCHIVELOG ALL | ARCHIVELOG FROM SCN n | CURRENT CONTROLFILE | SPFILE)
//          [TAG 'xxx'] [FORMAT 'fmt'] [MAXPIECESIZE n]
//          [COMPRESSED] [ENCRYPTED] [DELETE INPUT]
//          [VALIDATE]   (no-write check)
//          [KEEP {FOREVER | UNTIL TIME 'date'}]
//          [PLUS ARCHIVELOG [DELETE INPUT]]
//
// Exemple de sortie :
//   Starting backup at 05-MAY-2026 14:23:01
//   allocated channel: ORA_DISK_1
//   channel ORA_DISK_1: SID=142 device type=DISK
//   channel ORA_DISK_1: starting full datafile backup set
//   channel ORA_DISK_1: specifying datafile(s) in backup set
//   channel ORA_DISK_1: backing up database
//   piece handle=/u01/app/oracle/fast_recovery_area/ORCL/ORCL-1234567890-20260505-01.bkp tag=TAG20260505T142301
//   channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15
//   Finished backup at 05-MAY-2026 14:23:16
```

#### RestoreCommand — RESTORE DATABASE/TABLESPACE/DATAFILE

```typescript
// src/database/oracle/rman/commands/RestoreCommand.ts
// op: 'RESTORE'

// Pre-conditions verificees :
//   - DB doit etre en MOUNT (pour RESTORE DATABASE)
//   - DB peut etre OPEN pour RESTORE TABLESPACE OFFLINE
//   - Au moins un BackupSet disponible dans le catalog
//
// Syntaxe supportee :
//   RESTORE (DATABASE | TABLESPACE name | DATAFILE n)
//           [FROM TAG 'xxx'] [UNTIL (SCN n | TIME 'date' | SEQUENCE n THREAD n)]
//           [PREVIEW] [VALIDATE]
//
// Exemple de sortie :
//   Starting restore at 05-MAY-2026 14:25:01
//   using channel ORA_DISK_1
//   channel ORA_DISK_1: starting datafile backup set restore
//   channel ORA_DISK_1: restoring datafile 00001 to /u01/.../system01.dbf
//   channel ORA_DISK_1: restore complete, elapsed time: 00:00:25
//   Finished restore at 05-MAY-2026 14:25:26
```

#### RecoverCommand — RECOVER DATABASE/TABLESPACE

```typescript
// src/database/oracle/rman/commands/RecoverCommand.ts
// op: 'RECOVER'

// Pre-conditions :
//   - DB en MOUNT (RECOVER DATABASE) ou tablespace offline (RECOVER TABLESPACE)
//   - Des archivelogs disponibles dans le catalog depuis le dernier ckpScn
//
// Syntaxe :
//   RECOVER (DATABASE | TABLESPACE name | DATAFILE n)
//           [UNTIL (SCN n | TIME 'date' | CANCEL)]
//           [USING BACKUP CONTROLFILE]
//
// Exemple :
//   Starting recover at 05-MAY-2026 14:26:01
//   using channel ORA_DISK_1
//   starting media recovery
//   archived log for thread 1 with sequence 42 is already on disk as file /u01/.../arch_1_42.arc
//   media recovery complete, elapsed time: 00:00:03
//   Finished recover at 05-MAY-2026 14:26:04
```

#### ListCommand — LIST BACKUP/ARCHIVELOG/COPY

```typescript
// src/database/oracle/rman/commands/ListCommand.ts
// op: 'LIST'

// Syntaxe :
//   LIST BACKUP [SUMMARY | OF DATABASE | BY BACKUP | BY FILE]
//   LIST COPY [OF DATABASE | OF TABLESPACE name]
//   LIST ARCHIVELOG ALL
//   LIST EXPIRED BACKUP
//   LIST OBSOLETE
//
// Consulte IRmanCatalogReader uniquement — zero effet de bord.
```

#### ReportCommand — REPORT SCHEMA/NEED BACKUP/OBSOLETE

```typescript
// src/database/oracle/rman/commands/ReportCommand.ts
// op: 'REPORT'

// Syntaxe :
//   REPORT SCHEMA
//   REPORT NEED BACKUP [REDUNDANCY n | RECOVERY WINDOW n | DAYS n]
//   REPORT OBSOLETE [REDUNDANCY n | RECOVERY WINDOW n | ORPHAN]
//   REPORT UNRECOVERABLE
```

#### CrosscheckCommand — CROSSCHECK BACKUP/ARCHIVELOG

```typescript
// src/database/oracle/rman/commands/CrosscheckCommand.ts
// op: 'CROSSCHECK'

// Verifie l'existence physique de chaque piece sur le VFS via IBackupDeviceStrategy.
// Met a jour le status 'AVAILABLE'|'EXPIRED' dans le catalog.
//
// Sortie :
//   allocated channel: ORA_DISK_1
//   crosschecked backup piece: found to be 'AVAILABLE'
//   crosschecked backup piece: found to be 'EXPIRED'
//   Crosschecked N objects
```

#### DeleteCommand — DELETE EXPIRED/OBSOLETE/BACKUPSET

```typescript
// src/database/oracle/rman/commands/DeleteCommand.ts
// op: 'DELETE'

// Syntaxe :
//   DELETE [NOPROMPT] EXPIRED BACKUP
//   DELETE [NOPROMPT] OBSOLETE
//   DELETE [NOPROMPT] BACKUP TAG 'xxx'
//   DELETE [NOPROMPT] BACKUPSET n
//   DELETE [NOPROMPT] ARCHIVELOG ALL [BACKED UP n TIMES TO DEVICE TYPE DISK]
//
// Appelle IBackupDeviceStrategy.deletePiece() puis met a jour le catalog.
```

#### ConfigureCommand — CONFIGURE ...

```typescript
// src/database/oracle/rman/commands/ConfigureCommand.ts
// op: 'CONFIGURE'

// Syntaxe :
//   CONFIGURE RETENTION POLICY TO (REDUNDANCY n | RECOVERY WINDOW OF n DAYS | NONE)
//   CONFIGURE DEFAULT DEVICE TYPE TO (DISK | SBT)
//   CONFIGURE DEVICE TYPE DISK PARALLELISM n BACKUP TYPE TO BACKUPSET
//   CONFIGURE CONTROLFILE AUTOBACKUP (ON | OFF)
//   CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO 'fmt'
//   CONFIGURE COMPRESSION ALGORITHM 'ALG'
//   CONFIGURE ENCRYPTION FOR DATABASE (ON | OFF)
//   CONFIGURE MAXSETSIZE TO (n [K|M|G] | UNLIMITED)
//   CONFIGURE BACKUP OPTIMIZATION (ON | OFF)
//   CONFIGURE CHANNEL n DEVICE TYPE DISK FORMAT 'fmt'
//   CONFIGURE ARCHIVELOG DELETION POLICY TO (NONE | APPLIED ON ALL STANDBY)
//
// Appelle ctx.updateConfig(c => withConfig(c, {...})) — immuabilite garantie.
```

#### ShowCommand — SHOW ALL/RETENTION POLICY/...

```typescript
// src/database/oracle/rman/commands/ShowCommand.ts
// op: 'SHOW'

// Syntaxe :
//   SHOW ALL
//   SHOW RETENTION POLICY
//   SHOW DEFAULT DEVICE TYPE
//   SHOW CONTROLFILE AUTOBACKUP
//
// Lit ctx.config et formate CONFIGURE statements.
// Zero effet de bord — lecture pure.
```

#### ConnectCommand — CONNECT TARGET

```typescript
// src/database/oracle/rman/commands/ConnectCommand.ts
// op: 'CONNECT'

// Syntaxe :
//   CONNECT TARGET [username/password@service | /]
//
// Valide l'etat de l'instance via IRmanOracleContext.getInstanceState().
// Met a jour RmanSessionState (via ctx.updateConfig — ou plutot via RmanSession).
```

### 7.5 RmanCommandDispatcher — registre Open/Closed

```typescript
// src/database/oracle/rman/commands/RmanCommandDispatcher.ts

import type { IRmanCommand }        from './IRmanCommand'
import type { RmanCommandContext }  from './RmanCommandContext'
import type { RmanOutput }          from '../RmanOutput'
import type { Result }              from '../result'
import type { RmanError }           from '../RmanError'
import { err }                      from '../result'
import { makeRmanError }            from '../RmanError'
import { outputError }              from '../RmanOutput'

export class RmanCommandDispatcher {
  private readonly _registry = new Map<string, IRmanCommand<unknown>>()

  register(command: IRmanCommand<unknown>): this {
    this._registry.set(command.op.toUpperCase(), command)
    return this
  }

  dispatch(
    tokens: readonly string[],
    ctx: RmanCommandContext,
  ): Result<RmanOutput, RmanError> {
    if (tokens.length === 0) {
      return err(makeRmanError('RMAN_00558',
        'error encountered while parsing input command'))
    }

    const op = tokens[0].toUpperCase()
    const command = this._registry.get(op)

    if (!command) {
      return err(makeRmanError('RMAN_01009',
        `syntax error: found identifier "${tokens[0]}"`, 1))
    }

    return command.execute(tokens, ctx) as Result<RmanOutput, RmanError>
  }

  /** Liste toutes les commandes enregistrees (pour HELP) */
  getRegisteredOps(): readonly string[] {
    return [...this._registry.keys()].sort()
  }
}

// ─── Factory : dispatcher pre-configure avec toutes les commandes standard ──

import { BackupCommand }     from './BackupCommand'
import { RestoreCommand }    from './RestoreCommand'
import { RecoverCommand }    from './RecoverCommand'
import { ListCommand }       from './ListCommand'
import { ReportCommand }     from './ReportCommand'
import { CrosscheckCommand } from './CrosscheckCommand'
import { DeleteCommand }     from './DeleteCommand'
import { ConfigureCommand }  from './ConfigureCommand'
import { ShowCommand }       from './ShowCommand'
import { ConnectCommand }    from './ConnectCommand'
import { CatalogCommand }    from './CatalogCommand'
import { DuplicateCommand }  from './DuplicateCommand'
import { ValidateCommand }   from './ValidateCommand'

export function createDefaultDispatcher(): RmanCommandDispatcher {
  return new RmanCommandDispatcher()
    .register(new BackupCommand())
    .register(new RestoreCommand())
    .register(new RecoverCommand())
    .register(new ListCommand())
    .register(new ReportCommand())
    .register(new CrosscheckCommand())
    .register(new DeleteCommand())
    .register(new ConfigureCommand())
    .register(new ShowCommand())
    .register(new ConnectCommand())
    .register(new CatalogCommand())
    .register(new DuplicateCommand())
    .register(new ValidateCommand())
}
```

### 7.6 Principe Open/Closed — illustration concrete

```
Avant (switch monolithique) :
  Ajouter BACKUP VALIDATE --> modifier RmanSubShell.processLine() (risque de regression)

Apres (Command + Registry) :
  Ajouter BACKUP VALIDATE --> creer ValidateCommand.ts
                          --> enregistrer dans createDefaultDispatcher()
                          --> ZERO autre fichier modifie

Extension : DUPLICATE DATABASE
  createDefaultDispatcher().register(new DuplicateCommand())
  DuplicateCommand.op = 'DUPLICATE'
  Aucune modification dans RmanCommandDispatcher, RmanSession, RmanSubShell.
```

### 7.7 IRmanEventBus — Observer Pattern pour la progression

```typescript
// src/database/oracle/rman/events/IRmanEventBus.ts

export type RmanEventType =
  | 'CHANNEL_ALLOCATED'    // canal alloue
  | 'BACKUP_STARTED'       // debut d'un backup set
  | 'PIECE_WRITTEN'        // piece ecrite sur le device
  | 'BACKUP_COMPLETED'     // backup set termine
  | 'RESTORE_STARTED'      // debut d'une restauration
  | 'FILE_RESTORED'        // un fichier restaure
  | 'RESTORE_COMPLETED'    // restauration terminee
  | 'RECOVERY_STARTED'     // debut de la recovery media
  | 'ARCHIVELOG_APPLIED'   // un archivelog applique
  | 'RECOVERY_COMPLETED'   // recovery terminee
  | 'CROSSCHECK_RESULT'    // resultat crosscheck piece par piece
  | 'DELETE_PERFORMED'     // backup supprime
  | 'CONFIGURE_CHANGED'    // configuration RMAN modifiee
  | 'ERROR'                // erreur non-fatale (warning)

export interface RmanEvent {
  readonly type:    RmanEventType
  readonly message: string
  readonly data?:   Record<string, unknown>
}

export interface IRmanEventBus {
  emit(event: RmanEvent): void
  /** Les commandes collectent les lignes de sortie via cet abonnement */
  subscribe(handler: (event: RmanEvent) => void): () => void
}

/** Implementation simple en memoire — collecte les lignes pour l'affichage */
export class InMemoryEventBus implements IRmanEventBus {
  private readonly _handlers: Array<(e: RmanEvent) => void> = []

  emit(event: RmanEvent): void {
    for (const h of this._handlers) h(event)
  }

  subscribe(handler: (event: RmanEvent) => void): () => void {
    this._handlers.push(handler)
    return () => {
      const idx = this._handlers.indexOf(handler)
      if (idx >= 0) this._handlers.splice(idx, 1)
    }
  }
}
```

### 7.8 Diagramme complet du Command Pattern

```
RmanCommandDispatcher  (registre de IRmanCommand)
  dispatch(tokens, ctx) --> IRmanCommand.execute() --> Result<RmanOutput>

IRmanCommand<T>
  +-- BackupCommand     op='BACKUP'     Ecrit pieces sur VFS + catalog
  +-- RestoreCommand    op='RESTORE'    Lit pieces du VFS + affiche lignes
  +-- RecoverCommand    op='RECOVER'    Applique archivelogs
  +-- ListCommand       op='LIST'       Lecture catalog only
  +-- ReportCommand     op='REPORT'     Calcul pur (RetentionEngine)
  +-- CrosscheckCommand op='CROSSCHECK' VFS check -> catalog update
  +-- DeleteCommand     op='DELETE'     VFS delete + catalog update
  +-- ConfigureCommand  op='CONFIGURE'  ctx.updateConfig()
  +-- ShowCommand       op='SHOW'       Lecture config only
  +-- ConnectCommand    op='CONNECT'    IRmanOracleContext.getInstanceState()
  +-- CatalogCommand    op='CATALOG'    Ajoute pieces existantes au catalog
  +-- DuplicateCommand  op='DUPLICATE'  Clone database
  +-- ValidateCommand   op='VALIDATE'   Verifie sans ecrire

Chaque commande injecte :  RmanCommandContext (catalog, channels, config, eventBus)
Chaque commande retourne : Result<RmanOutput, RmanError>
```

---

