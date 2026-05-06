# RMAN — Diagramme de classe technique (Architecture Réactive & Événementielle)

> Refonte complète du design RMAN (`DESIGN-RMAN.md`) avec une approche
> **Observable / Subject / Event-Driven** inspirée de la conception EIGRP.
> Chaque opération longue (backup, restore, crosscheck) émet des événements
> typés sur des streams dédiés plutôt que de bloquer et retourner une valeur.

---

## Table des matières

1. Vue d'ensemble architecturale réactive
2. Fondations : Result monad + RmanError
3. Value Objects et utilitaires purs
4. Programmation réactive : RmanSubject + Operators + RmanEventBus
5. Backup Catalog réactif — Repository + événements de catalogue
6. Canaux de sauvegarde réactifs — ChannelPool + allocation events
7. Job Execution Engine — pipeline réactif
8. Commandes RMAN — Command Pattern réactif (Open/Closed)
9. Session RMAN — Reactive Facade + State Machine + Builder
10. Intégration : OracleInstance, VFS, SubShell réactif
11. Flux complets et scénarios (séquences événementielles)
12. Récapitulatif — Patterns, SOLID, FP, Réactif

---

## 1. Vue d'ensemble architecturale réactive

### 1.1 Principes directeurs

| Principe | Description |
|---|---|
| **Event-First** | Toute opération RMAN publie des événements typés sur `RmanEventBus` |
| **Non-bloquant** | Les commandes retournent `void` ; les résultats arrivent via des streams |
| **Observable partout** | Chaque sous-système expose des streams publics en lecture seule |
| **Pure Functions** | DUAL-like : les décisions (policy, channel allocation) sont des fonctions pures |
| **Result<T,E>** | Aucune exception lancée ; erreurs comme valeurs typées |

### 1.2 Diagramme des flux réactifs

```
                    ┌──────────────────────────────────────────────┐
                    │               RmanEventBus                    │
                    │                                              │
  RmanSession  ─────►  _events$: RmanSubject<RmanEvent>            │
  (Facade)          │      │                                       │
                    │   pipe(ofType(JOB_STARTED))                   │
                    │   ──────────────────> jobStarted$            │
                    │                                              │
                    │   pipe(ofType(BACKUP_PIECE_CREATED))          │
                    │   ──────────────────> pieceCreated$          │
                    │                                              │
                    │   pipe(ofType(JOB_COMPLETED))                 │
                    │   ──────────────────> jobCompleted$          │
                    │                                              │
                    │   pipe(ofType(JOB_FAILED))                    │
                    │   ──────────────────> jobFailed$             │
                    │                                              │
                    │   pipe(ofType(CHANNEL_ALLOCATED))             │
                    │   ──────────────────> channelAllocated$      │
                    │                                              │
                    │   pipe(ofType(CATALOG_UPDATED))               │
                    │   ──────────────────> catalogUpdated$        │
                    │                                              │
                    │   pipe(ofType(SESSION_STATE_CHANGED))         │
                    │   ──────────────────> sessionState$          │
                    │                                              │
                    │   pipe(ofType(PROGRESS_UPDATED))              │
                    │   ──────────────────> progress$              │
                    └──────────────────────────────────────────────┘
                                  │
                  ┌───────────────┼───────────────────────┐
                  │               │                       │
           RmanSubShell      ChannelPool           RmanCatalog
           (subscriber)      (subscriber)          (subscriber)
           imprime output    gère allocation        persiste pièces
```

### 1.3 Arbre des fichiers

```
src/terminal/subshells/rman/
├── index.ts                           # re-exports publics
│
├── core/
│   ├── RmanError.ts                   # discriminated union d'erreurs
│   ├── Result.ts                      # re-export depuis ssh/Result
│   └── types.ts                       # interfaces internes partagées
│
├── values/
│   ├── Scn.ts                         # Value Object SCN
│   ├── RmanTag.ts                     # Value Object Tag
│   ├── BackupKey.ts                   # Value Object clé de pièce
│   └── DbId.ts                        # Value Object DBID
│
├── reactive/
│   ├── RmanSubject.ts                 # RmanSubject<T> + RmanObservable<T>
│   ├── operators.ts                   # filter, map, ofType, merge, bufferTime
│   └── RmanEventBus.ts               # bus central + typed streams
│
├── catalog/
│   ├── types.ts                       # BackupSet, BackupPiece, CatalogEntry
│   ├── IRmanCatalogRepository.ts      # interface (ISP reader/writer)
│   ├── InMemoryRmanCatalog.ts         # implémentation (réactive)
│   └── BackupSetFactory.ts            # Factory
│
├── channel/
│   ├── types.ts                       # ChannelConfig, ChannelState
│   ├── IChannelPool.ts                # interface pool
│   └── ReactiveChannelPool.ts         # pool réactif avec allocation events
│
├── job/
│   ├── types.ts                       # RmanJob, JobStep, JobStatus
│   ├── IRmanJobEngine.ts              # interface moteur de job
│   └── RmanJobEngine.ts               # exécution réactive de jobs
│
├── policy/
│   ├── types.ts                       # RetentionConfig
│   ├── IRetentionPolicy.ts            # Strategy interface
│   ├── RedundancyPolicy.ts
│   ├── RecoveryWindowPolicy.ts
│   └── NonePolicy.ts
│
├── commands/
│   ├── types.ts                       # IRmanCommand<T>, RmanCommandContext
│   ├── RmanCommandDispatcher.ts       # Command registry (Open/Closed)
│   ├── BackupCommand.ts
│   ├── RestoreCommand.ts
│   ├── RecoverCommand.ts
│   ├── ListBackupCommand.ts
│   ├── ReportCommand.ts
│   ├── CrosscheckCommand.ts
│   ├── DeleteCommand.ts
│   └── ShowCommand.ts
│
├── session/
│   ├── types.ts                       # RmanSessionState, RmanSessionOptions
│   ├── RmanSessionOptionsBuilder.ts   # Builder
│   ├── IRmanSession.ts                # interface Facade publique
│   └── RmanSession.ts                 # Reactive Facade principale
│
└── integration/
    ├── IRmanOracleContext.ts           # Adapter interface
    └── LinuxRmanContext.ts             # Adapter concret → VFS + OracleInstance
```

### 1.4 Comparaison design original vs réactif

| Aspect | Design original | Design réactif |
|---|---|---|
| Exécution d'une commande | `session.execute(cmd) → Result<string[],E>` | `session.run(cmd)` émet sur `jobStarted$`, `progress$`, `jobCompleted$` |
| Output vers SubShell | Retour synchrone de `string[]` | Abonnement à `progress$` / `jobCompleted$` |
| Erreur de job | `Result.err(RmanError)` retourné | Émission sur `jobFailed$` |
| Allocation de canal | Synchrone, bloquant | `channelAllocated$` observable |
| Mise à jour catalogue | Après exécution | `catalogUpdated$` en temps réel |
| Debug / monitoring | `console.log` dispersés | `events$.subscribe(logger)` |
| Test d'une commande | Mock du retour `Result` | Subscribe aux streams, vérifier séquence d'events |

---

## 2. Fondations : Result monad + RmanError

### 2.1 Result<T,E>

```typescript
// src/terminal/subshells/rman/core/Result.ts

/** Re-export depuis le module ssh pour éviter la duplication. */
export type { Result, Ok, Err } from '@/terminal/subshells/ssh/Result'
export { ok, err }              from '@/terminal/subshells/ssh/Result'
```

### 2.2 RmanError — discriminated union

```typescript
// src/terminal/subshells/rman/core/RmanError.ts

export type RmanError =
  // Connexion
  | { code: 'RMAN_00558'; message: string }   // syntax error
  | { code: 'RMAN_01009'; message: string }   // unknown command
  | { code: 'RMAN_03002'; message: string }   // target db not connected
  | { code: 'RMAN_06004'; message: string }   // backup piece not found
  // Catalogue
  | { code: 'CATALOG_READ_ERROR';   message: string }
  | { code: 'CATALOG_WRITE_ERROR';  message: string }
  | { code: 'BACKUP_KEY_NOT_FOUND'; message: string; key: string }
  | { code: 'SCN_INVALID';          message: string; raw: string }
  // Canal
  | { code: 'NO_CHANNEL_AVAILABLE'; message: string }
  | { code: 'CHANNEL_TIMEOUT';      message: string; channelId: string }
  | { code: 'CHANNEL_IO_ERROR';     message: string; channelId: string }
  // VFS
  | { code: 'VFS_WRITE_ERROR';      message: string; path: string }
  | { code: 'VFS_READ_ERROR';       message: string; path: string }
  | { code: 'VFS_NO_SPACE';         message: string; available: number }
  // Job
  | { code: 'JOB_CANCELLED';        message: string; jobId: string }
  | { code: 'JOB_TIMEOUT';          message: string; jobId: string }
  // Policy
  | { code: 'RETENTION_EVAL_ERROR'; message: string }

export function rmanErrorMessage(e: RmanError): string {
  return `${e.code}: ${e.message}`
}
```

### 2.3 RmanEvent — discriminated union des événements

```typescript
// src/terminal/subshells/rman/core/types.ts

import type { RmanError }  from './RmanError'
import type { BackupKey }  from '../values/BackupKey'
import type { Scn }        from '../values/Scn'
import type { RmanTag }    from '../values/RmanTag'

/** Union de tous les événements émis sur RmanEventBus */
export type RmanEvent =
  // ── Session ─────────────────────────────────────────────────────
  | { type: 'SESSION_STATE_CHANGED'; from: RmanSessionState; to: RmanSessionState }
  | { type: 'CONNECTED';             dbId: string; dbName: string; connectedAt: number }
  | { type: 'DISCONNECTED' }
  // ── Job lifecycle ─────────────────────────────────────────────
  | { type: 'JOB_STARTED';    jobId: string; operation: RmanOperation; startedAt: number }
  | { type: 'JOB_COMPLETED';  jobId: string; operation: RmanOperation; elapsedMs: number }
  | { type: 'JOB_FAILED';     jobId: string; operation: RmanOperation; error: RmanError; elapsedMs: number }
  | { type: 'JOB_CANCELLED';  jobId: string; operation: RmanOperation }
  // ── Progression ───────────────────────────────────────────────
  | { type: 'PROGRESS_UPDATED'; jobId: string; stepName: string; pct: number; message: string }
  // ── Canal ─────────────────────────────────────────────────────
  | { type: 'CHANNEL_ALLOCATED';   channelId: string; sid: number; deviceType: 'DISK' | 'SBT' }
  | { type: 'CHANNEL_RELEASED';    channelId: string }
  | { type: 'CHANNEL_ERROR';       channelId: string; error: RmanError }
  // ── Backup ────────────────────────────────────────────────────
  | { type: 'BACKUP_PIECE_STARTED'; jobId: string; channelId: string; what: string }
  | { type: 'BACKUP_PIECE_CREATED'; jobId: string; channelId: string; piece: BackupPieceInfo }
  | { type: 'BACKUP_SET_COMPLETE';  jobId: string; bsKey: number; tag: RmanTag; sizeBytes: number }
  // ── Restore ───────────────────────────────────────────────────
  | { type: 'RESTORE_DATAFILE_STARTED';   jobId: string; channelId: string; fileNo: number; to: string }
  | { type: 'RESTORE_DATAFILE_COMPLETED'; jobId: string; fileNo: number; elapsedMs: number }
  | { type: 'RECOVER_STARTED';            jobId: string; fromScn: Scn }
  | { type: 'RECOVER_COMPLETED';          jobId: string; toScn: Scn; elapsedMs: number }
  // ── Catalogue ─────────────────────────────────────────────────
  | { type: 'CATALOG_UPDATED';    operation: 'INSERT' | 'DELETE' | 'EXPIRE'; key: BackupKey }
  | { type: 'CROSSCHECK_DONE';    available: number; expired: number }
  // ── Script parser ─────────────────────────────────────────────
  | { type: 'SCRIPT_LINE_PARSED'; lineNo: number; command: string }
  | { type: 'SCRIPT_BLOCK_START'; blockId: string }
  | { type: 'SCRIPT_BLOCK_END';   blockId: string }

export type RmanOperation =
  | 'BACKUP_DATABASE'
  | 'BACKUP_ARCHIVELOG'
  | 'BACKUP_TABLESPACE'
  | 'RESTORE_DATABASE'
  | 'RECOVER_DATABASE'
  | 'CROSSCHECK'
  | 'DELETE_EXPIRED'
  | 'DELETE_OBSOLETE'
  | 'LIST_BACKUP'
  | 'REPORT_SCHEMA'
  | 'SHOW_ALL'
  | 'CONNECT'

export type RmanSessionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RUNNING_JOB' | 'DISCONNECTED'

export interface BackupPieceInfo {
  readonly key:      BackupKey
  readonly tag:      RmanTag
  readonly path:     string
  readonly sizeBytes: number
  readonly checkpointScn: Scn
}
```

---

## 3. Value Objects et utilitaires purs

### 3.1 Scn

```typescript
// src/terminal/subshells/rman/values/Scn.ts

import type { Result } from '../core/Result'
import { ok, err }    from '../core/Result'
import type { RmanError } from '../core/RmanError'

export interface Scn {
  readonly _tag:  'Scn'
  readonly value: number
}

export const Scn = {
  of(raw: number | string): Result<Scn, RmanError> {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw
    if (!Number.isInteger(n) || n < 0)
      return err({ code: 'SCN_INVALID', message: `Invalid SCN: ${raw}`, raw: String(raw) })
    return ok(Object.freeze({ _tag: 'Scn', value: n }) satisfies Scn)
  },
  /** SCN zéro (base) */
  ZERO: Object.freeze({ _tag: 'Scn' as const, value: 0 }),
  gt:  (a: Scn, b: Scn): boolean  => a.value > b.value,
  gte: (a: Scn, b: Scn): boolean  => a.value >= b.value,
  toString: (s: Scn): string      => String(s.value),
}
```

### 3.2 RmanTag

```typescript
// src/terminal/subshells/rman/values/RmanTag.ts

export interface RmanTag {
  readonly _tag:  'RmanTag'
  readonly label: string
}

export const RmanTag = {
  /** Génère un tag à partir d'un timestamp (TAG20260506T143022) */
  generate(now: Date = new Date()): RmanTag {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const label = `TAG${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`
                + `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return Object.freeze({ _tag: 'RmanTag', label })
  },
  of(label: string): RmanTag {
    return Object.freeze({ _tag: 'RmanTag', label: label.toUpperCase() })
  },
  toString: (t: RmanTag): string => t.label,
}
```

### 3.3 BackupKey

```typescript
// src/terminal/subshells/rman/values/BackupKey.ts

export interface BackupKey {
  readonly _tag:    'BackupKey'
  readonly bsKey:   number
  readonly bpKey:   number
  readonly copy:    number
}

let _bsCounter = 1
let _bpCounter = 1

export const BackupKey = {
  /** Crée une nouvelle clé en incrémentant les compteurs internes. */
  next(): BackupKey {
    return Object.freeze({ _tag: 'BackupKey', bsKey: _bsCounter++, bpKey: _bpCounter++, copy: 1 })
  },
  toString: (k: BackupKey): string => `BS:${k.bsKey}/BP:${k.bpKey}`,
  /** Réinitialisation pour les tests */
  _reset(): void { _bsCounter = 1; _bpCounter = 1 },
}
```

### 3.4 DbId

```typescript
// src/terminal/subshells/rman/values/DbId.ts

export interface DbId {
  readonly _tag:   'DbId'
  readonly value:  number
  readonly name:   string
}

export const DbId = {
  of(value: number, name: string): DbId {
    return Object.freeze({ _tag: 'DbId', value, name: name.toUpperCase() })
  },
  /** DBID Oracle par défaut pour la simulation */
  DEFAULT: Object.freeze({ _tag: 'DbId' as const, value: 1234567890, name: 'ORCL' }),
  toString: (d: DbId): string => `${d.name} (DBID=${d.value})`,
}
```

### 3.5 Utilitaires purs

```typescript
// src/terminal/subshells/rman/core/pureUtils.ts

import type { Scn }      from '../values/Scn'
import type { RmanTag }  from '../values/RmanTag'
import type { BackupKey } from '../values/BackupKey'

/** Formate une durée en millisecondes → "HH:MM:SS" */
export function formatElapsed(ms: number): string {
  const s   = Math.floor(ms / 1000)
  const hh  = Math.floor(s / 3600)
  const mm  = Math.floor((s % 3600) / 60)
  const ss  = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

/** Formate une taille en octets → "1.20G", "512.00M", etc. */
export function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)}G`
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(2)}M`
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(2)}K`
  return `${bytes}B`
}

/** Génère un nom de pièce de backup aléatoire style Oracle */
export function generatePieceName(dbName: string, tag: RmanTag): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `/u01/backup/${dbName}_${rand}.bkp`
}

/** Formate la date en style Oracle (12-MAY-2026 14:30:22) */
export function formatOracleDate(d: Date = new Date()): string {
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
```

---
