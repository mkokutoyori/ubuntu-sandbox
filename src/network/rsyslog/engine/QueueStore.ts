import type { RsyslogMessage } from '../Message';

export interface QueuePosition {
  readonly file: number;
  readonly offset: number;
  readonly sequence?: number;
  readonly index?: number;
}

export interface LoadedBacklog {
  readonly messages: RsyslogMessage[];
  readonly positions: QueuePosition[];
}

export interface QueueStore {
  readonly infoFile: string;
  readonly managesCheckpoints: boolean;
  positionOf(item: object): QueuePosition | undefined;
  exceedsDiskSpace(): boolean;
  append(message: RsyslogMessage, internal?: boolean): string | null;
  takePendingPersist(): boolean;
  markDequeued(position: QueuePosition): void;
  commit(position: QueuePosition): number;
  persist(checkpoint: boolean, queueSize: number): boolean;
  drop(): void;
  close(queueSize: number): void;
  load(): LoadedBacklog | null;
}
