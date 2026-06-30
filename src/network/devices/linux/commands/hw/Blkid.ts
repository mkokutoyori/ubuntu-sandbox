import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { DiskPartition } from '@/network/devices/host/hardware/StorageDevice';

export function cmdBlkid(profile: HardwareProfile, args: string[]): { output: string; exitCode: number } {
  const targets: string[] = [];
  for (const a of args) {
    if (a === '-h' || a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '-V' || a === '--version') return { output: 'blkid from util-linux 2.37', exitCode: 0 };
    if (a.startsWith('-')) return { output: `blkid: unrecognized option '${a}'`, exitCode: 1 };
    targets.push(a);
  }

  const all: Array<{ disk: string; part: DiskPartition }> = [];
  for (const d of profile.storage) for (const p of d.partitions) all.push({ disk: d.name, part: p });

  const seen = new Set<string>();
  const matches = targets.length === 0
    ? all
    : all.filter(e => targets.includes(`/dev/${e.part.name}`));

  if (matches.length === 0) {
    if (targets.length > 0) return { output: '', exitCode: 2 };
  }

  const lines = matches.map(e => {
    const uuid = e.part.uuid || synthUuid(e.part.name);
    seen.add(uuid);
    return `/dev/${e.part.name}: UUID="${uuid}" TYPE="${e.part.fsType}" PARTUUID="${synthUuid('part-' + e.part.name)}"`;
  });
  return { output: lines.join('\n'), exitCode: 0 };
}

function synthUuid(seed: string): string {
  let h = 0;
  for (const c of seed) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const u = (h >>> 0).toString(16).padStart(8, '0');
  return `${u}-${u.slice(0, 4)}-${u.slice(4, 8)}-${u.slice(0, 4)}-${u}${u.slice(0, 4)}`;
}

function helpText(): string {
  return [
    'Usage:',
    ' blkid -L <label> | -U <uuid>',
    ' blkid [-o <format>] [-s <tag>] [--match-token <NAME=value>] [--match-tag <tag>]',
    '       [<dev> ...]',
  ].join('\n');
}
