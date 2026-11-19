import type { RadiusAttribute } from '@/network/radius/types';
import { RADIUS_ATTR } from '@/network/radius/types';
import { confBoolean, type ConfSection } from './FreeradiusConf';
import { parseUsersFile, pairMatches, isSettingPair, requestViewOf, usersPairToAttribute, type UsersEntry, type UsersPair } from './UsersFileParser';
import type { UnlangContext } from './Unlang';

export interface PreprocessOptions {
  readonly ascend: boolean;
  readonly ascendChannelsPerLine: number;
  readonly ntDomain: boolean;
  readonly specialixJetstream: boolean;
  readonly ciscoVsa: boolean;
}

export interface PreprocessFiles {
  readonly hints: UsersEntry[] | null;
  readonly huntgroups: UsersEntry[] | null;
  readonly options: PreprocessOptions;
}

const NO_OPTIONS: PreprocessOptions = { ascend: false, ascendChannelsPerLine: 23, ntDomain: false, specialixJetstream: false, ciscoVsa: false };
export const NO_PREPROCESS: PreprocessFiles = { hints: null, huntgroups: null, options: NO_OPTIONS };

function moduleSection(root: ConfSection): ConfSection | null {
  const modules = root.sections.find((section) => section.name1 === 'modules') ?? root;
  return modules.sections.find((candidate) => candidate.name1 === 'preprocess' && candidate.name2 === null) ?? null;
}

function readList(path: string, read: (path: string) => string | null): UsersEntry[] | { error: string } {
  const source = read(path);
  if (source === null) return { error: `Couldn't open ${path} for reading: No such file or directory` };
  const parsed = parseUsersFile(source, path, read);
  return 'error' in parsed ? { error: parsed.error } : parsed.entries;
}

export function readPreprocess(root: ConfSection, read: (path: string) => string | null): PreprocessFiles | { error: string } {
  const section = moduleSection(root);
  if (section === null) return NO_PREPROCESS;
  const named = (key: string): string | undefined => section.pairs.find((pair) => pair.name === key)?.value;
  const result: { hints: UsersEntry[] | null; huntgroups: UsersEntry[] | null } = { hints: null, huntgroups: null };
  for (const key of ['huntgroups', 'hints'] as const) {
    const path = named(key);
    if (path === undefined) continue;
    const list = readList(path, read);
    if ('error' in list) return list;
    result[key] = list;
  }
  const flag = (key: string): boolean | { error: string } => {
    const pair = section.pairs.find((candidate) => candidate.name === key);
    return pair === undefined ? false : confBoolean(pair);
  };
  const flags: Record<string, boolean> = {};
  for (const key of ['with_ascend_hack', 'with_ntdomain_hack', 'with_specialix_jetstream_hack', 'with_cisco_vsa_hack', 'with_alvarion_vsa_hack', 'with_cablelabs_vsa_hack']) {
    const value = flag(key);
    if (typeof value === 'object') return value;
    flags[key] = value;
  }
  if (flags.with_alvarion_vsa_hack) {
    const pair = section.pairs.find((candidate) => candidate.name === 'with_alvarion_vsa_hack')!;
    return { error: `${pair.file}[${pair.line}]: with_alvarion_vsa_hack is not implemented in this simulator: the vendor 12394 is not in its dictionary` };
  }
  const channelsText = named('ascend_channels_per_line');
  const channels = channelsText === undefined ? 23 : Number(channelsText);
  if (!Number.isInteger(channels) || channels < 0) {
    const pair = section.pairs.find((candidate) => candidate.name === 'ascend_channels_per_line')!;
    return { error: `${pair.file}[${pair.line}]: Invalid value '${channelsText}' for variable ascend_channels_per_line` };
  }
  return {
    ...result,
    options: { ascend: flags.with_ascend_hack, ascendChannelsPerLine: channels, ntDomain: flags.with_ntdomain_hack, specialixJetstream: flags.with_specialix_jetstream_hack, ciscoVsa: flags.with_cisco_vsa_hack },
  };
}

function mangle(context: UnlangContext, options: PreprocessOptions): void {
  if (context.username === '') return;
  let name = context.username;
  if (options.ntDomain) {
    const slash = name.indexOf('\\');
    if (slash >= 0) name = name.slice(slash + 1);
  }
  if (options.specialixJetstream && name.length > 10 && name[10] === '/') name = name.slice(11);
  if (name !== context.username) {
    context.username = name;
    const at = context.request.findIndex((attribute) => attribute.type === 'user-name');
    if (at >= 0) context.request[at] = { type: 'user-name', value: name };
  }
  if (context.request.some((attribute) => attribute.type === 'framed-protocol') && !context.request.some((attribute) => attribute.type === 'service-type')) {
    context.request.push({ type: 'service-type', value: 2 });
  }
}

function ascendPortHack(context: UnlangContext, channelsPerLine: number): void {
  const at = context.request.findIndex((attribute) => attribute.type === 'nas-port');
  if (at < 0) return;
  const port = Number(context.request[at].value);
  if (port <= 9999) return;
  const service = Math.floor(port / 10000);
  const line = Math.floor((port - 10000 * service) / 100);
  const channel = port - (10000 * service + 100 * line);
  context.request[at] = { type: 'nas-port', value: (channel - 1) + (line - 1) * channelsPerLine };
}

function ciscoVsaHack(context: UnlangContext): void {
  for (const attribute of [...context.request]) {
    if (attribute.type !== 'vendor-specific' || attribute.vendor === undefined || attribute.vendor.id !== 9) continue;
    const value = String(attribute.value);
    const equals = value.indexOf('=');
    if (equals < 0) continue;
    if (attribute.vendor.type === 1) {
      const name = /^\s*([A-Za-z0-9-]+)/.exec(value)?.[1];
      if (name !== undefined && name.toLowerCase() in RADIUS_ATTR) {
        const added = usersPairToAttribute({ name, op: '=', value: value.slice(equals + 1), tag: null });
        if (added !== null) context.request.push(added);
      }
    } else {
      const at = context.request.indexOf(attribute);
      context.request[at] = { ...attribute, value: value.slice(equals + 1) };
    }
  }
}

function checkMatches(entry: UsersEntry, context: UnlangContext, groupsOf: (username: string) => readonly string[]): boolean {
  const noStrip = entry.check.some((pair: UsersPair) => pair.name.toLowerCase() === 'strip-user-name' && /^(no|0|false)$/i.test(pair.value));
  const view = requestViewOf(context, groupsOf, () => !noStrip);
  return entry.check.filter((pair) => !isSettingPair(pair)).every((pair) => pairMatches(pair, context.username, view));
}

export function applyPreprocess(
  files: PreprocessFiles, context: UnlangContext, nasIp: string, nowSeconds: number,
  groupsOf: (username: string) => readonly string[],
): boolean {
  mangle(context, files.options);
  if (files.options.ascend) ascendPortHack(context, files.options.ascendChannelsPerLine);
  if (files.options.ciscoVsa) ciscoVsaHack(context);
  if (!context.request.some((attribute) => attribute.type === 'event-timestamp')) context.request.push({ type: 'event-timestamp', value: nowSeconds });
  if (!context.request.some((attribute) => attribute.type === 'nas-ip-address')) context.request.push({ type: 'nas-ip-address', value: nasIp });
  if (files.hints !== null && context.username !== '') {
    for (const entry of files.hints) {
      const current = context.strippedName ?? context.username;
      if (entry.name !== 'DEFAULT' && entry.name !== current) continue;
      if (!checkMatches(entry, context, groupsOf)) continue;
      let fallThrough = false;
      for (const pair of entry.reply) {
        const key = pair.name.toLowerCase();
        if (key === 'fall-through') { fallThrough = /^(yes|1)$/i.test(pair.value); continue; }
        if (key === 'strip-user-name') continue;
        const attribute = usersPairToAttribute(pair);
        if (attribute === null) { context.overlay.set(key, pair.value); continue; }
        if (pair.op === ':=') {
          for (let at = context.request.length - 1; at >= 0; at--) if (context.request[at].type === attribute.type) context.request.splice(at, 1);
          context.request.push(attribute);
        } else if (pair.op === '+=' || !context.request.some((known) => known.type === attribute.type)) {
          context.request.push(attribute);
        }
      }
      if (!fallThrough) break;
    }
  }
  const chap = context.request.some((attribute) => attribute.type === 'chap-password');
  if (chap && !context.request.some((attribute) => attribute.type === 'chap-challenge') && context.packet !== null) {
    context.request.push({ type: 'chap-challenge', value: context.packet.authenticator });
  }
  if (files.huntgroups !== null) {
    for (const entry of files.huntgroups) {
      if (!checkMatches(entry, context, groupsOf)) continue;
      const view = requestViewOf(context, groupsOf);
      const allowed = entry.reply.length === 0 || entry.reply.some((pair) => pairMatches(pair, context.username, view));
      if (!allowed) return true;
      if (!context.overlay.has('huntgroup-name')) context.overlay.set('huntgroup-name', entry.name);
      return false;
    }
  }
  return false;
}
