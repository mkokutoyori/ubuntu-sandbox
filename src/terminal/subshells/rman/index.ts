/**
 * RMAN — public re-exports.
 *
 * Consumers outside src/terminal/subshells/rman/ import from this
 * barrel. The internal module structure can be reorganised freely.
 */

// Core
export { ok, err, type Result } from './core/Result';
export { rmanErrorMessage, type RmanError } from './core/RmanError';
export type { RmanEvent, RmanOperation, RmanSessionState, BackupPieceInfo } from './core/types';

// Value objects
export { Scn } from './values/Scn';
export { RmanTag } from './values/RmanTag';
export { BackupKey } from './values/BackupKey';
export { DbId } from './values/DbId';

// Reactive primitives
export { RmanSubject, type RmanObservable, type RmanOperator } from './reactive/RmanSubject';
export { RmanBehaviorSubject } from './reactive/RmanBehaviorSubject';
export { Operators } from './reactive/operators';
export { RmanEventBus } from './reactive/RmanEventBus';
export { createAggregations, EMPTY_METRICS, type SessionMetrics, type ReactiveAggregations } from './reactive/aggregations';

// Policy
export type { IRetentionPolicy, RetentionKind } from './policy/IRetentionPolicy';
export { RedundancyPolicy } from './policy/RedundancyPolicy';
export { RecoveryWindowPolicy } from './policy/RecoveryWindowPolicy';
export { NonePolicy } from './policy/NonePolicy';

// Catalog
export type {
  BackupSet, BackupPiece, BackupType, DatafileEntry, PieceStatus, CatalogSnapshot,
} from './catalog/types';
export { InMemoryRmanCatalog } from './catalog/InMemoryRmanCatalog';
export { BackupSetFactory } from './catalog/BackupSetFactory';
export type {
  IRmanCatalogReader, IRmanCatalogWriter, IRmanCatalogRepository,
} from './catalog/IRmanCatalogRepository';

// Channels
export type { ChannelConfig, ChannelHandle, ChannelStats } from './channel/types';
export { ReactiveChannelPool } from './channel/ReactiveChannelPool';
export { DEFAULT_CHANNEL_CONFIGS, PARALLEL_4_CONFIGS } from './channel/defaults';

// Jobs
export { JobBuilder } from './job/JobBuilder';
export { RmanJobEngine } from './job/RmanJobEngine';
export type { RmanJob, JobStep, JobResult, JobError, JobStatus } from './job/types';

// Commands
export type { IRmanCommand, RmanCommandContext } from './commands/types';
export { RmanCommandDispatcher } from './commands/RmanCommandDispatcher';

// Session
export type { IRmanSession } from './session/IRmanSession';
export { RmanSession } from './session/RmanSession';
export { RmanSessionOptionsBuilder } from './session/RmanSessionOptionsBuilder';
export type { RmanSessionOptions } from './session/types';

// Integration
export type { IRmanOracleContext, DatafileInfo, VfsAdapter } from './integration/IRmanOracleContext';
export { LinuxRmanContext } from './integration/LinuxRmanContext';

// SubShell
export { ReactiveRmanSubShell } from './ReactiveRmanSubShell';

// Shared-bus integration
export type {
  RmanDomainEvent, RmanDomainEventTopic, RmanSessionRef,
  RmanSessionStateChangedPayload, RmanConnectedPayload, RmanDisconnectedPayload,
  RmanJobStartedPayload, RmanJobCompletedPayload, RmanJobFailedPayload,
  RmanProgressUpdatedPayload, RmanBackupPieceCreatedPayload,
  RmanBackupSetCompletePayload, RmanChannelAllocatedPayload,
  RmanChannelReleasedPayload, RmanCatalogUpdatedPayload, RmanConfigChangedPayload,
} from './events';
export { RmanBusBridge } from './RmanBusBridge';
export {
  RmanSignalStore, EMPTY_RMAN_METRICS, makeReadonlyRmanObservables,
  type RmanSessionVM, type RmanActiveJobVM, type RmanMetricsVM, type RmanObservables,
} from './RmanSignalStore';
export { RmanSignalRefreshActor } from './actors/RmanSignalRefreshActor';
export { RmanLoggerActor } from './actors/RmanLoggerActor';
export { OracleInstanceWatcherActor } from './actors/OracleInstanceWatcherActor';
