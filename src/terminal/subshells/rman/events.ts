/**
 * RMAN domain events — projected onto the shared `IEventBus`.
 *
 * Mirrors the existing in-session `RmanEvent` discriminated union, but
 * uses the dotted-topic naming convention the rest of the codebase has
 * adopted (`oracle.*`, `dhcp.*`, `port.*`, …).
 *
 * Sessions forward every internal RmanEvent onto the shared bus through
 * this taxonomy so cross-cutting consumers (UI hooks, signal-refresh
 * actors, audit loggers) can subscribe without coupling to the
 * RmanEventBus instance.
 */

import type { RmanError } from './core/RmanError';
import type { RmanOperation, RmanSessionState } from './core/types';
import type { BackupKey } from './values/BackupKey';

export interface RmanSessionRef {
  /** Stable id of the owning RmanSession. */
  sessionId: string;
}

export interface RmanSessionStateChangedPayload extends RmanSessionRef {
  from: RmanSessionState;
  to:   RmanSessionState;
}

export interface RmanConnectedPayload extends RmanSessionRef {
  dbId:        string;
  dbName:      string;
  connectedAt: number;
}

export interface RmanDisconnectedPayload extends RmanSessionRef {}

export interface RmanJobStartedPayload extends RmanSessionRef {
  jobId:     string;
  operation: RmanOperation;
  startedAt: number;
}

export interface RmanJobCompletedPayload extends RmanSessionRef {
  jobId:     string;
  operation: RmanOperation;
  elapsedMs: number;
}

export interface RmanJobFailedPayload extends RmanSessionRef {
  jobId:     string;
  operation: RmanOperation;
  error:     RmanError;
  elapsedMs: number;
}

export interface RmanProgressUpdatedPayload extends RmanSessionRef {
  jobId:    string;
  stepName: string;
  pct:      number;
  message:  string;
}

export interface RmanBackupPieceCreatedPayload extends RmanSessionRef {
  jobId:     string;
  channelId: string;
  key:       BackupKey;
  path:      string;
  sizeBytes: number;
  tag:       string;
}

export interface RmanBackupSetCompletePayload extends RmanSessionRef {
  jobId:     string;
  bsKey:     number;
  tag:       string;
  sizeBytes: number;
}

export interface RmanChannelAllocatedPayload extends RmanSessionRef {
  channelId:  string;
  sid:        number;
  deviceType: 'DISK' | 'SBT';
}

export interface RmanChannelReleasedPayload extends RmanSessionRef {
  channelId: string;
}

export interface RmanCatalogUpdatedPayload extends RmanSessionRef {
  operation: 'INSERT' | 'DELETE' | 'EXPIRE';
  bsKey:     number;
  bpKey:     number;
}

export interface RmanConfigChangedPayload extends RmanSessionRef {
  key:      string;
  oldValue: string;
  newValue: string;
}

export type RmanDomainEvent =
  | { topic: 'rman.session.state-changed';  payload: RmanSessionStateChangedPayload }
  | { topic: 'rman.session.connected';      payload: RmanConnectedPayload }
  | { topic: 'rman.session.disconnected';   payload: RmanDisconnectedPayload }
  | { topic: 'rman.job.started';            payload: RmanJobStartedPayload }
  | { topic: 'rman.job.completed';          payload: RmanJobCompletedPayload }
  | { topic: 'rman.job.failed';             payload: RmanJobFailedPayload }
  | { topic: 'rman.job.progress';           payload: RmanProgressUpdatedPayload }
  | { topic: 'rman.backup.piece-created';   payload: RmanBackupPieceCreatedPayload }
  | { topic: 'rman.backup.set-complete';    payload: RmanBackupSetCompletePayload }
  | { topic: 'rman.channel.allocated';      payload: RmanChannelAllocatedPayload }
  | { topic: 'rman.channel.released';       payload: RmanChannelReleasedPayload }
  | { topic: 'rman.catalog.updated';        payload: RmanCatalogUpdatedPayload }
  | { topic: 'rman.config.changed';         payload: RmanConfigChangedPayload };

export type RmanDomainEventTopic = RmanDomainEvent['topic'];
