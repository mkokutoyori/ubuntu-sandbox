/**
 * RmanConfig — session-scoped mutable configuration driven by
 * CONFIGURE commands. ShowCommand renders its current state.
 *
 * Each setter records the new value and returns the (key, oldValue,
 * newValue) tuple so RmanSession can emit a CONFIG_CHANGED event.
 */

import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import { RedundancyPolicy } from '../policy/RedundancyPolicy';

export type CompressionAlg = 'BASIC' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface RmanConfigSnapshot {
  readonly retentionPolicy:        IRetentionPolicy;
  readonly controlfileAutobackup:  boolean;
  readonly controlfileAutobackupFormat: string;
  readonly defaultDeviceType:      'DISK' | 'SBT';
  readonly deviceParallelism:      number;
  readonly defaultBackupType:      'BACKUPSET' | 'COMPRESSED BACKUPSET' | 'COPY';
  readonly datafileBackupCopies:   number;
  readonly archivelogBackupCopies: number;
  readonly maxSetSize:             string; // 'UNLIMITED' or '<n>[KMGT]'
  readonly compressionAlgorithm:   CompressionAlg;
  readonly encryptionForDatabase:  boolean;
  readonly encryptionAlgorithm:    'AES128' | 'AES192' | 'AES256';
  readonly archivelogDeletionPolicy: 'NONE';
  readonly backupOptimization:     boolean;
}

export interface ConfigDelta {
  readonly key:      string;
  readonly oldValue: string;
  readonly newValue: string;
}

export class RmanConfig {
  private _retentionPolicy: IRetentionPolicy;
  private _controlfileAutobackup: boolean;
  private _controlfileAutobackupFormat = '%F';
  private _defaultDeviceType: 'DISK' | 'SBT' = 'DISK';
  private _deviceParallelism = 1;
  private _defaultBackupType: 'BACKUPSET' | 'COMPRESSED BACKUPSET' | 'COPY' = 'BACKUPSET';
  private _datafileBackupCopies = 1;
  private _archivelogBackupCopies = 1;
  private _maxSetSize = 'UNLIMITED';
  private _compressionAlgorithm: CompressionAlg = 'BASIC';
  private _encryptionForDatabase = false;
  private _encryptionAlgorithm: 'AES128' | 'AES192' | 'AES256' = 'AES128';
  private _archivelogDeletionPolicy: 'NONE' = 'NONE';
  private _backupOptimization = false;

  constructor(initialPolicy: IRetentionPolicy = new RedundancyPolicy(1), initialAutobackup = true) {
    this._retentionPolicy = initialPolicy;
    this._controlfileAutobackup = initialAutobackup;
  }

  snapshot(): RmanConfigSnapshot {
    return {
      retentionPolicy:        this._retentionPolicy,
      controlfileAutobackup:  this._controlfileAutobackup,
      controlfileAutobackupFormat: this._controlfileAutobackupFormat,
      defaultDeviceType:      this._defaultDeviceType,
      deviceParallelism:      this._deviceParallelism,
      defaultBackupType:      this._defaultBackupType,
      datafileBackupCopies:   this._datafileBackupCopies,
      archivelogBackupCopies: this._archivelogBackupCopies,
      maxSetSize:             this._maxSetSize,
      compressionAlgorithm:   this._compressionAlgorithm,
      encryptionForDatabase:  this._encryptionForDatabase,
      encryptionAlgorithm:    this._encryptionAlgorithm,
      archivelogDeletionPolicy: this._archivelogDeletionPolicy,
      backupOptimization:     this._backupOptimization,
    };
  }

  // ── Setters return a ConfigDelta for the session to emit ─────────

  setRetentionPolicy(p: IRetentionPolicy): ConfigDelta {
    const old = this._retentionPolicy.describe();
    this._retentionPolicy = p;
    return { key: 'retention', oldValue: old, newValue: p.describe() };
  }

  setControlfileAutobackup(on: boolean): ConfigDelta {
    const old = String(this._controlfileAutobackup);
    this._controlfileAutobackup = on;
    return { key: 'controlfileAutobackup', oldValue: old, newValue: String(on) };
  }

  setDeviceParallelism(n: number): ConfigDelta {
    const old = String(this._deviceParallelism);
    this._deviceParallelism = n;
    return { key: 'deviceParallelism', oldValue: old, newValue: String(n) };
  }

  setDefaultDeviceType(t: 'DISK' | 'SBT'): ConfigDelta {
    const old = this._defaultDeviceType;
    this._defaultDeviceType = t;
    return { key: 'defaultDeviceType', oldValue: old, newValue: t };
  }

  setBackupOptimization(on: boolean): ConfigDelta {
    const old = String(this._backupOptimization);
    this._backupOptimization = on;
    return { key: 'backupOptimization', oldValue: old, newValue: String(on) };
  }

  setMaxSetSize(value: string): ConfigDelta {
    const old = this._maxSetSize;
    this._maxSetSize = value;
    return { key: 'maxSetSize', oldValue: old, newValue: value };
  }

  setCompressionAlgorithm(alg: CompressionAlg): ConfigDelta {
    const old = this._compressionAlgorithm;
    this._compressionAlgorithm = alg;
    return { key: 'compressionAlgorithm', oldValue: old, newValue: alg };
  }

  setEncryptionForDatabase(on: boolean): ConfigDelta {
    const old = String(this._encryptionForDatabase);
    this._encryptionForDatabase = on;
    return { key: 'encryptionForDatabase', oldValue: old, newValue: String(on) };
  }
}
