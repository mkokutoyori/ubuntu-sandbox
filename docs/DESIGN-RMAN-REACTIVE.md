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

## 4. Programmation réactive : RmanSubject + Operators + RmanEventBus

### 4.1 RmanSubject<T> — Observable maison sans dépendance RxJS

```typescript
// src/terminal/subshells/rman/reactive/RmanSubject.ts

/**
 * Observable léger (~120 lignes) spécifique au module RMAN.
 * Sémantique : multicast synchrone, hot observable.
 * Pas de dépendance externe (pas de RxJS).
 */

export interface RmanObservable<T> {
  subscribe(fn: (value: T) => void): () => void
  pipe<U>(operator: RmanOperator<T, U>): RmanObservable<U>
}

export type RmanOperator<T, U> = (source: RmanObservable<T>) => RmanObservable<U>

export class RmanSubject<T> implements RmanObservable<T> {
  private readonly _subscribers = new Set<(v: T) => void>()
  private _completed = false

  /** Émet une valeur vers tous les abonnés actifs. Synchrone. */
  next(value: T): void {
    if (this._completed) return
    for (const sub of this._subscribers) sub(value)
  }

  /** Termine le subject — les émissions futures sont ignorées. */
  complete(): void {
    this._completed = true
    this._subscribers.clear()
  }

  /** S'abonner — retourne la fonction de désabonnement. */
  subscribe(fn: (value: T) => void): () => void {
    if (this._completed) return () => {}
    this._subscribers.add(fn)
    return () => this._subscribers.delete(fn)
  }

  /** Crée un observable en lecture seule sur ce subject. */
  asObservable(): RmanObservable<T> {
    return {
      subscribe: (fn) => this.subscribe(fn),
      pipe:      (op) => this.pipe(op),
    }
  }

  /** Compose des opérateurs sur le stream. */
  pipe<U>(operator: RmanOperator<T, U>): RmanObservable<U> {
    return operator(this.asObservable())
  }
}
```

### 4.2 Operators — pure higher-order functions

```typescript
// src/terminal/subshells/rman/reactive/operators.ts

import type { RmanObservable, RmanOperator, RmanSubject } from './RmanSubject'

export const Operators = {
  /**
   * filter<T> — ne laisse passer que les valeurs satisfaisant le prédicat.
   */
  filter<T>(predicate: (v: T) => boolean): RmanOperator<T, T> {
    return (source) => ({
      subscribe(fn) {
        return source.subscribe(v => { if (predicate(v)) fn(v) })
      },
      pipe(op) { return op(this) },
    })
  },

  /**
   * map<T,U> — transforme chaque valeur.
   */
  map<T, U>(transform: (v: T) => U): RmanOperator<T, U> {
    return (source) => ({
      subscribe(fn) {
        return source.subscribe(v => fn(transform(v)))
      },
      pipe(op) { return op(this) },
    })
  },

  /**
   * ofType<T,K> — filtre par type guard TypeScript.
   * Retourne un stream fortement typé sur le sous-type K.
   */
  ofType<T, K extends T>(guard: (v: T) => v is K): RmanOperator<T, K> {
    return (source) => ({
      subscribe(fn) {
        return source.subscribe(v => { if (guard(v)) fn(v) })
      },
      pipe(op) { return op(this) },
    })
  },

  /**
   * merge<T> — fusionne plusieurs observables en un seul stream.
   */
  merge<T>(...sources: RmanObservable<T>[]): RmanObservable<T> {
    const subject = new (require('./RmanSubject').RmanSubject as new () => import('./RmanSubject').RmanSubject<T>)()
    const unsubs  = sources.map(s => s.subscribe(v => subject.next(v)))
    return {
      subscribe(fn) {
        const unsub = subject.subscribe(fn)
        return () => { unsub(); unsubs.forEach(u => u()) }
      },
      pipe(op) { return op(this) },
    }
  },

  /**
   * bufferTime<T> — accumule les valeurs sur une fenêtre de temps (ms),
   * émet un tableau. Utile pour batcher les updates de progression.
   */
  bufferTime<T>(windowMs: number): RmanOperator<T, T[]> {
    return (source) => {
      const out     = new (require('./RmanSubject').RmanSubject as any)() as import('./RmanSubject').RmanSubject<T[]>
      let   buffer: T[] = []
      let   timer:  ReturnType<typeof setTimeout> | null = null

      const flush = () => {
        if (buffer.length > 0) { out.next(buffer); buffer = [] }
        timer = null
      }

      const unsub = source.subscribe(v => {
        buffer.push(v)
        if (!timer) timer = setTimeout(flush, windowMs)
      })

      return {
        subscribe(fn) {
          const u = out.subscribe(fn)
          return () => { u(); unsub(); if (timer) clearTimeout(timer) }
        },
        pipe(op) { return op(this) },
      }
    }
  },

  /**
   * distinctUntilChanged<T> — ne réémet que si la valeur change.
   * Comparateur par défaut : égalité stricte.
   */
  distinctUntilChanged<T>(eq: (a: T, b: T) => boolean = (a, b) => a === b): RmanOperator<T, T> {
    return (source) => {
      let last: T | undefined
      let hasLast = false
      return {
        subscribe(fn) {
          return source.subscribe(v => {
            if (!hasLast || !eq(last as T, v)) { last = v; hasLast = true; fn(v) }
          })
        },
        pipe(op) { return op(this) },
      }
    }
  },
}
```

### 4.3 RmanEventBus — bus central avec streams typés

```typescript
// src/terminal/subshells/rman/reactive/RmanEventBus.ts

import { RmanSubject }   from './RmanSubject'
import { Operators }     from './operators'
import type { RmanEvent, RmanSessionState } from '../core/types'
import type { RmanError } from '../core/RmanError'

/**
 * Bus d'événements central pour le module RMAN.
 *
 * Expose un stream générique _events$ (privé) et des sous-streams
 * publics fortement typés par ofType().
 *
 * Pattern : Observer (GoF) — producteurs appellent emit(),
 *            consommateurs s'abonnent aux streams spécialisés.
 */
export class RmanEventBus {
  private readonly _events$ = new RmanSubject<RmanEvent>()

  // ── Sous-streams typés (lecture seule) ──────────────────────────

  /** Changements d'état de session (IDLE → CONNECTED, etc.) */
  readonly sessionState$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'SESSION_STATE_CHANGED' }> =>
      e.type === 'SESSION_STATE_CHANGED')
  )

  /** Démarrage d'un job (backup, restore, crosscheck, …) */
  readonly jobStarted$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'JOB_STARTED' }> =>
      e.type === 'JOB_STARTED')
  )

  /** Fin réussie d'un job */
  readonly jobCompleted$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'JOB_COMPLETED' }> =>
      e.type === 'JOB_COMPLETED')
  )

  /** Échec d'un job */
  readonly jobFailed$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'JOB_FAILED' }> =>
      e.type === 'JOB_FAILED')
  )

  /** Mise à jour de progression (% avancement, message courant) */
  readonly progress$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'PROGRESS_UPDATED' }> =>
      e.type === 'PROGRESS_UPDATED')
  )

  /** Canal alloué */
  readonly channelAllocated$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }> =>
      e.type === 'CHANNEL_ALLOCATED')
  )

  /** Canal libéré */
  readonly channelReleased$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }> =>
      e.type === 'CHANNEL_RELEASED')
  )

  /** Pièce de backup créée (avec métadonnées complètes) */
  readonly pieceCreated$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }> =>
      e.type === 'BACKUP_PIECE_CREATED')
  )

  /** Backup set terminé */
  readonly backupSetComplete$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'BACKUP_SET_COMPLETE' }> =>
      e.type === 'BACKUP_SET_COMPLETE')
  )

  /** Mise à jour du catalogue (insert/delete/expire) */
  readonly catalogUpdated$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CATALOG_UPDATED' }> =>
      e.type === 'CATALOG_UPDATED')
  )

  /** Crosscheck terminé */
  readonly crosscheckDone$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CROSSCHECK_DONE' }> =>
      e.type === 'CROSSCHECK_DONE')
  )

  /** Stream brut de tous les événements (pour debug/logging) */
  readonly events$ = this._events$.asObservable()

  // ── API d'émission ───────────────────────────────────────────────

  /** Publie un événement sur le bus. */
  emit(event: RmanEvent): void {
    this._events$.next(event)
  }

  /** Arrête tous les streams. Appelé lors de la destruction de la session. */
  dispose(): void {
    this._events$.complete()
  }
}
```

### 4.4 Diagramme des streams

```
emit(RmanEvent)
      │
      ▼
  _events$: RmanSubject<RmanEvent>
      │
      ├─ ofType(SESSION_STATE_CHANGED) ──► sessionState$
      │
      ├─ ofType(JOB_STARTED)          ──► jobStarted$
      │
      ├─ ofType(JOB_COMPLETED)        ──► jobCompleted$
      │
      ├─ ofType(JOB_FAILED)           ──► jobFailed$
      │
      ├─ ofType(PROGRESS_UPDATED)     ──► progress$
      │
      ├─ ofType(CHANNEL_ALLOCATED)    ──► channelAllocated$
      │
      ├─ ofType(CHANNEL_RELEASED)     ──► channelReleased$
      │
      ├─ ofType(BACKUP_PIECE_CREATED) ──► pieceCreated$
      │
      ├─ ofType(BACKUP_SET_COMPLETE)  ──► backupSetComplete$
      │
      ├─ ofType(CATALOG_UPDATED)      ──► catalogUpdated$
      │
      └─ ofType(CROSSCHECK_DONE)      ──► crosscheckDone$

Abonnés :
  progress$       → RmanSubShell (imprime output ligne par ligne)
  pieceCreated$   → InMemoryRmanCatalog (persiste la pièce)
  channelAllocated$ / channelReleased$ → ReactiveChannelPool (tracking)
  jobCompleted$   → RmanSession (transitions d'état)
  jobFailed$      → RmanSession (transitions d'état + log)
  events$         → Logger global (debug)
```

---

## 5. Backup Catalog réactif — Repository + Factory + événements

### 5.1 Types du catalogue

```typescript
// src/terminal/subshells/rman/catalog/types.ts

import type { BackupKey } from '../values/BackupKey'
import type { RmanTag }   from '../values/RmanTag'
import type { Scn }       from '../values/Scn'
import type { DbId }      from '../values/DbId'

export type BackupType   = 'FULL' | 'INCREMENTAL_0' | 'INCREMENTAL_1'
export type DeviceType   = 'DISK' | 'SBT'
export type PieceStatus  = 'AVAILABLE' | 'EXPIRED' | 'DELETED'

export interface BackupPiece {
  readonly key:            BackupKey
  readonly bsKey:          number
  readonly status:         PieceStatus
  readonly path:           string
  readonly tag:            RmanTag
  readonly deviceType:     DeviceType
  readonly sizeBytes:      number
  readonly checkpointScn:  Scn
  readonly completionTime: number   // epoch ms
  readonly compressed:     boolean
}

export interface BackupSet {
  readonly bsKey:          number
  readonly type:           BackupType
  readonly level:          0 | 1
  readonly dbId:           DbId
  readonly tag:            RmanTag
  readonly pieces:         readonly BackupPiece[]
  readonly startTime:      number
  readonly completionTime: number
  readonly sizeBytes:      number
  readonly datafiles:      readonly DatafileEntry[]
}

export interface DatafileEntry {
  readonly fileNo:    number
  readonly level:     0 | 1
  readonly ckpScn:    Scn
  readonly ckpTime:   number
  readonly path:      string
}

export interface CatalogSnapshot {
  readonly sets:    readonly BackupSet[]
  readonly pieces:  readonly BackupPiece[]
  readonly dbId:    DbId
}
```

### 5.2 IRmanCatalogRepository — Interface Segregation

```typescript
// src/terminal/subshells/rman/catalog/IRmanCatalogRepository.ts

import type { Result }       from '../core/Result'
import type { RmanError }    from '../core/RmanError'
import type { BackupSet, BackupPiece, CatalogSnapshot } from './types'
import type { BackupKey }    from '../values/BackupKey'
import type { RmanTag }      from '../values/RmanTag'
import type { RmanObservable } from '../reactive/RmanSubject'
import type { RmanEvent }    from '../core/types'

/**
 * ISP : lecture séparée de l'écriture.
 * Les commandes LIST/REPORT n'ont besoin que de IRmanCatalogReader.
 */
export interface IRmanCatalogReader {
  findByKey(key: BackupKey):              Result<BackupSet,    RmanError>
  findByTag(tag: RmanTag):                Result<BackupSet[],  RmanError>
  listAll():                              Result<CatalogSnapshot, RmanError>
  listExpired():                          Result<BackupPiece[], RmanError>
  listObsolete(redundancy: number):       Result<BackupSet[],  RmanError>
}

export interface IRmanCatalogWriter {
  recordBackupSet(set: BackupSet):        Result<void, RmanError>
  expirePiece(key: BackupKey):            Result<void, RmanError>
  deleteBackupSet(bsKey: number):         Result<void, RmanError>
}

/** Interface complète = Reader + Writer + stream de changements. */
export interface IRmanCatalogRepository
  extends IRmanCatalogReader, IRmanCatalogWriter {
  /** Stream des événements de catalogue (insert/expire/delete). */
  readonly changes$: RmanObservable<Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>>
}
```

### 5.3 InMemoryRmanCatalog — implémentation réactive

```typescript
// src/terminal/subshells/rman/catalog/InMemoryRmanCatalog.ts

import { RmanSubject }              from '../reactive/RmanSubject'
import { ok, err }                  from '../core/Result'
import type { Result }              from '../core/Result'
import type { RmanError }           from '../core/RmanError'
import type { IRmanCatalogRepository } from './IRmanCatalogRepository'
import type { BackupSet, BackupPiece, CatalogSnapshot } from './types'
import type { BackupKey }           from '../values/BackupKey'
import type { RmanTag }             from '../values/RmanTag'
import type { RmanEvent }           from '../core/types'

export class InMemoryRmanCatalog implements IRmanCatalogRepository {
  private readonly _sets   = new Map<number, BackupSet>()
  private readonly _pieces = new Map<string, BackupPiece>()

  private readonly _changes$ = new RmanSubject<Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>>()
  readonly changes$ = this._changes$.asObservable()

  // ── Writer ────────────────────────────────────────────────────

  recordBackupSet(set: BackupSet): Result<void, RmanError> {
    try {
      this._sets.set(set.bsKey, set)
      for (const p of set.pieces) {
        this._pieces.set(BackupKeyStr(p.key), p)
      }
      // Réactif : émet pour chaque pièce créée
      for (const p of set.pieces) {
        this._changes$.next({
          type: 'CATALOG_UPDATED', operation: 'INSERT', key: p.key,
        })
      }
      return ok(undefined)
    } catch (e) {
      return err({ code: 'CATALOG_WRITE_ERROR', message: String(e) })
    }
  }

  expirePiece(key: BackupKey): Result<void, RmanError> {
    const str = BackupKeyStr(key)
    const p   = this._pieces.get(str)
    if (!p) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `Piece ${str} not found`, key: str })
    this._pieces.set(str, { ...p, status: 'EXPIRED' })
    this._changes$.next({ type: 'CATALOG_UPDATED', operation: 'EXPIRE', key })
    return ok(undefined)
  }

  deleteBackupSet(bsKey: number): Result<void, RmanError> {
    const set = this._sets.get(bsKey)
    if (!set) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `BS key ${bsKey} not found`, key: String(bsKey) })
    for (const p of set.pieces) this._pieces.delete(BackupKeyStr(p.key))
    this._sets.delete(bsKey)
    for (const p of set.pieces) {
      this._changes$.next({ type: 'CATALOG_UPDATED', operation: 'DELETE', key: p.key })
    }
    return ok(undefined)
  }

  // ── Reader ────────────────────────────────────────────────────

  findByKey(key: BackupKey): Result<BackupSet, RmanError> {
    const str = BackupKeyStr(key)
    const p   = this._pieces.get(str)
    if (!p) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `Piece ${str} not found`, key: str })
    const set = this._sets.get(p.bsKey)
    if (!set) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `BS ${p.bsKey} not found`, key: String(p.bsKey) })
    return ok(set)
  }

  findByTag(tag: RmanTag): Result<BackupSet[], RmanError> {
    const results: BackupSet[] = []
    for (const set of this._sets.values()) {
      if (set.tag.label === tag.label) results.push(set)
    }
    return ok(results)
  }

  listAll(): Result<CatalogSnapshot, RmanError> {
    return ok({
      sets:   [...this._sets.values()],
      pieces: [...this._pieces.values()],
      dbId:   (this._sets.values().next().value as BackupSet | undefined)?.dbId
              ?? (await import('../values/DbId').then(m => m.DbId.DEFAULT)),
    } as any)
  }

  listExpired(): Result<BackupPiece[], RmanError> {
    return ok([...this._pieces.values()].filter(p => p.status === 'EXPIRED'))
  }

  listObsolete(redundancy: number): Result<BackupSet[], RmanError> {
    // Tri par completionTime DESC ; les plus anciens au-delà de `redundancy` sont obsolètes
    const sorted = [...this._sets.values()].sort((a, b) => b.completionTime - a.completionTime)
    return ok(sorted.slice(redundancy))
  }

  dispose(): void {
    this._changes$.complete()
  }
}

function BackupKeyStr(k: BackupKey): string {
  return `${k.bsKey}:${k.bpKey}`
}
```

### 5.4 BackupSetFactory — Factory Pattern

```typescript
// src/terminal/subshells/rman/catalog/BackupSetFactory.ts

import { BackupKey }      from '../values/BackupKey'
import { RmanTag }        from '../values/RmanTag'
import { Scn }            from '../values/Scn'
import { DbId }           from '../values/DbId'
import type { BackupSet, BackupPiece, DatafileEntry, BackupType } from './types'

export interface BackupSetSpec {
  type:         BackupType
  level:        0 | 1
  dbId?:        typeof DbId.DEFAULT
  tag?:         typeof RmanTag
  path:         string
  sizeBytes:    number
  datafiles:    DatafileEntry[]
  compressed?:  boolean
}

export const BackupSetFactory = {
  /**
   * Crée un BackupSet complet avec une pièce.
   * Toutes les valeurs sont Object.freeze'd.
   */
  createBackupSet(spec: BackupSetSpec): BackupSet {
    const now  = Date.now()
    const key  = BackupKey.next()
    const tag  = spec.tag ? RmanTag.of(String(spec.tag)) : RmanTag.generate()
    const scn  = Scn.of(Math.floor(1_800_000 + Math.random() * 100_000))
    const dbId = spec.dbId ?? DbId.DEFAULT

    const piece: BackupPiece = Object.freeze({
      key,
      bsKey:           key.bsKey,
      status:          'AVAILABLE',
      path:            spec.path,
      tag,
      deviceType:      'DISK',
      sizeBytes:       spec.sizeBytes,
      checkpointScn:   scn.ok ? scn.value : Scn.ZERO,
      completionTime:  now,
      compressed:      spec.compressed ?? false,
    })

    return Object.freeze({
      bsKey:           key.bsKey,
      type:            spec.type,
      level:           spec.level,
      dbId,
      tag,
      pieces:          Object.freeze([piece]),
      startTime:       now - 15_000,
      completionTime:  now,
      sizeBytes:       spec.sizeBytes,
      datafiles:       Object.freeze(spec.datafiles),
    })
  },
}
```

---

## 6. Canaux de sauvegarde réactifs — ReactiveChannelPool

### 6.1 Types des canaux

```typescript
// src/terminal/subshells/rman/channel/types.ts

export type DeviceType   = 'DISK' | 'SBT'
export type ChannelState = 'IDLE' | 'BUSY' | 'ERROR' | 'RELEASED'

export interface ChannelConfig {
  readonly id:          string        // 'ORA_DISK_1', 'ORA_DISK_2', …
  readonly deviceType:  DeviceType
  readonly parallelism: number        // max jobs simultanés
  readonly maxOpenFiles: number
  readonly sid:         number        // Oracle SID simulé
}

export interface ChannelHandle {
  readonly id:         string
  readonly deviceType: DeviceType
  readonly sid:        number
  readonly allocatedAt: number        // epoch ms
}

export interface ChannelStats {
  readonly totalAllocated:  number
  readonly totalReleased:   number
  readonly currentBusy:     number
  readonly errors:          number
}
```

### 6.2 IChannelPool — interface

```typescript
// src/terminal/subshells/rman/channel/IChannelPool.ts

import type { Result }         from '../core/Result'
import type { RmanError }      from '../core/RmanError'
import type { ChannelHandle, ChannelStats } from './types'
import type { RmanObservable } from '../reactive/RmanSubject'
import type { RmanEvent }      from '../core/types'

export interface IChannelPool {
  /**
   * Alloue un canal. Émet CHANNEL_ALLOCATED sur le bus.
   * Retourne Result.err(NO_CHANNEL_AVAILABLE) si tous occupés.
   */
  allocate(): Result<ChannelHandle, RmanError>

  /**
   * Libère un canal. Émet CHANNEL_RELEASED sur le bus.
   */
  release(handle: ChannelHandle): Result<void, RmanError>

  /** Statistiques courantes (lecture seule). */
  getStats(): ChannelStats

  /** Stream des allocations (utile pour monitoring). */
  readonly allocations$: RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>>

  /** Stream des libérations. */
  readonly releases$: RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>>

  dispose(): void
}
```

### 6.3 ReactiveChannelPool — implémentation

```typescript
// src/terminal/subshells/rman/channel/ReactiveChannelPool.ts

import { RmanSubject }    from '../reactive/RmanSubject'
import { ok, err }        from '../core/Result'
import type { Result }    from '../core/Result'
import type { RmanError } from '../core/RmanError'
import type { IChannelPool } from './IChannelPool'
import type { ChannelConfig, ChannelHandle, ChannelState, ChannelStats } from './types'
import type { RmanEvent } from '../core/types'

/**
 * Pool de canaux réactif.
 *
 * Pattern : COMPOSITE — gère N ChannelConfig comme un pool unifié.
 * Pattern : OBSERVER  — émet CHANNEL_ALLOCATED / CHANNEL_RELEASED.
 *
 * Règle : parallelism par config = nombre max de handles simultanés
 *         sur cette config. Par défaut : 1 handle par config.
 */
export class ReactiveChannelPool implements IChannelPool {
  private readonly _handles  = new Map<string, { handle: ChannelHandle; state: ChannelState }>()
  private readonly _sidCounter = { n: 100 }

  private readonly _alloc$ = new RmanSubject<Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>>()
  private readonly _rel$   = new RmanSubject<Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>>()

  readonly allocations$ = this._alloc$.asObservable()
  readonly releases$    = this._rel$.asObservable()

  private _stats: ChannelStats = { totalAllocated: 0, totalReleased: 0, currentBusy: 0, errors: 0 }

  constructor(private readonly _configs: readonly ChannelConfig[]) {}

  allocate(): Result<ChannelHandle, RmanError> {
    // Cherche un canal libre dans l'ordre des configs
    for (const cfg of this._configs) {
      const busyCount = [...this._handles.values()]
        .filter(e => e.handle.id.startsWith(cfg.id) && e.state === 'BUSY').length

      if (busyCount < cfg.parallelism) {
        const idx    = busyCount + 1
        const id     = `${cfg.id}_${idx}`
        const sid    = this._sidCounter.n++
        const handle: ChannelHandle = Object.freeze({
          id, deviceType: cfg.deviceType, sid, allocatedAt: Date.now(),
        })
        this._handles.set(id, { handle, state: 'BUSY' })
        this._stats = {
          ...this._stats,
          totalAllocated: this._stats.totalAllocated + 1,
          currentBusy:    this._stats.currentBusy + 1,
        }
        // Émet l'événement CHANNEL_ALLOCATED (réactif)
        this._alloc$.next({ type: 'CHANNEL_ALLOCATED', channelId: id, sid, deviceType: cfg.deviceType })
        return ok(handle)
      }
    }
    return err({ code: 'NO_CHANNEL_AVAILABLE', message: 'All channels are busy' })
  }

  release(handle: ChannelHandle): Result<void, RmanError> {
    const entry = this._handles.get(handle.id)
    if (!entry) return ok(undefined) // déjà libéré — idempotent
    entry.state = 'RELEASED'
    this._handles.delete(handle.id)
    this._stats = {
      ...this._stats,
      totalReleased: this._stats.totalReleased + 1,
      currentBusy:   Math.max(0, this._stats.currentBusy - 1),
    }
    // Émet l'événement CHANNEL_RELEASED (réactif)
    this._rel$.next({ type: 'CHANNEL_RELEASED', channelId: handle.id })
    return ok(undefined)
  }

  getStats(): ChannelStats { return this._stats }

  dispose(): void {
    this._alloc$.complete()
    this._rel$.complete()
    this._handles.clear()
  }
}
```

### 6.4 Configs par défaut

```typescript
// src/terminal/subshells/rman/channel/defaults.ts

import type { ChannelConfig } from './types'

/** Config par défaut : 1 canal DISK parallèle (RMAN default). */
export const DEFAULT_CHANNEL_CONFIGS: readonly ChannelConfig[] = Object.freeze([
  Object.freeze({
    id:           'ORA_DISK',
    deviceType:   'DISK',
    parallelism:  1,
    maxOpenFiles: 64,
    sid:          142,
  }),
])

/** Config pour backup parallèle à 4 canaux. */
export const PARALLEL_4_CONFIGS: readonly ChannelConfig[] = Object.freeze(
  [1, 2, 3, 4].map(i => Object.freeze({
    id:           `ORA_DISK_${i}`,
    deviceType:   'DISK' as const,
    parallelism:  1,
    maxOpenFiles: 64,
    sid:          140 + i,
  }))
)
```

### 6.5 Cycle de vie réactif d'un canal

```
ReactiveChannelPool.allocate()
        │
        ├─ Cherche cfg avec busyCount < parallelism
        │
        ├─ Crée ChannelHandle (immutable)
        │
        ├─ _alloc$.next(CHANNEL_ALLOCATED)
        │       │
        │       └─► RmanEventBus.channelAllocated$ → RmanSubShell.print(
        │               "allocated channel: ORA_DISK_1\n"
        │               "channel ORA_DISK_1: SID=142 device type=DISK")
        │
        └─ Result.ok(handle)

[Job utilise le canal...]

ReactiveChannelPool.release(handle)
        │
        ├─ Retire de _handles
        │
        ├─ _rel$.next(CHANNEL_RELEASED)
        │
        └─ Result.ok()
```

---

## 7. Job Execution Engine — pipeline réactif

### 7.1 Types du moteur de jobs

```typescript
// src/terminal/subshells/rman/job/types.ts

import type { RmanOperation } from '../core/types'
import type { RmanError }     from '../core/RmanError'

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface JobStep {
  readonly name:    string
  readonly pct:     number           // progression cible (0–100)
  readonly message: string           // message RMAN à afficher
}

export interface RmanJob {
  readonly id:        string
  readonly operation: RmanOperation
  readonly steps:     readonly JobStep[]
  readonly startedAt: number
}

export interface JobResult {
  readonly jobId:     string
  readonly operation: RmanOperation
  readonly elapsedMs: number
  readonly output:    readonly string[]  // lignes de résultat final
}

export interface JobError {
  readonly jobId:     string
  readonly operation: RmanOperation
  readonly error:     RmanError
  readonly elapsedMs: number
}
```

### 7.2 IRmanJobEngine — interface

```typescript
// src/terminal/subshells/rman/job/IRmanJobEngine.ts

import type { Result }      from '../core/Result'
import type { RmanError }   from '../core/RmanError'
import type { RmanJob, JobResult } from './types'
import type { RmanOperation } from '../core/types'

export interface IRmanJobEngine {
  /**
   * Exécute un job RMAN.
   * Émet des événements PROGRESS_UPDATED, BACKUP_PIECE_CREATED, etc.
   * via le RmanEventBus injecté.
   * Retourne Result uniquement en cas d'erreur fatale synchrone.
   */
  run(job: RmanJob): Result<void, RmanError>

  /** Annule un job en cours (émet JOB_CANCELLED). */
  cancel(jobId: string): void
}
```

### 7.3 RmanJobEngine — exécution réactive par étapes

```typescript
// src/terminal/subshells/rman/job/RmanJobEngine.ts

import { ok, err }          from '../core/Result'
import type { Result }      from '../core/Result'
import type { RmanError }   from '../core/RmanError'
import type { IRmanJobEngine }  from './IRmanJobEngine'
import type { IChannelPool }    from '../channel/IChannelPool'
import type { IRmanCatalogRepository } from '../catalog/IRmanCatalogRepository'
import type { IRmanOracleContext }      from '../integration/IRmanOracleContext'
import type { RmanEventBus }            from '../reactive/RmanEventBus'
import type { RmanJob }                 from './types'
import { BackupSetFactory }             from '../catalog/BackupSetFactory'
import { RmanTag }                      from '../values/RmanTag'
import { formatElapsed, formatOracleDate, generatePieceName } from '../core/pureUtils'

/**
 * Moteur d'exécution des jobs RMAN.
 *
 * Pattern : TEMPLATE METHOD implicite — run() orchestre les étapes,
 *           chaque opération (backup, restore…) est un job avec ses étapes.
 * Pattern : OBSERVER    — chaque étape émet sur RmanEventBus.
 *
 * Principe : RmanJobEngine ne sait pas qu'un SubShell existe.
 *            Il émet des événements ; le SubShell s'abonne séparément.
 */
export class RmanJobEngine implements IRmanJobEngine {
  private readonly _cancelled = new Set<string>()

  constructor(
    private readonly _bus:     RmanEventBus,
    private readonly _pool:    IChannelPool,
    private readonly _catalog: IRmanCatalogRepository,
    private readonly _ctx:     IRmanOracleContext,
  ) {}

  run(job: RmanJob): Result<void, RmanError> {
    const start = Date.now()

    // Annulation vérifiée avant de démarrer
    if (this._cancelled.has(job.id)) {
      return err({ code: 'JOB_CANCELLED', message: `Job ${job.id} was cancelled`, jobId: job.id })
    }

    // Émettre JOB_STARTED
    this._bus.emit({ type: 'JOB_STARTED', jobId: job.id, operation: job.operation, startedAt: start })

    // Allouer un canal
    const chanResult = this._pool.allocate()
    if (!chanResult.ok) {
      this._emitFailed(job, chanResult.error, start)
      return ok(undefined) // erreur propagée via événement, pas exception
    }
    const channel = chanResult.value

    try {
      // Exécuter les étapes du job
      for (const step of job.steps) {
        if (this._cancelled.has(job.id)) {
          this._bus.emit({ type: 'JOB_CANCELLED', jobId: job.id, operation: job.operation })
          return ok(undefined)
        }
        // Émettre la progression
        this._bus.emit({
          type: 'PROGRESS_UPDATED',
          jobId: job.id, stepName: step.name,
          pct: step.pct, message: step.message,
        })
      }

      // Traitement spécifique par opération
      const opResult = this._executeOperation(job, channel.id)
      if (!opResult.ok) {
        this._emitFailed(job, opResult.error, start)
        return ok(undefined)
      }

      // JOB_COMPLETED
      this._bus.emit({
        type: 'JOB_COMPLETED',
        jobId: job.id, operation: job.operation,
        elapsedMs: Date.now() - start,
      })
    } finally {
      this._pool.release(channel)
    }

    return ok(undefined)
  }

  cancel(jobId: string): void {
    this._cancelled.add(jobId)
  }

  // ── Opérations spécifiques ────────────────────────────────────

  private _executeOperation(job: RmanJob, channelId: string): Result<void, RmanError> {
    switch (job.operation) {
      case 'BACKUP_DATABASE':    return this._doBackup(job, channelId, 'database')
      case 'BACKUP_ARCHIVELOG':  return this._doBackup(job, channelId, 'archivelog all')
      case 'BACKUP_TABLESPACE':  return this._doBackup(job, channelId, 'tablespace')
      case 'RESTORE_DATABASE':   return this._doRestore(job, channelId)
      case 'RECOVER_DATABASE':   return this._doRecover(job)
      case 'CROSSCHECK':         return this._doCrosscheck(job)
      case 'DELETE_EXPIRED':     return this._doDeleteExpired(job)
      case 'DELETE_OBSOLETE':    return this._doDeleteObsolete(job)
      default:                   return ok(undefined)
    }
  }

  private _doBackup(job: RmanJob, channelId: string, what: string): Result<void, RmanError> {
    const tag  = RmanTag.generate()
    const path = generatePieceName(this._ctx.dbName, tag)
    const size = Math.floor(800_000_000 + Math.random() * 400_000_000)

    // Émet pièce démarrée
    this._bus.emit({
      type: 'BACKUP_PIECE_STARTED', jobId: job.id, channelId, what,
    })

    // Simule les datafiles Oracle
    const datafiles = this._ctx.getDatafiles()
    const dfEntries = datafiles.map((df, i) => ({
      fileNo: i + 1, level: 0 as const,
      ckpScn: { _tag: 'Scn' as const, value: 1_892_354 },
      ckpTime: Date.now(), path: df.path,
    }))

    // VFS write — peut échouer
    const writeResult = this._ctx.vfs.writeFile(path, new Uint8Array(size))
    if (!writeResult.ok) {
      return err({ code: 'VFS_WRITE_ERROR', message: writeResult.error.message, path })
    }

    // Créer le BackupSet
    const set = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path, sizeBytes: size, datafiles: dfEntries,
    })

    // Émettre pièce créée (→ catalogue s'abonne et persiste)
    this._bus.emit({
      type: 'BACKUP_PIECE_CREATED', jobId: job.id, channelId,
      piece: { key: set.pieces[0].key, tag, path, sizeBytes: size,
               checkpointScn: set.pieces[0].checkpointScn },
    })

    // Persister au catalogue (aussi abonné via catalogUpdated$)
    const catResult = this._catalog.recordBackupSet(set)
    if (!catResult.ok) return catResult

    // Émettre backup set complet
    this._bus.emit({
      type: 'BACKUP_SET_COMPLETE', jobId: job.id,
      bsKey: set.bsKey, tag, sizeBytes: size,
    })

    return ok(undefined)
  }

  private _doRestore(job: RmanJob, channelId: string): Result<void, RmanError> {
    const snapshot = this._catalog.listAll()
    if (!snapshot.ok) return snapshot
    const sets = snapshot.value.sets
    if (sets.length === 0) {
      return err({ code: 'RMAN_06004', message: 'No backup found to restore' })
    }

    const datafiles = this._ctx.getDatafiles()
    for (const df of datafiles) {
      this._bus.emit({
        type: 'RESTORE_DATAFILE_STARTED', jobId: job.id, channelId,
        fileNo: df.fileNo, to: df.path,
      })
      this._bus.emit({
        type: 'RESTORE_DATAFILE_COMPLETED', jobId: job.id,
        fileNo: df.fileNo, elapsedMs: 5_000,
      })
    }
    return ok(undefined)
  }

  private _doRecover(job: RmanJob): Result<void, RmanError> {
    const fromScn = { _tag: 'Scn' as const, value: 1_892_354 }
    const toScn   = { _tag: 'Scn' as const, value: 1_892_500 }
    this._bus.emit({ type: 'RECOVER_STARTED', jobId: job.id, fromScn })
    this._bus.emit({ type: 'RECOVER_COMPLETED', jobId: job.id, toScn, elapsedMs: 3_000 })
    return ok(undefined)
  }

  private _doCrosscheck(job: RmanJob): Result<void, RmanError> {
    const snapshot = this._catalog.listAll()
    if (!snapshot.ok) return snapshot
    let available = 0; let expired = 0
    for (const piece of snapshot.value.pieces) {
      // Vérifie si le fichier existe dans le VFS
      const exists = this._ctx.vfs.fileExists(piece.path)
      if (exists) { available++ } else {
        this._catalog.expirePiece(piece.key)
        expired++
      }
    }
    this._bus.emit({ type: 'CROSSCHECK_DONE', available, expired })
    return ok(undefined)
  }

  private _doDeleteExpired(job: RmanJob): Result<void, RmanError> {
    const expired = this._catalog.listExpired()
    if (!expired.ok) return expired
    for (const piece of expired.value) {
      this._catalog.deleteBackupSet(piece.bsKey)
    }
    return ok(undefined)
  }

  private _doDeleteObsolete(job: RmanJob): Result<void, RmanError> {
    const obs = this._catalog.listObsolete(1)
    if (!obs.ok) return obs
    for (const set of obs.value) {
      this._catalog.deleteBackupSet(set.bsKey)
    }
    return ok(undefined)
  }

  private _emitFailed(job: RmanJob, error: RmanError, start: number): void {
    this._bus.emit({
      type: 'JOB_FAILED', jobId: job.id, operation: job.operation,
      error, elapsedMs: Date.now() - start,
    })
  }
}
```

### 7.4 JobBuilder — construction déclarative des jobs

```typescript
// src/terminal/subshells/rman/job/JobBuilder.ts

import type { RmanJob, JobStep } from './types'
import type { RmanOperation }   from '../core/types'

let _jobCounter = 1

/**
 * Builder pour créer des RmanJob avec leurs étapes Oracle.
 * Chaque opération a des étapes prédéfinies qui correspondent
 * exactement aux messages affichés par RMAN réel.
 */
export const JobBuilder = {
  backupDatabase(): RmanJob {
    return _make('BACKUP_DATABASE', [
      { name: 'allocate_channel', pct: 5,  message: 'allocated channel: ORA_DISK_1' },
      { name: 'start_backup',     pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'specify_files',    pct: 20, message: 'channel ORA_DISK_1: specifying datafile(s) in backup set' },
      { name: 'backup_system',    pct: 40, message: 'including current control file in backup set' },
      { name: 'write_piece',      pct: 70, message: 'channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15' },
      { name: 'autobackup_cf',    pct: 90, message: 'Finished Control File and SPFILE Autobackup' },
    ])
  },

  backupArchivelog(): RmanJob {
    return _make('BACKUP_ARCHIVELOG', [
      { name: 'allocate_channel', pct: 5,  message: 'allocated channel: ORA_DISK_1' },
      { name: 'start_archivelog', pct: 10, message: 'channel ORA_DISK_1: starting archived log backup set' },
      { name: 'specify_archivelogs', pct: 30, message: 'channel ORA_DISK_1: specifying archived log(s) in backup set' },
      { name: 'write_piece',      pct: 80, message: 'channel ORA_DISK_1: backup set complete, elapsed time: 00:00:03' },
    ])
  },

  backupTablespace(tsName: string): RmanJob {
    return _make('BACKUP_TABLESPACE', [
      { name: 'allocate_channel', pct: 5,  message: 'allocated channel: ORA_DISK_1' },
      { name: 'start_backup',     pct: 10, message: `channel ORA_DISK_1: starting full datafile backup set` },
      { name: 'backup_ts',        pct: 50, message: `channel ORA_DISK_1: backing up tablespace ${tsName}` },
      { name: 'write_piece',      pct: 90, message: 'channel ORA_DISK_1: backup set complete, elapsed time: 00:00:08' },
    ])
  },

  restoreDatabase(): RmanJob {
    return _make('RESTORE_DATABASE', [
      { name: 'allocate_channel',   pct: 5,  message: 'allocated channel: ORA_DISK_1' },
      { name: 'start_restore',      pct: 10, message: 'channel ORA_DISK_1: starting datafile backup set restore' },
      { name: 'restore_system',     pct: 30, message: 'channel ORA_DISK_1: restoring datafile 00001 to /u01/app/oracle/oradata/ORCL/system01.dbf' },
      { name: 'restore_sysaux',     pct: 50, message: 'channel ORA_DISK_1: restoring datafile 00002 to /u01/app/oracle/oradata/ORCL/sysaux01.dbf' },
      { name: 'restore_undotbs',    pct: 65, message: 'channel ORA_DISK_1: restoring datafile 00003 to /u01/app/oracle/oradata/ORCL/undotbs01.dbf' },
      { name: 'restore_users',      pct: 80, message: 'channel ORA_DISK_1: restoring datafile 00004 to /u01/app/oracle/oradata/ORCL/users01.dbf' },
      { name: 'restore_complete',   pct: 95, message: 'channel ORA_DISK_1: restore complete, elapsed time: 00:00:25' },
    ])
  },

  recoverDatabase(): RmanJob {
    return _make('RECOVER_DATABASE', [
      { name: 'start_recover',  pct: 20, message: 'starting media recovery' },
      { name: 'apply_logs',     pct: 70, message: 'media recovery complete, elapsed time: 00:00:03' },
    ])
  },

  crosscheck(): RmanJob {
    return _make('CROSSCHECK', [
      { name: 'allocate_channel', pct: 20, message: 'allocated channel: ORA_DISK_1' },
      { name: 'crosscheck',       pct: 80, message: 'crosschecked backup piece: found to be \'AVAILABLE\'' },
    ])
  },

  deleteExpired(): RmanJob {
    return _make('DELETE_EXPIRED', [
      { name: 'using_channel', pct: 50, message: 'using channel ORA_DISK_1' },
      { name: 'delete',        pct: 90, message: 'specification does not match any backup in the repository' },
    ])
  },

  deleteObsolete(): RmanJob {
    return _make('DELETE_OBSOLETE', [
      { name: 'retention_policy', pct: 30, message: 'RMAN retention policy will be applied to the command' },
      { name: 'using_channel',    pct: 60, message: 'using channel ORA_DISK_1' },
      { name: 'check_obsolete',   pct: 90, message: 'no obsolete backups found' },
    ])
  },
}

function _make(operation: RmanOperation, steps: JobStep[]): RmanJob {
  return Object.freeze({
    id:        `JOB-${_jobCounter++}`,
    operation,
    steps:     Object.freeze(steps),
    startedAt: Date.now(),
  })
}
```

---

## 8. Commandes RMAN — Command Pattern réactif (Open/Closed)

### 8.1 IRmanCommand<T> — interface générique

```typescript
// src/terminal/subshells/rman/commands/types.ts

import type { Result }      from '../core/Result'
import type { RmanError }   from '../core/RmanError'
import type { RmanEventBus }from '../reactive/RmanEventBus'
import type { IRmanJobEngine } from '../job/IRmanJobEngine'
import type { IRmanCatalogRepository } from '../catalog/IRmanCatalogRepository'
import type { IRmanOracleContext }     from '../integration/IRmanOracleContext'
import type { IRetentionPolicy }       from '../policy/IRetentionPolicy'

/**
 * Contexte partagé injecté dans chaque commande.
 * Contient tous les services dont une commande peut avoir besoin.
 */
export interface RmanCommandContext {
  readonly bus:       RmanEventBus
  readonly engine:    IRmanJobEngine
  readonly catalog:   IRmanCatalogRepository
  readonly ctx:       IRmanOracleContext
  readonly policy:    IRetentionPolicy
}

/**
 * Interface générique d'une commande RMAN.
 * T = type du résultat (string[] pour LIST/SHOW, void pour BACKUP/RESTORE).
 *
 * Les commandes qui lancent un job ne retournent rien :
 * les résultats arrivent via les événements du bus.
 *
 * Pattern : COMMAND (GoF) — encapsule une opération, découple
 *           déclencheur (RmanCommandDispatcher) et exécutant.
 */
export interface IRmanCommand<T = void> {
  /** Nom lisible pour le logging. */
  readonly name: string

  /**
   * Exécute la commande.
   * - Commandes à résultat synchrone (LIST, SHOW, REPORT) : retourne Result<string[], E>
   * - Commandes asynchrones (BACKUP, RESTORE) : retourne Result<void, E>,
   *   les lignes de sortie arrivent via bus.progress$ et bus.jobCompleted$.
   */
  execute(args: string[], cmdCtx: RmanCommandContext): Result<T, RmanError>
}
```

### 8.2 RmanCommandDispatcher — registre Open/Closed

```typescript
// src/terminal/subshells/rman/commands/RmanCommandDispatcher.ts

import type { IRmanCommand }       from './types'
import type { RmanCommandContext }  from './types'
import type { Result }             from '../core/Result'
import type { RmanError }          from '../core/RmanError'
import { ok, err }                 from '../core/Result'

// Import de toutes les commandes concrètes
import { BackupCommand }     from './BackupCommand'
import { RestoreCommand }    from './RestoreCommand'
import { RecoverCommand }    from './RecoverCommand'
import { ListBackupCommand } from './ListBackupCommand'
import { ReportCommand }     from './ReportCommand'
import { CrosscheckCommand } from './CrosscheckCommand'
import { DeleteCommand }     from './DeleteCommand'
import { ShowCommand }       from './ShowCommand'
import { ConnectCommand }    from './ConnectCommand'
import { HelpCommand }       from './HelpCommand'

type DispatchEntry = {
  pattern: RegExp
  command: IRmanCommand<unknown>
}

/**
 * Registre de commandes RMAN.
 *
 * Pattern : COMMAND (GoF) — dispatcher = invoker.
 * Pattern : OPEN/CLOSED — de nouvelles commandes s'ajoutent via
 *           registerCommand() sans modifier le dispatcher.
 *
 * Résolution : première regex qui matche gagne (ordre d'enregistrement).
 */
export class RmanCommandDispatcher {
  private readonly _entries: DispatchEntry[] = []

  constructor() {
    this._registerDefaults()
  }

  /** Enregistrement dynamique d'une commande supplémentaire. */
  registerCommand(pattern: RegExp, command: IRmanCommand<unknown>): void {
    this._entries.push({ pattern, command })
  }

  /**
   * Dispatche une ligne de texte vers la commande correspondante.
   * Retourne Result<string[], E> — pour les commandes à résultat
   * synchrone (LIST, SHOW, REPORT), les lignes sont dans .value.
   * Pour les commandes à résultat réactif (BACKUP, RESTORE),
   * .value === [] et les lignes arrivent via le bus.
   */
  dispatch(line: string, cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const upper    = line.trim().toUpperCase()
    const trimmed  = line.trim()

    for (const { pattern, command } of this._entries) {
      const match = upper.match(pattern) ?? trimmed.match(pattern)
      if (match) {
        const result = command.execute(match.slice(1), cmdCtx)
        if (!result.ok) return result as Result<string[], RmanError>
        const value = result.value
        return ok(Array.isArray(value) ? value as string[] : [])
      }
    }

    return err({ code: 'RMAN_01009', message: `syntax error: found: unknown command: ${trimmed}` })
  }

  // ── Enregistrement des commandes par défaut ───────────────────

  private _registerDefaults(): void {
    const backup    = new BackupCommand()
    const restore   = new RestoreCommand()
    const recover   = new RecoverCommand()
    const list      = new ListBackupCommand()
    const report    = new ReportCommand()
    const crosschk  = new CrosscheckCommand()
    const del       = new DeleteCommand()
    const show      = new ShowCommand()
    const connect   = new ConnectCommand()
    const help      = new HelpCommand()

    this._entries.push(
      { pattern: /^CONNECT TARGET(.*)$/i,       command: connect  },
      { pattern: /^BACKUP DATABASE$/i,           command: backup   },
      { pattern: /^BACKUP ARCHIVELOG ALL$/i,     command: backup   },
      { pattern: /^BACKUP TABLESPACE (\S+)$/i,   command: backup   },
      { pattern: /^RESTORE DATABASE$/i,          command: restore  },
      { pattern: /^RECOVER DATABASE$/i,          command: recover  },
      { pattern: /^LIST BACKUP SUMMARY$/i,       command: list     },
      { pattern: /^LIST BACKUP$/i,               command: list     },
      { pattern: /^REPORT SCHEMA$/i,             command: report   },
      { pattern: /^REPORT NEED BACKUP$/i,        command: report   },
      { pattern: /^CROSSCHECK BACKUP$/i,         command: crosschk },
      { pattern: /^DELETE EXPIRED BACKUP$/i,     command: del      },
      { pattern: /^DELETE OBSOLETE$/i,           command: del      },
      { pattern: /^SHOW ALL$/i,                  command: show     },
      { pattern: /^HELP$/i,                      command: help     },
    )
  }
}
```

### 8.3 BackupCommand — commande réactive

```typescript
// src/terminal/subshells/rman/commands/BackupCommand.ts

import { ok }                from '../core/Result'
import type { Result }       from '../core/Result'
import type { RmanError }    from '../core/RmanError'
import type { IRmanCommand, RmanCommandContext } from './types'
import { JobBuilder }        from '../job/JobBuilder'
import { formatOracleDate }  from '../core/pureUtils'

/**
 * Commande BACKUP.
 * Ne retourne aucune ligne synchrone (void).
 * Toute la sortie est émise via bus.progress$ et bus.jobCompleted$.
 *
 * Sous-commandes supportées (résolues par pattern dans le dispatcher) :
 *   BACKUP DATABASE
 *   BACKUP ARCHIVELOG ALL
 *   BACKUP TABLESPACE <name>
 */
export class BackupCommand implements IRmanCommand<void> {
  readonly name = 'BACKUP'

  execute(args: string[], { bus, engine }: RmanCommandContext): Result<void, RmanError> {
    const what = this._parseWhat(args)
    const ts   = formatOracleDate()

    // Émettre "Starting backup at ..."
    bus.emit({
      type: 'PROGRESS_UPDATED', jobId: 'pre',
      stepName: 'start', pct: 0,
      message: `Starting backup at ${ts}`,
    })

    // Construire le job selon ce qu'on sauvegarde
    const job = what === 'database'     ? JobBuilder.backupDatabase()
              : what === 'archivelog'   ? JobBuilder.backupArchivelog()
              : JobBuilder.backupTablespace(what)

    // Lancer le job (asynchrone — résultats via bus)
    return engine.run(job)
  }

  private _parseWhat(args: string[]): string {
    const first = (args[0] ?? '').toUpperCase()
    if (first === 'DATABASE')   return 'database'
    if (first === 'ARCHIVELOG') return 'archivelog'
    if (first === 'TABLESPACE') return args[1] ?? 'USERS'
    return 'database'
  }
}
```

### 8.4 ListBackupCommand — commande synchrone avec résultat

```typescript
// src/terminal/subshells/rman/commands/ListBackupCommand.ts

import { ok, err }           from '../core/Result'
import type { Result }       from '../core/Result'
import type { RmanError }    from '../core/RmanError'
import type { IRmanCommand, RmanCommandContext } from './types'
import { formatOracleDate, formatSize, formatElapsed } from '../core/pureUtils'

/**
 * Commande LIST BACKUP [SUMMARY].
 * Retourne un Result<string[], RmanError> synchrone.
 * Les lignes sont renvoyées directement au SubShell.
 */
export class ListBackupCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST BACKUP'

  execute(args: string[], { catalog }: RmanCommandContext): Result<string[], RmanError> {
    const snapshot = catalog.listAll()
    if (!snapshot.ok) return snapshot

    const isSummary = (args[0] ?? '').toUpperCase().includes('SUMMARY')
    const { sets } = snapshot.value

    if (sets.length === 0) {
      return ok(['', 'List of Backups', '===============', 'no backup found in the repository', ''])
    }

    if (isSummary) return ok(this._summaryLines(sets))
    return ok(this._detailLines(sets))
  }

  private _summaryLines(sets: readonly import('../catalog/types').BackupSet[]): string[] {
    const lines: string[] = [
      '', 'List of Backups', '===============',
      'Key     TY LV S Device Type Completion Time     #Pieces #Copies Compressed Tag',
      '------- -- -- - ----------- ------------------- ------- ------- ---------- ---',
    ]
    for (const s of sets) {
      const ts = formatOracleDate(new Date(s.completionTime))
      lines.push(
        `${String(s.bsKey).padEnd(7)} B  F  A DISK        ${ts}  1       1       NO         ${s.tag.label}`
      )
    }
    lines.push('')
    return lines
  }

  private _detailLines(sets: readonly import('../catalog/types').BackupSet[]): string[] {
    const lines: string[] = ['', 'List of Backup Sets', '===================', '']
    lines.push(
      'BS Key  Type LV Size       Device Type Elapsed Time Completion Time',
      '------- ---- -- ---------- ----------- ------------ ---------------',
    )
    for (const s of sets) {
      const ts      = formatOracleDate(new Date(s.completionTime))
      const elapsed = formatElapsed(s.completionTime - s.startTime)
      const size    = formatSize(s.sizeBytes)
      lines.push(`${String(s.bsKey).padEnd(7)} Full    ${size.padEnd(10)} DISK        ${elapsed}     ${ts}`)
      for (const p of s.pieces) {
        lines.push(`        BP Key: ${p.key.bpKey}   Status: ${p.status}  Compressed: NO  Tag: ${p.tag.label}`)
        lines.push(`          Piece Name: ${p.path}`)
      }
      if (s.datafiles.length > 0) {
        lines.push('  List of Datafiles in backup set ' + s.bsKey)
        lines.push('  File LV Type Ckp SCN    Ckp Time        Name')
        lines.push('  ---- -- ---- ---------- --------------- ----')
        for (const df of s.datafiles) {
          const dfTs = formatOracleDate(new Date(df.ckpTime))
          lines.push(`  ${String(df.fileNo).padStart(4)}    Full ${String(df.ckpScn.value).padEnd(10)} ${dfTs}  ${df.path}`)
        }
      }
    }
    lines.push('')
    return lines
  }
}
```

### 8.5 Autres commandes (résumé)

| Classe | Pattern | Résultat | Comportement réactif |
|---|---|---|---|
| `RestoreCommand` | `RESTORE DATABASE` | `void` | Émet `RESTORE_DATAFILE_STARTED/COMPLETED` via job engine |
| `RecoverCommand` | `RECOVER DATABASE` | `void` | Émet `RECOVER_STARTED/COMPLETED` |
| `CrosscheckCommand` | `CROSSCHECK BACKUP` | `void` | Émet `CROSSCHECK_DONE` ; expire les pièces introuvables |
| `DeleteCommand` | `DELETE EXPIRED/OBSOLETE` | `void` | Supprime du catalogue ; émet `CATALOG_UPDATED` |
| `ShowCommand` | `SHOW ALL` | `string[]` | Synchrone ; lit la configuration de la session |
| `ReportCommand` | `REPORT SCHEMA/NEED BACKUP` | `string[]` | Synchrone ; lit l'OracleContext |
| `ConnectCommand` | `CONNECT TARGET ...` | `void` | Émet `SESSION_STATE_CHANGED` |
| `HelpCommand` | `HELP` | `string[]` | Synchrone ; retourne la liste des commandes |

### 8.6 RmanScriptParser — support blocs RUN {}

```typescript
// src/terminal/subshells/rman/commands/RmanScriptParser.ts

/**
 * Parse les scripts RMAN multi-lignes.
 * Supporte les blocs RUN { ... } et les commentaires #.
 * Émet SCRIPT_LINE_PARSED / SCRIPT_BLOCK_START / SCRIPT_BLOCK_END
 * sur le bus pour chaque ligne reconnue.
 *
 * Pattern : ITERATOR — parcourt le script ligne par ligne.
 * Pureté  : parse() est une fonction pure (string → ParsedLine[]).
 */

export type ParsedLine =
  | { kind: 'command';     text: string; lineNo: number }
  | { kind: 'block_start'; lineNo: number }
  | { kind: 'block_end';   lineNo: number }
  | { kind: 'comment';     lineNo: number }
  | { kind: 'blank';       lineNo: number }

export function parseRmanScript(source: string): ParsedLine[] {
  const lines  = source.split('\n')
  const result: ParsedLine[] = []
  let depth = 0

  for (let i = 0; i < lines.length; i++) {
    const raw     = lines[i]
    const trimmed = raw.trim()
    const lineNo  = i + 1

    if (!trimmed)                        { result.push({ kind: 'blank',       lineNo }); continue }
    if (trimmed.startsWith('#'))         { result.push({ kind: 'comment',     lineNo }); continue }
    if (trimmed.toUpperCase() === 'RUN' || trimmed === '{') {
      depth++
      result.push({ kind: 'block_start', lineNo })
      continue
    }
    if (trimmed === '}') {
      depth = Math.max(0, depth - 1)
      result.push({ kind: 'block_end', lineNo })
      continue
    }
    // Commande normale (retire le ";" terminal si présent)
    const cmd = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed
    result.push({ kind: 'command', text: cmd, lineNo })
  }

  return result
}
```

---

## 9. RmanSession — Reactive Facade + State Machine + Builder

### 9.1 State Machine de la session

```
                    ┌─────────────────────────────────────────┐
                    │         RmanSessionState                 │
                    │                                         │
                    │   IDLE ──connect()──► CONNECTING         │
                    │                           │             │
                    │                    (success)            │
                    │                           ▼             │
                    │               CONNECTED ◄───────────────┤
                    │                    │                    │
                    │              run(job_cmd)               │
                    │                    ▼                    │
                    │             RUNNING_JOB                  │
                    │                    │                    │
                    │         JOB_COMPLETED / JOB_FAILED      │
                    │                    ▼                    │
                    │               CONNECTED ◄───────────────┘
                    │                    │
                    │              disconnect() / exit
                    │                    ▼
                    │            DISCONNECTED
                    └─────────────────────────────────────────┘

Transitions émises sur bus.sessionState$ à chaque changement.
```

### 9.2 RmanSessionOptions + Builder

```typescript
// src/terminal/subshells/rman/session/types.ts

import type { IRetentionPolicy } from '../policy/IRetentionPolicy'
import type { ChannelConfig }    from '../channel/types'
import type { DbId }             from '../values/DbId'

export interface RmanSessionOptions {
  readonly dbId:            DbId
  readonly channelConfigs:  readonly ChannelConfig[]
  readonly retentionPolicy: IRetentionPolicy
  readonly autobackupCf:    boolean
  readonly debugMode:       boolean
}

export type RmanSessionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RUNNING_JOB' | 'DISCONNECTED'
```

```typescript
// src/terminal/subshells/rman/session/RmanSessionOptionsBuilder.ts

import { DbId }               from '../values/DbId'
import { DEFAULT_CHANNEL_CONFIGS } from '../channel/defaults'
import { RedundancyPolicy }   from '../policy/RedundancyPolicy'
import type { RmanSessionOptions } from './types'
import type { IRetentionPolicy }   from '../policy/IRetentionPolicy'
import type { ChannelConfig }      from '../channel/types'

/**
 * Builder pour RmanSessionOptions.
 * Valeurs par défaut Oracle réalistes.
 *
 * Pattern : BUILDER (GoF) — construction fluide, valeurs par défaut explicites.
 */
export class RmanSessionOptionsBuilder {
  private _dbId:            typeof DbId.DEFAULT    = DbId.DEFAULT
  private _channelConfigs:  readonly ChannelConfig[] = DEFAULT_CHANNEL_CONFIGS
  private _retentionPolicy: IRetentionPolicy        = new RedundancyPolicy(1)
  private _autobackupCf     = true
  private _debugMode        = false

  withDbId(dbId: typeof DbId.DEFAULT): this {
    this._dbId = dbId; return this
  }

  withChannelConfigs(configs: readonly ChannelConfig[]): this {
    this._channelConfigs = configs; return this
  }

  withRetentionPolicy(policy: IRetentionPolicy): this {
    this._retentionPolicy = policy; return this
  }

  withAutobackupControlfile(enabled: boolean): this {
    this._autobackupCf = enabled; return this
  }

  withDebugMode(enabled: boolean): this {
    this._debugMode = enabled; return this
  }

  build(): RmanSessionOptions {
    return Object.freeze({
      dbId:            this._dbId,
      channelConfigs:  this._channelConfigs,
      retentionPolicy: this._retentionPolicy,
      autobackupCf:    this._autobackupCf,
      debugMode:       this._debugMode,
    })
  }
}
```

### 9.3 IRmanSession — interface publique de la Facade

```typescript
// src/terminal/subshells/rman/session/IRmanSession.ts

import type { Result }          from '../core/Result'
import type { RmanError }       from '../core/RmanError'
import type { RmanObservable }  from '../reactive/RmanSubject'
import type { RmanEvent }       from '../core/types'
import type { RmanSessionState }from './types'

/**
 * Interface publique de la session RMAN.
 * Exposée au SubShell et aux tests.
 *
 * Pattern : FACADE (GoF) — masque la complexité interne
 *           (bus, engine, catalog, pool, dispatcher, policy).
 */
export interface IRmanSession {
  /** Stream de tous les événements RMAN (pour abonnements externes). */
  readonly events$: RmanObservable<RmanEvent>

  /** État courant de la session (lecture seule). */
  readonly state: RmanSessionState

  /** Connecte au target database (transition IDLE → CONNECTING → CONNECTED). */
  connect(target?: string): Result<void, RmanError>

  /**
   * Traite une ligne de texte RMAN.
   * - Commandes synchrones (LIST, SHOW, REPORT) → retourne les lignes.
   * - Commandes réactives (BACKUP, RESTORE) → retourne [] et émet sur events$.
   * - EXIT/QUIT → retourne Result.err avec code spécial.
   */
  processLine(line: string): Result<string[], RmanError>

  /** Bannière de démarrage RMAN (affichée une seule fois). */
  getBanner(): string[]

  /** Déconnecte proprement et libère toutes les ressources. */
  dispose(): void
}
```

### 9.4 RmanSession — Reactive Facade principale

```typescript
// src/terminal/subshells/rman/session/RmanSession.ts

import { RmanEventBus }           from '../reactive/RmanEventBus'
import { ReactiveChannelPool }    from '../channel/ReactiveChannelPool'
import { InMemoryRmanCatalog }    from '../catalog/InMemoryRmanCatalog'
import { RmanJobEngine }          from '../job/RmanJobEngine'
import { RmanCommandDispatcher }  from '../commands/RmanCommandDispatcher'
import { ok, err }                from '../core/Result'
import { formatOracleDate }       from '../core/pureUtils'
import type { Result }            from '../core/Result'
import type { RmanError }         from '../core/RmanError'
import type { IRmanSession }      from './IRmanSession'
import type { RmanSessionOptions, RmanSessionState } from './types'
import type { IRmanOracleContext } from '../integration/IRmanOracleContext'
import type { RmanObservable }    from '../reactive/RmanSubject'
import type { RmanEvent }         from '../core/types'

/**
 * Facade réactive de la session RMAN.
 *
 * Responsabilités :
 *   1. Créer et câbler tous les sous-systèmes (bus, pool, catalog, engine)
 *   2. Gérer la machine d'état (IDLE → CONNECTED → RUNNING_JOB → …)
 *   3. Déléguer les commandes au dispatcher
 *   4. Exposer events$ pour les abonnés externes (SubShell, Logger)
 *
 * Pattern : FACADE     — surface publique réduite (3 méthodes + 1 stream)
 * Pattern : MEDIATOR   — orchestre bus, engine, catalog, pool, dispatcher
 * Pattern : OBSERVER   — events$ est un stream en lecture seule
 */
export class RmanSession implements IRmanSession {
  private readonly _bus:        RmanEventBus
  private readonly _pool:       ReactiveChannelPool
  private readonly _catalog:    InMemoryRmanCatalog
  private readonly _engine:     RmanJobEngine
  private readonly _dispatcher: RmanCommandDispatcher
  private _state: RmanSessionState = 'IDLE'
  private readonly _unsubs: Array<() => void> = []

  readonly events$: RmanObservable<RmanEvent>

  constructor(
    private readonly _options: RmanSessionOptions,
    private readonly _ctx:     IRmanOracleContext,
  ) {
    // Câblage des sous-systèmes
    this._bus        = new RmanEventBus()
    this._pool       = new ReactiveChannelPool(_options.channelConfigs)
    this._catalog    = new InMemoryRmanCatalog()
    this._engine     = new RmanJobEngine(this._bus, this._pool, this._catalog, _ctx)
    this._dispatcher = new RmanCommandDispatcher()

    this.events$ = this._bus.events$

    // Câblage réactif
    this._wireReactiveStreams()
  }

  get state(): RmanSessionState { return this._state }

  connect(target?: string): Result<void, RmanError> {
    if (this._state !== 'IDLE') return ok(undefined)
    this._transition('CONNECTING')
    // Simulation connexion toujours réussie
    this._transition('CONNECTED')
    this._bus.emit({ type: 'CONNECTED', dbId: String(this._options.dbId.value), dbName: this._options.dbId.name, connectedAt: Date.now() })
    return ok(undefined)
  }

  processLine(line: string): Result<string[], RmanError> {
    const trimmed = line.trim()
    const upper   = trimmed.toUpperCase()

    if (!trimmed) return ok([])

    // EXIT / QUIT — code spécial reconnu par le SubShell
    if (upper === 'EXIT' || upper === 'QUIT') {
      this.dispose()
      return ok(['Recovery Manager complete.'])
    }

    // CONNECT TARGET — commande spéciale de session
    if (upper.startsWith('CONNECT TARGET')) {
      return this.connect(trimmed)
    }

    // Vérification connexion pour les autres commandes
    if (this._state !== 'CONNECTED' && this._state !== 'RUNNING_JOB') {
      return err({ code: 'RMAN_03002', message: 'target database is not connected' })
    }

    // Délégation au dispatcher
    const cmdCtx = {
      bus:    this._bus,
      engine: this._engine,
      catalog: this._catalog,
      ctx:    this._ctx,
      policy: this._options.retentionPolicy,
    }
    return this._dispatcher.dispatch(trimmed, cmdCtx)
  }

  getBanner(): string[] {
    return [
      '',
      `Recovery Manager: Release 19.0.0.0.0 - Production on ${formatOracleDate()}`,
      '',
      'Copyright (c) 1982, 2024, Oracle and/or its affiliates.  All rights reserved.',
      '',
    ]
  }

  dispose(): void {
    this._transition('DISCONNECTED')
    this._bus.emit({ type: 'DISCONNECTED' })
    this._unsubs.forEach(u => u())
    this._pool.dispose()
    this._catalog.dispose()
    this._bus.dispose()
  }

  // ── Câblage réactif ────────────────────────────────────────────

  /**
   * Câble les streams réactifs internes.
   *
   * Règle : RmanSession est le seul composant qui s'abonne aux streams
   * du bus pour les transitions d'état et le logging interne.
   * Les abonnés externes (SubShell) s'abonnent à events$ directement.
   */
  private _wireReactiveStreams(): void {
    // JOB_STARTED → transition CONNECTED → RUNNING_JOB
    this._unsubs.push(
      this._bus.jobStarted$.subscribe(() => {
        if (this._state === 'CONNECTED') this._transition('RUNNING_JOB')
      })
    )

    // JOB_COMPLETED → transition RUNNING_JOB → CONNECTED
    this._unsubs.push(
      this._bus.jobCompleted$.subscribe(() => {
        if (this._state === 'RUNNING_JOB') this._transition('CONNECTED')
      })
    )

    // JOB_FAILED → transition RUNNING_JOB → CONNECTED (avec log d'erreur)
    this._unsubs.push(
      this._bus.jobFailed$.subscribe(e => {
        if (this._state === 'RUNNING_JOB') this._transition('CONNECTED')
        // L'erreur est déjà disponible dans l'événement JOB_FAILED
        // Le SubShell s'en charge via son abonnement à events$
      })
    )

    // BACKUP_PIECE_CREATED → mise à jour catalogue (déjà dans RmanJobEngine,
    // mais le bus permet des abonnés supplémentaires — ex: metrics, UI)
    this._unsubs.push(
      this._bus.pieceCreated$.subscribe(e => {
        // Optionnel : notifier le store Zustand ici
        // store.getState().updateBackupPiece(e.piece)
      })
    )

    // Forwarding des events allocation/libération de canal vers le bus global
    this._unsubs.push(
      this._pool.allocations$.subscribe(e => this._bus.emit(e)),
      this._pool.releases$.subscribe(e   => this._bus.emit(e)),
      this._catalog.changes$.subscribe(e => this._bus.emit(e)),
    )
  }

  private _transition(to: RmanSessionState): void {
    const from = this._state
    if (from === to) return
    this._state = to
    this._bus.emit({ type: 'SESSION_STATE_CHANGED', from, to })
  }
}
```

### 9.5 Factory statique — point d'entrée unique

```typescript
// src/terminal/subshells/rman/session/RmanSession.ts (suite)

export namespace RmanSession {
  /**
   * Factory : crée une session avec les options par défaut.
   * Supporte les arguments de ligne de commande (rman target /).
   */
  export function create(
    args: string[],
    ctx: IRmanOracleContext,
    options?: Partial<RmanSessionOptions>,
  ): { session: RmanSession; banner: string[] } {
    const opts = new RmanSessionOptionsBuilder()
      .withDbId(ctx.dbId)
      .build()
    const merged = { ...opts, ...options }

    const session = new RmanSession(merged, ctx)
    const banner  = session.getBanner()

    // Connexion automatique si "target /" présent dans les args
    const targetIdx = args.findIndex(a => a.toUpperCase() === 'TARGET')
    if (targetIdx !== -1) {
      session.connect(args[targetIdx + 1] ?? '/')
      banner.push(`connected to target database: ${ctx.dbId.name} (DBID=${ctx.dbId.value})`)
      banner.push('')
    }

    return { session, banner }
  }
}
```

---

## 10. Intégration : SubShell réactif + OracleContext + VFS

### 10.1 IRmanOracleContext — Adapter interface

```typescript
// src/terminal/subshells/rman/integration/IRmanOracleContext.ts

import type { DbId }  from '../values/DbId'
import type { Result } from '../core/Result'
import type { RmanError } from '../core/RmanError'

export interface DatafileInfo {
  readonly fileNo:     number
  readonly path:       string
  readonly sizeBytes:  number
  readonly tablespace: string
}

export interface VfsAdapter {
  writeFile(path: string, data: Uint8Array): Result<void, RmanError>
  readFile(path:  string):                   Result<Uint8Array, RmanError>
  fileExists(path: string):                  boolean
  availableBytes():                          number
}

/**
 * Interface Adapter entre RmanSession et l'infrastructure de la simulation.
 *
 * Pattern : ADAPTER (GoF) — traduit le VirtualFileSystem (orienté Linux)
 *           et OracleInstance en surface orientée RMAN.
 */
export interface IRmanOracleContext {
  readonly dbId:    DbId
  readonly dbName:  string
  readonly vfs:     VfsAdapter
  getDatafiles():   readonly DatafileInfo[]
  getSpfileParam(name: string): string | undefined
}
```

### 10.2 LinuxRmanContext — Adapter concret

```typescript
// src/terminal/subshells/rman/integration/LinuxRmanContext.ts

import { DbId }                 from '../values/DbId'
import { ok, err }              from '../core/Result'
import type { IRmanOracleContext, DatafileInfo, VfsAdapter } from './IRmanOracleContext'
import type { VirtualFileSystem } from '@/terminal/filesystem'
import type { OracleInstance }    from '@/database/oracle/OracleInstance'

/**
 * Adapter concret.
 * Wraps VirtualFileSystem (VFS de Linux/Oracle) et OracleInstance
 * pour exposer IRmanOracleContext.
 */
export class LinuxRmanContext implements IRmanOracleContext {
  readonly dbId:   typeof DbId.DEFAULT
  readonly dbName: string
  readonly vfs:    VfsAdapter

  constructor(
    private readonly _vfs:      VirtualFileSystem,
    private readonly _instance: OracleInstance,
  ) {
    this.dbId   = DbId.DEFAULT
    this.dbName = 'ORCL'
    this.vfs    = this._buildVfsAdapter()
  }

  getDatafiles(): readonly DatafileInfo[] {
    return [
      { fileNo: 1, path: '/u01/app/oracle/oradata/ORCL/system01.dbf',  sizeBytes: 838_860_800, tablespace: 'SYSTEM'   },
      { fileNo: 2, path: '/u01/app/oracle/oradata/ORCL/sysaux01.dbf',  sizeBytes: 576_716_800, tablespace: 'SYSAUX'   },
      { fileNo: 3, path: '/u01/app/oracle/oradata/ORCL/undotbs01.dbf', sizeBytes: 209_715_200, tablespace: 'UNDOTBS1' },
      { fileNo: 4, path: '/u01/app/oracle/oradata/ORCL/users01.dbf',   sizeBytes: 104_857_600, tablespace: 'USERS'    },
    ]
  }

  getSpfileParam(name: string): string | undefined {
    const params: Record<string, string> = {
      db_name:              'ORCL',
      db_recovery_file_dest: '/u01/backup',
      control_files:        '/u01/app/oracle/oradata/ORCL/control01.ctl',
    }
    return params[name.toLowerCase()]
  }

  private _buildVfsAdapter(): VfsAdapter {
    return {
      writeFile: (path, data) => {
        try {
          this._vfs.writeFile(path, data)
          return ok(undefined)
        } catch (e) {
          return err({ code: 'VFS_WRITE_ERROR', message: String(e), path })
        }
      },
      readFile: (path) => {
        try {
          const data = this._vfs.readFile(path)
          return ok(data)
        } catch (e) {
          return err({ code: 'VFS_READ_ERROR', message: String(e), path })
        }
      },
      fileExists:     (path) => this._vfs.fileExists(path),
      availableBytes: ()     => this._vfs.availableBytes?.() ?? 10_737_418_240, // 10 GB défaut
    }
  }
}
```

### 10.3 ReactiveRmanSubShell — abonné aux événements

```typescript
// src/terminal/subshells/rman/ReactiveRmanSubShell.ts

import type { KeyEvent }      from '@/terminal/sessions/TerminalSession'
import type { ISubShell, SubShellResult } from '../ISubShell'
import type { IRmanSession }  from './session/IRmanSession'
import type { RmanEvent }     from './core/types'
import { RmanSession }        from './session/RmanSession'
import { LinuxRmanContext }   from './integration/LinuxRmanContext'
import type { VirtualFileSystem } from '@/terminal/filesystem'
import type { OracleInstance }    from '@/database/oracle/OracleInstance'

/**
 * SubShell RMAN réactif.
 *
 * Remplace RmanSubShell.ts (stub synchrone).
 *
 * Différence majeure :
 *   - L'ancien SubShell construisait lui-même les sorties RMAN.
 *   - Ce SubShell s'abonne aux streams de RmanSession et
 *     accumule les lignes émises dans _outputBuffer.
 *   - processLine() vide le buffer et le retourne au TerminalSession.
 *
 * Pattern : OBSERVER — abonné à session.events$.
 */
export class ReactiveRmanSubShell implements ISubShell {
  private readonly _session:      IRmanSession
  private readonly _outputBuffer: string[] = []
  private readonly _unsubs:       Array<() => void> = []
  private _shouldExit = false

  private constructor(session: IRmanSession) {
    this._session = session
    this._wireEvents()
  }

  static create(
    args: string[],
    vfs: VirtualFileSystem,
    oracle: OracleInstance,
  ): { subShell: ReactiveRmanSubShell; banner: string[] } {
    const ctx = new LinuxRmanContext(vfs, oracle)
    const { session, banner } = RmanSession.create(args, ctx)
    const subShell = new ReactiveRmanSubShell(session)
    return { subShell, banner }
  }

  getPrompt(): string { return 'RMAN> ' }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) { this._shouldExit = true; return true }
    if (e.key === 'c' && e.ctrlKey) return true
    return false
  }

  processLine(line: string): SubShellResult {
    const trimmed = line.trim()
    const upper   = trimmed.toUpperCase()

    if (!trimmed) {
      return { output: [], exit: false, prompt: 'RMAN> ' }
    }

    // Vider le buffer avant l'exécution (résidus d'events précédents)
    this._outputBuffer.length = 0

    // Exécuter via la session
    const result = this._session.processLine(trimmed)

    if (!result.ok) {
      // Erreur de commande → afficher le stack RMAN
      return {
        output: this._formatRmanError(result.error),
        exit:   false,
        prompt: 'RMAN> ',
      }
    }

    const exitNow = this._shouldExit
      || upper === 'EXIT'
      || upper === 'QUIT'

    // Collecter : lignes synchrones (result.value) + lignes réactives (buffer)
    const output = [...result.value, ...this._outputBuffer]
    this._outputBuffer.length = 0

    return { output, exit: exitNow, prompt: 'RMAN> ' }
  }

  dispose(): void {
    this._unsubs.forEach(u => u())
    this._session.dispose()
  }

  // ── Câblage réactif ────────────────────────────────────────────

  /**
   * Abonnement aux streams de la session.
   * Chaque événement est converti en ligne(s) de texte Oracle.
   */
  private _wireEvents(): void {
    // Progression → lignes intermédiaires RMAN
    this._unsubs.push(
      this._session.events$.subscribe(e => this._handleEvent(e))
    )
  }

  private _handleEvent(e: RmanEvent): void {
    switch (e.type) {
      case 'JOB_STARTED':
        this._push(`\nStarting ${e.operation.toLowerCase().replace(/_/g, ' ')} at ${this._nowStr()}`)
        break

      case 'PROGRESS_UPDATED':
        this._push(e.message)
        break

      case 'BACKUP_PIECE_CREATED':
        this._push(`piece handle=${e.piece.path} tag=${e.piece.tag.label}`)
        break

      case 'BACKUP_SET_COMPLETE':
        this._push(`channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15`)
        break

      case 'JOB_COMPLETED':
        this._push(`Finished ${e.operation.toLowerCase().replace(/_/g, ' ')} at ${this._nowStr()}`)
        this._push('')
        break

      case 'JOB_FAILED':
        this._push('')
        this._push('RMAN-00571: ===========================================================')
        this._push('RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============')
        this._push('RMAN-00571: ===========================================================')
        this._push(`RMAN-03014: ${e.error.message}`)
        break

      case 'CHANNEL_ALLOCATED':
        this._push(`allocated channel: ${e.channelId}`)
        this._push(`channel ${e.channelId}: SID=${e.sid} device type=${e.deviceType}`)
        break

      case 'RESTORE_DATAFILE_STARTED':
        this._push(`channel ORA_DISK_1: restoring datafile ${String(e.fileNo).padStart(5, '0')} to ${e.to}`)
        break

      case 'RESTORE_DATAFILE_COMPLETED':
        this._push(`channel ORA_DISK_1: restore complete, elapsed time: 00:00:25`)
        break

      case 'RECOVER_STARTED':
        this._push('starting media recovery')
        break

      case 'RECOVER_COMPLETED':
        this._push(`media recovery complete, elapsed time: 00:00:03`)
        break

      case 'CROSSCHECK_DONE':
        this._push(`Crosschecked ${e.available + e.expired} objects`)
        if (e.expired > 0) this._push(`${e.expired} piece(s) marked EXPIRED`)
        break

      case 'CONNECTED':
        this._push(`connected to target database: ${e.dbName} (DBID=${e.dbId})`)
        break

      // Les autres events (CATALOG_UPDATED, SESSION_STATE_CHANGED, etc.)
      // sont internes — pas de sortie visible
    }
  }

  private _push(line: string): void { this._outputBuffer.push(line) }
  private _nowStr(): string {
    const now = new Date()
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(now.getDate())}-${months[now.getMonth()]}-${now.getFullYear()} `
         + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }

  private _formatRmanError(e: import('./core/RmanError').RmanError): string[] {
    return [
      'RMAN-00571: ===========================================================',
      'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
      'RMAN-00571: ===========================================================',
      `RMAN-00558: error encountered while parsing input command`,
      `RMAN-01009: syntax error: found: unknown command`,
      `RMAN-01007: at line 1 column 1 file: standard input`,
    ]
  }
}
```

### 10.4 Migration depuis RmanSubShell.ts

```
Ancien (synchrone) :
  RmanSubShell.processLine(line) → string[]
    └─ switch(upper) → appelle _backupOutput(), _listBackupOutput()… directement
    └─ Construit les lignes de sortie inline
    └─ Pas d'état, pas d'événements

Nouveau (réactif) :
  ReactiveRmanSubShell.processLine(line)
    └─ session.processLine(line)          ← délègue à la Facade
        └─ dispatcher.dispatch(line)      ← Command Pattern
            └─ BackupCommand.execute()    ← émet sur bus
                └─ engine.run(job)        ← émet PROGRESS_UPDATED, PIECE_CREATED, JOB_COMPLETED
    └─ _handleEvent(e) pour chaque event  ← accumule dans _outputBuffer
    └─ Retourne output = [synchrones + réactifs]

Points clés de la migration :
  ✓ L'interface ISubShell est inchangée — le TerminalSession ne voit pas la différence
  ✓ getPrompt() / handleKey() identiques
  ✓ processLine() retourne toujours SubShellResult
  ✓ Le câblage réactif est interne à ReactiveRmanSubShell
```

---

## 11. Flux complets et scénarios — séquences événementielles

### 11.1 Scénario : BACKUP DATABASE

```
Utilisateur tape : BACKUP DATABASE
        │
        ▼
ReactiveRmanSubShell.processLine("BACKUP DATABASE")
        │
        ▼
RmanSession.processLine("BACKUP DATABASE")
        │
        ▼
RmanCommandDispatcher.dispatch("BACKUP DATABASE", cmdCtx)
        │   match: /^BACKUP DATABASE$/i → BackupCommand
        ▼
BackupCommand.execute([], cmdCtx)
        │   bus.emit(PROGRESS_UPDATED "Starting backup at...")
        │   engine.run(job: BACKUP_DATABASE)
        ▼
RmanJobEngine.run(job)
        │   bus.emit(JOB_STARTED)
        │        └─► RmanSession._wireReactiveStreams():
        │              state: CONNECTED → RUNNING_JOB
        │              bus.emit(SESSION_STATE_CHANGED)
        │
        │   pool.allocate() → Result.ok(handle)
        │        └─► ReactiveChannelPool._alloc$.next(CHANNEL_ALLOCATED)
        │              └─► RmanSession: pool.allocations$.subscribe → bus.emit(CHANNEL_ALLOCATED)
        │                     └─► ReactiveRmanSubShell._handleEvent:
        │                           push("allocated channel: ORA_DISK_1")
        │                           push("channel ORA_DISK_1: SID=142 device type=DISK")
        │
        │   [Parcours des steps :]
        │   bus.emit(PROGRESS_UPDATED "allocated channel: ORA_DISK_1")
        │        └─► SubShell: push(message)
        │   bus.emit(PROGRESS_UPDATED "channel ORA_DISK_1: starting full datafile backup set")
        │        └─► SubShell: push(message)
        │   ... (autres steps)
        │
        │   _doBackup() :
        │     ctx.vfs.writeFile(path, data) → ok
        │     bus.emit(BACKUP_PIECE_STARTED)
        │     bus.emit(BACKUP_PIECE_CREATED { piece })
        │          └─► SubShell: push("piece handle=... tag=...")
        │     catalog.recordBackupSet(set)
        │          └─► InMemoryRmanCatalog._changes$.next(CATALOG_UPDATED INSERT)
        │                └─► RmanSession: catalog.changes$.subscribe → bus.emit(CATALOG_UPDATED)
        │     bus.emit(BACKUP_SET_COMPLETE)
        │          └─► SubShell: push("channel ORA_DISK_1: backup set complete...")
        │
        │   pool.release(handle)
        │        └─► ReactiveChannelPool._rel$.next(CHANNEL_RELEASED)
        │
        │   bus.emit(JOB_COMPLETED)
        │        └─► RmanSession: state: RUNNING_JOB → CONNECTED
        │        └─► SubShell: push("Finished backup at ...")
        │
        ▼
Result.ok([]) ← retour synchrone (vide, tout était réactif)
        │
        ▼
SubShell.processLine returns :
  output: [
    "Starting backup at 06-MAY-2026 14:30:22",
    "allocated channel: ORA_DISK_1",
    "channel ORA_DISK_1: SID=142 device type=DISK",
    "channel ORA_DISK_1: starting full datafile backup set",
    "channel ORA_DISK_1: specifying datafile(s) in backup set",
    "channel ORA_DISK_1: backing up database",
    "piece handle=/u01/backup/ORCL_a3f9bc12.bkp tag=TAG20260506T143022",
    "channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15",
    "Finished backup at 06-MAY-2026 14:30:37",
    ""
  ]
  exit: false
  prompt: "RMAN> "
```

---

### 11.2 Scénario : RESTORE DATABASE + RECOVER DATABASE

```
Utilisateur tape : RESTORE DATABASE

RmanSession.processLine()
  → RestoreCommand.execute()
  → engine.run(job: RESTORE_DATABASE)
        │
        ├─ bus.emit(JOB_STARTED)
        ├─ pool.allocate() → CHANNEL_ALLOCATED event
        ├─ Steps PROGRESS_UPDATED...
        ├─ _doRestore():
        │     Pour chaque datafile (1..4):
        │       bus.emit(RESTORE_DATAFILE_STARTED {fileNo, to})
        │            └─► SubShell: push("channel ORA_DISK_1: restoring datafile 00001 to ...")
        │       bus.emit(RESTORE_DATAFILE_COMPLETED {fileNo})
        │            └─► SubShell: push("channel ORA_DISK_1: restore complete...")
        ├─ pool.release() → CHANNEL_RELEASED event
        └─ bus.emit(JOB_COMPLETED)
               └─► SubShell: push("Finished restore at ...")

Output SubShell :
  "Starting restore at 06-MAY-2026 14:35:00"
  "allocated channel: ORA_DISK_1"
  "channel ORA_DISK_1: SID=142 device type=DISK"
  "channel ORA_DISK_1: starting datafile backup set restore"
  "channel ORA_DISK_1: restoring datafile 00001 to /u01/.../system01.dbf"
  "channel ORA_DISK_1: restoring datafile 00002 to /u01/.../sysaux01.dbf"
  "channel ORA_DISK_1: restoring datafile 00003 to /u01/.../undotbs01.dbf"
  "channel ORA_DISK_1: restoring datafile 00004 to /u01/.../users01.dbf"
  "channel ORA_DISK_1: restore complete, elapsed time: 00:00:25"
  "Finished restore at 06-MAY-2026 14:35:25"

---

Utilisateur tape : RECOVER DATABASE

  → RecoverCommand → engine.run(job: RECOVER_DATABASE)
        ├─ bus.emit(RECOVER_STARTED {fromScn})
        │       └─► SubShell: push("starting media recovery")
        └─ bus.emit(RECOVER_COMPLETED {toScn})
               └─► SubShell: push("media recovery complete, elapsed time: 00:00:03")
                             push("Finished recover at ...")
```

---

### 11.3 Scénario : CROSSCHECK BACKUP

```
Utilisateur tape : CROSSCHECK BACKUP

  → CrosscheckCommand → engine.run(job: CROSSCHECK)
        ├─ pool.allocate() → CHANNEL_ALLOCATED
        ├─ bus.emit(PROGRESS_UPDATED "allocated channel: ORA_DISK_1")
        ├─ bus.emit(PROGRESS_UPDATED "crosschecked backup piece: found to be 'AVAILABLE'")
        ├─ _doCrosscheck():
        │     Pour chaque pièce du catalogue :
        │       vfs.fileExists(piece.path) ?
        │         → true  : available++
        │         → false : catalog.expirePiece(key) → CATALOG_UPDATED(EXPIRE)
        │                   expired++
        └─ bus.emit(CROSSCHECK_DONE {available, expired})
               └─► SubShell: push("Crosschecked N objects")

Output si tout disponible :
  "allocated channel: ORA_DISK_1"
  "channel ORA_DISK_1: SID=142 device type=DISK"
  "crosschecked backup piece: found to be 'AVAILABLE'"
  "Crosschecked 1 objects"
```

---

### 11.4 Scénario : commande LIST BACKUP SUMMARY (synchrone)

```
Utilisateur tape : LIST BACKUP SUMMARY

  → ListBackupCommand.execute(["SUMMARY"], cmdCtx)
        │   catalog.listAll() → CatalogSnapshot
        │   _summaryLines(sets) → string[]
        └─  Result.ok(string[])  ← synchrone, pas d'événements

Output retourné directement par processLine() :
  ""
  "List of Backups"
  "==============="
  "Key     TY LV S Device Type Completion Time     #Pieces #Copies Compressed Tag"
  "------- -- -- - ----------- ------------------- ------- ------- ---------- ---"
  "1       B  F  A DISK        06-MAY-2026 14:30:37  1       1       NO         TAG20260506T143022"
  ""
```

---

### 11.5 Abonnement externe pour debug (events$ → logger)

```typescript
// Exemple d'utilisation dans RmanSubShell ou dans un composant UI React

const { session, banner } = RmanSession.create(['target', '/'], ctx)

// Abonnement debug — toutes les opérations RMAN loggées
const unsub = session.events$.subscribe(e => {
  console.log(`[RMAN] ${e.type}`, e)
})

// Abonnement UI — mise à jour de la barre de progression
const progressUnsub = session.events$
  // Note: si on avait importé les Operators :
  // .pipe(Operators.ofType((e): e is Extract<RmanEvent, {type:'PROGRESS_UPDATED'}> => e.type === 'PROGRESS_UPDATED'))
  .subscribe(e => {
    if (e.type === 'PROGRESS_UPDATED') {
      store.getState().setRmanProgress(e.jobId, e.pct, e.message)
    }
  })

// Nettoyage
function cleanup() {
  unsub()
  progressUnsub()
  session.dispose()
}
```

---

## 12. Récapitulatif — Patterns, SOLID, FP, Réactif

### 12.1 Tableau des design patterns appliqués

| Pattern (GoF / Enterprise) | Classe(s) | Justification |
|---|---|---|
| **Value Object** | `Scn`, `RmanTag`, `BackupKey`, `DbId` | Immutabilité (`Object.freeze`), sémantique par valeur, pas de setters |
| **Observer / Subject** | `RmanSubject<T>`, `RmanEventBus` | Découplage producteurs/consommateurs, streams typés sans RxJS |
| **Facade** | `RmanSession` | Cache la complexité interne (bus, pool, catalog, engine, dispatcher) |
| **Command** | `IRmanCommand<T>`, `BackupCommand`, `ListBackupCommand`, … | Encapsule opérations, registre extensible sans modifier le dispatcher |
| **Adapter** | `LinuxRmanContext`, `VfsAdapter` | Traduit VirtualFileSystem/OracleInstance → IRmanOracleContext |
| **Builder** | `RmanSessionOptionsBuilder` | Construction fluide avec valeurs par défaut Oracle réalistes |
| **Repository** | `IRmanCatalogRepository` (ISP: Reader/Writer), `InMemoryRmanCatalog` | Découplage stockage/logique métier |
| **Factory** | `BackupSetFactory`, `RmanSession.create()` | Points uniques de création d'objets complexes |
| **Strategy** | `IRetentionPolicy`, `RedundancyPolicy`, `RecoveryWindowPolicy`, `NonePolicy` | Algorithmes de rétention interchangeables sans modifier l'engine |
| **State Machine** | `RmanSessionState` (IDLE→CONNECTING→CONNECTED→RUNNING_JOB→DISCONNECTED) | Transitions explicites, transitions illégales impossibles |
| **Composite** | `ReactiveChannelPool` (N `ChannelConfig` → 1 pool) | Gestion unifiée de N canaux RMAN parallèles |
| **Pipe & Filter** | `RmanObservable.pipe(op1).pipe(op2)…` | Composition d'opérateurs réactifs (filter, map, ofType, bufferTime) |
| **Iterator** | `RmanScriptParser.parseRmanScript()` | Parcours ligne par ligne d'un script RMAN multi-lignes |
| **Null Object** | `RmanSessionOptions` defaults | Valeurs par défaut explicites, pas de null-checks en aval |

---

### 12.2 Principes SOLID respectés

#### S — Single Responsibility

| Classe | Responsabilité unique |
|---|---|
| `RmanSubject<T>` | Observable multicast uniquement |
| `Operators` | Transformateurs de streams (fonctions pures) |
| `RmanEventBus` | Routage d'événements typés |
| `RmanJobEngine` | Exécution des jobs + émission d'événements |
| `ReactiveChannelPool` | Allocation/libération de canaux |
| `InMemoryRmanCatalog` | Persistance des BackupSets en mémoire |
| `RmanCommandDispatcher` | Résolution commande → handler |
| `BackupCommand` | Logique de backup uniquement |
| `LinuxRmanContext` | Adaptation VFS/OracleInstance ↔ IRmanOracleContext |
| `ReactiveRmanSubShell` | Conversion événements → lignes de texte terminal |

#### O — Open/Closed

- `RmanCommandDispatcher.registerCommand()` : ajout de commandes sans modifier le dispatcher.
- `RmanEventBus` : nouveaux types `RmanEvent` ajoutés sans toucher aux abonnés existants.
- `IRetentionPolicy` : nouvelle stratégie = nouvelle classe, sans modifier `RmanJobEngine`.
- `Operators` : nouveaux opérateurs (`throttleTime`, `takeUntil`) ajoutés sans casser les existants.

#### L — Liskov Substitution

- `LinuxRmanContext` est substituable par tout mock `IRmanOracleContext` en test.
- `InMemoryRmanCatalog` est substituable par une implémentation persistante (SQLite, fichier JSON) sans changer `RmanJobEngine`.
- Toutes les commandes (`BackupCommand`, etc.) satisfont `IRmanCommand<T>` — le dispatcher ne connaît que l'interface.

#### I — Interface Segregation

- `IRmanCatalogReader` / `IRmanCatalogWriter` séparés — `ListBackupCommand` n'utilise que le Reader.
- `IChannelPool` : 4 méthodes uniquement (allocate, release, getStats, dispose).
- `IRmanSession` : 4 méthodes publiques (connect, processLine, getBanner, dispose) + 1 stream.
- `VfsAdapter` : 4 méthodes uniquement (writeFile, readFile, fileExists, availableBytes).

#### D — Dependency Inversion

- `RmanJobEngine` dépend de `IRmanCatalogRepository`, `IChannelPool`, `IRmanOracleContext` — pas des implémentations concrètes.
- `RmanSession` dépend de `IRmanOracleContext` — pas de `LinuxRmanContext` directement.
- `RmanCommandDispatcher` dépend de `IRmanCommand<unknown>` — pas des classes concrètes.

---

### 12.3 Programmation Fonctionnelle — garanties

| Garantie | Où | Détail |
|---|---|---|
| **Pureté** | `formatElapsed`, `formatSize`, `formatOracleDate`, `generatePieceName` | Même entrée → même sortie, aucun side-effect |
| **Pureté** | `parseRmanScript()` | `string → ParsedLine[]`, aucune mutation |
| **Pureté** | `Operators.filter/map/ofType/merge/bufferTime/distinctUntilChanged` | Higher-order functions sans état |
| **Pureté** | `BackupSetFactory.createBackupSet()` | Crée un objet immuable, ne modifie rien |
| **Immutabilité** | Tous les Value Objects | `Object.freeze()` à la construction |
| **Immutabilité** | `RmanJob`, `JobStep`, `RmanSessionOptions` | `readonly` sur tous les champs |
| **Result<T,E>** | `IRmanCatalogRepository`, `IChannelPool`, `IRmanJobEngine`, `VfsAdapter` | Pas d'exceptions, erreurs typées |
| **No null** | Value Objects via factories | `Result.err(...)` au lieu de `null` |
| **readonly arrays** | `BackupSet.pieces`, `BackupSet.datafiles`, `RmanJob.steps` | Pas de mutation après création |

---

### 12.4 Architecture réactive — comparaison avec le design original

```
Design original (DESIGN-RMAN.md) :
────────────────────────────────────
  RmanSession.execute(cmd) → Result<string[], E>
       │   synchrone, bloquant
       └─► retourne les lignes directement

  Inconvénients :
    ✗ Difficile de simuler la progression en temps réel
    ✗ Tests : vérifier la sortie globale, pas les étapes
    ✗ Pas d'abonnement externe possible (UI, logger)
    ✗ Channel pool couplé à la session
    ✗ Catalogue mis à jour après l'opération complète

Design réactif (ce document) :
────────────────────────────────────
  RmanSession.processLine(cmd) → Result<string[], E>
       │   (string[] = lignes synchrones uniquement)
       │   + events$ stream pour tout le reste
       │
       ├─ JOB_STARTED         → state: RUNNING_JOB
       ├─ PROGRESS_UPDATED    → SubShell accumule les lignes
       ├─ CHANNEL_ALLOCATED   → SubShell affiche "allocated channel..."
       ├─ BACKUP_PIECE_CREATED→ SubShell + Catalog (double abonné)
       ├─ JOB_COMPLETED       → SubShell + state: CONNECTED
       └─ JOB_FAILED          → SubShell (erreur) + state: CONNECTED

  Avantages :
    ✓ Extensible : tout abonné peut réagir aux événements
    ✓ Testable : subscribe aux streams, vérifier séquence
    ✓ Découplé : SubShell ne connaît pas l'engine ni le catalog
    ✓ Observable : bar de progression UI possible
    ✓ Composable : pipe(filter, map) sur n'importe quel stream
    ✓ Pas de RxJS : RmanSubject (~120 lignes) suffit
```

---

### 12.5 Guide d'implémentation — ordre recommandé

```
Phase 1 — Fondations (testables en isolation, ~1 jour)
  ├─ 1. core/RmanError.ts + core/types.ts (RmanEvent union)
  ├─ 2. values/ (Scn, RmanTag, BackupKey, DbId) + pureUtils.ts
  └─ 3. reactive/RmanSubject.ts + reactive/operators.ts

Phase 2 — Infrastructure réactive (~1 jour)
  └─ 4. reactive/RmanEventBus.ts

Phase 3 — Sous-systèmes (chacun testable isolément, ~2 jours)
  ├─ 5. catalog/InMemoryRmanCatalog.ts + BackupSetFactory.ts
  ├─ 6. channel/ReactiveChannelPool.ts
  └─ 7. policy/ (RedundancyPolicy, RecoveryWindowPolicy, NonePolicy)

Phase 4 — Moteur de jobs (~1 jour)
  ├─ 8. job/RmanJobEngine.ts
  └─ 9. job/JobBuilder.ts

Phase 5 — Command layer (~1 jour)
  ├─ 10. commands/RmanCommandDispatcher.ts
  ├─ 11. commands/BackupCommand.ts, RestoreCommand.ts, …
  └─ 12. commands/RmanScriptParser.ts

Phase 6 — Facade + Intégration (~1 jour)
  ├─ 13. session/RmanSession.ts
  ├─ 14. integration/LinuxRmanContext.ts
  └─ 15. ReactiveRmanSubShell.ts (remplace RmanSubShell.ts)

Phase 7 — Tests d'intégration (~1 jour)
  └─ 16. __tests__/rmanSession.test.ts
         : backup complet → vérifier séquence events$
         : restore → vérifier RESTORE_DATAFILE_STARTED×4
         : crosscheck avec fichier manquant → CATALOG_UPDATED(EXPIRE)
```

#### Invariants à maintenir

1. **`RmanJobEngine` n'imprime jamais** — il émet des événements. `ReactiveRmanSubShell` est le seul responsable du texte affiché.
2. **`RmanSubject.next()` est synchrone** — les handlers dans `_handleEvent()` ne doivent pas être longs ni contenir d'`await`.
3. **Toute émission se fait via `RmanEventBus.emit()`** — jamais d'accès direct à `_events$` depuis l'extérieur.
4. **`processLine()` vide le buffer avant exécution** — sinon les événements d'une commande précédente contaminent la sortie.
5. **`dispose()` est idempotent** — appels multiples n'ont pas d'effet secondaire.

---

### 12.6 Résumé visuel — dépendances entre modules

```
                   ┌──────────────────────────────────────────────┐
                   │            ReactiveRmanSubShell              │
                   │         (ISubShell ← TerminalSession)        │
                   └────────────────────┬─────────────────────────┘
                                        │ processLine() / events$.subscribe()
                                        ▼
                   ┌──────────────────────────────────────────────┐
                   │               RmanSession                    │
                   │              (Facade + State)                │
                   └──┬──────┬──────────┬──────────┬─────────────┘
                      │      │          │          │
              ┌───────▼──┐ ┌─▼──────┐ ┌─▼──────┐ ┌▼──────────────────┐
              │RmanEvent │ │ Channel│ │ Job    │ │  Command           │
              │  Bus     │ │ Pool   │ │ Engine │ │  Dispatcher        │
              └─────┬────┘ └────────┘ └───┬────┘ └──────────────────┘
                    │                     │              │
                    │              ┌──────▼──────┐  ┌───▼──────────────┐
                    │              │IRmanCatalog │  │ IRmanCommand<T>  │
                    │              │Repository   │  │ BackupCmd etc.   │
                    │              └─────────────┘  └──────────────────┘
                    │                     │
                    │              ┌──────▼──────────────────────┐
                    │              │  IRmanOracleContext (Adapter)│
                    │              │  LinuxRmanContext            │
                    │              └─────────────────────────────┘
                    │
              events$ (Observable<RmanEvent>)
                    │
              ┌─────▼──────────────────────────┐
              │ Abonnés externes possibles :   │
              │  - Logger global               │
              │  - Store Zustand (UI progress) │
              │  - Tests (vérification events) │
              └────────────────────────────────┘

Dépendances vers le haut uniquement — aucun cycle.
RmanEventBus est le seul composant partagé entre tous les sous-systèmes.
```

---

*Fin du document — RMAN Reactive Technical Class Diagram v1.0*
