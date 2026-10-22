import {
  ERRNO_TEXT, posixDirname, readConfigLines, splitNameValue, type AuditMessage, type AuditdConfigFs, type NameValue,
} from '../AuditdConfig';

export type PluginType = 'ALWAYS';
export type PluginFormat = 'binary' | 'string';

export interface PluginConfig {
  active: boolean;
  direction: 'out' | null;
  path: string | null;
  type: PluginType;
  args: string[];
  format: PluginFormat;
  inode: number;
  name: string;
}

export interface PluginConfigLoad {
  readonly rc: 0 | 1;
  readonly config: PluginConfig;
  readonly messages: readonly AuditMessage[];
}

const OBSOLETE_BUILTIN_PATH = '/sbin/audisp-af_unix';
const S_IWOTH = 0o002;
const OWNER_AND_GROUP_EXEC = 0o770 & ~0o020;

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function clearPluginConfig(): PluginConfig {
  return { active: false, direction: null, path: null, type: 'ALWAYS', args: [], format: 'string', inode: 0, name: '' };
}

type Keyword = (nv: Required<NameValue>, line: number, config: PluginConfig, messages: AuditMessage[]) => number;

const KEYWORDS: Readonly<Record<string, { parse: Keyword; maxOptions: number }>> = {
  active: {
    parse: (nv, line, config, messages) => {
      const value = nv.value.toLowerCase();
      if (value !== 'yes' && value !== 'no') {
        messages.push({ priority: 'ERR', text: `Option ${nv.value} not found - line ${line}` });
        return 1;
      }
      config.active = value === 'yes';
      return 0;
    },
    maxOptions: 0,
  },
  direction: {
    parse: (nv, line, config, messages) => {
      if (nv.value.toLowerCase() !== 'out') {
        messages.push({ priority: 'ERR', text: `Option ${nv.value} not found - line ${line}` });
        return 1;
      }
      config.direction = 'out';
      return 0;
    },
    maxOptions: 0,
  },
  path: {
    parse: (nv, line, config, messages) => {
      if (nv.value.toLowerCase().startsWith('builtin_')) {
        messages.push({ priority: 'WARNING', text: `Option ${nv.value} line ${line} is obsolete - using ${OBSOLETE_BUILTIN_PATH}` });
        config.path = OBSOLETE_BUILTIN_PATH;
        return 0;
      }
      const dir = posixDirname(nv.value);
      if (dir.length < 4) {
        messages.push({ priority: 'ERR', text: `The directory name: ${dir} is too short - line ${line}` });
        return 1;
      }
      config.path = nv.value;
      return 0;
    },
    maxOptions: 0,
  },
  type: {
    parse: (nv, line, config, messages) => {
      const value = nv.value.toLowerCase();
      if (value === 'builtin') {
        messages.push({ priority: 'WARNING', text: `Option ${nv.value} line ${line} is obsolete - update it` });
        config.type = 'ALWAYS';
        return 0;
      }
      if (value !== 'always') {
        messages.push({ priority: 'ERR', text: `Option ${nv.value} not found - line ${line}` });
        return 1;
      }
      config.type = 'ALWAYS';
      return 0;
    },
    maxOptions: 0,
  },
  args: {
    parse: (nv, _line, config) => {
      config.args = nv.option === null ? [nv.value] : [nv.value, nv.option];
      return 0;
    },
    maxOptions: 2,
  },
  format: {
    parse: (nv, line, config, messages) => {
      const value = nv.value.toLowerCase();
      if (value !== 'binary' && value !== 'string') {
        messages.push({ priority: 'ERR', text: `Option ${nv.value} not found - line ${line}` });
        return 1;
      }
      config.format = value;
      return 0;
    },
    maxOptions: 0,
  },
};

function sanityCheck(config: PluginConfig, file: string, fs: AuditdConfigFs, messages: AuditMessage[]): number {
  if (!config.active) return 0;
  if (config.path === null) {
    messages.push({ priority: 'ERR', text: `Error - plugin (${file}) is active but no path given` });
    return 1;
  }
  if (config.path.toLowerCase().startsWith('builtin_')) return 0;
  const stat = fs.stat(config.path, true);
  if (stat.ok === false) {
    messages.push({ priority: 'ERR', text: `Unable to stat ${config.path} (${ERRNO_TEXT[stat.errno]})` });
    return 1;
  }
  if (stat.info.kind !== 'file') {
    messages.push({ priority: 'ERR', text: `${config.path} is not a regular file` });
    return 1;
  }
  if (stat.info.uid !== 0) {
    messages.push({ priority: 'ERR', text: `${config.path} is not owned by root` });
    return 1;
  }
  if ((stat.info.mode & OWNER_AND_GROUP_EXEC) !== OWNER_AND_GROUP_EXEC) {
    messages.push({ priority: 'ERR', text: `${config.path} permissions should be 0750` });
    return 1;
  }
  config.inode = stat.info.ino ?? 0;
  return 0;
}

export function loadPluginConfig(fs: AuditdConfigFs, file: string): PluginConfigLoad {
  const config = clearPluginConfig();
  const messages: AuditMessage[] = [];
  const fail = (): PluginConfigLoad => ({ rc: 1, config, messages });

  const stat = fs.stat(file, true);
  if (stat.ok === false) {
    if (stat.errno !== 'ENOENT') {
      messages.push({ priority: 'ERR', text: `Error opening ${file} (${ERRNO_TEXT[stat.errno]})` });
      return fail();
    }
    messages.push({ priority: 'WARNING', text: `Config file ${file} doesn't exist, skipping` });
    return { rc: 0, config, messages };
  }
  if (stat.info.uid !== 0) {
    messages.push({ priority: 'ERR', text: `Error - ${file} isn't owned by root` });
    return fail();
  }
  if ((stat.info.mode & S_IWOTH) === S_IWOTH) {
    messages.push({ priority: 'ERR', text: `Error - ${file} is world writable` });
    return fail();
  }
  if (stat.info.kind !== 'file') {
    messages.push({ priority: 'ERR', text: `Error - ${file} is not a regular file` });
    return fail();
  }

  const lineNumber = { value: 1 };
  for (const buffer of readConfigLines(fs.readText(file) ?? '', file, messages, lineNumber)) {
    const { rc, nv } = splitNameValue(buffer);
    if (rc === 1) messages.push({ priority: 'ERR', text: `Wrong number of arguments for line ${lineNumber.value} in ${file}` });
    else if (rc === 2) messages.push({ priority: 'ERR', text: `Missing equal sign for line ${lineNumber.value} in ${file}` });
    if (nv.name === null) {
      lineNumber.value++;
      continue;
    }
    if (nv.value === null) return fail();
    const keyword = KEYWORDS[nv.name.toLowerCase()];
    if (keyword === undefined) {
      messages.push({ priority: 'ERR', text: `Unknown keyword "${nv.name}" in line ${lineNumber.value} of ${file}` });
      return fail();
    }
    if (keyword.maxOptions === 0 && nv.option !== null) {
      messages.push({ priority: 'ERR', text: `Keyword "${nv.name}" has invalid option "${nv.option}" in line ${lineNumber.value} of ${file}` });
      return fail();
    }
    if (keyword.parse(nv as Required<NameValue>, lineNumber.value, config, messages) !== 0) return fail();
    lineNumber.value++;
  }
  config.name = baseName(file);
  if (lineNumber.value > 1 && sanityCheck(config, file, fs, messages) !== 0) return fail();
  return { rc: 0, config, messages };
}
