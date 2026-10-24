import type { ServiceRegistration } from '@/network/dnssd/types';
import {
  readSystemdConfig, wordsOf,
  type ConfigDiagnostic, type ConfigHandler, type ConfigSource, type ConfigSpec,
} from '../systemd/ConfigFiles';

export const DNSSD_DIRS = [
  '/etc/systemd/dnssd',
  '/run/systemd/dnssd',
  '/usr/lib/systemd/dnssd',
] as const;

export interface DnssdFile {
  path: string;
  basename: string;
  service: ServiceRegistration;
}

export interface DnssdSource extends ConfigSource {
  hostName(): string;
}

export interface DnssdReadout {
  files: DnssdFile[];
  diagnostics: ConfigDiagnostic[];
}

const LOG_ERR = 3;
const LOG_WARNING = 4;
const DNS_LABEL_MAX = 63;
const SERVICE_TYPE = /^_[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?\._(?:tcp|udp)$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

type TxtKind = 'text' | 'data';

interface Draft {
  nameTemplate: string | null;
  type: string | null;
  port: number;
  priority: number;
  weight: number;
  subtypes: string[];
  txt: string[][];
}

function emptyDraft(): Draft {
  return { nameTemplate: null, type: null, port: 0, priority: 0, weight: 0, subtypes: [], txt: [] };
}

function firstLine(source: ConfigSource, path: string, key: string): string | null {
  const text = source.readFile(path);
  const line = text?.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  return line === undefined ? null : line.slice(key.length + 1).replace(/^"(.*)"$/, '$1');
}

function specifierValue(source: DnssdSource, specifier: string): string | null | undefined {
  switch (specifier) {
    case '%': return '%';
    case 'H': return source.hostName();
    case 'a': return 'x86-64';
    case 'm': return source.readFile('/etc/machine-id')?.trim() ?? null;
    case 'b': return source.readFile('/proc/sys/kernel/random/boot_id')?.trim() ?? null;
    case 'v': return source.readFile('/proc/sys/kernel/osrelease')?.trim() ?? null;
    case 'o': return firstLine(source, '/etc/os-release', 'ID');
    case 'w': return firstLine(source, '/etc/os-release', 'VERSION_ID');
    case 'B': return firstLine(source, '/etc/os-release', 'BUILD_ID');
    case 'W': return firstLine(source, '/etc/os-release', 'VARIANT_ID');
    default: return undefined;
  }
}

function expandTemplate(source: DnssdSource, template: string): { name: string } | { error: string } {
  let out = '';
  for (let index = 0; index < template.length; index++) {
    if (template[index] !== '%') {
      out += template[index];
      continue;
    }
    const specifier = template[++index];
    if (specifier === undefined) return { error: 'Invalid slot' };
    const value = specifierValue(source, specifier);
    if (value === undefined) return { error: 'Invalid slot' };
    if (value === null) return { error: 'No such file or directory' };
    out += value;
  }
  return { name: out };
}

function serviceNameIsValid(name: string): boolean {
  return name.length > 0 && name.length <= DNS_LABEL_MAX && !/[\u0000-\u001f\u007f]/.test(name);
}

function splitPair(word: string): { key: string; value: string | null } {
  const equals = word.indexOf('=');
  return equals < 0 ? { key: word, value: null } : { key: word.slice(0, equals), value: word.slice(equals + 1) };
}

function decodeBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, '');
  if (!BASE64.test(compact)) return null;
  return Buffer.from(compact, 'base64').toString('latin1');
}

function txtHandler(draft: Draft, kind: TxtKind): ConfigHandler {
  return (value, _at, warn) => {
    if (value === '') {
      draft.txt = [];
      return;
    }
    const items: string[] = [];
    for (const word of wordsOf(value, true, true)) {
      const { key, value: pairValue } = splitPair(word);
      if (/[^\u0000-\u007f]/.test(key)) {
        warn(`Invalid key, ignoring: ${key}`);
        continue;
      }
      if (kind === 'data') {
        const decoded = pairValue === null ? '' : decodeBase64(pairValue);
        if (decoded === null) {
          warn(`Invalid base64 encoding, ignoring: ${pairValue}`);
          continue;
        }
        items.push(`${key}=${decoded}`);
      } else items.push(pairValue === null ? key : `${key}=${pairValue}`);
    }
    if (items.length > 0) draft.txt.push(items);
  };
}

function uint16Handler(apply: (value: number) => void): ConfigHandler {
  return (value, _at, warn) => {
    if (value === '') {
      apply(0);
      return;
    }
    if (/^\+?\d+$/.test(value) && Number(value) <= 0xffff) apply(Number(value));
    else warn(`Failed to parse unsigned integer, ignoring: ${value}`);
  };
}

function dnssdSpec(source: DnssdSource, path: string, serviceName: string, draft: Draft): ConfigSpec {
  const handlers = new Map<string, ConfigHandler>([
    ['Service.Name', (value, _at, warn) => {
      if (value === '') {
        draft.nameTemplate = null;
        return;
      }
      const expanded = expandTemplate(source, value);
      if ('error' in expanded) {
        warn(`Invalid service instance name template '${value}', ignoring assignment: ${expanded.error}`);
        return;
      }
      if (!serviceNameIsValid(expanded.name)) {
        warn(`Service instance name template '${value}' renders to invalid name '${expanded.name}'. Ignoring assignment.`);
        return;
      }
      draft.nameTemplate = expanded.name;
    }],
    ['Service.Type', (value, _at, warn) => {
      if (value === '') {
        draft.type = null;
        return;
      }
      if (!SERVICE_TYPE.test(value)) {
        warn('Service type is invalid. Ignoring.');
        return;
      }
      draft.type = value;
    }],
    ['Service.SubType', (value) => {
      if (value === '') draft.subtypes = [];
      else draft.subtypes.push(value);
    }],
    ['Service.Port', (value, _at, warn) => {
      if (value === '') {
        draft.port = 0;
        return;
      }
      if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 0xffff) draft.port = Number(value);
      else warn(`Failed to parse port '${value}'.`);
    }],
    ['Service.Priority', uint16Handler((value) => { draft.priority = value; })],
    ['Service.Weight', uint16Handler((value) => { draft.weight = value; })],
    ['Service.TxtText', txtHandler(draft, 'text')],
    ['Service.TxtData', txtHandler(draft, 'data')],
  ]);
  return { mainFile: path, dropInName: `dnssd/${serviceName}.dnssd.d`, sections: ['Service'], handlers };
}

export function readDnssdFile(source: DnssdSource, path: string): { file: DnssdFile | null; diagnostics: ConfigDiagnostic[] } {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (!basename.endsWith('.dnssd')) return { file: null, diagnostics: [] };
  const serviceName = basename.slice(0, -'.dnssd'.length);
  const draft = emptyDraft();
  const diagnostics = readSystemdConfig(source, dnssdSpec(source, path, serviceName, draft));
  const refuse = (message: string): { file: null; diagnostics: ConfigDiagnostic[] } => ({
    file: null,
    diagnostics: [...diagnostics, { priority: LOG_ERR, file: path, line: 0, message }],
  });
  if (draft.nameTemplate === null) return refuse(`${serviceName} doesn't define service instance name`);
  if (draft.type === null) return refuse(`${serviceName} doesn't define service type`);
  const [first = [], ...more] = draft.txt;
  return {
    diagnostics,
    file: {
      path,
      basename,
      service: {
        instance: draft.nameTemplate,
        type: draft.type.toLowerCase(),
        port: draft.port,
        txt: first,
        ...(more.length > 0 ? { moreTxt: more } : {}),
        subtypes: draft.subtypes.map((subtype) => subtype.toLowerCase()),
        priority: draft.priority,
        weight: draft.weight,
      },
    },
  };
}

export function parseDnssdFile(path: string, text: string, hostName = 'localhost'): DnssdFile | null {
  const inMemory: DnssdSource = {
    readFile: (candidate) => (candidate === path ? text : null),
    listDirectory: () => null,
    hostName: () => hostName,
  };
  return readDnssdFile(inMemory, path).file;
}

export function discoverDnssdFiles(source: DnssdSource): DnssdReadout {
  const byBasename = new Map<string, DnssdFile>();
  const diagnostics: ConfigDiagnostic[] = [];
  const seen = new Set<string>();
  for (const dir of DNSSD_DIRS) {
    for (const entry of source.listDirectory(dir) ?? []) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const read = readDnssdFile(source, `${dir}/${entry.name}`);
      diagnostics.push(...read.diagnostics);
      if (read.file) byBasename.set(entry.name, read.file);
    }
  }
  return { files: [...byBasename.values()].sort((a, b) => a.basename.localeCompare(b.basename)), diagnostics };
}
