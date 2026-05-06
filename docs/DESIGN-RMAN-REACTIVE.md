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
