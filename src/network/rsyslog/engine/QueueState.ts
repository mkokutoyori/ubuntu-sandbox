import { RsyslogMessage } from '../Message';
import type { RsyslogFiles } from './Host';
import type { QueueSettings } from './Settings';

export function queueStatePath(settings: QueueSettings, workDirectory: string | null): string | null {
  if (settings.type === 'Direct' || settings.fileName === null || !settings.saveOnShutdown) return null;
  return `${workDirectory ?? '.'}/${settings.fileName}.qi`;
}

export function saveQueueState(files: RsyslogFiles, path: string, name: string, pending: readonly RsyslogMessage[]): boolean {
  if (pending.length === 0) return true;
  return files.write(path, `${JSON.stringify({ queue: name, messages: pending })}\n`);
}

export function loadQueueState(files: RsyslogFiles, path: string): RsyslogMessage[] {
  const text = files.read(path);
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) return [];
    return parsed.messages.map((fields: object) => Object.assign(Object.create(RsyslogMessage.prototype) as RsyslogMessage, fields));
  } catch {
    return [];
  }
}
