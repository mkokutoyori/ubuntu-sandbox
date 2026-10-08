import { basenameOf, dirnameOf, FLAG, NO_GID, NO_MODE, NO_UID, strtol, type LogInfo } from './LogrotateConfig';
import { strptimeFields, type BrokenDownTime } from './CalendarTime';
import { MESS_DEBUG, MessageLog } from './LogrotateLog';
import { poptParseArgvString } from './PoptArgv';
import { isFailure, STRERROR, type Errno, type FileStat, type LogrotateSystem } from './LogrotateSystem';

const DAY_SECONDS = 86400;
const SECONDS_IN_YEAR = 31556926;
const HASH_SIZE_MIN = 64;
const HASH_SIZE_MAX = 8192;
const HASH_CONST = 13;

interface LogState {
  fn: string;
  lastRotated: BrokenDownTime;
  sb: FileStat;
  doRotate: boolean;
  isUsed: boolean;
}

interface LogNames {
  firstRotated: string | null;
  disposeName: string | null;
  finalName: string | null;
  dirName: string | null;
  baseName: string | null;
}

const EMPTY_STAT: FileStat = { type: 'file', mode: 0, uid: 0, gid: 0, size: 0, nlink: 1, mtimeSec: 0, atimeSec: 0, dev: 0 };

export interface EngineOptions {
  debug: boolean;
  mailCommand: string;
}

export class LogrotateEngine {
  private states: LogState[][] = [];
  private hashSize = 0;
  private nowSecs = 0;
  private savedEuid = 0;
  private savedEgid = 0;
  private lastErrno: Errno | null = null;

  constructor(
    private readonly system: LogrotateSystem,
    private readonly log: MessageLog,
    private readonly options: EngineOptions,
  ) {}

  private get debug(): boolean { return this.options.debug; }

  setNow(seconds: number): void { this.nowSecs = seconds; }

  private now(): BrokenDownTime { return this.system.calendar.localtime(this.nowSecs); }

  private hashIndex(name: string): number {
    if (this.hashSize === 0) return -1;
    let hash = 0;
    for (const byte of Buffer.from(name, 'utf8')) hash = (Math.imul(hash, HASH_CONST) + byte) >>> 0;
    return hash % this.hashSize;
  }

  private allocateHash(size: number): void {
    let effective = size;
    if (effective < HASH_SIZE_MIN) effective = HASH_SIZE_MIN;
    if (effective > HASH_SIZE_MAX) effective = HASH_SIZE_MAX;
    this.log.debug(`Allocating hash table for state file, size ${effective} entries\n`);
    this.states = Array.from({ length: effective }, () => []);
    this.hashSize = effective;
  }

  private newState(name: string): LogState {
    this.log.debug('Creating new state\n');
    const current = this.now();
    const calendar = this.system.calendar;
    const lastRotated = calendar.normalise({
      year: current.year, month: current.month, day: current.day, hour: current.hour, minute: 0, second: 0,
    });
    return { fn: name, lastRotated, sb: EMPTY_STAT, doRotate: false, isUsed: false };
  }

  private findState(name: string): LogState | null {
    const index = this.hashIndex(name);
    if (index < 0) return null;
    const bucket = this.states[index];
    let found = bucket.find((entry) => entry.fn === name);
    if (found === undefined) {
      found = this.newState(name);
      bucket.unshift(found);
    }
    return found;
  }

  switchUser(user: number, group: number): boolean {
    this.savedEgid = this.system.getegid();
    this.savedEuid = this.system.geteuid();
    if (this.savedEuid === user && this.savedEgid === group) return true;
    this.log.debug(`switching euid from ${this.savedEuid} to ${user} and egid from ${this.savedEgid} to ${group} (pid ${this.system.pid()})\n`);
    return this.system.switchEffective(user, group);
  }

  switchUserBack(): boolean {
    return this.switchUser(this.savedEuid, this.savedEgid);
  }

  private runScript(info: LogInfo, logfn: string, logrotfn: string | null, script: string): number {
    if (this.debug) {
      this.log.debug(`running script with args ${logfn} ${logrotfn ?? ''}: "${script}"\n`);
      return 0;
    }
    const run = this.system.runScript(script, logrotfn === null ? [logfn] : [logfn, logrotfn]);
    this.log.write(run.output);
    return run.status;
  }

  private openLogfile(path: string, info: LogInfo): Errno | null {
    const stat = this.system.lstat(path);
    if (isFailure(stat)) return stat.errno;
    if (stat.type === 'symlink') return 'ELOOP';
    if (stat.type !== 'file') return 'ENOTSUP';
    if (stat.nlink !== 1 && (info.flags & FLAG.ALLOWHARDLINK) === 0) return 'ENOTSUP';
    return null;
  }

  private createOutputFile(fileName: string, sb: Pick<FileStat, 'mode' | 'uid' | 'gid'>): boolean {
    const mode = 0o600 & sb.mode;
    let created: Errno | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      created = this.system.createExclusive(fileName, mode, this.system.geteuid(), this.system.geteuid() === 0 ? 0 : 0);
      if (created !== 'EEXIST') break;
      const current = this.now();
      const backup = `${fileName}${this.system.calendar.strftime('-%Y%m%d%H', current)}.backup`;
      this.log.error(`destination ${fileName} already exists, renaming to ${backup}\n`);
      const failure = this.system.rename(fileName, backup);
      if (failure !== null) {
        this.log.error(`error renaming already existing output file ${fileName} to ${backup}: ${STRERROR[failure]}\n`);
        return false;
      }
    }
    if (created !== null) {
      this.log.error(`error creating output file ${fileName}: ${STRERROR[created]}\n`);
      return false;
    }
    if (this.system.chmod(fileName, mode) !== null) return false;
    if (this.system.geteuid() === 0) {
      const stat = this.system.stat(fileName);
      if (!isFailure(stat) && (stat.uid !== sb.uid || stat.gid !== sb.gid)) {
        const failure = this.system.chown(fileName, sb.uid, sb.gid);
        if (failure !== null) {
          this.log.error(`error setting owner of ${fileName} to uid ${sb.uid} and gid ${sb.gid}: ${STRERROR[failure]}\n`);
          return false;
        }
      }
    }
    const failure = this.system.chmod(fileName, sb.mode);
    if (failure !== null) {
      this.log.error(`error setting mode of ${fileName}: ${STRERROR[failure]}\n`);
      return false;
    }
    return true;
  }

  private shredFile(filename: string, info: LogInfo): boolean {
    if (info.preremove !== null) {
      this.log.debug('running preremove script\n');
      if (this.runScript(info, filename, null, info.preremove) !== 0) {
        this.log.error(`error running preremove script for ${filename} of '${info.pattern}'. Not removing this file.\n`);
        return true;
      }
    }
    if ((info.flags & FLAG.SHRED) !== 0) {
      if ((info.flags & FLAG.ALLOWHARDLINK) === 0) {
        const stat = this.system.stat(filename);
        if (isFailure(stat)) {
          this.log.error(`cannot stat ${filename}: ${STRERROR[stat.errno]}\n`);
          return true;
        }
        if (stat.nlink !== 1) {
          this.log.error(`failed to shred "${filename}", because shredding files with multiple hard links is disabled for ${info.pattern}.\n`);
          return true;
        }
      }
      this.log.debug(`Using shred to remove the file ${filename}\n`);
      if (!this.system.shred(filename, info.shredCycles)) {
        this.log.error(`Failed to shred ${filename}, trying unlink\n`);
        return this.system.unlink(filename) !== null;
      }
    }
    const failure = this.system.unlink(filename);
    if (failure === null) return false;
    if (failure !== 'ENOENT') return true;
    this.log.error(`error unlinking log file ${filename}: ${STRERROR[failure]}\n`);
    return false;
  }

  private removeLogFile(name: string, info: LogInfo): boolean {
    this.log.debug(`removing old log ${name}\n`);
    if ((info.flags & FLAG.SHRED) !== 0) {
      const failure = this.openLogfile(name, info);
      if (failure !== null) {
        this.log.error(`error opening ${name}: ${this.strerror(failure)}\n`);
        return true;
      }
    }
    if (!this.debug && this.shredFile(name, info)) {
      this.log.error(`Failed to remove old log ${name}: ${this.errnoText()}\n`);
      return true;
    }
    return false;
  }

  private strerror(errno: Errno): string {
    return STRERROR[errno];
  }

  private errnoText(): string {
    return this.lastErrno === null ? 'Success' : STRERROR[this.lastErrno];
  }

  private compressLogFile(name: string, info: LogInfo, sb: FileStat): boolean {
    this.log.debug(`compressing log with: ${info.compressProg}\n`);
    if (this.debug) return false;
    const failure = this.openLogfile(name, info);
    if (failure !== null) {
      this.log.error(`unable to open ${name} (${(info.flags & FLAG.SHRED) !== 0 ? 'read-write' : 'read-only'}) for compression: ${this.strerror(failure)}\n`);
      return true;
    }
    this.lastErrno = 'ENODATA';
    const compressedName = `${name}${info.compressExt}`;
    if (!this.createOutputFile(compressedName, sb)) return true;
    const outcome = this.system.compress({
      program: info.compressProg as string,
      options: info.compressOptions,
      inputPath: name,
      outputPath: compressedName,
      environmentFileName: name,
    });
    if (outcome.stderr !== '') {
      this.log.error(`Compressing program wrote following message to stderr when compressing log ${name}:\n`);
      this.log.write(outcome.stderr);
    }
    if (!outcome.exited || outcome.status !== 0) {
      this.log.error(`failed to compress log ${name}\n`);
      this.system.unlink(compressedName);
      return true;
    }
    this.system.setTimes(compressedName, sb.atimeSec, sb.mtimeSec);
    return this.shredFile(name, info);
  }

  private mailLog(info: LogInfo, logFile: string, mailCommand: string, uncompress: string | null, address: string, subject: string): boolean {
    const failure = this.openLogfile(logFile, info);
    if (failure !== null) {
      this.log.error(`failed to open ${logFile} for mailing: ${this.strerror(failure)}\n`);
      return true;
    }
    let body = this.system.readText(logFile);
    if (isFailure(body)) return true;
    if (uncompress !== null) {
      const decoded = this.system.uncompressForMail(logFile, uncompress);
      if (decoded === null) {
        this.log.error(`uncompress command failed mailing ${logFile}\n`);
        return true;
      }
      body = decoded;
    }
    const sent = this.system.mail(mailCommand, subject, address, body);
    this.log.write(sent.output);
    if (sent.status !== 0) {
      this.log.error(`mail command failed for ${logFile}\n`);
      return true;
    }
    return false;
  }

  private mailLogWrapper(mailFilename: string, mailCommand: string, logNum: number, info: LogInfo): boolean {
    let uncompress = (info.flags & FLAG.COMPRESS) !== 0 ? info.uncompressProg : null;
    let subject = mailFilename;
    if ((info.flags & FLAG.MAILFIRST) !== 0) {
      if ((info.flags & FLAG.DELAYCOMPRESS) !== 0) uncompress = null;
      if (uncompress !== null) subject = info.files[logNum];
    }
    return this.mailLog(info, mailFilename, mailCommand, uncompress, info.logAddress as string, subject);
  }

  private copyTruncate(currLog: string, saveLog: string, sb: FileStat, info: LogInfo, skipCopy: boolean): boolean {
    const log = this.log;
    log.debug(`copying ${currLog} to ${saveLog}\n`);
    if (!this.debug) {
      const failure = this.openLogfile(currLog, info);
      if (failure !== null) {
        log.error(`error opening ${currLog}: ${this.strerror(failure)}\n`);
        return true;
      }
      if (!skipCopy) {
        this.lastErrno = 'ENODATA';
        if (!this.createOutputFile(saveLog, sb)) return true;
        const content = this.system.readText(currLog);
        const written = isFailure(content) ? content.errno : this.system.writeText(saveLog, content);
        if (written !== null) {
          log.error(`error copying ${currLog} to ${saveLog}: ${typeof written === 'string' ? STRERROR[written as Errno] : ''}\n`);
          this.system.unlink(saveLog);
          return true;
        }
      }
    }
    if ((info.flags & FLAG.COPYTRUNCATE) !== 0) {
      log.debug(`truncating ${currLog}\n`);
      if (!this.debug) {
        const failure = this.system.truncate(currLog);
        if (failure !== null) {
          log.error(`error truncating ${currLog}: ${STRERROR[failure]}\n`);
          return true;
        }
      }
    } else {
      log.debug(`Not truncating ${currLog}\n`);
    }
    return false;
  }

  private daysElapsed(now: BrokenDownTime, last: BrokenDownTime): number {
    const calendar = this.system.calendar;
    const a = calendar.mktime({ ...now, hour: 0, minute: 0, second: 0 });
    const b = calendar.mktime({ ...last, hour: 0, minute: 0, second: 0 });
    return Math.trunc((a - b) / (24 * 3600));
  }

  private fmt(time: BrokenDownTime): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${time.year}-${pad(time.month + 1)}-${pad(time.day)} ${pad(time.hour)}:${pad(time.minute)}`;
  }

  private findNeedRotating(info: LogInfo, logNum: number, force: boolean): boolean {
    const log = this.log;
    const file = info.files[logNum];
    log.debug(`considering log ${file}\n`);
    const now = this.now();
    const calendar = this.system.calendar;

    if ((info.flags & FLAG.SU) === 0 && this.system.getuid() === 0) {
      const directory = dirnameOf(file);
      const stat = this.system.stat(directory);
      if (isFailure(stat)) {
        if (stat.errno !== 'ENOENT' || (info.flags & FLAG.MISSINGOK) === 0) {
          log.error(`stat of ${directory} failed: ${STRERROR[stat.errno]}\n`);
          return true;
        }
        return false;
      }
      if ((stat.gid !== 0 && (stat.mode & 0o020) !== 0) || (stat.mode & 0o002) !== 0) {
        log.error(`skipping "${file}" because parent directory has insecure permissions (It's world writable or writable by group which is not "root") Set "su" directive in config file to tell logrotate which user/group should be used for rotation.\n`);
        return true;
      }
    }

    const sb = this.system.lstat(file);
    if (isFailure(sb)) {
      if ((info.flags & FLAG.MISSINGOK) !== 0 && sb.errno === 'ENOENT') {
        log.debug(`  log ${file} does not exist -- skipping\n`);
        return false;
      }
      log.error(`stat of ${file} failed: ${STRERROR[sb.errno]}\n`);
      return true;
    }

    const state = this.findState(file);
    if (state === null) return true;
    state.doRotate = false;
    state.sb = sb;
    state.isUsed = true;

    if (sb.type === 'symlink') {
      log.debug(`  log ${file} is symbolic link. Rotation of symbolic links is not allowed to avoid security issues -- skipping.\n`);
      return false;
    }
    if ((info.flags & FLAG.ALLOWHARDLINK) === 0 && sb.nlink !== 1) {
      log.debug(`  log ${file} has multiple (${sb.nlink}) hard links. Rotation of files with multiple hard links is not allowed for ${info.pattern} -- skipping.\n`);
      return false;
    }

    log.debug(`  Now: ${this.fmt(now)}\n`);
    log.debug(`  Last rotated at ${this.fmt(state.lastRotated)}\n`);

    const last = state.lastRotated;
    if (force) {
      state.doRotate = true;
    } else if (info.maxsize !== 0 && sb.size > info.maxsize) {
      state.doRotate = true;
    } else if (info.criterium === 'size') {
      state.doRotate = sb.size >= info.threshold;
      if (!state.doRotate) log.debug("  log does not need rotating (log size is below the 'size' threshold)\n");
    } else if (calendar.mktime(last) - calendar.mktime(now) > 25 * 3600) {
      log.error(`log ${file} last rotated in the future -- rotation forced\n`);
      state.doRotate = true;
    } else if (last.year !== now.year || last.month !== now.month || last.day !== now.day || last.hour !== now.hour) {
      const rotatedAt = this.fmt(last);
      switch (info.criterium) {
        case 'weekly': {
          const days = this.daysElapsed(now, last);
          state.doRotate = days >= 7 || (days >= 1 && now.weekday === info.weekday);
          if (!state.doRotate) {
            log.debug(`  log does not need rotating (log has been rotated at ${rotatedAt}, which is less than a week ago)\n`);
          }
          break;
        }
        case 'hourly':
          state.doRotate = now.hour !== last.hour || now.day !== last.day || now.month !== last.month || now.year !== last.year;
          if (!state.doRotate) log.debug(`  log does not need rotating (log has been rotated at ${rotatedAt}, which is less than an hour ago)\n`);
          break;
        case 'days':
          state.doRotate = now.day !== last.day || now.month !== last.month || now.year !== last.year;
          if (!state.doRotate) log.debug(`  log does not need rotating (log has been rotated at ${rotatedAt}, which is less than a day ago)\n`);
          break;
        case 'monthly':
          state.doRotate = now.month !== last.month || now.year !== last.year;
          if (!state.doRotate) log.debug(`  log does not need rotating (log has been rotated at ${rotatedAt}, which is less than a month ago)\n`);
          break;
        case 'yearly':
          state.doRotate = now.year !== last.year;
          if (!state.doRotate) log.debug(`  log does not need rotating (log has been rotated at ${rotatedAt}, which is less than a year ago)\n`);
          break;
        default:
          state.doRotate = false;
          break;
      }
      if (info.minsize !== 0 && sb.size < info.minsize) {
        state.doRotate = false;
        log.debug("  log does not need rotating ('minsize' directive is used and the log size is smaller than the minsize value)\n");
      }
      if (info.rotateMinAge !== 0 && info.rotateMinAge * DAY_SECONDS >= this.nowSecs - sb.mtimeSec) {
        state.doRotate = false;
        log.debug("  log does not need rotating ('minage' directive is used and the log age is smaller than the minage days)\n");
      }
    } else if (!state.doRotate) {
      log.debug('  log does not need rotating (log has already been rotated)\n');
    }

    if (state.doRotate && (info.flags & FLAG.IFEMPTY) === 0 && sb.size === 0) {
      state.doRotate = false;
      log.debug('  log does not need rotating (log is empty)\n');
    }
    if (state.doRotate) log.debug('  log needs rotating\n');
    return false;
  }

  private findLastRotated(names: LogNames, fileext: string, compext: string): number {
    const matches = this.system.glob(`${names.dirName}/${names.baseName}.*${fileext}${compext}`, false);
    const prefixLength = (names.dirName as string).length + 1 + (names.baseName as string).length + 1;
    const suffixLength = fileext.length + compext.length;
    let last = 0;
    for (const match of matches) {
      if (match.length <= prefixLength + suffixLength) continue;
      const index = match.slice(prefixLength, match.length - suffixLength);
      const parsed = /^\s*([+-]?\d+)(.?)/s.exec(index);
      if (parsed === null || parsed[2] !== '') continue;
      const number = Number(parsed[1]);
      if (last < number) last = number;
    }
    return last;
  }

  private sortByDate(paths: string[], prefixLength: number, dformat: string): string[] {
    if (dformat === '') return paths;
    const calendar = this.system.calendar;
    const keyOf = (path: string): number => {
      const fields = strptimeFields(path.slice(prefixLength), dformat) ?? {};
      return calendar.mktime({
        year: fields.year ?? 1900, month: fields.month ?? 0, day: fields.day ?? 0,
        hour: fields.hour ?? 0, minute: fields.minute ?? 0, second: fields.second ?? 0,
      });
    };
    return paths.map((path, index) => ({ path, index, key: keyOf(path) }))
      .sort((a, b) => a.key - b.key || a.index - b.index).map((entry) => entry.path);
  }

  private prerotateSingleLog(info: LogInfo, logNum: number, state: LogState, names: LogNames): boolean {
    const log = this.log;
    let compext = '';
    let fileext = '';
    let hasErrors = false;
    const rotateCount0 = info.rotateCount !== 0 ? info.rotateCount : 1;
    let rotateCount = rotateCount0;
    const logStart = info.logStart === -1 ? 1 : info.logStart;
    let dformat = '';
    let dextPattern = '';
    let dextStr = '';
    const file = info.files[logNum];

    if (!state.doRotate) return false;
    log.debug(`rotating log ${file}, log->rotateCount is ${info.rotateCount}\n`);
    if ((info.flags & FLAG.COMPRESS) !== 0) {
      if (info.compressExt === null) {
        log.error(`log ${file}: compression enabled, but compression extension is not set\n`);
        return true;
      }
      compext = info.compressExt;
    }

    let now = this.now();
    state.lastRotated = now;
    const logDir = dirnameOf(file);
    if (info.oldDir !== null) names.dirName = info.oldDir[0] !== '/' ? `${logDir}/${info.oldDir}` : info.oldDir;
    else names.dirName = logDir;
    names.baseName = basenameOf(file);

    if (info.addextension !== null) {
      const base = names.baseName;
      if (base.length >= info.addextension.length && base.endsWith(info.addextension)) {
        names.baseName = base.slice(0, base.length - info.addextension.length);
      }
      fileext = info.addextension;
    }
    if (info.extension !== null) {
      const base = names.baseName;
      if (base.length >= info.extension.length && base.endsWith(info.extension)) {
        fileext = info.extension;
        names.baseName = base.slice(0, base.length - info.extension.length);
      }
    }

    const calendar = this.system.calendar;
    if ((info.flags & FLAG.DATEYESTERDAY) !== 0) {
      now = calendar.normalise({ ...now, hour: 12, day: now.day - 1 });
    }
    if ((info.flags & FLAG.DATEHOURAGO) !== 0) {
      now = calendar.normalise({ ...now, hour: now.hour - 1 });
    }

    if (info.dateformat !== null) {
      let index = 0;
      let dext = info.dateformat.replace(/^ +/, '');
      const lengthLimit = 128;
      let patternOut = '';
      let formatOut = '';
      while (index < dext.length && !hasErrors) {
        if (patternOut.length >= lengthLimit - 1) {
          log.error(`Date format ${info.dateformat} is too long\n`);
          hasErrors = true;
          break;
        }
        const char = dext[index];
        if (char === '%') {
          const spec = dext[index + 1];
          if (spec === 'Y' || spec === 'm' || spec === 'd' || spec === 'H' || spec === 'M' || spec === 'S' || spec === 'V') {
            patternOut += spec === 'Y' ? '[0-9][0-9][0-9][0-9]' : '[0-9][0-9]';
            if (patternOut.length >= lengthLimit - 1) {
              log.error(`Date format ${info.dateformat} is too long\n`);
              hasErrors = true;
              break;
            }
            formatOut += `%${spec}`;
            index += 2;
            continue;
          }
          if (spec === 's') {
            patternOut += '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';
            if (patternOut.length >= lengthLimit - 1) {
              log.error(`Date format ${info.dateformat} is too long\n`);
              hasErrors = true;
              break;
            }
            formatOut += '%s';
            index += 2;
            continue;
          }
          formatOut += `%${spec ?? ''}`;
          patternOut += `%${spec ?? ''}`;
          index += 2;
          continue;
        }
        formatOut += char;
        patternOut += char;
        index++;
      }
      dformat = formatOut;
      dextPattern = patternOut;
      dext = '';
      log.debug(`Converted '${info.dateformat}' -> '${dformat}'\n`);
      dextStr = calendar.strftime(dformat, now);
    } else if (info.criterium === 'hourly') {
      dextStr = calendar.strftime('-%Y%m%d%H', now);
      dextPattern = '-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';
    } else {
      dextStr = calendar.strftime('-%Y%m%d', now);
      dextPattern = '-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';
    }
    log.debug(`dateext suffix '${dextStr}'\n`);
    log.debug(`glob pattern '${dextPattern}'\n`);

    const dirName = names.dirName;
    const baseName = names.baseName;
    if ((info.flags & FLAG.COMPRESS) !== 0 && (info.flags & FLAG.DELAYCOMPRESS) !== 0) {
      if ((info.flags & FLAG.DATEEXT) !== 0) {
        const matches = this.system.glob(`${dirName}/${baseName}${dextPattern}${fileext}`, false);
        if (matches.length > 0) {
          const ordered = this.sortByDate(matches, dirName.length + 1 + baseName.length, dformat);
          for (const oldName of ordered) {
            if (hasErrors) break;
            const stat = this.system.stat(oldName);
            if (isFailure(stat)) {
              if (stat.errno === 'ENOENT') log.debug(`previous log ${oldName} does not exist\n`);
              else log.error(`cannot stat ${oldName}: ${STRERROR[stat.errno]}\n`);
            } else {
              hasErrors = this.compressLogFile(oldName, info, stat);
            }
          }
        } else {
          log.debug('glob finding logs to compress failed\n');
        }
      } else {
        const oldName = `${dirName}/${baseName}.${logStart}${fileext}`;
        const stat = this.system.stat(oldName);
        if (isFailure(stat)) {
          if (stat.errno === 'ENOENT') log.debug(`previous log ${oldName} does not exist\n`);
          else log.error(`cannot stat ${oldName}: ${STRERROR[stat.errno]}\n`);
        } else {
          hasErrors = this.compressLogFile(oldName, info, stat);
        }
      }
    }

    if ((info.flags & FLAG.DATEEXT) !== 0) {
      const matches = this.system.glob(`${dirName}/${baseName}${dextPattern}${fileext}${compext}`, false);
      if (matches.length > 0) {
        let mailOut = -1;
        const ordered = this.sortByDate(matches, dirName.length + 1 + baseName.length, dformat);
        for (let index = 0; index < ordered.length; index++) {
          const stat = this.system.stat(ordered[index]);
          if (isFailure(stat)) continue;
          const beyondCount = ordered.length >= rotateCount && index <= ordered.length - rotateCount;
          const tooOld = info.rotateAge > 0 && (this.nowSecs - stat.mtimeSec) / DAY_SECONDS > info.rotateAge;
          if (beyondCount || tooOld) {
            if (mailOut !== -1) {
              const mailFilename = ordered[mailOut];
              if (!hasErrors && info.logAddress !== null) hasErrors = this.mailLogWrapper(mailFilename, this.options.mailCommand, logNum, info);
              if (!hasErrors) {
                log.debug(`removing ${mailFilename}\n`);
                hasErrors = this.removeLogFile(mailFilename, info);
              }
            }
            mailOut = index;
          }
        }
        names.disposeName = mailOut !== -1 ? ordered[mailOut] : null;
      } else {
        log.debug('glob finding old rotated logs failed\n');
        names.disposeName = null;
      }
      names.firstRotated = `${dirName}/${baseName}${dextStr}${fileext}${(info.flags & FLAG.DELAYCOMPRESS) !== 0 ? '' : compext}`;
    } else {
      if (rotateCount === -1) {
        rotateCount = this.findLastRotated(names, fileext, compext);
      }
      let oldName = `${dirName}/${baseName}.${logStart + rotateCount}${fileext}${compext}`;
      if (info.rotateCount !== -1) names.disposeName = oldName;
      names.firstRotated = `${dirName}/${baseName}.${logStart}${fileext}${(info.flags & FLAG.DELAYCOMPRESS) !== 0 ? '' : compext}`;
      let newName: string | null = null;
      for (let i = rotateCount + logStart - 1; i >= 0 && !hasErrors; i--) {
        newName = oldName;
        oldName = `${dirName}/${baseName}.${i}${fileext}${compext}`;
        if (info.rotateAge !== 0) {
          const stat = this.system.stat(oldName);
          if (isFailure(stat)) {
            if (stat.errno === 'ENOENT') log.debug(`old log ${oldName} does not exist\n`);
            else {
              log.error(`cannot stat ${oldName}: ${STRERROR[stat.errno]}\n`);
              hasErrors = true;
            }
            continue;
          }
          if ((this.nowSecs - stat.mtimeSec) / DAY_SECONDS > info.rotateAge) {
            if (!hasErrors && info.logAddress !== null) hasErrors = this.mailLogWrapper(oldName, this.options.mailCommand, logNum, info);
            if (!hasErrors) hasErrors = this.removeLogFile(oldName, info);
            continue;
          }
        }
        log.debug(`renaming ${oldName} to ${newName} (rotatecount ${rotateCount}, logstart ${logStart}, i ${i}), \n`);
        if (!this.debug) {
          const failure = this.system.rename(oldName, newName);
          if (failure !== null) {
            if (failure === 'ENOENT') log.debug(`old log ${oldName} does not exist\n`);
            else {
              log.error(`error renaming ${oldName} to ${newName}: ${STRERROR[failure]}\n`);
              hasErrors = true;
            }
          }
        }
      }
    }

    if ((info.flags & FLAG.DATEEXT) !== 0) {
      names.finalName = `${dirName}/${baseName}${dextStr}${fileext}`;
      if (!isFailure(this.system.stat(`${names.finalName}${compext}`))) {
        log.error(`destination ${names.firstRotated} already exists, skipping rotation\n`);
        hasErrors = true;
      }
    } else {
      names.finalName = `${dirName}/${baseName}.${logStart}${fileext}`;
    }

    if (names.disposeName !== null && isFailure(this.system.stat(names.disposeName)) && isFailure(this.system.lstat(names.disposeName))) {
      log.debug(`log ${names.disposeName} doesn't exist -- won't try to dispose of it\n`);
      names.disposeName = null;
    }
    return hasErrors;
  }

  private rotateSingleLog(info: LogInfo, logNum: number, state: LogState, names: LogNames): boolean {
    const log = this.log;
    const file = info.files[logNum];
    let hasErrors = false;
    if (!state.doRotate) return false;

    const copyMode = (info.flags & (FLAG.COPYTRUNCATE | FLAG.COPY)) !== 0;
    if (!copyMode) {
      this.lastErrno = 'ENODATA';
      if ((info.flags & FLAG.TMPFILENAME) !== 0) {
        const tmp = `${file}.tmp`;
        log.debug(`renaming ${file} to ${tmp}\n`);
        if (!this.debug && !hasErrors) {
          const failure = this.system.rename(file, tmp);
          if (failure !== null) {
            log.error(`failed to rename ${file} to ${tmp}: ${STRERROR[failure]}\n`);
            hasErrors = true;
          }
        }
      } else {
        log.debug(`renaming ${file} to ${names.finalName}\n`);
        if (!this.debug && !hasErrors) {
          const failure = this.system.rename(file, names.finalName as string);
          if (failure !== null) {
            log.error(`failed to rename ${file} to ${names.finalName}: ${STRERROR[failure]}\n`);
            hasErrors = true;
          }
        }
      }
      if (info.rotateCount === 0) {
        const extension = info.compressExt !== null && (info.flags & FLAG.COMPRESS) !== 0 && (info.flags & FLAG.DELAYCOMPRESS) === 0
          ? info.compressExt : '';
        names.disposeName = `${names.finalName}${extension}`;
        log.debug(`disposeName will be ${names.disposeName}\n`);
      }
    }

    if (!hasErrors && (info.flags & FLAG.CREATE) !== 0 && !copyMode) {
      const target = {
        uid: info.createUid === NO_UID ? state.sb.uid : info.createUid,
        gid: info.createGid === NO_GID ? state.sb.gid : info.createGid,
        mode: info.createMode === NO_MODE ? state.sb.mode & 0o777 : info.createMode,
      };
      log.debug(`creating new ${file} mode = 0${target.mode.toString(8)} uid = ${target.uid} gid = ${target.gid}\n`);
      if (!this.debug && !this.createOutputFile(file, target)) hasErrors = true;
    }

    if (!hasErrors && copyMode && (info.flags & FLAG.TMPFILENAME) === 0) {
      hasErrors = this.copyTruncate(file, names.finalName as string, state.sb, info, info.rotateCount === 0);
    }
    return hasErrors;
  }

  private postrotateSingleLog(info: LogInfo, logNum: number, state: LogState, names: LogNames): boolean {
    let hasErrors = false;
    if (!state.doRotate) return false;
    const file = info.files[logNum];
    if ((info.flags & FLAG.TMPFILENAME) !== 0) {
      const tmp = `${file}.tmp`;
      hasErrors = this.copyTruncate(tmp, names.finalName as string, state.sb, info, false);
      this.log.debug(`removing tmp log ${tmp}\n`);
      if (!this.debug && !hasErrors) this.system.unlink(tmp);
    }
    if (!hasErrors && (info.flags & FLAG.COMPRESS) !== 0 && (info.flags & FLAG.DELAYCOMPRESS) === 0) {
      hasErrors = this.compressLogFile(names.finalName as string, info, state.sb);
    }
    if (!hasErrors && info.logAddress !== null) {
      const mailFilename = (info.flags & FLAG.MAILFIRST) !== 0 ? names.firstRotated : names.disposeName;
      if (mailFilename !== null) hasErrors = this.mailLogWrapper(mailFilename, this.options.mailCommand, logNum, info);
    }
    if (!hasErrors && names.disposeName !== null) hasErrors = this.removeLogFile(names.disposeName, info);
    return hasErrors;
  }

  rotateLogSet(info: LogInfo, force: boolean): boolean {
    const log = this.log;
    let hasErrors = false;
    let numRotated = 0;
    const shared = (info.flags & FLAG.SHAREDSCRIPTS) !== 0;

    let head = `\nrotating pattern: ${info.pattern} `;
    if (force) head += 'forced from command line ';
    else {
      switch (info.criterium) {
        case 'hourly': head += 'hourly '; break;
        case 'days': head += `after ${info.threshold} days `; break;
        case 'weekly': head += 'weekly '; break;
        case 'monthly': head += 'monthly '; break;
        case 'yearly': head += 'yearly '; break;
        default: head += `${info.threshold} bytes `; break;
      }
    }
    log.debug(head);
    if (info.rotateCount > 0) log.debug(`(${info.rotateCount} rotations)\n`);
    else if (info.rotateCount === 0) log.debug('(no old logs will be kept)\n');
    if (info.oldDir !== null) log.debug(`olddir is ${info.oldDir}, `);
    log.debug((info.flags & FLAG.IFEMPTY) !== 0 ? 'empty log files are rotated, ' : 'empty log files are not rotated, ');
    if (info.minsize !== 0) log.debug(`only log files >= ${info.minsize} bytes are rotated, `);
    if (info.maxsize !== 0) log.debug(`log files >= ${info.maxsize} are rotated earlier, `);
    if (info.rotateMinAge !== 0) log.debug(`only log files older than ${info.rotateMinAge} days are rotated, `);
    if (info.logAddress !== null) log.debug(`old logs mailed to ${info.logAddress}\n`);
    else log.debug('old logs are removed\n');

    if (info.files.length === 0) {
      log.debug('No logs found. Rotation not needed.\n');
      return false;
    }

    const logHasErrors: boolean[] = info.files.map(() => false);
    if ((info.flags & FLAG.SU) !== 0) {
      if (!this.switchUser(info.suUid, info.suGid)) return true;
    }

    for (let i = 0; i < info.files.length; i++) {
      logHasErrors[i] = this.findNeedRotating(info, i, force);
      hasErrors ||= logHasErrors[i];
      const state = this.findState(info.files[i]);
      if (state !== null && state.doRotate) numRotated++;
    }

    if (info.first !== null) {
      if (numRotated === 0) {
        log.debug('not running first action script, since no logs will be rotated\n');
      } else {
        log.debug('running first action script\n');
        if (this.runScript(info, info.pattern as string, null, info.first) !== 0) {
          log.error(`error running first action script for ${info.pattern}\n`);
          if ((info.flags & FLAG.SU) !== 0) this.switchUserBack();
          return true;
        }
      }
    }

    const states: Array<LogState | null> = info.files.map(() => null);
    const names: LogNames[] = info.files.map(() => ({ firstRotated: null, disposeName: null, finalName: null, dirName: null, baseName: null }));
    const outer = shared ? 1 : info.files.length;
    for (let j = 0; j < outer; j++) {
      const range = shared ? info.files.map((_, index) => index) : [j];
      for (const i of range) {
        states[i] = this.findState(info.files[i]);
        if (states[i] === null) logHasErrors[i] = true;
        else logHasErrors[i] ||= this.prerotateSingleLog(info, i, states[i] as LogState, names[i]);
        hasErrors ||= logHasErrors[i];
      }

      const skipScript = (): boolean => (!shared && (logHasErrors[j] || !(states[j] as LogState).doRotate)) || (hasErrors && shared);
      if (info.pre !== null && !skipScript()) {
        if (numRotated === 0) {
          log.debug('not running prerotate script, since no logs will be rotated\n');
        } else {
          log.debug('running prerotate script\n');
          if (this.runScript(info, shared ? info.pattern as string : info.files[j], null, info.pre) !== 0) {
            if (shared) log.error(`error running shared prerotate script for '${info.pattern}'\n`);
            else log.error(`error running non-shared prerotate script for ${info.files[j]} of '${info.pattern}'\n`);
            logHasErrors[j] = true;
            hasErrors = true;
          }
        }
      }

      for (const i of range) {
        if (!((logHasErrors[i] && !shared) || (hasErrors && shared))) {
          logHasErrors[i] ||= this.rotateSingleLog(info, i, states[i] as LogState, names[i]);
          hasErrors ||= logHasErrors[i];
        }
      }

      if (info.post !== null && !skipScript()) {
        if (numRotated === 0) {
          log.debug('not running postrotate script, since no logs were rotated\n');
        } else {
          const logfn = shared ? info.pattern as string : info.files[j];
          const logrotfn = shared ? null : names[j].finalName;
          log.debug('running postrotate script\n');
          if (this.runScript(info, logfn, logrotfn, info.post) !== 0) {
            if (shared) log.error(`error running shared postrotate script for '${info.pattern}'\n`);
            else log.error(`error running non-shared postrotate script for ${info.files[j]} of '${info.pattern}'\n`);
            logHasErrors[j] = true;
            hasErrors = true;
          }
        }
      }

      for (const i of range) {
        if (!((logHasErrors[i] && !shared) || (hasErrors && shared))) {
          logHasErrors[i] ||= this.postrotateSingleLog(info, i, states[i] as LogState, names[i]);
          hasErrors ||= logHasErrors[i];
        }
      }
    }

    if (info.last !== null) {
      if (numRotated === 0) {
        log.debug('not running last action script, since no logs will be rotated\n');
      } else {
        log.debug('running last action script\n');
        if (this.runScript(info, info.pattern as string, null, info.last) !== 0) {
          log.error(`error running last action script for ${info.pattern}\n`);
          hasErrors = true;
        }
      }
    }

    if ((info.flags & FLAG.SU) !== 0) {
      if (!this.switchUserBack()) return true;
    }
    return hasErrors;
  }

  readState(stateFile: string): boolean {
    const log = this.log;
    log.debug(`Reading state from file: ${stateFile}\n`);
    let size = 0;
    let text: string | null = null;
    let rc = false;
    const stat = this.system.stat(stateFile);
    if (isFailure(stat)) {
      if (!this.debug) {
        log.error(`error opening state file ${stateFile}: ${STRERROR[stat.errno]}\n`);
        rc = true;
      } else if (stat.errno === 'ENOENT') {
        log.debug(`state file ${stateFile} does not exist\n`);
      } else {
        log.error(`error opening state file ${stateFile}; assuming empty state: ${STRERROR[stat.errno]}\n`);
      }
    } else {
      size = stat.size;
      const content = this.system.readText(stateFile);
      text = isFailure(content) ? null : content;
    }
    this.allocateHash(Math.floor(size / 80 / 200));
    if (rc || size === 0 || text === null) return rc;

    const lines = text.split('\n');
    const bytes = Buffer.byteLength(text);
    void bytes;
    const header = lines[0] === undefined ? '' : `${lines[0]}\n`;
    if (header !== 'logrotate state -- version 1\n' && header !== 'logrotate state -- version 2\n') {
      log.error(`bad top line in state file ${stateFile}\n`);
      return true;
    }
    let lineNumber = 1;
    const body = lines.slice(1);
    if (body.length > 0 && body[body.length - 1] === '') body.pop();
    else if (body.length > 0) {
      lineNumber++;
      log.error(`line ${lineNumber} too long in state file ${stateFile}\n`);
      return true;
    }
    for (const line of body) {
      lineNumber++;
      if (line === '') continue;
      const parsed = poptParseArgvString(line);
      const stamp = parsed.argv.length === 2 ? /^(-?\d+)-(-?\d+)-(-?\d+)(?:-(-?\d+):(-?\d+):(-?\d+))?/.exec(parsed.argv[1]) : null;
      if (!parsed.ok || parsed.argv.length !== 2 || stamp === null) {
        log.error(`bad line ${lineNumber} in state file ${stateFile}\n`);
        return true;
      }
      const [year, month, day, hour, minute, second] = [stamp[1], stamp[2], stamp[3], stamp[4] ?? '0', stamp[5] ?? '0', stamp[6] ?? '0'].map(Number);
      const name = parsed.argv[0];
      const checks: Array<[boolean, string, number]> = [
        [year !== 1900 && (year < 1970 || year > 2100), 'year', year],
        [month < 1 || month > 12, 'month', month],
        [day < 0 || day > 31, 'day', day],
        [hour < 0 || hour > 23, 'hour', hour],
        [minute < 0 || minute > 59, 'minute', minute],
        [second < 0 || second > 59, 'second', second],
      ];
      for (const [bad, label, value] of checks) {
        if (bad) {
          log.error(`bad ${label} ${value} for file ${name} in state file ${stateFile}\n`);
          return true;
        }
      }
      const filename = name.replace(/\\(n|\\)/g, (_, kind: string) => (kind === 'n' ? '\n' : '\\'));
      const state = this.findState(filename);
      if (state === null) return true;
      state.lastRotated = this.system.calendar.normalise({ year: year, month: month - 1, day, hour, minute, second });
    }
    return false;
  }

  lockState(stateFile: string, skipLock: boolean): boolean {
    const log = this.log;
    let stat = this.system.stat(stateFile);
    if (isFailure(stat)) {
      if (stat.errno === 'ENOENT') {
        log.debug(`Creating stub state file: ${stateFile}\n`);
        const failure = this.system.createExclusive(stateFile, 0o640, this.system.geteuid(), 0);
        if (failure !== null) {
          log.error(`error creating stub state file ${stateFile}: ${STRERROR[failure]}\n`);
          return true;
        }
        stat = this.system.stat(stateFile);
        if (isFailure(stat)) return true;
      } else {
        log.error(`error opening state file ${stateFile}: ${STRERROR[stat.errno]}\n`);
        return true;
      }
    }
    if (skipLock) {
      log.debug(`Skip locking state file ${stateFile}\n`);
      return false;
    }
    if ((stat.mode & 0o004) !== 0) {
      log.error(`state file ${stateFile} is world-readable and thus can be locked from other unprivileged users. Skipping lock acquisition...\n`);
      return false;
    }
    return false;
  }

  writeState(stateFile: string): boolean {
    const log = this.log;
    if (stateFile === '/dev/null') return false;
    const tmp = `${stateFile}.tmp`;
    const removal = this.system.unlink(tmp);
    if (removal !== null && removal !== 'ENOENT') {
      log.error(`error removing old temporary state file ${tmp}: ${STRERROR[removal]}\n`);
      return true;
    }
    const current = this.system.stat(stateFile);
    if (isFailure(current)) {
      log.error(`error opening state file ${stateFile}: ${STRERROR[current.errno]}\n`);
      return true;
    }
    this.lastErrno = 'ENODATA';
    const sb = { mode: current.mode & ~0o004, uid: current.uid, gid: current.gid };
    if (!this.createOutputFile(tmp, sb)) return true;
    const calendar = this.system.calendar;
    const nowTime = calendar.mktime(this.now());
    let out = 'logrotate state -- version 2\n';
    for (const bucket of this.states) {
      for (const entry of bucket) {
        const lastTime = calendar.mktime(entry.lastRotated);
        if (!entry.isUsed && nowTime - lastTime > SECONDS_IN_YEAR) {
          log.debug(`Removing ${entry.fn} from state file, because it does not exist and has not been rotated for one year\n`);
          continue;
        }
        const escaped = entry.fn.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n');
        const t = entry.lastRotated;
        out += `"${escaped}" ${t.year}-${t.month + 1}-${t.day}-${t.hour}:${t.minute}:${t.second}\n`;
      }
    }
    const written = this.system.writeText(tmp, out);
    if (written !== null) {
      log.error(`error creating temp state file ${tmp}: ${STRERROR[written]}\n`);
      this.system.unlink(tmp);
      return true;
    }
    const renamed = this.system.rename(tmp, stateFile);
    if (renamed !== null) {
      log.error(`error renaming temp state file ${tmp} to ${stateFile}: ${STRERROR[renamed]}\n`);
      this.system.unlink(tmp);
      return true;
    }
    return false;
  }
}

export { MESS_DEBUG, strtol };
