/**
 * RmanSessionOptionsBuilder — fluent Builder for RmanSessionOptions.
 */

import { DbId } from '../values/DbId';
import { DEFAULT_CHANNEL_CONFIGS } from '../channel/defaults';
import { RedundancyPolicy } from '../policy/RedundancyPolicy';
import type { RmanSessionOptions } from './types';
import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import type { ChannelConfig } from '../channel/types';
import type { IEventBus } from '@/events/EventBus';
import type { InMemoryRmanCatalog } from '../catalog/InMemoryRmanCatalog';

export class RmanSessionOptionsBuilder {
  private _dbId: DbId = DbId.DEFAULT;
  private _channelConfigs: ReadonlyArray<ChannelConfig> = DEFAULT_CHANNEL_CONFIGS;
  private _retentionPolicy: IRetentionPolicy = new RedundancyPolicy(1);
  private _autobackupCf = true;
  private _debugMode = false;
  private _sharedBus?: IEventBus;
  private _sessionId?: string;
  private _catalog?: InMemoryRmanCatalog;

  withDbId(dbId: DbId): this { this._dbId = dbId; return this; }
  withChannelConfigs(c: ReadonlyArray<ChannelConfig>): this { this._channelConfigs = c; return this; }
  withRetentionPolicy(p: IRetentionPolicy): this { this._retentionPolicy = p; return this; }
  withAutobackupControlfile(b: boolean): this { this._autobackupCf = b; return this; }
  withDebugMode(b: boolean): this { this._debugMode = b; return this; }
  withSharedBus(bus: IEventBus, sessionId: string): this {
    this._sharedBus = bus; this._sessionId = sessionId; return this;
  }
  withCatalog(c: InMemoryRmanCatalog): this { this._catalog = c; return this; }

  build(): RmanSessionOptions {
    return Object.freeze({
      dbId:            this._dbId,
      channelConfigs:  this._channelConfigs,
      retentionPolicy: this._retentionPolicy,
      autobackupCf:    this._autobackupCf,
      debugMode:       this._debugMode,
      sharedBus:       this._sharedBus,
      sessionId:       this._sessionId,
      catalog:         this._catalog,
    });
  }
}
