/**
 * Shared CLI Utilities — DRY extraction for Cisco & Huawei shells
 *
 * Eliminates duplicated pipe filtering, error messages, and interface
 * resolution logic across CiscoIOSShell, CiscoSwitchShell, and HuaweiVRPShell.
 */

// ─── Cisco CLI Error Messages ──────────────────────────────────────

export const CISCO_ERRORS = {
  AMBIGUOUS: (cmd: string) => `% Ambiguous command: "${cmd}"`,
  INCOMPLETE: '% Incomplete command.',
  INVALID_INPUT: "% Invalid input detected at '^' marker.",
  UNRECOGNIZED: (cmd: string) => `% Unrecognized command "${cmd}"`,
  UNRECOGNIZED_HELP: '% Unrecognized command',
} as const;

export const HUAWEI_ERRORS = {
  AMBIGUOUS: (cmd: string) => `Error: Ambiguous command "${cmd}"`,
  INCOMPLETE: 'Error: Incomplete command.',
  UNRECOGNIZED: (cmd: string) => `Error: Unrecognized command "${cmd}"`,
} as const;

// ─── Pipe Filter ───────────────────────────────────────────────────

export interface PipeFilter {
  type: string;
  pattern: string;
}

const PIPE_FILTER_RE = /^(include|exclude|grep|findstr)\s+(.+)$/i;

/**
 * Parse pipe filter from raw CLI input.
 * Returns the command portion and an optional pipe filter.
 *
 * Example: "show ip route | include 10.0" → { cmd: "show ip route", filter: { type: "include", pattern: "10.0" } }
 */
export function parsePipeFilter(trimmed: string): { cmd: string; filter: PipeFilter | null } {
  const pipeIdx = trimmed.indexOf(' | ');
  if (pipeIdx === -1) return { cmd: trimmed, filter: null };

  const cmd = trimmed.substring(0, pipeIdx).trim();
  const filterPart = trimmed.substring(pipeIdx + 3).trim();
  const match = filterPart.match(PIPE_FILTER_RE);
  if (!match) return { cmd, filter: null };

  return {
    cmd,
    filter: { type: match[1].toLowerCase(), pattern: match[2] },
  };
}

/**
 * Apply a pipe filter (include/exclude/grep/findstr) to CLI output.
 * Strips surrounding quotes from pattern before matching (Cisco behavior).
 */
export function applyPipeFilter(output: string, filter: PipeFilter | null): string {
  if (!filter || !output) return output;

  const lines = output.split('\n');
  let pattern = filter.pattern;

  // Strip surrounding quotes (consistent Cisco behavior)
  if ((pattern.startsWith('"') && pattern.endsWith('"')) ||
      (pattern.startsWith("'") && pattern.endsWith("'"))) {
    pattern = pattern.slice(1, -1);
  }

  const lowerPattern = pattern.toLowerCase();

  if (filter.type === 'include' || filter.type === 'grep' || filter.type === 'findstr') {
    return lines.filter(l => l.toLowerCase().includes(lowerPattern)).join('\n');
  }
  if (filter.type === 'exclude') {
    return lines.filter(l => !l.toLowerCase().includes(lowerPattern)).join('\n');
  }

  return output;
}

// ─── Interface Name Resolution ────────────────────────────────────

/** Cisco interface abbreviation → full prefix */
const CISCO_INTERFACE_PREFIXES: Record<string, string> = {
  'g': 'GigabitEthernet',
  'gi': 'GigabitEthernet',
  'gig': 'GigabitEthernet',
  'giga': 'GigabitEthernet',
  'gigabit': 'GigabitEthernet',
  'gigabitethernet': 'GigabitEthernet',
  'fa': 'FastEthernet',
  'fast': 'FastEthernet',
  'fastethernet': 'FastEthernet',
  'se': 'Serial',
  'serial': 'Serial',
  'lo': 'Loopback',
  'loopback': 'Loopback',
  'tu': 'Tunnel',
  'tunnel': 'Tunnel',
  'ge': 'GE',
};

/** Huawei interface abbreviation → full prefix candidates (ordered) */
const HUAWEI_INTERFACE_PREFIXES: Record<string, string[]> = {
  'ge': ['GE', 'GigabitEthernet'],
  'gi': ['GE', 'GigabitEthernet'],
  'gigabitethernet': ['GE', 'GigabitEthernet'],
};

const IFACE_NAME_RE = /^([a-z]+)([\d/.-]+)$/;

/**
 * Resolve abbreviated Cisco interface name to the actual port name.
 * E.g. "gi0/0" → "GigabitEthernet0/0"
 */
export function resolveCiscoInterfaceName(
  portNames: Iterable<string>,
  input: string,
): string | null {
  const combined = input.replace(/\s+/g, '');
  const lower = combined.toLowerCase();

  // Direct match
  for (const name of portNames) {
    if (name.toLowerCase() === lower || name === input.trim()) return name;
  }

  // Abbreviation expansion
  const match = lower.match(IFACE_NAME_RE);
  if (!match) return null;

  const [, prefix, numbers] = match;
  const fullPrefix = CISCO_INTERFACE_PREFIXES[prefix];
  if (!fullPrefix) return null;

  const resolved = `${fullPrefix}${numbers}`;
  for (const name of portNames) {
    if (name === resolved) return name;
  }

  return null;
}

/**
 * Resolve abbreviated Huawei interface name to the actual port name.
 * E.g. "ge0/0/0" → "GE0/0/0"
 */
export function resolveHuaweiInterfaceName(
  portNames: Iterable<string>,
  input: string,
): string | null {
  const lower = input.toLowerCase();

  // Direct match
  for (const name of portNames) {
    if (name.toLowerCase() === lower) return name;
  }

  // Abbreviation: GE0/0/0 → full port name
  const match = lower.match(/^(ge|gigabitethernet|gi)([\d/]+)$/);
  if (!match) return null;

  const numbers = match[2];
  const candidates = HUAWEI_INTERFACE_PREFIXES[match[1]];
  if (!candidates) return null;

  for (const prefix of candidates) {
    const resolved = `${prefix}${numbers}`;
    for (const name of portNames) {
      if (name === resolved) return name;
    }
  }

  return null;
}
