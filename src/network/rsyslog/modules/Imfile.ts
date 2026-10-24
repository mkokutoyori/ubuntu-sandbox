import type { NvList } from '../config/Ast';
import { getParams, numberParam, reportUnused, stringParam, type ParamDescriptor } from '../config/Params';
import type { FileChange, ReadableFile } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type { StatsObject } from '../engine/Statistics';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext } from '../engine/Modules';
import { jsonText } from '../Json';
import type { JsonValue } from '../Message';
import { sipHash24 } from '../SipHash';
import { compileRegex } from '../Template';
import { MonitorStream, StreamFailure } from './ImfileStream';

const FILE_ID_SIZE = 512;
const FILE_DELETE_DELAY = 5;
const DEFAULT_POLL_INTERVAL = 10;
const DEFAULT_INOTIFY_FALLBACK_INTERVAL = 60;
const DEFAULT_MULTI_SUBMIT = 1024;
const DEFAULT_LEGACY_MAX_LINES = 10240;
const DEFAULT_FACILITY = 128;
const DEFAULT_SEVERITY = 5;
const MODULE_NAME = 'imfile';
const SIPHASH_KEY = Uint8Array.from({ length: 16 }, (_, index) => index);

type OperationMode = 'polling' | 'inotify' | 'fen';

interface ModuleSettings {
  mode: OperationMode;
  pollInterval: number;
  readTimeout: number;
  timeoutGranularityMs: number;
  sortFiles: boolean;
  stateFileDirectory: string | null;
  normalizePath: boolean;
  deleteStateOnMove: boolean;
  maxInotifyWatches: number;
  inotifyFallbackInterval: number;
  configuredViaModule: boolean;
  legacyPollInterval: number;
}

interface LegacyInput {
  fileName: string | null;
  tag: string | null;
  stateFile: string | null;
  bindRuleset: string | null;
  severity: number;
  facility: number;
  readMode: number;
  maxLinesAtOnce: number;
  trimLineOverBytes: number;
  persistStateInterval: number;
}

interface PerMinuteLimits {
  maxBytesPerMinute: number;
  maxLinesPerMinute: number;
  minute: number;
  bytesThisMinute: number;
  linesThisMinute: number;
}

interface InputSettings {
  fileName: string;
  tag: string;
  stateFile: string | null;
  bindRuleset: string | null;
  severity: number;
  facility: number;
  readMode: number;
  startRegex: RegExp | null;
  endRegex: RegExp | null;
  discardTruncatedMsg: boolean;
  msgDiscardingError: boolean;
  escapeLF: boolean;
  escapeLFString: string | null;
  reopenOnTruncate: boolean;
  maxLinesAtOnce: number;
  trimLineOverBytes: number;
  ignoreOlderThan: number;
  persistStateInterval: number;
  persistStateAfterSubmission: boolean;
  multiSubmit: number;
  readTimeout: number;
  delayPerMessageMicros: number;
  deleteStateOnDelete: boolean;
  deleteStateOnMove: boolean;
  addMetadata: boolean;
  addCeeTag: boolean;
  freshStartTail: boolean;
  fileNotFoundError: boolean;
  needParse: boolean;
  limits: PerMinuteLimits;
}

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'pollinginterval', type: 'positive' }, { name: 'readtimeout', type: 'nonneg' }, { name: 'timeoutgranularity', type: 'positive' },
  { name: 'sortfiles', type: 'binary' }, { name: 'statefile.directory', type: 'string' }, { name: 'normalizepath', type: 'binary' },
  { name: 'mode', type: 'word' }, { name: 'deletestateonfilemove', type: 'binary' }, { name: 'maxinotifywatches', type: 'nonneg' },
  { name: 'inotifyfallbackinterval', type: 'nonneg' },
];

const INPUT_PARAMS: readonly ParamDescriptor[] = [
  { name: 'file', type: 'string', required: true }, { name: 'tag', type: 'string', required: true }, { name: 'severity', type: 'severity' },
  { name: 'facility', type: 'facility' }, { name: 'ruleset', type: 'string' }, { name: 'readmode', type: 'int' },
  { name: 'startmsg.regex', type: 'string' }, { name: 'endmsg.regex', type: 'string' }, { name: 'discardtruncatedmsg', type: 'binary' },
  { name: 'msgdiscardingerror', type: 'binary' }, { name: 'escapelf', type: 'binary' }, { name: 'escapelf.replacement', type: 'string' },
  { name: 'reopenontruncate', type: 'binary' }, { name: 'maxlinesatonce', type: 'int' }, { name: 'trimlineoverbytes', type: 'int' },
  { name: 'maxsubmitatonce', type: 'int' }, { name: 'deletestateonfiledelete', type: 'binary' }, { name: 'removestateondelete', type: 'binary' },
  { name: 'persiststateinterval', type: 'int' }, { name: 'persiststateaftersubmission', type: 'binary' },
  { name: 'delay.message', type: 'nonneg' }, { name: 'addmetadata', type: 'binary' }, { name: 'addceetag', type: 'binary' },
  { name: 'statefile', type: 'string', deprecated: true }, { name: 'readtimeout', type: 'nonneg' }, { name: 'freshstarttail', type: 'binary' },
  { name: 'filenotfounderror', type: 'binary' }, { name: 'needparse', type: 'binary' }, { name: 'ignoreolderthan', type: 'int' },
  { name: 'maxbytesperminute', type: 'int' }, { name: 'maxlinesperminute', type: 'int' }, { name: 'deletestateonfilemove', type: 'binary' },
];

function defaultModuleSettings(): ModuleSettings {
  return {
    mode: 'polling', pollInterval: DEFAULT_POLL_INTERVAL, readTimeout: 0, timeoutGranularityMs: 1000, sortFiles: false,
    stateFileDirectory: null, normalizePath: true, deleteStateOnMove: false, maxInotifyWatches: 0,
    inotifyFallbackInterval: DEFAULT_INOTIFY_FALLBACK_INTERVAL, configuredViaModule: false, legacyPollInterval: DEFAULT_POLL_INTERVAL,
  };
}

function defaultLegacyInput(): LegacyInput {
  return {
    fileName: null, tag: null, stateFile: null, bindRuleset: null, severity: DEFAULT_SEVERITY, facility: DEFAULT_FACILITY, readMode: 0,
    maxLinesAtOnce: DEFAULT_LEGACY_MAX_LINES, trimLineOverBytes: 0, persistStateInterval: 0,
  };
}

function newLimits(maxBytes: number, maxLines: number): PerMinuteLimits {
  return { maxBytesPerMinute: maxBytes, maxLinesPerMinute: maxLines, minute: 0, bytesThisMinute: 0, linesThisMinute: 0 };
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function hasGlobWildcard(path: string): boolean {
  return /[*?[{]/.test(path);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface FsNode {
  edges: FsEdge[];
  root: FsNode | null;
}

interface FsEdge {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly instances: InputSettings[];
  readonly node: FsNode;
  readonly parent: FsNode;
  active: ActiveObject[];
}

interface ActiveObject {
  readonly edge: FsEdge;
  readonly name: string;
  readonly basename: string;
  readonly sourceName: string | null;
  readonly isSymlink: boolean;
  readonly inode: number;
  readonly handle: ReadableFile | null;
  stream: MonitorStream | null;
  nRecords: number;
  lineNum: number;
  timeToDelete: number;
  fileId: string;
  fileIdPrevious: string;
  inMove: boolean;
  bytesProcessed: number;
  linesProcessed: number;
  statistics: StatsObject | null;
  pending: Array<() => void>;
}

class RateLimited extends Error {}

class ImfileMonitor {
  private readonly tree: FsNode = { edges: [], root: null };
  private readonly instances: ImfileInstance[] = [];
  private cancelers: Array<() => void> = [];
  private started = false;
  private running = false;
  private hadData = false;
  private pendingDeletes = false;
  private dispatching = false;
  private queuedChanges: FileChange[] = [];

  constructor(private readonly context: InputContext, private readonly module: ModuleSettings) {}

  register(instance: ImfileInstance): void {
    this.instances.push(instance);
  }

  private get host() {
    return this.context.host;
  }

  private nowSeconds(): number {
    return Math.floor(this.host.clock.wallMs() / 1000);
  }

  private stateDirectory(): string | null {
    return this.module.stateFileDirectory ?? this.context.settings.workDirectory;
  }

  private stateFileName(act: ActiveObject, fileId: string): string {
    const directory = this.stateDirectory();
    return `${directory === null ? '.' : directory}/imfile-state:${act.inode}${fileId === '' ? '' : `:${fileId}`}`;
  }

  activate(instance: ImfileInstance): void {
    const settings = instance.settings;
    if (!hasGlobWildcard(settings.fileName)) {
      const probe = this.host.files.openRead(settings.fileName);
      if ('error' in probe) {
        this.context.runtime.error(
          `imfile: on startup file '${settings.fileName}' does not exist but is configured in static file monitor - this may indicate a misconfiguration. If the file appears at a later time, it will automatically be processed. Reason: ${probe.error}`,
          RS_RET.ERR,
        );
      } else {
        probe.file.close();
      }
    }
    this.addToTree(this.tree, null, settings.fileName, 0, settings);
  }

  private addToTree(node: FsNode, source: FsNode | null, toFind: string, pathIndex: number, settings: InputSettings): void {
    let end = pathIndex;
    while (end < toFind.length && toFind[end] !== '/') end++;
    const isFile = end >= toFind.length;
    const ourPath = end === 0 ? '/' : toFind.slice(0, end);
    const name = toFind.slice(pathIndex, end);
    node.root = source;
    const known = node.edges.find((edge) => edge.name === name);
    if (known !== undefined) {
      known.instances.push(settings);
      if (!isFile) this.addToTree(known.node, node, toFind, end + 1, settings);
      return;
    }
    const edge: FsEdge = { name, path: ourPath, isFile, instances: [settings], node: { edges: [], root: null }, parent: node, active: [] };
    if (!isFile) this.addToTree(edge.node, node, toFind, end + 1, settings);
    node.edges.unshift(edge);
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    if (this.module.mode === 'fen') {
      this.context.runtime.error('do_fen: mode set to fen, but the platform does not support fen', RS_RET.ERR);
      return;
    }
    this.initialPoll();
    if (this.module.mode === 'polling') {
      const seconds = this.module.configuredViaModule ? this.module.pollInterval : this.module.legacyPollInterval;
      this.cancelers.push(this.host.scheduleEvery(() => this.pollingRun(), Math.max(seconds, 0.01) * 1000));
      return;
    }
    this.cancelers.push(this.host.files.observe((change) => this.dispatch(change)));
    const hasTimeouts = this.instances.some((instance) => instance.settings.readTimeout !== 0);
    if (hasTimeouts) this.cancelers.push(this.host.scheduleEvery(() => this.walk(this.tree, (edge) => this.pollTimeouts(edge)), this.module.timeoutGranularityMs));
    this.cancelers.push(this.host.scheduleEvery(() => this.recheckDeletes(), (FILE_DELETE_DELAY + 1) * 1000));
  }

  private initialPoll(): void {
    this.walk(this.tree, (edge) => this.pollTree(edge));
    for (const instance of this.instances) instance.settings.freshStartTail = false;
  }

  private pollingRun(): void {
    if (this.running) return;
    this.running = true;
    try {
      do {
        this.hadData = false;
        this.walk(this.tree, (edge) => this.pollTree(edge));
      } while (this.hadData);
    } finally {
      this.running = false;
    }
  }

  private recheckDeletes(): void {
    if (!this.pendingDeletes) return;
    this.pendingDeletes = false;
    this.walk(this.tree, (edge) => this.pollTree(edge));
  }

  private walk(node: FsNode, visit: (edge: FsEdge) => void): void {
    for (const edge of [...node.edges]) {
      visit(edge);
      this.walk(edge.node, visit);
    }
  }

  private allActive(): ActiveObject[] {
    const out: ActiveObject[] = [];
    const collect = (node: FsNode): void => {
      for (const edge of node.edges) {
        out.push(...edge.active);
        collect(edge.node);
      }
    };
    collect(this.tree);
    return out;
  }

  private dispatch(change: FileChange): void {
    this.queuedChanges.push(change);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queuedChanges.length > 0) this.handleChange(this.queuedChanges.shift() as FileChange);
    } finally {
      this.dispatching = false;
    }
  }

  private handleChange(change: FileChange): void {
    const actives = this.allActive();
    if (change.kind === 'modified') {
      for (const act of actives) {
        if (act.edge.isFile && !act.isSymlink && act.inode === change.inode) this.pollFile(act);
      }
      return;
    }
    const names = change.kind === 'moved' ? [change.from, change.path] : [change.path];
    for (const act of actives) {
      if (!act.edge.isFile || act.isSymlink) continue;
      if (change.kind === 'moved' && act.name === change.from) {
        this.flagMove(act.edge, basenameOf(change.from));
        this.pollFile(act);
      } else if (change.kind === 'deleted' && act.name === change.path) {
        this.pollFile(act);
      }
    }
    const touched = new Set(names.map((name) => dirnameOf(name)));
    for (const act of actives) {
      if (!act.edge.isFile && touched.has(act.name)) this.walk(act.edge.node, (edge) => this.pollTree(edge));
    }
  }

  private flagMove(edge: FsEdge, movedName: string): void {
    const act = edge.active.find((candidate) => candidate.basename === movedName);
    if (act !== undefined) act.inMove = true;
  }

  private pollTimeouts(edge: FsEdge): void {
    if (!edge.isFile) return;
    for (const act of edge.active) {
      if (act.stream !== null && act.stream.isTimedOut()) this.pollFile(act);
    }
  }

  private pollTree(edge: FsEdge): void {
    this.detectUpdates(edge);
    let matches = this.host.files.glob(edge.path);
    if (this.module.sortFiles) matches = [...matches].sort();
    for (const file of matches) {
      const info = this.host.files.lstat(file);
      if (info === null) {
        this.context.runtime.error(`imfile: poll_tree cannot stat file '${file}' - ignored`, RS_RET.ERR);
        continue;
      }
      let isSymlink = false;
      if (info.kind === 'symlink') {
        if (!this.processSymlink(edge, file)) continue;
        isSymlink = true;
      }
      const isFile = info.kind === 'file' || isSymlink;
      if (!isSymlink && edge.isFile !== isFile) {
        this.context.runtime.warning(
          `imfile: '${file}' is ${isFile ? 'FILE' : 'DIRECTORY'} but ${edge.isFile ? 'FILE' : 'DIRECTORY'} expected - ignored`, RS_RET.ERR,
        );
        continue;
      }
      this.addActive(edge, file, isFile, info.inode, isSymlink, null);
    }
    if (this.module.mode === 'polling' && edge.isFile) {
      for (const act of [...edge.active]) this.pollFile(act);
    }
  }

  private processSymlink(edge: FsEdge, symlink: string): boolean {
    const target = this.host.files.realpath(symlink);
    if (target === null) return false;
    const info = this.host.files.lstat(target);
    if (info === null) {
      this.context.runtime.error(`imfile: process_symlink: cannot stat file '${target}' - ignored`, RS_RET.ERR);
      return false;
    }
    const isFile = info.kind === 'file';
    if (!this.addActive(edge, target, isFile, info.inode, false, symlink)) return true;
    const parent = dirnameOf(target);
    if (parent !== target) {
      const parentInfo = this.host.files.lstat(parent);
      if (parentInfo === null) {
        this.context.runtime.error(`imfile: process_symlink: cannot stat directory '${parent}' - ignored`, RS_RET.ERR);
        return true;
      }
      const rootEdges = edge.parent.root?.edges;
      if (rootEdges !== undefined && rootEdges.length > 0) this.addActive(rootEdges[0], parent, false, parentInfo.inode, false, null);
    }
    return true;
  }

  private ignoredAsOld(settings: InputSettings, name: string): boolean {
    if (settings.ignoreOlderThan === 0) return false;
    const info = this.host.files.stat(name);
    return info !== null && this.nowSeconds() - Math.floor(info.mtimeMs / 1000) > settings.ignoreOlderThan;
  }

  private addActive(edge: FsEdge, name: string, isFile: boolean, inode: number, isSymlink: boolean, source: string | null): boolean {
    if (this.ignoredAsOld(edge.instances[0], name)) return false;
    for (const known of edge.active) {
      if (known.name === name && (source === null || known.sourceName === null || known.sourceName === source)) return false;
    }
    const opened = this.host.files.openRead(name);
    if ('error' in opened) {
      if (isFile) this.context.runtime.error(`imfile: error accessing file '${name}': ${opened.error}`, RS_RET.ERR);
      return false;
    }
    const act: ActiveObject = {
      edge, name, basename: basenameOf(name), sourceName: source, isSymlink, inode, handle: opened.file, stream: null, nRecords: 0,
      lineNum: 0, timeToDelete: 0, fileId: '', fileIdPrevious: '', inMove: false, bytesProcessed: 0, linesProcessed: 0, statistics: null,
      pending: [],
    };
    if (isFile && !isSymlink) {
      act.statistics = this.context.statistics.create(name, { origin: MODULE_NAME });
      act.statistics.addCounter({ name: 'bytes.processed', read: () => act.bytesProcessed, reset: () => { act.bytesProcessed = 0; } });
      act.statistics.addCounter({ name: 'lines.processed', read: () => act.linesProcessed, reset: () => { act.linesProcessed = 0; } });
      this.pollFile(act);
    }
    edge.active.unshift(act);
    return true;
  }

  private detectUpdates(edge: FsEdge): void {
    for (const act of [...edge.active]) {
      const info = this.host.files.lstat(act.name);
      if (info === null) {
        const now = this.nowSeconds();
        if (act.timeToDelete === 0) act.timeToDelete = now;
        if (!edge.isFile || act.timeToDelete + FILE_DELETE_DELAY < now) {
          this.unlinkActive(act);
          this.destroyActive(act, true);
        } else {
          this.pendingDeletes = true;
          this.pollFile(act);
        }
      } else if (info.inode !== act.inode) {
        this.unlinkActive(act);
        this.destroyActive(act, true);
      }
    }
  }

  private unlinkActive(act: ActiveObject): void {
    act.edge.active = act.edge.active.filter((candidate) => candidate !== act);
  }

  private destroyActive(act: ActiveObject, isDeleted: boolean): void {
    if (act.stream !== null) {
      const settings = act.edge.instances[0];
      this.pollFile(act);
      if (act.statistics !== null) this.context.statistics.remove(act.statistics);
      act.statistics = null;
      let toDelete: string | null = null;
      if (settings.deleteStateOnDelete || (isDeleted && settings.deleteStateOnMove)) {
        this.refreshFileId(act);
        toDelete = this.stateFileName(act, act.fileId);
      }
      this.persistState(act);
      act.stream.closeFile();
      act.stream = null;
      if (toDelete !== null && isDeleted && ((!act.inMove && settings.deleteStateOnDelete) || settings.deleteStateOnMove)) {
        this.host.files.remove(toDelete);
      }
    }
    act.handle?.close();
  }

  private refreshFileId(act: ActiveObject): void {
    const previous = act.fileId;
    act.fileId = '';
    if (act.handle !== null) {
      const head = act.handle.read(0, FILE_ID_SIZE);
      if (head.length === FILE_ID_SIZE) act.fileId = hex(sipHash24(Uint8Array.from(head, (character) => character.charCodeAt(0) & 0xff), SIPHASH_KEY));
    }
    if (previous !== act.fileId) act.fileIdPrevious = previous;
  }

  persistState(act: ActiveObject): void {
    const stream = act.stream;
    if (stream === null) return;
    this.refreshFileId(act);
    const path = this.stateFileName(act, act.fileId);
    const state: { [key: string]: JsonValue } = {
      filename: act.name,
      prev_was_nl: stream.prevWasNL ? 1 : 0,
      curr_offs: stream.currOffs,
      strt_offs: stream.strtOffs,
      inode_gen: 0,
      line_number: act.lineNum,
    };
    if (stream.prevLineSegment !== null) state.prev_line_segment = stream.prevLineSegment;
    if (stream.prevMsgSegment !== null) state.prev_msg_segment = stream.prevMsgSegment;
    if (!this.host.files.write(path, jsonText(state))) {
      this.context.runtime.error(
        `imfile: cannot open state file '${path}' for persisting file state - some data will probably be duplicated on next startup`, RS_RET.IO_ERROR,
      );
      this.context.runtime.error(`imfile: could not persist state file ${path} - data may be repeated on next startup. Is WorkDirectory set?`, RS_RET.IO_ERROR);
      return;
    }
    if (act.fileIdPrevious !== act.fileId) {
      this.host.files.remove(this.stateFileName(act, act.fileIdPrevious));
      act.fileIdPrevious = act.fileId;
    }
  }

  private newStream(act: ActiveObject): MonitorStream {
    const settings = act.edge.instances[0];
    const stream = new MonitorStream(act.name, {
      openFile: (path) => this.host.files.openRead(path),
      warning: (text, code) => this.context.runtime.warning(text, code),
      error: (text, code) => this.context.runtime.error(text, code),
      nowSeconds: () => this.nowSeconds(),
      maxMessageSize: () => this.context.settings.parser.maxLine,
    }, settings.fileNotFoundError);
    return stream;
  }

  private openWithState(act: ActiveObject): MonitorStream | null {
    this.refreshFileId(act);
    let text = this.host.files.read(this.stateFileName(act, act.fileId));
    if (text === null && act.fileId !== '') text = this.host.files.read(this.stateFileName(act, ''));
    if (text === null) return null;
    let state: { [key: string]: unknown };
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      state = parsed as { [key: string]: unknown };
    } catch {
      this.context.runtime.error(`imfile: error reading state file for '${act.name}'`, RS_RET.ERR);
      return null;
    }
    for (const field of ['prev_was_nl', 'curr_offs', 'strt_offs']) {
      if (typeof state[field] !== 'number') {
        this.context.runtime.error(`imfile: missing required state file field '${field}'`, RS_RET.ERR);
        return null;
      }
    }
    if (state.line_number !== undefined) {
      if (typeof state.line_number !== 'number') {
        this.context.runtime.error(`imfile: invalid line_number in state file for '${act.name}'`, RS_RET.ERR);
        return null;
      }
      act.lineNum = state.line_number;
    }
    for (const field of ['prev_line_segment', 'prev_msg_segment']) {
      if (state[field] !== undefined && typeof state[field] !== 'string') {
        this.context.runtime.error(`imfile: invalid ${field} in state file for '${act.name}'`, RS_RET.ERR);
        return null;
      }
    }
    const stream = this.newStream(act);
    stream.prevWasNL = state.prev_was_nl !== 0;
    stream.prevLineSegment = typeof state.prev_line_segment === 'string' ? state.prev_line_segment : null;
    stream.prevMsgSegment = typeof state.prev_msg_segment === 'string' ? state.prev_msg_segment : null;
    try {
      stream.seek(state.curr_offs as number);
    } catch (error) {
      if (error instanceof StreamFailure) return null;
      throw error;
    }
    stream.strtOffs = state.strt_offs as number;
    return stream;
  }

  private openWithoutState(act: ActiveObject): MonitorStream {
    const settings = act.edge.instances[0];
    const stream = this.newStream(act);
    if (settings.freshStartTail) {
      const info = this.host.files.stat(act.name);
      if (info !== null) {
        try {
          stream.seek(info.size);
        } catch (error) {
          if (!(error instanceof StreamFailure)) throw error;
        }
      }
    }
    return stream;
  }

  private openStream(act: ActiveObject): boolean {
    const settings = act.edge.instances[0];
    const stream = this.openWithState(act) ?? this.openWithoutState(act);
    stream.reopenOnTruncate = settings.reopenOnTruncate;
    stream.readTimeout = settings.readTimeout;
    act.stream = stream;
    return true;
  }

  pollFile(act: ActiveObject): void {
    if (act.isSymlink) return;
    const settings = act.edge.instances[0];
    if (act.stream === null) this.openStream(act);
    const stream = act.stream as MonitorStream;
    let startOffset = stream.currOffs;
    let processed = 0;
    try {
      for (;;) {
        if (settings.maxLinesAtOnce !== 0 && processed >= settings.maxLinesAtOnce) break;
        const line = settings.startRegex === null && settings.endRegex === null
          ? stream.readLine({ mode: settings.readMode, escapeLF: settings.escapeLF, escapeLFString: settings.escapeLFString, trimLineOverBytes: settings.trimLineOverBytes })
          : stream.readMultiLine({
            startRegex: settings.startRegex, endRegex: settings.endRegex, escapeLF: settings.escapeLF, escapeLFString: settings.escapeLFString,
            discardTruncatedMsg: settings.discardTruncatedMsg, msgDiscardingError: settings.msgDiscardingError,
          });
        if (line === null) break;
        processed++;
        if (startOffset < FILE_ID_SIZE && stream.currOffs >= FILE_ID_SIZE) {
          this.persistState(act);
          startOffset = stream.currOffs;
        }
        this.hadData = true;
        act.lineNum++;
        if (stream.currOffs > line.startOffset) act.bytesProcessed += stream.currOffs - line.startOffset;
        act.linesProcessed++;
        const delayed = this.enqueueLine(act, line.text, line.startOffset, act.lineNum);
        if (settings.persistStateInterval > 0 && ++act.nRecords >= settings.persistStateInterval) {
          this.persistState(act);
          act.nRecords = 0;
        }
        if (delayed) break;
      }
    } catch (error) {
      if (!(error instanceof StreamFailure) && !(error instanceof RateLimited)) throw error;
    }
    this.flushSubmissions(act);
    if (settings.persistStateAfterSubmission) this.persistState(act);
  }

  private flushSubmissions(act: ActiveObject): void {
    const pending = act.pending;
    act.pending = [];
    for (const submit of pending) submit();
  }

  private checkLimits(settings: InputSettings, length: number): boolean {
    const limits = settings.limits;
    const minute = Math.floor(this.nowSeconds() / 60);
    if (limits.maxBytesPerMinute > 0) {
      if (limits.minute === minute) {
        limits.bytesThisMinute += length;
        if (limits.bytesThisMinute > limits.maxBytesPerMinute) return false;
      } else {
        limits.minute = minute;
        limits.bytesThisMinute = length;
      }
    }
    if (limits.maxLinesPerMinute > 0) {
      if (limits.minute === minute) {
        limits.linesThisMinute++;
        if (limits.linesThisMinute > limits.maxLinesPerMinute) return false;
      } else {
        limits.minute = minute;
        limits.linesThisMinute = 1;
      }
    }
    return true;
  }

  private enqueueLine(act: ActiveObject, text: string, startOffset: number, lineNumber: number): boolean {
    if (text.length === 0) return false;
    const instances = act.edge.instances;
    const submissions: Array<() => void> = [];
    let delay = 0;
    for (const settings of instances) {
      if ((settings.limits.maxBytesPerMinute > 0 || settings.limits.maxLinesPerMinute > 0) && !this.checkLimits(settings, text.length)) {
        if (instances.length > 1) continue;
        throw new RateLimited();
      }
      if (settings.delayPerMessageMicros > 0) delay = Math.max(delay, settings.delayPerMessageMicros);
      submissions.push(() => this.submitLine(act, settings, text, startOffset, lineNumber));
    }
    for (const submit of submissions) {
      act.pending.push(submit);
      if (act.pending.length >= (instances[0].multiSubmit > 0 ? instances[0].multiSubmit : DEFAULT_MULTI_SUBMIT)) this.flushSubmissions(act);
    }
    if (delay > 0) {
      this.flushSubmissions(act);
      this.cancelers.push(this.host.schedule(() => this.pollFile(act), Math.max(1, Math.ceil(delay / 1000))));
      return true;
    }
    return false;
  }

  private submitLine(act: ActiveObject, settings: InputSettings, text: string, startOffset: number, lineNumber: number): void {
    const raw = settings.addCeeTag ? `@cee:${text}` : text;
    const ruleset = settings.bindRuleset !== null && this.context.rulesetExists(settings.bindRuleset) ? settings.bindRuleset : null;
    const metadata: { [key: string]: JsonValue } = {
      filename: act.sourceName ?? act.name, fileoffset: String(startOffset), line_number: String(lineNumber),
    };
    this.context.submitter.submit({
      raw, inputName: MODULE_NAME, fromHost: null, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset, localOrigin: true,
      ...(settings.addMetadata ? { cee: { metadata } } : {}),
      ...(settings.needParse
        ? {}
        : { preparsed: { priority: settings.facility | settings.severity, offsetAfterPriority: 0, tag: settings.tag, msg: raw, timestamp: null, parseHostname: false } }),
    });
  }

  destroy(): void {
    for (const cancel of this.cancelers) cancel();
    this.cancelers = [];
    const destroyNode = (node: FsNode): void => {
      for (const edge of node.edges) {
        this.detectUpdates(edge);
        destroyNode(edge.node);
        for (const act of [...edge.active]) this.destroyActive(act, false);
        edge.active = [];
      }
    };
    destroyNode(this.tree);
    this.tree.edges = [];
    this.started = false;
  }
}

class ImfileInstance implements InputInstance {
  readonly description: string;

  constructor(
    readonly settings: InputSettings,
    private readonly context: InputContext,
    private readonly monitor: ImfileMonitor,
    private readonly shared: SharedState,
  ) {
    this.description = `imfile(${settings.fileName})`;
    monitor.register(this);
  }

  check(): void {
    const ruleset = this.settings.bindRuleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(`imfile: ruleset '${ruleset}' for ${this.settings.fileName} not found - using default ruleset instead`, RS_RET.NO_ERRCODE);
    }
  }

  start(): boolean {
    this.monitor.activate(this);
    return true;
  }

  run(): void {
    this.monitor.begin();
  }

  stop(): void {
    this.shared.stopped(this);
  }
}

interface SharedState {
  module: ModuleSettings;
  legacy: LegacyInput;
  monitor: ImfileMonitor | null;
  live: Set<ImfileInstance>;
  stopped(instance: ImfileInstance): void;
}

function sharedState(context: ModuleContext): SharedState {
  return context.moduleState('imfile.state', () => {
    const state: SharedState = {
      module: defaultModuleSettings(), legacy: defaultLegacyInput(), monitor: null, live: new Set<ImfileInstance>(),
      stopped: (instance) => {
        state.live.delete(instance);
        if (state.live.size === 0 && state.monitor !== null) {
          state.monitor.destroy();
          state.monitor = null;
        }
      },
    };
    return state;
  });
}

function monitorFor(context: InputContext): { state: SharedState; monitor: ImfileMonitor } {
  const state = sharedState(context);
  state.monitor ??= new ImfileMonitor(context, state.module);
  return { state, monitor: state.monitor };
}

function normalizeFileName(name: string, module: ModuleSettings, context: ModuleContext): string | null {
  if (!module.normalizePath) return name;
  let result = name;
  if (result.startsWith('./')) result = result.slice(2);
  if (!result.startsWith('/')) {
    context.runtime.error(`imfile: error querying current working directory - can not continue with ${result}`, RS_RET.ERR);
    return null;
  }
  return result;
}

function newInstance(settings: InputSettings, context: InputContext): ImfileInstance {
  const { state, monitor } = monitorFor(context);
  const instance = new ImfileInstance(settings, context, monitor, state);
  state.live.add(instance);
  return instance;
}

function newInstances(params: NvList, context: InputContext): InputInstance[] | null {
  const values = getParams(params, INPUT_PARAMS, {
    report: (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR), uidOf: () => null, gidOf: () => null,
  });
  if (values === null) return null;
  const state = sharedState(context);
  const module = state.module;
  const flag = (key: string): boolean | undefined => {
    const value = values.get(key);
    return value?.kind === 'N' ? value.n !== 0 : undefined;
  };
  const fileName = normalizeFileName(stringParam(values, 'file') ?? '', module, context);
  if (fileName === null) return null;
  const readMode = numberParam(values, 'readmode') ?? 0;
  const startPattern = stringParam(values, 'startmsg.regex');
  const endPattern = stringParam(values, 'endmsg.regex');
  const exclusive = (readMode > 0 ? 1 : 0) + (startPattern !== undefined ? 1 : 0) + (endPattern !== undefined ? 1 : 0);
  if (exclusive > 1) {
    context.runtime.error('only one of readMode or startmsg.regex or endmsg.regex can be set at the same time', RS_RET.PARAM_NOT_PERMITTED);
    return null;
  }
  const compile = (pattern: string | undefined, label: string): RegExp | null | undefined => {
    if (pattern === undefined) return null;
    const compiled = compileRegex('ERE', pattern);
    if (compiled === null) {
      context.runtime.error(`imfile: error in ${label} expansion: Invalid regular expression`, RS_RET.ERR);
      return undefined;
    }
    return compiled;
  };
  const startRegex = compile(startPattern, 'startmsg.regex');
  if (startRegex === undefined) return null;
  const endRegex = compile(endPattern, 'endmsg.regex');
  if (endRegex === undefined) return null;
  let maxLinesAtOnce = 0;
  const requestedLines = numberParam(values, 'maxlinesatonce');
  if (requestedLines !== undefined) {
    if (module.mode === 'inotify' && requestedLines > 0) {
      context.runtime.error('parameter "maxLinesAtOnce" not permited in inotify mode - ignored', RS_RET.PARAM_NOT_PERMITTED);
    } else {
      maxLinesAtOnce = requestedLines;
    }
  }
  const settings: InputSettings = {
    fileName, tag: stringParam(values, 'tag') ?? '', stateFile: stringParam(values, 'statefile') ?? null,
    bindRuleset: stringParam(values, 'ruleset') ?? null, severity: numberParam(values, 'severity') ?? DEFAULT_SEVERITY,
    facility: numberParam(values, 'facility') ?? DEFAULT_FACILITY, readMode, startRegex, endRegex,
    discardTruncatedMsg: flag('discardtruncatedmsg') ?? false, msgDiscardingError: flag('msgdiscardingerror') ?? true,
    escapeLF: flag('escapelf') ?? true, escapeLFString: stringParam(values, 'escapelf.replacement') ?? null,
    reopenOnTruncate: flag('reopenontruncate') ?? false, maxLinesAtOnce, trimLineOverBytes: numberParam(values, 'trimlineoverbytes') ?? 0,
    ignoreOlderThan: numberParam(values, 'ignoreolderthan') ?? 0, persistStateInterval: numberParam(values, 'persiststateinterval') ?? 0,
    persistStateAfterSubmission: flag('persiststateaftersubmission') ?? false,
    multiSubmit: numberParam(values, 'maxsubmitatonce') ?? DEFAULT_MULTI_SUBMIT, readTimeout: numberParam(values, 'readtimeout') ?? module.readTimeout,
    delayPerMessageMicros: numberParam(values, 'delay.message') ?? 0,
    deleteStateOnDelete: flag('deletestateonfiledelete') ?? flag('removestateondelete') ?? true,
    deleteStateOnMove: flag('deletestateonfilemove') ?? module.deleteStateOnMove,
    addMetadata: flag('addmetadata') ?? true, addCeeTag: flag('addceetag') ?? false, freshStartTail: flag('freshstarttail') ?? false,
    fileNotFoundError: flag('filenotfounderror') ?? true, needParse: flag('needparse') ?? false,
    limits: newLimits(numberParam(values, 'maxbytesperminute') ?? 0, numberParam(values, 'maxlinesperminute') ?? 0),
  };
  reportUnused(params, (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR));
  return [newInstance(settings, context)];
}

function legacy(context: ModuleContext): LegacyInput {
  return sharedState(context).legacy;
}

function directives(): DirectiveRegistration[] {
  const text = (apply: (state: LegacyInput, value: string) => void) => (value: string | number, context: ModuleContext): void => apply(legacy(context), String(value));
  const number = (apply: (state: LegacyInput, value: number) => void) => (value: string | number, context: ModuleContext): void => apply(legacy(context), Number(value));
  return [
    { name: 'inputfilename', type: 'word', apply: text((state, value) => { state.fileName = value; }) },
    { name: 'inputfiletag', type: 'word', apply: text((state, value) => { state.tag = value; }) },
    { name: 'inputfilestatefile', type: 'word', apply: text((state, value) => { state.stateFile = value; }) },
    { name: 'inputfileseverity', type: 'severity', apply: number((state, value) => { state.severity = value; }) },
    { name: 'inputfilefacility', type: 'facility', apply: number((state, value) => { state.facility = value; }) },
    { name: 'inputfilereadmode', type: 'int', apply: number((state, value) => { state.readMode = value; }) },
    { name: 'inputfilemaxlinesatonce', type: 'size', apply: number((state, value) => { state.maxLinesAtOnce = value; }) },
    { name: 'inputfiletrimlineoverbytes', type: 'size', apply: number((state, value) => { state.trimLineOverBytes = value; }) },
    { name: 'inputfilepersiststateinterval', type: 'int', apply: number((state, value) => { state.persistStateInterval = value; }) },
    { name: 'inputfilebindruleset', type: 'word', apply: text((state, value) => { state.bindRuleset = value; }) },
    {
      name: 'inputfilepollinterval', type: 'int',
      apply: (value, context) => {
        const module = sharedState(context).module;
        if (module.configuredViaModule) context.runtime.error('$InputFilePollInterval not permitted after module(...) parameters were given', RS_RET.ERR);
        else module.legacyPollInterval = Number(value);
      },
    },
    { name: 'inputrunfilemonitor', type: 'word', apply: (_value, context) => addLegacyInstance(context as InputContext) },
    {
      name: 'resetconfigvariables', type: 'custom', apply: () => undefined,
      custom: (rest, context) => { sharedState(context).legacy = defaultLegacyInput(); return rest; },
    },
  ];
}

function addLegacyInstance(context: InputContext): void {
  const state = sharedState(context);
  const input = state.legacy;
  if (input.fileName === null) {
    context.runtime.error('imfile error: no file name given, file monitor can not be created', RS_RET.CONFIG_ERROR);
    return;
  }
  if (input.tag === null) {
    context.runtime.error('imfile error: no tag value given, file monitor can not be created', RS_RET.CONFIG_ERROR);
    return;
  }
  const fileName = normalizeFileName(input.fileName, state.module, context);
  if (fileName === null) return;
  let maxLinesAtOnce = 0;
  if (input.maxLinesAtOnce !== 0) {
    if (state.module.mode === 'inotify') context.runtime.error('parameter "maxLinesAtOnce" not permited in inotify mode - ignored', RS_RET.PARAM_NOT_PERMITTED);
    else maxLinesAtOnce = input.maxLinesAtOnce;
  }
  const settings: InputSettings = {
    fileName, tag: input.tag, stateFile: input.stateFile, bindRuleset: input.bindRuleset === null || input.bindRuleset === '' ? null : input.bindRuleset,
    severity: input.severity, facility: input.facility, readMode: input.readMode, startRegex: null, endRegex: null, discardTruncatedMsg: false,
    msgDiscardingError: true, escapeLF: false, escapeLFString: null, reopenOnTruncate: false, maxLinesAtOnce,
    trimLineOverBytes: input.trimLineOverBytes, ignoreOlderThan: 0, persistStateInterval: input.persistStateInterval,
    persistStateAfterSubmission: false, multiSubmit: DEFAULT_MULTI_SUBMIT, readTimeout: state.module.readTimeout, delayPerMessageMicros: 0,
    deleteStateOnDelete: false, deleteStateOnMove: state.module.deleteStateOnMove, addMetadata: false, addCeeTag: false, freshStartTail: false,
    fileNotFoundError: true, needParse: false, limits: newLimits(0, 0),
  };
  const instance = newInstance(settings, context);
  context.registerInput(MODULE_NAME, instance);
  state.legacy = { ...defaultLegacyInput(), ...{ persistStateInterval: 0 } };
}

export const imfile: InputModule = {
  kind: 'input',
  name: MODULE_NAME,
  builtin: false,
  newInstances,
  directives,
  setModuleConfig(params, context) {
    const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], { report, uidOf: () => null, gidOf: () => null });
    if (values === null) {
      context.runtime.error('imfile: error processing module config parameters [module(...)]', RS_RET.MISSING_CNFPARAMS);
      return false;
    }
    const module = sharedState(context).module;
    module.mode = 'inotify';
    module.pollInterval = numberParam(values, 'pollinginterval') ?? module.pollInterval;
    module.deleteStateOnMove = (numberParam(values, 'deletestateonfilemove') ?? (module.deleteStateOnMove ? 1 : 0)) !== 0;
    module.readTimeout = numberParam(values, 'readtimeout') ?? module.readTimeout;
    const granularity = numberParam(values, 'timeoutgranularity');
    if (granularity !== undefined) module.timeoutGranularityMs = granularity * 1000;
    module.maxInotifyWatches = numberParam(values, 'maxinotifywatches') ?? module.maxInotifyWatches;
    module.inotifyFallbackInterval = numberParam(values, 'inotifyfallbackinterval') ?? module.inotifyFallbackInterval;
    const sort = numberParam(values, 'sortfiles');
    if (sort !== undefined) module.sortFiles = sort !== 0;
    module.stateFileDirectory = stringParam(values, 'statefile.directory') ?? module.stateFileDirectory;
    const normalize = numberParam(values, 'normalizepath');
    if (normalize !== undefined) module.normalizePath = normalize !== 0;
    const mode = stringParam(values, 'mode');
    if (mode !== undefined) {
      if (mode === 'polling' || mode === 'inotify' || mode === 'fen') module.mode = mode;
      else context.runtime.error(`imfile: unknown mode '${mode}'`, RS_RET.PARAM_ERROR);
    }
    module.configuredViaModule = true;
    for (const entry of params.entries) entry.used = true;
    return true;
  },
  check(instanceCount, context) {
    const state = sharedState(context);
    if (state.module.stateFileDirectory === null && context.settings.workDirectory === null) {
      context.runtime.error(
        'imfile: no working or state file directory set, imfile will create state files in the current working directory (probably the root dir). Use global(workDirectory="/some/path") to set the working directory',
        RS_RET.NO_WRKDIR_SET,
      );
    }
    if (instanceCount === 0) context.runtime.warning('imfile: no files configured to be monitored - no input will be gathered', RS_RET.NO_ERRCODE);
  },
  implicitInstances(context) {
    if (sharedState(context).live.size > 0) return [];
    return [{
      description: 'imfile(no monitors)',
      start: () => {
        context.runtime.error('imfile: no file monitors configured, input not activated.\n', RS_RET.NO_ERRCODE);
        return false;
      },
      stop: () => undefined,
    }];
  },
  reset(context) {
    sharedState(context).legacy = defaultLegacyInput();
  },
};
