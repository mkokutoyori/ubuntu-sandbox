import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';

const KNOWN_CLASSES = new Set([
  'system', 'bus', 'memory', 'processor', 'cpu', 'address', 'storage', 'disk',
  'tape', 'bridge', 'display', 'input', 'multimedia', 'network', 'printer',
  'communication', 'power', 'volume', 'generic', 'firmware',
]);

interface Options {
  format: 'text' | 'json' | 'xml' | 'html' | 'short';
  classFilter: string | null;
}

export function cmdLshw(profile: HardwareProfile, args: string[], isPrivileged: boolean): { output: string; exitCode: number } {
  const parsed = parseArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: 1 };
  const opts = parsed.opts;

  const warn = isPrivileged ? '' : 'WARNING: you should run this program as super-user.\n';
  switch (opts.format) {
    case 'json': return { output: warn + renderJson(profile, opts.classFilter), exitCode: 0 };
    case 'xml': return { output: warn + renderXml(profile, opts.classFilter), exitCode: 0 };
    case 'html': return { output: warn + renderHtml(profile, opts.classFilter), exitCode: 0 };
    case 'short': return { output: warn + renderShort(profile, opts.classFilter), exitCode: 0 };
    default: return { output: warn + renderText(profile, opts.classFilter), exitCode: 0 };
  }
}

function parseArgs(args: string[]): { opts: Options } | { error: string } {
  const opts: Options = { format: 'text', classFilter: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-json' || a === '-J') { opts.format = 'json'; continue; }
    if (a === '-xml' || a === '-X') { opts.format = 'xml'; continue; }
    if (a === '-html' || a === '-H') { opts.format = 'html'; continue; }
    if (a === '-short') { opts.format = 'short'; continue; }
    if (a === '-C' || a === '-class') {
      const v = args[++i];
      if (!v || !KNOWN_CLASSES.has(v.toLowerCase())) {
        return { error: `lshw: invalid class "${v ?? ''}"` };
      }
      opts.classFilter = v.toLowerCase();
      continue;
    }
    if (a === '-version') return { error: 'lshw B.02.19.2' };
    if (a === '-help' || a === '-h') return { error: helpText() };
    if (a.startsWith('--')) return { error: `lshw: unrecognized option '${a}'` };
    if (a.startsWith('-') && !['-json', '-xml', '-html', '-short', '-C', '-class', '-version', '-help', '-h'].includes(a)) {
      return { error: `lshw: unrecognized option '${a}'` };
    }
  }
  return { opts };
}

function entries(profile: HardwareProfile, filter: string | null): Array<{ class: string; id: string; description: string; product: string; vendor: string }> {
  const all = [
    { class: 'system', id: profile.productUuid, description: 'Computer', product: profile.productName, vendor: profile.manufacturer },
    { class: 'firmware', id: 'firmware', description: 'BIOS', product: profile.firmware.version, vendor: profile.firmware.vendor },
    { class: 'cpu', id: 'cpu', description: 'CPU', product: profile.cpu.modelName, vendor: profile.cpu.vendor },
    { class: 'memory', id: 'memory', description: 'System memory', product: `${Math.ceil(profile.memory.totalKib / 1024)} MiB`, vendor: profile.manufacturer },
    ...profile.adapters.map(a => ({ class: 'network', id: a.name, description: 'Ethernet interface', product: a.model ?? 'Ethernet Controller', vendor: 'Intel Corporation' })),
    ...profile.storage.map(d => ({ class: 'disk', id: d.name, description: 'ATA Disk', product: d.model, vendor: d.vendor })),
    { class: 'display', id: 'display', description: 'VGA compatible controller', product: 'Virtual Video Controller', vendor: 'QEMU' },
    { class: 'storage', id: 'storage', description: 'SATA controller', product: 'AHCI mode', vendor: 'Intel Corporation' },
    { class: 'bridge', id: 'isa', description: 'ISA bridge', product: 'PIIX3', vendor: 'Intel Corporation' },
  ];
  return filter ? all.filter(e => e.class === filter) : all;
}

function renderText(profile: HardwareProfile, filter: string | null): string {
  const lines: string[] = [];
  for (const e of entries(profile, filter)) {
    lines.push(`*-${e.class}`);
    lines.push(`     description: ${e.description}`);
    lines.push(`     product: ${e.product}`);
    lines.push(`     vendor: ${e.vendor}`);
    lines.push(`     physical id: ${e.id}`);
  }
  return lines.join('\n');
}

function renderShort(profile: HardwareProfile, filter: string | null): string {
  const lines = ['H/W path        Device      Class          Description', '=========================================================='];
  for (const e of entries(profile, filter)) {
    lines.push(`/0/${e.id.padEnd(10)} ${''.padEnd(11)} ${e.class.padEnd(14)} ${e.description}`);
  }
  return lines.join('\n');
}

function renderJson(profile: HardwareProfile, filter: string | null): string {
  return JSON.stringify(entries(profile, filter), null, 2);
}

function renderXml(profile: HardwareProfile, filter: string | null): string {
  const out: string[] = ['<?xml version="1.0" standalone="yes" ?>', '<list>'];
  for (const e of entries(profile, filter)) {
    out.push(`  <node id="${e.id}" class="${e.class}">`);
    out.push(`    <description>${e.description}</description>`);
    out.push(`    <product>${e.product}</product>`);
    out.push(`    <vendor>${e.vendor}</vendor>`);
    out.push(`  </node>`);
  }
  out.push('</list>');
  return out.join('\n');
}

function renderHtml(profile: HardwareProfile, filter: string | null): string {
  const out: string[] = ['<html>', '<head><title>lshw report</title></head>', '<body>', '<table>'];
  for (const e of entries(profile, filter)) {
    out.push(`<tr><td class="${e.class}">${e.id}</td><td>${e.description}</td><td>${e.product}</td></tr>`);
  }
  out.push('</table>', '</body>', '</html>');
  return out.join('\n');
}

function helpText(): string {
  return [
    'Hardware Lister (lshw) - B.02.19.2',
    'usage: lshw [-format] [-options ...]',
    '',
    'format can be',
    '  -html           output hardware tree as HTML',
    '  -xml            output hardware tree as XML',
    '  -json           output hardware tree as a JSON object',
    '  -short          output hardware paths',
    '',
    'options can be',
    '  -class CLASS    only show a certain class of hardware',
    '  -C CLASS        same as \'-class CLASS\'',
    '  -version        display version and exit',
  ].join('\n');
}
