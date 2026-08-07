import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

const ROOT = join(process.cwd(), 'src');

const RENDER_ROOTS = [
  'network/devices/shells',
  'network/devices/inspection',
  'terminal/sessions',
];

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /software-only sim/i, why: 'nomme le substrat logiciel' },
  { pattern: /Node crypto/i, why: 'nomme le moteur JavaScript sous-jacent' },
  { pattern: /not simulated/i, why: 'annonce que la machine est une simulation' },
  { pattern: /not instrumented/i, why: 'annonce une absence de modélisation' },
  { pattern: /in this model/i, why: 'annonce une absence de modélisation' },
  { pattern: /this is a router, no/i, why: 'commente sa propre nature' },
  { pattern: /\(unhandled(\)|\s)/i, why: 'expose un chemin de code non traité' },
  { pattern: /\(already in\)/i, why: 'commente sa propre nature' },
  { pattern: /Built-in PID \(real\)/i, why: 'oppose du réel à du non-réel' },
];

async function lab(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  r.powerOn?.();
  await r.executeCommand('enable');
  return r;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('aucune sortie CLI ne parle de son propre substrat', () => {
  it('les sources de rendu ne contiennent aucun terme d\'implémentation', () => {
    const offenders: string[] = [];
    for (const root of RENDER_ROOTS) {
      for (const file of sourceFiles(join(ROOT, root))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          for (const { pattern, why } of FORBIDDEN) {
            if (pattern.test(line)) {
              offenders.push(`${relative(ROOT, file)}:${i + 1} — ${why}\n    ${line.trim()}`);
            }
          }
        });
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('les commandes autrefois fautives rendent une sortie IOS ou disparaissent', async () => {
    const r = await lab();

    const eli = await r.executeCommand('show crypto eli');
    expect(eli).toContain('Number of crypto engines');
    expect(eli).not.toMatch(/software-only|Node crypto/i);

    const hosts = await r.executeCommand('show hosts');
    expect(hosts).toContain('Name/address lookup uses static mappings');
    expect(hosts).not.toMatch(/not simulated/i);

    const buffers = await r.executeCommand('show buffers');
    expect(buffers).toContain('Public buffer pools:');
    expect(buffers).toContain('Small buffers, 104 bytes');
    expect(buffers).not.toMatch(/in this model/i);

    const env = await r.executeCommand('show environment');
    expect(env).toContain('Number of Critical alarms:  0');
    expect(env).not.toMatch(/not instrumented/i);

    const diag = await r.executeCommand('show diag');
    expect(diag).toContain('CISCO2911/K9');
    expect(diag).not.toMatch(/\(real\)/i);

    const udi = await r.executeCommand('show license udi');
    expect(udi).toContain('FTX1234567A');
    expect(udi).not.toMatch(/hostname:/i);
  }, 30_000);

  it('les commandes absentes d\'un ISR 2911 répondent au caret', async () => {
    const r = await lab();
    for (const cmd of ['show interfaces trunk', 'show idprom backplane']) {
      expect(await r.executeCommand(cmd)).toContain('% Invalid input detected');
    }
  }, 30_000);

  it('l\'aide contextuelle ne décrit aucun nœud par son état d\'implémentation', async () => {
    const r = await lab();
    const help = [
      await r.executeCommand('?'),
      await r.executeCommand('configure terminal'),
      await r.executeCommand('?'),
    ].join('\n');
    expect(help).not.toMatch(/\(unhandled|\(already in\)/i);
  }, 30_000);
});
