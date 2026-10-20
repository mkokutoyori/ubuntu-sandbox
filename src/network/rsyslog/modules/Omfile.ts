import type { NvList } from '../config/Ast';
import { getParams, numberParam, reportUnused, stringParam, type ParamDescriptor } from '../config/Params';
import type { FileHandle, OpenFileOptions } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type {
  ActionArguments, ActionModuleInstance, ActionOutcome, ActionWorker, DirectiveRegistration, ModuleContext, OutputModule, SelectorParse,
  TemplateRequest,
} from '../engine/Modules';
import type { RsyslogMessage } from '../Message';
import { OmfileStream, type StreamSettings } from './OmfileStream';
import { parseSelectorTemplate } from './SelectorTemplate';

interface OmfileModuleConfig {
  template: string | null;
  addLf: boolean;
  fileCreateMode: number;
  directoryCreateMode: number;
  fileUid: number | null;
  fileGid: number | null;
  directoryUid: number | null;
  directoryGid: number | null;
  dynafileDoNotSuspend: boolean;
  permitPathEscape: boolean;
  restrictTemplateType: boolean;
  followSymlinks: boolean | null;
  compressionDriver: 'zlib' | 'zstd';
}

interface OmfileLegacyState {
  fileUid: number | null;
  fileGid: number | null;
  directoryUid: number | null;
  directoryGid: number | null;
  failOnChown: boolean;
  dynaFileCacheSize: number;
  fileCreateMode: number;
  directoryCreateMode: number;
  createDirectories: boolean;
  enableSync: boolean;
  defaultTemplate: string | null;
  zipLevel: number;
  flushIntervalSeconds: number;
  asyncWriting: boolean;
  flushOnTxEnd: boolean;
  ioBufferSize: number;
}

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'template', type: 'word' }, { name: 'addlf', type: 'binary' }, { name: 'compression.driver', type: 'word' },
  { name: 'compression.zstd.workers', type: 'positive' }, { name: 'dircreatemode', type: 'filemode' },
  { name: 'filecreatemode', type: 'filemode' }, { name: 'dirowner', type: 'uid' }, { name: 'dirownernum', type: 'int' },
  { name: 'dirgroup', type: 'gid' }, { name: 'dirgroupnum', type: 'int' }, { name: 'fileowner', type: 'uid' },
  { name: 'fileownernum', type: 'int' }, { name: 'filegroup', type: 'gid' }, { name: 'dynafile.donotsuspend', type: 'binary' },
  { name: 'followsymlinks', type: 'binary' }, { name: 'dynafile.dangerouspermitpathescape', type: 'binary' },
  { name: 'dynafile.restricttemplatetype', type: 'binary' }, { name: 'filegroupnum', type: 'int' },
];

const ACTION_PARAMS: readonly ParamDescriptor[] = [
  { name: 'dynafilecachesize', type: 'int' }, { name: 'ziplevel', type: 'int' }, { name: 'flushinterval', type: 'int' },
  { name: 'asyncwriting', type: 'binary' }, { name: 'veryrobustzip', type: 'binary' }, { name: 'flushontxend', type: 'binary' },
  { name: 'iobuffersize', type: 'size' }, { name: 'dirowner', type: 'uid' }, { name: 'dirownernum', type: 'int' },
  { name: 'dirgroup', type: 'gid' }, { name: 'dirgroupnum', type: 'int' }, { name: 'fileowner', type: 'uid' },
  { name: 'fileownernum', type: 'int' }, { name: 'filegroup', type: 'gid' }, { name: 'filegroupnum', type: 'int' },
  { name: 'dircreatemode', type: 'filemode' }, { name: 'filecreatemode', type: 'filemode' },
  { name: 'failonchownfailure', type: 'binary' }, { name: 'createdirs', type: 'binary' }, { name: 'sync', type: 'binary' },
  { name: 'file', type: 'string' }, { name: 'dynafile', type: 'string' }, { name: 'followsymlinks', type: 'binary' },
  { name: 'sig.provider', type: 'word' }, { name: 'cry.provider', type: 'word' }, { name: 'closetimeout', type: 'positive' },
  { name: 'rotation.sizelimit', type: 'size' }, { name: 'rotation.sizelimitcommand', type: 'string' },
  { name: 'rotation.sizelimitcommandpassfilename', type: 'binary' }, { name: 'template', type: 'word' },
  { name: 'dynafile.dangerouspermitpathescape', type: 'binary' }, { name: 'addlf', type: 'binary' },
];

function defaultModuleConfig(): OmfileModuleConfig {
  return {
    template: null, addLf: true, fileCreateMode: 0o644, directoryCreateMode: 0o700, fileUid: null, fileGid: null,
    directoryUid: null, directoryGid: null, dynafileDoNotSuspend: true, permitPathEscape: false, restrictTemplateType: false,
    followSymlinks: null, compressionDriver: 'zlib',
  };
}

function defaultLegacyState(): OmfileLegacyState {
  return {
    fileUid: null, fileGid: null, directoryUid: null, directoryGid: null, failOnChown: true, dynaFileCacheSize: 10,
    fileCreateMode: 0o644, directoryCreateMode: 0o700, createDirectories: true, enableSync: false, defaultTemplate: null,
    zipLevel: 0, flushIntervalSeconds: 1, asyncWriting: false, flushOnTxEnd: true, ioBufferSize: 4096,
  };
}

function moduleConfig(context: ModuleContext): OmfileModuleConfig {
  return context.moduleState('omfile.config', defaultModuleConfig);
}

function legacyState(context: ModuleContext): OmfileLegacyState {
  return context.moduleState('omfile.legacy', defaultLegacyState);
}

export function normalizePathLexically(path: string): string {
  const absolute = path.startsWith('/');
  const components: string[] = [];
  for (const piece of path.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (components.length > 0 && components[components.length - 1] !== '..') components.pop();
      else if (!absolute) components.push('..');
      continue;
    }
    components.push(piece);
  }
  if (components.length === 0) return absolute ? '/' : '.';
  return (absolute ? '/' : '') + components.join('/');
}

function isBelow(path: string, base: string): boolean {
  if (base === '/') return path.startsWith('/');
  return path === base || (path.startsWith(base) && path[base.length] === '/');
}

function deriveBase(prefix: string): string | null {
  const slash = prefix.lastIndexOf('/');
  if (slash < 0) return null;
  const base = normalizePathLexically(prefix.slice(0, slash === 0 ? 1 : slash));
  return base !== '' && base !== '.' ? base : null;
}

interface OmfileInstanceSettings {
  readonly dynamic: boolean;
  readonly fileName: string;
  readonly templateName: string;
  readonly addLf: boolean;
  readonly createDirectories: boolean;
  readonly fileMode: number;
  readonly directoryMode: number;
  readonly fileUid: number | null;
  readonly fileGid: number | null;
  readonly directoryUid: number | null;
  readonly directoryGid: number | null;
  readonly failOnChown: boolean;
  readonly cacheSize: number;
  readonly closeTimeoutMinutes: number;
  readonly dynafileDoNotSuspend: boolean;
  readonly permitPathEscape: boolean;
  readonly restrictTemplateType: boolean;
  readonly isDevNull: boolean;
  readonly sizeLimit: number;
  readonly sizeLimitCommand: string | null;
  readonly sizeLimitPassFileName: boolean;
  readonly zipLevel: number;
  readonly veryRobustZip: boolean;
  readonly driver: 'zlib' | 'zstd';
  readonly asyncWriting: boolean;
  readonly flushIntervalSeconds: number;
  readonly flushOnTxEnd: boolean;
  readonly ioBufferSize: number;
  readonly sync: boolean;
  readonly followSymlinks: boolean;
  readonly followSymlinksExplicit: boolean;
}

interface CacheEntry {
  readonly name: string;
  readonly handle: OmfileStream;
  accessed: number;
  idleMinutes: number;
}

class OmfileInstance implements ActionModuleInstance {
  readonly moduleName = 'omfile';
  readonly description: string;
  readonly templates: TemplateRequest[];
  private handle: OmfileStream | null = null;
  private current: OmfileStream | null = null;
  private idleMinutes = 0;
  private readonly cache: CacheEntry[] = [];
  private clock = 0;
  private cancelJanitor: (() => void) | null = null;
  private baseDirectory: string | null = null;

  constructor(private readonly settings: OmfileInstanceSettings, private readonly context: ModuleContext) {
    this.description = settings.fileName;
    this.templates = settings.dynamic
      ? [{ name: settings.templateName }, { name: settings.fileName, dynamicFileName: true }]
      : [{ name: settings.templateName }];
    if (settings.dynamic) {
      const template = context.template(settings.fileName);
      this.baseDirectory = template === undefined ? null : OmfileInstance.baseOf(template);
    }
    if (settings.closeTimeoutMinutes > 0) {
      this.cancelJanitor = context.host.scheduleEvery(() => this.janitor(), 60_000);
    }
  }

  private static baseOf(template: { kind: string; entries: ReadonlyArray<{ kind: string; text?: string }> }): string | null {
    if (template.kind !== 'entries') return null;
    let prefix = '';
    for (const entry of template.entries) {
      if (entry.kind !== 'constant') break;
      prefix += entry.text ?? '';
    }
    return prefix.length === 0 ? null : deriveBase(prefix);
  }

  private openOptions(): OpenFileOptions {
    const s = this.settings;
    return {
      mode: s.fileMode, directoryMode: s.directoryMode, uid: s.fileUid, gid: s.fileGid, directoryUid: s.directoryUid,
      directoryGid: s.directoryGid, createDirectories: s.createDirectories, failOnChownFailure: s.failOnChown,
      followSymlinks: s.followSymlinks,
    };
  }

  private openRaw(path: string): FileHandle | { error: string; reported: boolean } {
    const settings = this.settings;
    if (settings.followSymlinks && !settings.followSymlinksExplicit && this.context.settings.compatDefaultsSecure === 'warn' && this.context.host.files.isSymbolicLink(path)) {
      this.context.runtime.warning(
        `omfile: following symbolic link output file '${path}'; set action(type="omfile" followSymlinks="off") or global(compatibility.defaults.secure="strict") to reject final-component symlinks`,
        RS_RET.NO_ERRCODE,
      );
    }
    const result = this.context.host.files.open(path, this.openOptions());
    for (const notice of result.notices ?? []) {
      if (notice.kind === 'directory-chown') {
        this.context.runtime.error(`chown for directory '${notice.path}' failed`, RS_RET.DIR_CHOWN_ERROR);
      } else {
        this.context.runtime.error(`omfile: chown for file '${notice.path}' failed: ${notice.reason}`, RS_RET.CONF_PARSE_ERROR);
      }
    }
    if ('handle' in result) return result.handle;
    if (result.step === 'parents') {
      this.context.runtime.error(`omfile: creating parent directories for file  '${path}' failed: ${result.error}`, RS_RET.CONF_PARSE_ERROR);
      return { error: result.error, reported: true };
    }
    return { error: result.error, reported: result.step === 'chown' };
  }

  private streamSettings(): StreamSettings {
    const s = this.settings;
    return {
      ioBufferSize: Math.max(1, s.ioBufferSize), zipLevel: s.zipLevel, veryRobustZip: s.veryRobustZip, driver: s.driver,
      asyncWriting: s.asyncWriting, flushIntervalSeconds: s.flushIntervalSeconds, sizeLimit: s.sizeLimit,
      sizeLimitCommand: s.sizeLimitCommand, passFileName: s.sizeLimitPassFileName,
    };
  }

  private open(path: string): OmfileStream | { error: string; reported: boolean } {
    const first = this.openRaw(path);
    if ('error' in first) return first;
    return new OmfileStream(path, first, this.streamSettings(), {
      open: () => this.openRaw(path),
      size: (target) => this.context.host.files.statSize(target),
      schedule: (callback, delayMs) => this.context.host.schedule(callback, delayMs),
      run: (argv) => { this.context.host.process?.run?.(argv); },
      report: (text, code) => this.context.runtime.error(text, code),
    });
  }

  private validate(path: string): boolean {
    if (this.settings.permitPathEscape) return true;
    const normalized = normalizePathLexically(path);
    if (this.baseDirectory !== null) {
      if (!isBelow(normalized, this.baseDirectory)) {
        this.context.runtime.error(`omfile: dynafile path traversal blocked: '${path}' resolves outside base '${this.baseDirectory}'`, RS_RET.CONF_PARSE_ERROR);
        return false;
      }
    } else if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      this.context.runtime.error(`omfile: dynafile path traversal blocked: '${path}'`, RS_RET.CONF_PARSE_ERROR);
      return false;
    }
    return true;
  }

  private dynamicHandle(path: string): OmfileStream | 'discard' | 'error' {
    const existing = this.cache.find((entry) => entry.name === path);
    if (existing !== undefined) {
      existing.accessed = ++this.clock;
      existing.idleMinutes = 0;
      return existing.handle;
    }
    if (!this.validate(path)) return 'discard';
    if (this.cache.length >= this.settings.cacheSize) {
      let oldest = 0;
      this.cache.forEach((entry, index) => { if (entry.accessed < this.cache[oldest].accessed) oldest = index; });
      this.cache[oldest].handle.close();
      this.cache.splice(oldest, 1);
    }
    const opened = this.open(path);
    if ('error' in opened) {
      if (!opened.reported) {
        this.context.runtime.error(`omfile: open file '${path}' failed: ${opened.error}`, RS_RET.CONF_PARSE_ERROR);
        this.context.runtime.error(`Could not open dynamic file '${path}' [state ${opened.error === 'No such file or directory' ? -2040 : -2433}] - discarding message`, RS_RET.CONF_PARSE_ERROR);
      }
      return 'error';
    }
    this.cache.push({ name: path, handle: opened, accessed: ++this.clock, idleMinutes: 0 });
    return opened;
  }

  private janitor(): void {
    const limit = this.settings.closeTimeoutMinutes;
    if (this.settings.dynamic) {
      for (const entry of [...this.cache]) {
        entry.idleMinutes++;
        if (entry.idleMinutes >= limit) {
          entry.handle.close();
          this.cache.splice(this.cache.indexOf(entry), 1);
        }
      }
    } else if (this.handle !== null) {
      this.idleMinutes++;
      if (this.idleMinutes >= limit) {
        this.handle.close();
        this.handle = null;
      }
    }
  }

  write(text: string, path: string): ActionOutcome {
    if (this.settings.isDevNull) return 'ok';
    let handle: OmfileStream;
    if (this.settings.dynamic) {
      const found = this.dynamicHandle(path);
      if (found === 'discard') return 'ok';
      if (found === 'error') return this.settings.dynafileDoNotSuspend ? 'ok' : 'suspended';
      handle = found;
    } else {
      if (this.handle === null) {
        const opened = this.open(this.settings.fileName);
        if ('error' in opened) {
          if (!opened.reported) {
            this.context.runtime.error(`omfile: open file '${this.settings.fileName}' failed: ${opened.error}`, RS_RET.CONF_PARSE_ERROR);
            this.context.runtime.error(`Could not open output file '${this.settings.fileName}'`, RS_RET.CONF_PARSE_ERROR);
          }
          return 'suspended';
        }
        this.handle = opened;
      }
      this.idleMinutes = 0;
      handle = this.handle;
    }
    this.current = handle;
    const needsLf = this.settings.addLf && (text.length === 0 || !text.endsWith('\n'));
    const failure = handle.write(needsLf ? `${text}\n` : text);
    if (failure !== null) {
      if (handle.lastFailure !== null) return 'fail';
      this.context.runtime.error(`omfile: write to '${handle.path}' failed: ${failure}`, RS_RET.FILE_OPEN_ERROR);
      this.closeHandle(handle);
      return 'suspended';
    }
    return 'ok';
  }

  commit(): ActionOutcome {
    if (this.settings.flushOnTxEnd) this.current?.flush();
    return 'ok';
  }

  private closeHandle(handle: OmfileStream): void {
    if (this.handle === handle) this.handle = null;
    if (this.current === handle) this.current = null;
    const index = this.cache.findIndex((entry) => entry.handle === handle);
    if (index >= 0) this.cache.splice(index, 1);
    handle.close();
  }

  createWorker(): ActionWorker {
    return {
      doAction: (args: ActionArguments, _message: RsyslogMessage) => this.write(args.strings[0] ?? '', args.strings[1] ?? ''),
      endTransaction: () => this.commit(),
      close: () => undefined,
    };
  }

  hup(): void {
    this.current = null;
    if (this.settings.dynamic) {
      for (const entry of this.cache) entry.handle.close();
      this.cache.length = 0;
    } else if (this.handle !== null) {
      this.handle.close();
      this.handle = null;
    }
  }

  teardown(): void {
    this.hup();
    this.cancelJanitor?.();
    this.cancelJanitor = null;
  }
}

function defaultTemplateName(context: ModuleContext): string {
  return moduleConfig(context).template ?? legacyState(context).defaultTemplate ?? 'RSYSLOG_FileFormat';
}

function parseFileName(rest: string, context: ModuleContext): { name: string; template: string; error: boolean } {
  let name = '';
  let index = 0;
  while (index < rest.length && rest[index] !== ';' && rest[index] !== ' ' && name.length < 4095) name += rest[index++];
  const template = parseSelectorTemplate(rest.slice(index), defaultTemplateName(context), context.runtime);
  if (template === null) return { name, template: '', error: true };
  return { name, template, error: false };
}

function effectiveFollow(context: ModuleContext, explicit: boolean | null): boolean {
  return explicit ?? context.settings.compatDefaultsSecure !== 'strict';
}

function buildSettings(
  context: ModuleContext, dynamic: boolean, fileName: string, templateName: string, overrides: Partial<OmfileInstanceSettings>,
): OmfileInstanceSettings {
  const legacy = legacyState(context);
  return {
    dynamic, fileName, templateName, addLf: true, createDirectories: legacy.createDirectories, fileMode: legacy.fileCreateMode,
    directoryMode: legacy.directoryCreateMode, fileUid: legacy.fileUid, fileGid: legacy.fileGid, directoryUid: legacy.directoryUid,
    directoryGid: legacy.directoryGid, failOnChown: legacy.failOnChown, cacheSize: legacy.dynaFileCacheSize,
    closeTimeoutMinutes: dynamic ? 10 : 0, dynafileDoNotSuspend: moduleConfig(context).dynafileDoNotSuspend,
    permitPathEscape: moduleConfig(context).permitPathEscape, restrictTemplateType: moduleConfig(context).restrictTemplateType,
    isDevNull: fileName === '/dev/null', sizeLimit: 0, sizeLimitCommand: null, sizeLimitPassFileName: true,
    zipLevel: legacy.zipLevel, veryRobustZip: false, driver: moduleConfig(context).compressionDriver, asyncWriting: legacy.asyncWriting,
    flushIntervalSeconds: legacy.flushIntervalSeconds, flushOnTxEnd: legacy.flushOnTxEnd, ioBufferSize: legacy.ioBufferSize,
    sync: legacy.enableSync, followSymlinks: effectiveFollow(context, moduleConfig(context).followSymlinks),
    followSymlinksExplicit: moduleConfig(context).followSymlinks !== null, ...overrides,
  };
}

function parseSelector(line: string, context: ModuleContext): SelectorParse {
  let rest = line.startsWith(':omfile:') ? line.slice(':omfile:'.length) : line;
  const syncOverride: Partial<OmfileInstanceSettings> = rest.startsWith('-') ? { sync: false } : {};
  if (rest.startsWith('-')) rest = rest.slice(1);
  const first = rest[0];
  if (first === '$') {
    let name = '';
    let index = 1;
    while (index < rest.length && rest[index] !== ';' && rest[index] !== ' ' && name.length < 127) name += rest[index++];
    const channel = context.outchannel(name);
    if (channel === undefined) {
      context.runtime.error(`outchannel '${name}' not found - ignoring action line`, RS_RET.NOT_FOUND);
      return { status: 'error' };
    }
    if (channel.fileTemplate === null) {
      context.runtime.error(`outchannel '${name}' has no file name template - ignoring action line`, RS_RET.ERR);
      return { status: 'error' };
    }
    const template = parseSelectorTemplate(rest.slice(index), defaultTemplateName(context), context.runtime);
    if (template === null) return { status: 'error' };
    const overrides = { ...syncOverride, sizeLimit: channel.sizeLimit, sizeLimitCommand: channel.sizeLimitCommand, sizeLimitPassFileName: false };
    return { status: 'ok', instance: new OmfileInstance(buildSettings(context, false, channel.fileTemplate, template, overrides), context), rest: '' };
  }
  if (first === '?') {
    const parsed = parseFileName(rest.slice(1), context);
    if (parsed.error) return { status: 'error' };
    return { status: 'ok', instance: new OmfileInstance(buildSettings(context, true, parsed.name, parsed.template, syncOverride), context), rest: '' };
  }
  if (first === '/' || first === '.') {
    const parsed = parseFileName(rest, context);
    if (parsed.error) return { status: 'error' };
    return { status: 'ok', instance: new OmfileInstance(buildSettings(context, false, parsed.name, parsed.template, syncOverride), context), rest: '' };
  }
  return { status: 'unprocessed' };
}

function newActionInstance(params: NvList, context: ModuleContext): ActionModuleInstance | null {
  const values = getParams(params, ACTION_PARAMS, {
    report: (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR),
    uidOf: (name) => context.host.users.uidOf(name),
    gidOf: (name) => context.host.users.gidOf(name),
  });
  if (values === null) {
    context.runtime.error('omfile: either the "file" or "dynafile" parameter must be given', RS_RET.CONF_PARSE_ERROR);
    return null;
  }
  reportUnused(params, (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR));
  const module = moduleConfig(context);
  const flag = (key: string): boolean | undefined => {
    const value = values.get(key);
    return value?.kind === 'N' ? value.n !== 0 : undefined;
  };
  const file = stringParam(values, 'file');
  const dynafile = stringParam(values, 'dynafile');
  if (file !== undefined && dynafile !== undefined) context.runtime.error('omfile: both "file" and "dynafile" set, will use dynafile', RS_RET.CONF_PARSE_ERROR);
  const name = dynafile ?? file;
  if (name === undefined || name === '') {
    context.runtime.error('omfile: either the "file" or "dynafile" parameter must be given', RS_RET.CONF_PARSE_ERROR);
    return null;
  }
  if (/^\s*$/.test(name)) {
    context.runtime.error('omfile: "file" or "dynafile" parameter consist only of whitespace - this is not permitted', RS_RET.CONF_PARSE_ERROR);
    return null;
  }
  const uid = (key: string, numeric: string): number | null => numberParam(values, key) ?? numberParam(values, numeric) ?? null;
  const legacy = legacyState(context);
  const dynamic = dynafile !== undefined;
  const closeTimeout = numberParam(values, 'closetimeout');
  const templateName = stringParam(values, 'template') ?? module.template ?? legacy.defaultTemplate ?? 'RSYSLOG_FileFormat';
  const settings = buildSettings(context, dynamic, name, templateName, {
    addLf: flag('addlf') ?? module.addLf,
    createDirectories: flag('createdirs') ?? true,
    fileMode: numberParam(values, 'filecreatemode') ?? module.fileCreateMode,
    directoryMode: numberParam(values, 'dircreatemode') ?? module.directoryCreateMode,
    fileUid: uid('fileowner', 'fileownernum') ?? module.fileUid,
    fileGid: uid('filegroup', 'filegroupnum') ?? module.fileGid,
    directoryUid: uid('dirowner', 'dirownernum') ?? module.directoryUid,
    directoryGid: uid('dirgroup', 'dirgroupnum') ?? module.directoryGid,
    failOnChown: flag('failonchownfailure') ?? true,
    cacheSize: numberParam(values, 'dynafilecachesize') ?? 10,
    closeTimeoutMinutes: closeTimeout ?? (dynamic ? 10 : 0),
    permitPathEscape: flag('dynafile.dangerouspermitpathescape') ?? module.permitPathEscape,
    sizeLimit: numberParam(values, 'rotation.sizelimit') ?? 0,
    sizeLimitCommand: stringParam(values, 'rotation.sizelimitcommand') ?? null,
    sizeLimitPassFileName: flag('rotation.sizelimitcommandpassfilename') ?? true,
    zipLevel: numberParam(values, 'ziplevel') ?? 0,
    veryRobustZip: flag('veryrobustzip') ?? false,
    asyncWriting: flag('asyncwriting') ?? false,
    flushIntervalSeconds: numberParam(values, 'flushinterval') ?? 1,
    flushOnTxEnd: flag('flushontxend') ?? true,
    ioBufferSize: numberParam(values, 'iobuffersize') ?? 4096,
    sync: flag('sync') ?? false,
    followSymlinks: effectiveFollow(context, flag('followsymlinks') ?? module.followSymlinks),
    followSymlinksExplicit: flag('followsymlinks') !== undefined || module.followSymlinks !== null,
  });
  const cryProvider = stringParam(values, 'cry.provider');
  if (cryProvider !== undefined) {
    const library = `lmcry_${cryProvider}`;
    if (!context.moduleFileAvailable(`${library}.so`)) {
      context.runtime.error(`omfile: could not load crypto provider '${library}' - encryption disabled`, RS_RET.CONF_PARSE_ERROR);
      return null;
    }
  }
  const sigProvider = stringParam(values, 'sig.provider');
  if (sigProvider !== undefined && !context.moduleFileAvailable(`lmsig_${sigProvider}.so`)) {
    context.runtime.error(`omfile: could not load signature provider 'lmsig_${sigProvider}' - signatures disabled`, RS_RET.CONF_PARSE_ERROR);
  }
  if (dynamic && settings.restrictTemplateType) {
    const template = context.template(name);
    if (template === undefined || template.kind !== 'entries') {
      context.runtime.error(`omfile: dynafile template '${name}' uses a template type that cannot be safely inspected for path traversal; use type="string" or type="list", or set module parameter dynafile.restrictTemplateType="off" to use the legacy template subject to the fallback path guards`, RS_RET.CONF_PARSE_ERROR);
      return null;
    }
  }
  return new OmfileInstance(settings, context);
}

function directives(): DirectiveRegistration[] {
  const set = (apply: (state: OmfileLegacyState, value: number | string) => void) => (value: number | string, context: ModuleContext): void => apply(legacyState(context), value);
  const list: DirectiveRegistration[] = [
    { name: 'dynafilecachesize', type: 'int', apply: set((s, v) => { s.dynaFileCacheSize = Math.max(1, Number(v)); }) },
    { name: 'omfileziplevel', type: 'int', apply: set((s, v) => { s.zipLevel = Number(v); }) },
    { name: 'omfileflushinterval', type: 'int', apply: set((s, v) => { s.flushIntervalSeconds = Number(v); }) },
    { name: 'omfileasyncwriting', type: 'binary', apply: set((s, v) => { s.asyncWriting = v === 1; }) },
    { name: 'omfileflushontxend', type: 'binary', apply: set((s, v) => { s.flushOnTxEnd = v === 1; }) },
    { name: 'omfileiobuffersize', type: 'size', apply: set((s, v) => { s.ioBufferSize = Number(v); }) },
    { name: 'dirowner', type: 'uid', apply: set((s, v) => { s.directoryUid = Number(v); }) },
    { name: 'dirownernum', type: 'int', apply: set((s, v) => { s.directoryUid = Number(v); }) },
    { name: 'dirgroup', type: 'gid', apply: set((s, v) => { s.directoryGid = Number(v); }) },
    { name: 'dirgroupnum', type: 'int', apply: set((s, v) => { s.directoryGid = Number(v); }) },
    { name: 'fileowner', type: 'uid', apply: set((s, v) => { s.fileUid = Number(v); }) },
    { name: 'fileownernum', type: 'int', apply: set((s, v) => { s.fileUid = Number(v); }) },
    { name: 'filegroup', type: 'gid', apply: set((s, v) => { s.fileGid = Number(v); }) },
    { name: 'filegroupnum', type: 'int', apply: set((s, v) => { s.fileGid = Number(v); }) },
    { name: 'dircreatemode', type: 'filemode', apply: set((s, v) => { s.directoryCreateMode = Number(v); }) },
    { name: 'filecreatemode', type: 'filemode', apply: set((s, v) => { s.fileCreateMode = Number(v); }) },
    { name: 'createdirs', type: 'binary', apply: set((s, v) => { s.createDirectories = v === 1; }) },
    { name: 'failonchownfailure', type: 'binary', apply: set((s, v) => { s.failOnChown = v === 1; }) },
    { name: 'omfileforcechown', type: 'goneaway', apply: () => undefined },
    { name: 'actionfileenablesync', type: 'binary', apply: set((s, v) => { s.enableSync = v === 1; }) },
    { name: 'actionfiledefaulttemplate', type: 'word', apply: set((s, v) => { s.defaultTemplate = String(v); }) },
  ];
  return list;
}

export const omfile: OutputModule = {
  kind: 'output',
  name: 'omfile',
  builtin: true,
  parseSelector,
  newActionInstance,
  directives,
  moduleParams: MODULE_PARAMS,
  setModuleConfig(params, context) {
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], {
      report: (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR),
      uidOf: (name) => context.host.users.uidOf(name),
      gidOf: (name) => context.host.users.gidOf(name),
    });
    if (values === null) return false;
    const config = moduleConfig(context);
    const flag = (key: string): boolean | undefined => {
      const value = values.get(key);
      return value?.kind === 'N' ? value.n !== 0 : undefined;
    };
    config.template = stringParam(values, 'template') ?? config.template;
    config.addLf = flag('addlf') ?? config.addLf;
    config.fileCreateMode = numberParam(values, 'filecreatemode') ?? config.fileCreateMode;
    config.directoryCreateMode = numberParam(values, 'dircreatemode') ?? config.directoryCreateMode;
    config.fileUid = numberParam(values, 'fileowner') ?? numberParam(values, 'fileownernum') ?? config.fileUid;
    config.fileGid = numberParam(values, 'filegroup') ?? numberParam(values, 'filegroupnum') ?? config.fileGid;
    config.directoryUid = numberParam(values, 'dirowner') ?? numberParam(values, 'dirownernum') ?? config.directoryUid;
    config.directoryGid = numberParam(values, 'dirgroup') ?? numberParam(values, 'dirgroupnum') ?? config.directoryGid;
    config.dynafileDoNotSuspend = flag('dynafile.donotsuspend') ?? config.dynafileDoNotSuspend;
    config.permitPathEscape = flag('dynafile.dangerouspermitpathescape') ?? config.permitPathEscape;
    config.restrictTemplateType = flag('dynafile.restricttemplatetype') ?? config.restrictTemplateType;
    config.followSymlinks = flag('followsymlinks') ?? config.followSymlinks;
    const driver = stringParam(values, 'compression.driver');
    if (driver !== undefined) {
      const lowered = driver.toLowerCase();
      if (lowered.startsWith('zlib')) config.compressionDriver = 'zlib';
      else if (lowered.startsWith('zstd')) config.compressionDriver = 'zstd';
      else context.runtime.error("omfile: error: invalid compression.driver driver name - noch applying setting. Valid drivers: 'zlib' and 'zstd'.", RS_RET.CONF_PARSE_ERROR);
    }
    for (const entry of params.entries) entry.used = true;
    return true;
  },
  reset(context) {
    const legacy = legacyState(context);
    Object.assign(legacy, defaultLegacyState());
  },
};
