import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';
import type { VirtualReassembly, VfrSettings } from '@/network/devices/router/VirtualReassembly';
import { VFR_DEFAULTS } from '@/network/devices/router/VirtualReassembly';

export interface VfrHost {
  reassembly(): VirtualReassembly;
  selectedInterface(): string | null;
  resolveInterface(name: string): string | null;
}

const SHOW: readonly string[] = Object.freeze(['user', 'privileged']);
const TIMEOUT_MAXIMUM_SECONDS = 60;
const INVALID = "% Invalid input detected at '^' marker.";

const OPTIONS: ArgumentSpec = { name: 'options', type: 'REST', optional: true, description: 'max-reassemblies, max-fragments, timeout, drop-fragments', values: [] };
const SELECTOR: ArgumentSpec = { name: 'selector', type: 'REST', optional: true, description: 'interface type number', values: [] };

function positiveInteger(token: string | undefined): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  const value = Number(token);
  return value > 0 ? value : null;
}

export function parseVfrOptions(tokens: readonly string[]): Partial<VfrSettings> | null {
  const change: { -readonly [K in keyof VfrSettings]?: VfrSettings[K] } = {};
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index].toLowerCase();
    if (keyword === 'drop-fragments') {
      change.dropFragments = true;
    } else if (keyword === 'max-reassemblies' || keyword === 'max-fragments') {
      const value = positiveInteger(tokens[++index]);
      if (value === null) return null;
      if (keyword === 'max-reassemblies') change.maxReassemblies = value;
      else change.maxFragments = value;
    } else if (keyword === 'timeout') {
      const token = tokens[++index];
      if (token === undefined || !/^\d+$/.test(token) || Number(token) > TIMEOUT_MAXIMUM_SECONDS) return null;
      change.timeoutSeconds = Number(token);
    } else {
      return null;
    }
  }
  return change;
}

export function vfrInterfaceFamily(host: () => VfrHost, modes: readonly string[]): CommandSpec[] {
  const onSelected = (run: (reassembly: VirtualReassembly, interfaceName: string) => string): string => {
    const h = host();
    const interfaceName = h.selectedInterface();
    return interfaceName ? run(h.reassembly(), interfaceName) : '% No interface selected.';
  };
  const tokens = (options: string | undefined): string[] => (options ?? '').split(/\s+/).filter(Boolean);
  return [{
    id: 'config-if-ip-virtual-reassembly',
    path: ['ip', 'virtual-reassembly', OPTIONS],
    description: 'Enable Virtual Fragment Reassembly',
    modes, minPrivilege: 15,
    run: (_session, args) => onSelected((reassembly, interfaceName) => {
      const change = parseVfrOptions(tokens(args.options));
      if (change === null) return INVALID;
      reassembly.configure(interfaceName, change);
      return '';
    }),
    undoDescription: 'Disable Virtual Fragment Reassembly',
    undo: () => onSelected((reassembly, interfaceName) => {
      reassembly.unconfigure(interfaceName);
      return '';
    }),
  }];
}

export function renderVfrInterface(reassembly: VirtualReassembly, interfaceName: string): string[] {
  const snapshot = reassembly.snapshot(interfaceName);
  if (snapshot === null) return [];
  return [
    `${interfaceName}:`,
    'Virtual Fragment Reassembly (VFR) is ENABLED...',
    `Concurrent reassemblies (max-reassemblies):${snapshot.settings.maxReassemblies}`,
    `Fragments per reassembly (max-fragments):${snapshot.settings.maxFragments}`,
    `Reassembly timeout (timeout):${snapshot.settings.timeoutSeconds} seconds`,
    `Drop fragments:${snapshot.settings.dropFragments ? 'ON' : 'OFF'}`,
    `Current reassembly count:${snapshot.currentReassemblies}`,
    `Current fragment count:${snapshot.currentFragments}`,
    `Total reassembly count:${snapshot.totalReassemblies}`,
    `Total reassembly failures:${snapshot.totalFailures}`,
  ];
}

export function vfrRunningConfigLines(reassembly: VirtualReassembly, interfaceName: string): string[] {
  if (!reassembly.isConfigured(interfaceName)) return [];
  const settings = reassembly.settings(interfaceName) ?? VFR_DEFAULTS;
  const parts = ['ip virtual-reassembly'];
  if (settings.maxReassemblies !== VFR_DEFAULTS.maxReassemblies) parts.push('max-reassemblies', String(settings.maxReassemblies));
  if (settings.maxFragments !== VFR_DEFAULTS.maxFragments) parts.push('max-fragments', String(settings.maxFragments));
  if (settings.timeoutSeconds !== VFR_DEFAULTS.timeoutSeconds) parts.push('timeout', String(settings.timeoutSeconds));
  if (settings.dropFragments) parts.push('drop-fragments');
  return [` ${parts.join(' ')}`];
}

export function vfrShowFamily(host: () => VfrHost): CommandSpec[] {
  return [{
    id: 'show-ip-virtual-reassembly',
    path: ['show', 'ip', 'virtual-reassembly', SELECTOR],
    description: 'Display Virtual Fragment Reassembly configuration and statistics',
    modes: SHOW, minPrivilege: 1,
    run: (_session, args) => {
      const h = host();
      const reassembly = h.reassembly();
      const given = (args.selector ?? '').split(/\s+/).filter(Boolean);
      if (given.length === 0) {
        return reassembly.enabledInterfaces().map((name) => renderVfrInterface(reassembly, name).join('\n')).join('\n\n');
      }
      if (given[0].toLowerCase() !== 'interface' || given.length < 2) return INVALID;
      const resolved = h.resolveInterface(given.slice(1).join(''));
      return resolved === null ? INVALID : renderVfrInterface(reassembly, resolved).join('\n');
    },
  }];
}
