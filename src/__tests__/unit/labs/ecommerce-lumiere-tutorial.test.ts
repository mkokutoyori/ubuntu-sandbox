/*
 * Tutorial Oracle / RMAN du lab Lumiere Boutique. Le tutoriel n'est pas ecrit a la main : chaque etape est une commande tapee sur le lab rouvert depuis
 * labs/ecommerce-lumiere/topology.json, avec ce qu'elle doit afficher, et les blocs de sortie du README sont ceux que cette execution a captures. Un tutoriel
 * dont une commande ne produit plus ce qu'il annonce fait donc echouer ce test.
 *
 * Regenerate the README with:  UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { useNetworkStore } from '@/store/networkStore';
import { importTopology, type TopologyExport } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { __setLegacyRouterPortCount, __setInterfacesBootShutdown } from '@/network/devices/inspection/InterfaceStatusView';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import type { Equipment } from '@/network';
import { runTutorial } from '@/labs/ecommerceLumiere/tutorial/engine';
import { renderTutorial } from '@/labs/ecommerceLumiere/tutorial/render';
import { TUTORIAL_STEPS } from '@/labs/ecommerceLumiere/tutorial/steps';

const LAB_FILE = resolve(process.cwd(), 'labs/ecommerce-lumiere/topology.json');
const TEMPLATE_FILE = resolve(process.cwd(), 'src/labs/ecommerceLumiere/tutorial/template.md');
const README_FILE = resolve(process.cwd(), 'labs/ecommerce-lumiere/tutoriel-oracle-rman/README.md');

beforeEach(() => {
  __setLegacyRouterPortCount(null);
  __setInterfacesBootShutdown(true);
  resetAllOracleInstances();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function reopenedLab(): Promise<Map<string, Equipment>> {
  const topology = JSON.parse(readFileSync(LAB_FILE, 'utf8')) as TopologyExport;
  const result = await importTopology(topology);
  expect(result.warnings).toEqual([]);
  useNetworkStore.getState().replaceTopology(result.deviceInstances, result.connections);
  return new Map([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
}

describe('Tutoriel Oracle / RMAN du lab Lumiere Boutique', () => {
  it('declares unique steps, each with an expectation', () => {
    expect(new Set(TUTORIAL_STEPS.map((step) => step.id)).size).toBe(TUTORIAL_STEPS.length);
    for (const step of TUTORIAL_STEPS) expect(step.expects.length).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(LAB_FILE))('replays every step on the reopened lab and each prints what the tutorial says', async () => {
    const run = await runTutorial(await reopenedLab(), TUTORIAL_STEPS);
    const failures = run.records
      .filter((record) => record.missing.length > 0 || record.forbidden.length > 0)
      .map((record) => `${record.step.id} @${record.step.device}: missing ${record.missing.join(' ')} forbidden ${record.forbidden.join(' ')}\n${record.command}\n${record.output}`);
    if (process.env.TUTORIAL_DUMP) {
      writeFileSync(process.env.TUTORIAL_DUMP, run.records.map((record) => `### ${record.step.id} @${record.step.device}\n${record.command}\n${record.output}`).join('\n\n'));
    }
    if (process.env.UPDATE_LABS === '1' && existsSync(TEMPLATE_FILE)) {
      mkdirSync(dirname(README_FILE), { recursive: true });
      writeFileSync(README_FILE, renderTutorial(readFileSync(TEMPLATE_FILE, 'utf8'), run));
    }
    expect(failures).toEqual([]);
  }, 1_800_000);
});
