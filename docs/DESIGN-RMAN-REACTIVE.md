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
