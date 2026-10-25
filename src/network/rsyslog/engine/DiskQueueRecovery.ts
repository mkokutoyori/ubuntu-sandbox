import { MAX_DISK_QUEUE_FILES, type DiskQueueStore } from './DiskQueueStore';
import type { RsyslogFiles } from './Host';
import { encryptionInfoPath } from '../crypto/EncryptionInfo';
import type { LoadedBacklog } from './QueueStore';
import { ObjectStreamError } from './ObjectStream';
import { RS_RET } from './Log';
import type { SyslogTime } from '@/network/syslog/codec/SyslogTime';

const LOG_ERR = 3;
const LOG_ALERT = 1;

export type OnCorruption = 'safe' | 'ignore' | 'inMemory';

export interface RecoveryEnvironment {
  readonly name: string;
  readonly mode: OnCorruption;
  readonly files: RsyslogFiles;
  readonly now: () => SyslogTime;
  readonly pid: number;
  report(severity: number, code: number, text: string): void;
}

export type DiskQueueLoad =
  | { readonly kind: 'backlog'; readonly backlog: LoadedBacklog }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'emergency' };

interface NumberedFile {
  readonly number: number;
  readonly name: string;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export function recoveryTimestamp(time: SyslogTime): string {
  return `${pad(time.year, 4)}${pad(time.month)}${pad(time.day)}${pad(time.hour)}${pad(time.minute)}${pad(time.second)}`;
}

function scanSpool(store: DiskQueueStore, environment: RecoveryEnvironment): { files: NumberedFile[]; corrupt: boolean } {
  const { prefix, directory } = store.settings;
  const files: NumberedFile[] = [];
  let corrupt = false;
  for (const name of environment.files.list(directory)) {
    if (name.length <= prefix.length + 1 || !name.startsWith(prefix) || name[prefix.length] !== '.') continue;
    const suffix = name.slice(prefix.length + 1);
    if (suffix === 'qi' || !/^[+-]?\d+$/.test(suffix.trim()) || suffix.trim() !== suffix) continue;
    const parsed = Number(suffix);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0x7fffffff) {
      environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: found file with invalid sequence number ${suffix}`);
      corrupt = true;
      continue;
    }
    if (parsed >= MAX_DISK_QUEUE_FILES) {
      environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: found file with out-of-range sequence number ${parsed}`);
      corrupt = true;
      continue;
    }
    files.push({ number: parsed, name });
  }
  files.sort((left, right) => left.number - right.number);
  return { files, corrupt };
}

function validateState(store: DiskQueueStore, files: readonly NumberedFile[], environment: RecoveryEnvironment): boolean {
  const deqNum = store.currentDeleteFile;
  const enqNum = store.currentWriteFile;
  let corrupt = false;
  if (deqNum < 0 || deqNum >= MAX_DISK_QUEUE_FILES) {
    environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: .qi file contains invalid dequeue number ${deqNum}`);
    corrupt = true;
  }
  if (enqNum < 0 || enqNum >= MAX_DISK_QUEUE_FILES) {
    environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: .qi file contains invalid enqueue number ${enqNum}`);
    corrupt = true;
  }
  const present = new Set(files.map((file) => file.number));
  if (!corrupt) {
    let current = deqNum;
    let steps = 0;
    while (current !== enqNum) {
      if (!present.has(current)) {
        environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: missing file in sequence: ${current}`);
        corrupt = true;
        break;
      }
      current = (current + 1) % MAX_DISK_QUEUE_FILES;
      steps++;
      if (steps > MAX_DISK_QUEUE_FILES) {
        environment.report(LOG_ERR, RS_RET.ERR, 'queue corruption: infinite loop detected verifying sequence');
        corrupt = true;
        break;
      }
    }
    if (!corrupt && !present.has(enqNum)) {
      environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: missing enqueue file: ${enqNum}`);
      corrupt = true;
    }
  }
  if (!corrupt) {
    const wrapped = enqNum < deqNum;
    for (const file of files) {
      const orphan = wrapped ? file.number > enqNum && file.number < deqNum : file.number < deqNum || file.number > enqNum;
      if (orphan) {
        environment.report(
          LOG_ERR, RS_RET.ERR,
          `queue corruption: orphaned file found: ${file.name} (seq ${file.number} not in range [${deqNum}, ${enqNum}]${wrapped ? ' wrapped' : ''})`,
        );
        corrupt = true;
      }
    }
  }
  return corrupt;
}

function emergency(store: DiskQueueStore, environment: RecoveryEnvironment): DiskQueueLoad {
  store.abandon();
  environment.report(
    LOG_ALERT, RS_RET.ERR,
    'Queue now runs in pure in-memory emergency mode. Data is not persistent and can be lost on restart or crash.',
  );
  return { kind: 'emergency' };
}

function moveToDirectory(files: RsyslogFiles, from: string, directory: string): boolean {
  const name = from.slice(from.lastIndexOf('/') + 1);
  if (!files.exists(from)) return true;
  return files.rename(from, `${directory}/${name}`);
}

function quarantine(store: DiskQueueStore, files: readonly NumberedFile[], environment: RecoveryEnvironment): DiskQueueLoad {
  const { prefix, directory } = store.settings;
  const badDirectory = `${directory}/${prefix}.bad.${recoveryTimestamp(environment.now())}`;
  if (!environment.files.mkdir(badDirectory, 0o755) && !environment.files.isDirectory(badDirectory)) {
    environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: failed to create recovery directory ${badDirectory}; switching to emergency in-memory mode`);
    return emergency(store, environment);
  }
  store.abandon();
  if (!moveToDirectory(environment.files, store.infoFile, badDirectory)) {
    environment.report(LOG_ERR, RS_RET.ERR, 'queue corruption: could not move .qi file to recovery directory; switching to emergency in-memory mode');
    return emergency(store, environment);
  }
  for (const file of files) {
    const path = `${directory}/${file.name}`;
    const moved = moveToDirectory(environment.files, path, badDirectory) && moveToDirectory(environment.files, encryptionInfoPath(path), badDirectory);
    if (!moved) {
      environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: could not move queue file ${file.name} to recovery directory; switching to emergency in-memory mode`);
      return emergency(store, environment);
    }
  }
  store.resetState();
  return { kind: 'fresh' };
}

function quarantineAfterResyncFailure(store: DiskQueueStore, files: readonly NumberedFile[], environment: RecoveryEnvironment): DiskQueueLoad {
  const { prefix, directory } = store.settings;
  const badDirectory = `${directory}/${prefix}.bad.${recoveryTimestamp(environment.now())}.${environment.pid}`;
  const failed = (): DiskQueueLoad => {
    environment.report(
      LOG_ERR, RS_RET.ERR,
      `${environment.name}: disk queue corruption quarantine failed; switching to emergency in-memory mode`,
    );
    return emergency(store, environment);
  };
  if (!environment.files.mkdir(badDirectory, 0o755) && !environment.files.isDirectory(badDirectory)) return failed();
  store.abandon();
  if (!moveToDirectory(environment.files, store.infoFile, badDirectory)) return failed();
  for (const file of files) {
    const path = `${directory}/${file.name}`;
    if (!moveToDirectory(environment.files, path, badDirectory) || !moveToDirectory(environment.files, encryptionInfoPath(path), badDirectory)) return failed();
  }
  environment.report(LOG_ALERT, RS_RET.ERR, `${environment.name}: disk queue corruption could not be resynchronized; quarantined unread tail into ${badDirectory}`);
  store.resetState();
  environment.report(4, RS_RET.OK_VALUE, `${environment.name}: disk queue active state reset after corruption quarantine`);
  return { kind: 'fresh' };
}

export function loadDiskQueue(store: DiskQueueStore, environment: RecoveryEnvironment): DiskQueueLoad {
  if (environment.mode === 'ignore') {
    const backlog = store.load({ resynchronize: false });
    return backlog === null ? { kind: 'fresh' } : { kind: 'backlog', backlog: backlog };
  }
  const { prefix, directory } = store.settings;
  if (directory === '') {
    const plain = store.load({ resynchronize: environment.mode === 'safe' });
    return plain === null ? { kind: 'fresh' } : { kind: 'backlog', backlog: plain };
  }
  if (prefix.includes('/') || prefix.includes('\\')) {
    environment.report(LOG_ERR, RS_RET.ERR, 'queue corruption: queue file prefix contains path separators; switching to emergency in-memory mode');
    return emergency(store, environment);
  }
  let backlog: LoadedBacklog | null = null;
  let structural = false;
  try {
    backlog = store.load({ resynchronize: environment.mode === 'safe', report: (severity, code, text) => environment.report(severity, code, text) });
  } catch (error) {
    if (!(error instanceof ObjectStreamError)) throw error;
    structural = true;
  }
  const scanned = scanSpool(store, environment);
  let corrupt = scanned.corrupt;
  const loaded = !structural && backlog !== null;
  if (loaded) {
    if (validateState(store, scanned.files, environment)) corrupt = true;
  } else if (scanned.files.length > 0) {
    corrupt = true;
    environment.report(LOG_ERR, RS_RET.ERR, `queue corruption: .qi file missing or inaccessible but ${scanned.files.length} segment files exist`);
  } else if (structural) {
    corrupt = true;
    environment.report(LOG_ERR, RS_RET.ERR, 'queue corruption: .qi file is invalid and contains no usable queue state');
  }
  if (corrupt) {
    if (environment.mode === 'inMemory') {
      environment.report(LOG_ALERT, RS_RET.ERR, 'Queue corruption detected. Entering emergency in-memory mode (non-persistent queue).');
      return emergency(store, environment);
    }
    environment.report(LOG_ALERT, RS_RET.ERR, 'Queue corruption detected! Moving queue files to .bad directory and starting fresh.');
    return quarantine(store, scanned.files, environment);
  }
  if (backlog === null) return { kind: 'fresh' };
  if (backlog.unrecoverable === true) return quarantineAfterResyncFailure(store, scanned.files, environment);
  return { kind: 'backlog', backlog };
}
