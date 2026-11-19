import type { RadiusAttribute } from '@/network/radius/types';
import type { ConfSection } from './FreeradiusConf';
import { parseUsersFile, pairMatches, isSettingPair, requestViewOf, usersPairToAttribute, type UsersEntry } from './UsersFileParser';

export interface PreprocessFiles {
  readonly hints: UsersEntry[] | null;
  readonly huntgroups: UsersEntry[] | null;
}

export interface PreprocessOutcome {
  readonly extra: RadiusAttribute[];
  readonly overlay: ReadonlyMap<string, string>;
  readonly rejected: boolean;
}

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
  if (section === null) return { hints: null, huntgroups: null };
  const named = (key: string): string | undefined => section.pairs.find((pair) => pair.name === key)?.value;
  const result: { hints: UsersEntry[] | null; huntgroups: UsersEntry[] | null } = { hints: null, huntgroups: null };
  for (const key of ['huntgroups', 'hints'] as const) {
    const path = named(key);
    if (path === undefined) continue;
    const list = readList(path, read);
    if ('error' in list) return list;
    result[key] = list;
  }
  return result;
}

export function applyPreprocess(
  files: PreprocessFiles, username: string, attributes: readonly RadiusAttribute[], nasIp: string,
  groupsOf: (username: string) => readonly string[],
): PreprocessOutcome {
  const extra: RadiusAttribute[] = [];
  const overlay = new Map<string, string>();
  if (!attributes.some((attribute) => attribute.type === 'nas-ip-address')) extra.push({ type: 'nas-ip-address', value: nasIp });
  const view = () => requestViewOf([...attributes, ...extra], overlay, groupsOf, username);
  if (files.hints !== null && username !== '') {
    for (const entry of files.hints) {
      if (entry.name !== 'DEFAULT' && entry.name !== username) continue;
      if (!entry.check.filter((pair) => !isSettingPair(pair)).every((pair) => pairMatches(pair, username, view()))) continue;
      let fallThrough = false;
      for (const pair of entry.reply) {
        const key = pair.name.toLowerCase();
        if (key === 'fall-through') { fallThrough = /^(yes|1)$/i.test(pair.value); continue; }
        if (key === 'strip-user-name') continue;
        const attribute = usersPairToAttribute(pair);
        if (attribute === null) { overlay.set(key, pair.value); continue; }
        if (pair.op === ':=') {
          for (let at = extra.length - 1; at >= 0; at--) if (extra[at].type === attribute.type) extra.splice(at, 1);
          extra.push(attribute);
        } else if (pair.op === '+=' || !attributes.some((known) => known.type === attribute.type) && !extra.some((known) => known.type === attribute.type)) {
          extra.push(attribute);
        }
      }
      if (!fallThrough) break;
    }
  }
  let rejected = false;
  if (files.huntgroups !== null) {
    for (const entry of files.huntgroups) {
      if (!entry.check.filter((pair) => !isSettingPair(pair)).every((pair) => pairMatches(pair, username, view()))) continue;
      rejected = true;
      const allowed = entry.reply.length === 0 || entry.reply.some((pair) => pairMatches(pair, username, view()));
      if (allowed) {
        if (!overlay.has('huntgroup-name')) overlay.set('huntgroup-name', entry.name);
        rejected = false;
      }
      break;
    }
  }
  return { extra, overlay, rejected };
}
