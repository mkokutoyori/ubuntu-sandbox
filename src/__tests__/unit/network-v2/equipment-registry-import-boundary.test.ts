import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { Equipment } from '@/network/equipment/Equipment';

/**
 * Lint the source ESLint would see at that path without writing a file:
 * the rule is path-scoped, so the path is the whole point of the check.
 */
async function lintAt(relPath: string, source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(source, { filePath: relPath, warnIgnored: false });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

const IMPORT_LINE =
  "import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';\n" +
  'export const all = () => EquipmentRegistry.getInstance().getAll();\n';

const RELATIVE_IMPORT_LINE =
  "import { EquipmentRegistry } from '../equipment/EquipmentRegistry';\n" +
  'export const all = () => EquipmentRegistry.getInstance().getAll();\n';

describe('a device cannot reach the global equipment registry', () => {
  it('rejects the import from a protocol directory under src/network', async () => {
    const messages = await lintAt('src/network/madeupproto/MadeUpEngine.ts', IMPORT_LINE);
    expect(
      messages.length,
      'a protocol engine must learn about other devices from frames it receives',
    ).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/PRD-Frame-Only-Refactor/);
  });

  it('rejects it through a relative path too, not just the @/ alias', async () => {
    const messages = await lintAt('src/network/devices/MadeUpDevice.ts', RELATIVE_IMPORT_LINE);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('allows it from the registry\'s own directory', async () => {
    const messages = await lintAt('src/network/equipment/MadeUpHelper.ts', IMPORT_LINE);
    expect(messages).toEqual([]);
  });

  it('allows it from the read-only inspection tooling', async () => {
    const messages = await lintAt('src/network/devices/inspection/MadeUpView.ts', IMPORT_LINE);
    expect(messages).toEqual([]);
  });

  it('leaves code outside src/network alone', async () => {
    const messages = await lintAt('src/terminal/sessions/MadeUpSession.ts', IMPORT_LINE);
    expect(
      messages,
      'the UI, terminal and shell layers legitimately enumerate the topology',
    ).toEqual([]);
  });
});

describe('Equipment no longer offers the registry as a static shortcut', () => {
  it('has no getById / getAllEquipment / clearRegistry passthrough left', () => {
    const statics = Equipment as unknown as Record<string, unknown>;
    for (const name of ['getById', 'getAllEquipment', 'clearRegistry']) {
      expect(
        statics[name],
        `Equipment.${name} would let any file walk the graph without importing the registry, ` +
        'which is exactly what the lint rule cannot see',
      ).toBeUndefined();
    }
  });
});
