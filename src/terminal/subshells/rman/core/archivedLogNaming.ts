import type { ArchivedLogRecord } from '../integration/IRmanOracleContext';

const NAMED_THREAD_AND_SEQUENCE = /(?:^|_)(\d+)_(\d+)(?:_|\.)/;

export function archivedLogFromPath(path: string, position: number): ArchivedLogRecord {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const named = NAMED_THREAD_AND_SEQUENCE.exec(base);
  const thread = named ? Number(named[1]) : 1;
  const sequence = named ? Number(named[2]) : position + 1;
  return { thread, sequence, path, firstScn: 0, nextScn: 0 };
}
