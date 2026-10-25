import { numberParam, stringParam, type ParamValues } from '../config/Params';
import { isCryptoProviderName } from '../crypto/CryptoEnvironment';
import type { CryptoParameters, CryptoProvider } from '../crypto/CryptoProvider';
import { RS_RET } from './Log';
import type { QueueSettings } from './Settings';

const MAX_QUEUE_SIZE = 0x7fffffff;
const OVERSIZE_QUEUE_WATERMARK = 500000;
const RS_RET_QUEUE_DISK_NO_FN = -2328;
const RS_RET_QUEUE_CRY_DISK_ONLY = -2351;
const RS_RET_LOAD_ERROR = -1006;
const RS_RET_ERR_QUEUE_FN_DUP = -2451;
const RS_RET_CONF_WRN_FULLDLY_BELOW_HIGHWTR = -2358;

export interface QueueDiagnostics {
  parserError(text: string): void;
  parserWarning(text: string): void;
  warning(text: string, code: number): void;
  error(text: string, code: number): void;
}

export interface QueueContext {
  readonly name: string;
  readonly diagnostics: QueueDiagnostics;
  readonly usedFiles: Set<string>;
  readonly workDirectory: string | null;
  readonly moduleFileAvailable?: (fileName: string) => boolean;
  readonly configureCrypto?: (provider: 'gcry' | 'ossl', parameters: CryptoParameters) => CryptoProvider | null;
}

function flagOf(values: ParamValues, key: string): boolean | undefined {
  const value = values.get(key);
  return value?.kind === 'N' ? value.n !== 0 : undefined;
}

function normalizedSpoolDirectory(queue: QueueSettings, context: QueueContext): boolean {
  const directory = queue.spoolDirectory;
  if (directory === null) return true;
  if (directory.length === 0) {
    context.diagnostics.parserError('queue.spooldirectory must not be empty');
    return false;
  }
  if (directory.endsWith('/')) {
    queue.spoolDirectory = directory.slice(0, -1);
    context.diagnostics.parserError(`queue.spooldirectory must not end with '/', corrected to '${queue.spoolDirectory}'`);
  }
  return true;
}

export function applyQueueParameters(queue: QueueSettings, values: ParamValues, context: QueueContext): void {
  const { diagnostics } = context;
  const number = (key: string): number | undefined => numberParam(values, key);
  const text = (key: string): string | undefined => stringParam(values, key);
  const cryptoParameters: CryptoParameters = { get: (parameter) => text(`queue.cry.${parameter}`) };
  let applied = 0;
  for (const key of values.keys()) if (key.startsWith('queue.')) applied++;
  if (text('queue.type')?.toLowerCase() === 'direct') applied--;
  queue.fileName = text('queue.filename') ?? queue.fileName;
  queue.spoolDirectory = text('queue.spooldirectory') ?? queue.spoolDirectory;
  if (!normalizedSpoolDirectory(queue, context)) {
    finalizeQueueType(queue, context, applied, cryptoParameters);
    return;
  }
  const size = number('queue.size');
  if (size !== undefined) {
    if (size > MAX_QUEUE_SIZE) {
      diagnostics.parserWarning('queue.size higher than maximum (2147483647) - corrected to maximum');
      queue.size = MAX_QUEUE_SIZE;
    } else {
      if (size > OVERSIZE_QUEUE_WATERMARK) {
        diagnostics.parserWarning(`queue.size=${size} is very large - is this really intended? More info at https://www.rsyslog.com/avoid-overly-large-in-memory-queues/`);
      }
      queue.size = size;
    }
  }
  queue.dequeueBatchSize = number('queue.dequeuebatchsize') ?? queue.dequeueBatchSize;
  queue.minDequeueBatchSize = number('queue.mindequeuebatchsize') ?? queue.minDequeueBatchSize;
  queue.minDequeueBatchTimeout = number('queue.mindequeuebatchsize.timeout') ?? queue.minDequeueBatchTimeout;
  queue.maxDiskSpace = number('queue.maxdiskspace') ?? queue.maxDiskSpace;
  queue.highWatermark = number('queue.highwatermark') ?? queue.highWatermark;
  queue.lowWatermark = number('queue.lowwatermark') ?? queue.lowWatermark;
  queue.fullDelayMark = number('queue.fulldelaymark') ?? queue.fullDelayMark;
  queue.lightDelayMark = number('queue.lightdelaymark') ?? queue.lightDelayMark;
  queue.discardMark = number('queue.discardmark') ?? queue.discardMark;
  queue.discardSeverity = number('queue.discardseverity') ?? queue.discardSeverity;
  queue.checkpointInterval = number('queue.checkpointinterval') ?? queue.checkpointInterval;
  queue.syncQueueFiles = flagOf(values, 'queue.syncqueuefiles') ?? queue.syncQueueFiles;
  queue.type = text('queue.type') ?? queue.type;
  queue.cryProvider = text('queue.cry.provider') ?? queue.cryProvider;
  const diskType = text('queue.diskqueuetype');
  if (diskType !== undefined) {
    const lowered = diskType.toLowerCase();
    if (lowered === 'auto' || lowered === 'disk') queue.diskQueueType = lowered;
    else if (lowered === 'segmenteddisk') queue.diskQueueType = 'segmentedDisk';
    else {
      diagnostics.parserError(`queue.diskQueueType: invalid value '${diskType}'; using 'auto'`);
      queue.diskQueueType = 'auto';
    }
  }
  queue.diskQueueAutoUpgrade = flagOf(values, 'queue.diskqueueautoupgrade') ?? queue.diskQueueAutoUpgrade;
  const idle = number('queue.diskqueueidletimeout');
  if (idle !== undefined) {
    if (idle < -1) {
      diagnostics.parserError('queue.diskQueueIdleTimeout must be -1 or greater; using 60000');
      queue.diskQueueIdleTimeout = 60000;
    } else queue.diskQueueIdleTimeout = idle;
  }
  queue.workerThreads = number('queue.workerthreads') ?? queue.workerThreads;
  queue.timeoutShutdown = number('queue.timeoutshutdown') ?? queue.timeoutShutdown;
  queue.timeoutActionCompletion = number('queue.timeoutactioncompletion') ?? queue.timeoutActionCompletion;
  queue.timeoutEnqueue = number('queue.timeoutenqueue') ?? queue.timeoutEnqueue;
  queue.workerTimeoutThreadShutdown = number('queue.timeoutworkerthreadshutdown') ?? queue.workerTimeoutThreadShutdown;
  queue.workerThreadMinimumMessages = number('queue.workerthreadminimummessages') ?? queue.workerThreadMinimumMessages;
  queue.maxFileSize = number('queue.maxfilesize') ?? queue.maxFileSize;
  queue.saveOnShutdown = flagOf(values, 'queue.saveonshutdown') ?? queue.saveOnShutdown;
  queue.dequeueSlowdown = number('queue.dequeueslowdown') ?? queue.dequeueSlowdown;
  queue.dequeueTimeBegin = number('queue.dequeuetimebegin') ?? queue.dequeueTimeBegin;
  queue.dequeueTimeEnd = number('queue.dequeuetimeend') ?? queue.dequeueTimeEnd;
  queue.samplingInterval = number('queue.samplinginterval') ?? queue.samplingInterval;
  queue.takeFlowCtlFromMsg = flagOf(values, 'queue.takeflowctlfrommsg') ?? queue.takeFlowCtlFromMsg;
  queue.mutexContentionStats = flagOf(values, 'queue.mutexcontentionstats') ?? queue.mutexContentionStats;
  const corruption = text('queue.oncorruption');
  if (corruption !== undefined) {
    const lowered = corruption.toLowerCase();
    if (lowered === 'ignore') queue.onCorruption = 'ignore';
    else if (lowered === 'safe') queue.onCorruption = 'safe';
    else if (lowered === 'inmemory') queue.onCorruption = 'inMemory';
    else {
      diagnostics.error(`queue.oncorruption: invalid value '${corruption}', using 'safe'`, RS_RET.CONF_PARAM_INVLD);
      queue.onCorruption = 'safe';
    }
  }
  validateDiskAssist(queue, values, context);
  finalizeQueueType(queue, context, applied, cryptoParameters);
}

function validateDiskAssist(queue: QueueSettings, values: ParamValues, context: QueueContext): void {
  const { diagnostics } = context;
  const assisted = (queue.type === 'FixedArray' || queue.type === 'LinkedList') && queue.fileName !== null;
  const setDiskType = values.has('queue.diskqueuetype');
  const setUpgrade = values.has('queue.diskqueueautoupgrade');
  const setIdle = values.has('queue.diskqueueidletimeout');
  if ((setDiskType || setUpgrade || setIdle) && !assisted) {
    diagnostics.parserError('queue.diskQueueType, queue.diskQueueAutoUpgrade, and queue.diskQueueIdleTimeout apply only to FixedArray or LinkedList disk-assisted queues; ignoring these parameters');
    queue.diskQueueType = 'auto';
    queue.diskQueueAutoUpgrade = false;
    queue.diskQueueIdleTimeout = 60000;
  }
  if (assisted && setUpgrade && queue.diskQueueType !== 'auto') {
    diagnostics.parserError("queue.diskQueueAutoUpgrade applies only when queue.diskQueueType='auto'; ignoring it");
    queue.diskQueueAutoUpgrade = false;
  }
  if (assisted && queue.diskQueueType === 'disk' && setIdle && queue.diskQueueIdleTimeout !== 60000) {
    diagnostics.parserError('queue.diskQueueIdleTimeout does not apply to the classic disk engine; using 60000');
    queue.diskQueueIdleTimeout = 60000;
  }
}

function finalizeQueueType(queue: QueueSettings, context: QueueContext, applied: number, cryptoParameters: CryptoParameters): void {
  const { diagnostics, name } = context;
  checkUniqueDiskFile(queue, context);
  if (queue.type === 'Direct') {
    if (applied > 0) {
      diagnostics.warning(`warning on queue '${name}': queue is in direct mode, but parameters have been set. These PARAMETERS cannot be applied and WILL BE IGNORED.`, RS_RET.OK_VALUE);
    }
  } else if (queue.type === 'Disk') {
    if (queue.fileName === null) {
      diagnostics.error(`error on queue '${name}', disk mode selected, but no queue file name given; queue type changed to 'linkedList'`, RS_RET_QUEUE_DISK_NO_FN);
      queue.type = 'LinkedList';
    }
  } else if (queue.type === 'SegmentedDisk') {
    if (queue.fileName === null) {
      diagnostics.error(`error on queue '${name}', segmentedDisk mode selected, but no queue file name given`, RS_RET_QUEUE_DISK_NO_FN);
    } else if (queue.onCorruption !== 'safe') {
      diagnostics.error(`error on queue '${name}': segmentedDisk currently supports only queue.onCorruption="safe"`, RS_RET.CONF_PARAM_INVLD);
    } else if (queue.cryProvider !== null) {
      diagnostics.error(`error on queue '${name}': queue.cry.provider is not yet supported by segmentedDisk`, RS_RET.CONF_PARAM_INVLD);
    }
  }
  if (queue.cryProvider === null) return;
  if (queue.fileName === null) {
    diagnostics.error(`error on queue '${name}', crypto provider can only be set for disk or disk assisted queue - ignored`, RS_RET_QUEUE_CRY_DISK_ONLY);
    queue.cryProvider = null;
    return;
  }
  if (queue.type === 'SegmentedDisk') return;
  const library = `lmcry_${queue.cryProvider}`;
  if (!isCryptoProviderName(queue.cryProvider) || (context.moduleFileAvailable !== undefined && !context.moduleFileAvailable(`${library}.so`))) {
    diagnostics.error(`queue: could not load crypto provider '${library}' - encryption disabled`, RS_RET_LOAD_ERROR);
    queue.cryProvider = null;
    return;
  }
  if (context.configureCrypto === undefined) return;
  if (queue.cryProvider === 'ossl' && cryptoParameters.get('keyprogram') !== undefined) {
    diagnostics.parserError("parameter 'queue.cry.keyprogram' not known -- typo in config file?");
  }
  queue.crypto = context.configureCrypto(queue.cryProvider, cryptoParameters);
}

function checkUniqueDiskFile(queue: QueueSettings, context: QueueContext): void {
  if (queue.fileName === null) return;
  const directory = queue.spoolDirectory ?? context.workDirectory ?? '';
  const key = `${directory}\0${queue.fileName}`;
  if (context.usedFiles.has(key)) {
    context.diagnostics.parserError(`queue directory '${directory}' and file name prefix '${queue.fileName}' already used. This is not possible. Please make it unique.`);
    return;
  }
  context.usedFiles.add(key);
}

export function correctQueueParameters(queue: QueueSettings, context: QueueContext): void {
  const { diagnostics, name } = context;
  const quote = `queue "${name}"`;
  const size = queue.size;
  const percent = (value: number, share: number): number => Math.trunc(value / 100) * share;
  if (size < 100 && (queue.type === 'LinkedList' || queue.type === 'FixedArray')) {
    diagnostics.warning(`Note: queue.size="${size}" is very low and can lead to unpredictable results. See also https://www.rsyslog.com/lower-bound-for-queue-sizes/`, RS_RET.OK_WARN);
  }
  let good = percent(size, 60);
  if (queue.highWatermark !== -1 && queue.highWatermark < good) {
    diagnostics.warning(`${quote}: high water mark is set quite low at ${queue.highWatermark}. You should only set it below 60% (${good}) if you have a good reason for this.`, RS_RET.CONF_PARSE_WARNING);
  }
  if (queue.workerThreads > 1) {
    good = percent(size, 10);
    if (queue.workerThreadMinimumMessages !== -1 && queue.workerThreadMinimumMessages < good) {
      diagnostics.warning(`${quote}: queue.workerThreadMinimumMessage is set quite low at ${queue.workerThreadMinimumMessages}. You should only set it below 10% (${good}) if you have a good reason for this.`, RS_RET.CONF_PARSE_WARNING);
    }
  }
  if (queue.discardMark > size) {
    diagnostics.error(`error: queue "${name}": queue.discardMark ${queue.discardMark} is set larger than queue.size`, RS_RET.PARAM_ERROR);
  }
  good = percent(size, 80);
  if (queue.discardMark !== -1 && queue.discardMark < good) {
    diagnostics.warning(`${quote}: queue.discardMark is set quite low at ${queue.discardMark}. You should only set it below 80% (${good}) if you have a good reason for this.`, RS_RET.CONF_PARSE_WARNING);
  }
  if (queue.fileName !== null && queue.fullDelayMark !== -1 && queue.fullDelayMark < queue.highWatermark) {
    diagnostics.warning(`${quote}: queue.fullDelayMark is set below high water mark. This will result in DA mode  NOT being activated for full delayable messages: In many cases this is a configuration error, please check if this is really what you want`, RS_RET_CONF_WRN_FULLDLY_BELOW_HIGHWTR);
  }
  const highInvalid = queue.highWatermark !== -1 && (queue.highWatermark < 2 || queue.highWatermark > size);
  if (queue.highWatermark === -1 || highInvalid) {
    queue.highWatermark = percent(size, 90);
    if (queue.highWatermark === 0) queue.highWatermark = size;
    if (highInvalid) {
      diagnostics.warning(`${quote}: queue.highWaterMark is invalid (must be between 2 and queue size). It has been automatically adjusted to ${queue.highWatermark}. In any case, we strongly recommend to review the queue definition and resolve inconsistencies to guarantee the config really matches your intent.`, RS_RET.CONF_PARSE_WARNING);
    }
  }
  const lowInvalid = queue.lowWatermark !== -1 && (queue.lowWatermark < 2 || queue.lowWatermark > queue.highWatermark);
  if (queue.lowWatermark === -1 || lowInvalid) {
    queue.lowWatermark = Math.trunc((queue.highWatermark * 7) / 10);
    if (queue.lowWatermark === 0) queue.lowWatermark = 1;
    if (lowInvalid) {
      diagnostics.warning(`${quote}: queue.lowWaterMark is invalid (must be between 2 and highWaterMark). It has been automatically adjusted to ${queue.lowWatermark}. In any case, we strongly recommend to review the queue definition and resolve inconsistencies to guarantee the config really matches your intent.`, RS_RET.CONF_PARSE_WARNING);
    }
  }
  if (queue.workerThreadMinimumMessages < 1 || queue.workerThreadMinimumMessages > size) {
    queue.workerThreadMinimumMessages = Math.trunc(size / queue.workerThreads);
  }
  if (queue.fullDelayMark === -1 || queue.fullDelayMark > size) {
    queue.fullDelayMark = percent(size, 97);
    if (queue.fullDelayMark === 0) queue.fullDelayMark = size === 1 ? 1 : size - 1;
  }
  if (queue.lightDelayMark === 0) queue.lightDelayMark = size;
  if (queue.lightDelayMark === -1 || queue.lightDelayMark > size) {
    queue.lightDelayMark = percent(size, 70);
    if (queue.lightDelayMark === 0) queue.lightDelayMark = size === 1 ? 1 : size - 1;
  }
  if (queue.discardMark < 1 || queue.discardMark > size) {
    queue.discardMark = percent(size, 98);
    if (queue.discardMark === 0) queue.discardMark = size;
  }
  if (size > 0 && queue.dequeueBatchSize > size) queue.dequeueBatchSize = size;
}
