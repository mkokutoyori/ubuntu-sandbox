import type { GpoSettings } from './AdTypes';
import { decodeGpLink, normalisedPolicyKey } from './AdTypes';

export interface GpoContainerReader {
  gpLinks(containerDn: string): readonly string[];
  inheritanceBlocked(containerDn: string): boolean;
  readGpo(gpoDn: string): { name: string; settings: GpoSettings } | null;
}

export interface GroupPolicyResult {
  appliedGpoNames: string[];
  appliedUserGpoNames: string[];
  settings: GpoSettings;
}

export function containerChain(objectDn: string, rootDn: string): string[] {
  const rdns = objectDn.split(',');
  const rootLength = rootDn.split(',').length;
  const chain: string[] = [];
  for (let length = rootLength; length < rdns.length; length++) {
    chain.push(rdns.slice(rdns.length - length).join(','));
  }
  return chain.length > 0 ? chain : [rootDn];
}

export function mergeGpoSettings(target: GpoSettings, source: GpoSettings): void {
  if (source.accountPolicy !== undefined) target.accountPolicy = { ...target.accountPolicy, ...source.accountPolicy };
  if (source.logonBanner !== undefined) target.logonBanner = source.logonBanner;
  if (source.startupScript !== undefined) target.startupScript = source.startupScript;
  if (source.auditPolicy !== undefined) target.auditPolicy = { ...target.auditPolicy, ...source.auditPolicy };
  if (source.registryPolicy !== undefined) {
    const identity = (e: { key: string; valueName: string }): string => `${normalisedPolicyKey(e.key)}|${e.valueName.toLowerCase()}`;
    const byKey = new Map((target.registryPolicy ?? []).map(e => [identity(e), e]));
    for (const e of source.registryPolicy) byKey.set(identity(e), e);
    target.registryPolicy = Array.from(byKey.values());
  }
}

interface Candidate {
  gpoDn: string;
  name: string;
  settings: GpoSettings;
  enforced: boolean;
  order: number;
  level: number;
  sequence: number;
}

const USER_HIVE = /^(HKCU|HKEY_CURRENT_USER)([\\:]|$)/i;

function scopedSettings(settings: GpoSettings, scope: 'computer' | 'user'): GpoSettings {
  if (scope === 'user') {
    const registryPolicy = (settings.registryPolicy ?? []).filter(e => USER_HIVE.test(e.key));
    return registryPolicy.length > 0 ? { registryPolicy } : {};
  }
  const { registryPolicy, ...rest } = settings;
  const machine = (registryPolicy ?? []).filter(e => !USER_HIVE.test(e.key));
  return machine.length > 0 ? { ...rest, registryPolicy: machine } : rest;
}

function candidatesOf(reader: GpoContainerReader, chain: readonly string[]): Candidate[] {
  const blocksFrom = chain.map(container => reader.inheritanceBlocked(container));
  const found: Candidate[] = [];
  chain.forEach((container, level) => {
    reader.gpLinks(container).forEach((raw, index) => {
      const link = decodeGpLink(raw);
      if (!link.linkEnabled) return;
      const blockedBelow = blocksFrom.slice(level + 1).some(Boolean);
      if (blockedBelow && !link.enforced) return;
      const gpo = reader.readGpo(link.gpoDn);
      if (!gpo) return;
      found.push({ gpoDn: link.gpoDn, name: gpo.name, settings: gpo.settings, enforced: link.enforced, order: link.order, level, sequence: index });
    });
  });
  return found;
}

function applicationOrder(candidates: readonly Candidate[]): Candidate[] {
  const byOrderThenSequence = (a: Candidate, b: Candidate): number => b.order - a.order || a.sequence - b.sequence;
  const normal = candidates.filter(c => !c.enforced)
    .sort((a, b) => a.level - b.level || byOrderThenSequence(a, b));
  const enforced = candidates.filter(c => c.enforced)
    .sort((a, b) => b.level - a.level || byOrderThenSequence(a, b));
  return [...normal, ...enforced];
}

/**
 * Local, Site, Domain, OU precedence, once for the computer's OU chain
 * (Computer Configuration: everything but the `HKCU` registry policy) and
 * once for the logged-on user's (User Configuration: the `HKCU` registry
 * policy). A GPO linked at any level of a chain applies, top to bottom, the
 * lowest container winning a conflict; a container that blocks inheritance
 * withholds every non-enforced link from the containers above it; an
 * enforced link applies regardless of a block and wins over every
 * non-enforced one, the highest container's enforced link winning among
 * them; inside one container, link order 1 wins. The two scopes never lend
 * each other a GPO: a GPO the computer chain blocked does not come back
 * through the user's chain.
 */
export function resolveGroupPolicy(
  reader: GpoContainerReader, computerChain: readonly string[], userChain?: readonly string[],
): GroupPolicyResult {
  const settings: GpoSettings = {};
  const computerApplied = applicationOrder(candidatesOf(reader, computerChain));
  for (const candidate of computerApplied) mergeGpoSettings(settings, scopedSettings(candidate.settings, 'computer'));

  const userApplied: Candidate[] = [];
  for (const candidate of applicationOrder(userChain ? candidatesOf(reader, userChain) : [])) {
    const userSettings = scopedSettings(candidate.settings, 'user');
    if (userSettings.registryPolicy === undefined) continue;
    mergeGpoSettings(settings, userSettings);
    userApplied.push(candidate);
  }
  return {
    appliedGpoNames: computerApplied.map(c => c.name).reverse(),
    appliedUserGpoNames: userApplied.map(c => c.name).reverse(),
    settings,
  };
}
