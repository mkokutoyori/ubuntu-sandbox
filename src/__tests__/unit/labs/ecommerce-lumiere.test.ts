/*
 * Lab "Lumiere Boutique" : une entreprise de e-commerce, son siege (FortiGate, routeur et commutateurs Cisco, controleur de domaine, DHCP, DNS, journaux,
 * AAA, DMZ web, zone des bases Oracle), son site de reprise (FortiGate, routeur et commutateurs Huawei, second controleur de domaine, hote standby, serveur
 * de sauvegarde), deux agences et un Internet simule. Meme methode que les autres labs : le lab est construit en tapant les commandes, exporte, puis reimporte
 * dans un canevas vierge, et les memes verifications doivent passer sur le lab neuf ET sur le lab rouvert.
 *
 * Regenerate the committed file with:  UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/ecommerce-lumiere.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { useNetworkStore } from '@/store/networkStore';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { __setLegacyRouterPortCount, __setInterfacesBootShutdown } from '@/network/devices/inspection/InterfaceStatusView';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import type { Equipment } from '@/network';
import { buildLumiere } from '@/labs/ecommerceLumiere/build';
import { LUMIERE_CHECKS, runLumiereChecks } from '@/labs/ecommerceLumiere/checks';
import { PROJECT_NAME } from '@/labs/ecommerceLumiere/plan';

const LAB_FILE = resolve(process.cwd(), 'labs/ecommerce-lumiere/topology.json');

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

function byName(): Map<string, Equipment> {
  return new Map([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
}

async function failedChecks(devices: ReadonlyMap<string, Equipment>): Promise<string[]> {
  return (await runLumiereChecks(devices))
    .filter((result) => result.missing.length > 0)
    .map((result) => `${result.check.id}: missing ${result.missing.join(' ')}\n${result.output}`);
}

describe('Lab Lumiere Boutique', () => {
  it('declares one check per lesson, each with an expectation', () => {
    expect(new Set(LUMIERE_CHECKS.map((check) => check.id)).size).toBe(LUMIERE_CHECKS.length);
    for (const check of LUMIERE_CHECKS) expect(check.expects.length).toBeGreaterThan(0);
  });

  it('refuses nothing while it is typed in', async () => {
    const lab = await buildLumiere();
    const refused = lab.bench.transcript.filter((step) => /Command fail|command parse error|Unknown action|not found|Invalid input|ORA-\d|SP2-\d|Failed to/i.test(step.output));
    expect(refused.map((step) => `${step.device}> ${step.command}\n${step.output}`)).toEqual([]);
  }, 300000);

  it('builds the topology, exports it as JSON, and the lab passes every check', async () => {
    await buildLumiere();
    const { deviceInstances, connections } = useNetworkStore.getState();
    const topology = exportTopology(PROJECT_NAME, deviceInstances, connections);
    if (process.env.UPDATE_LABS === '1') {
      mkdirSync(dirname(LAB_FILE), { recursive: true });
      writeFileSync(LAB_FILE, `${JSON.stringify(topology, null, 2)}\n`);
    }
    expect(await failedChecks(byName())).toEqual([]);
  }, 300000);

  describe('the committed topology file', () => {
    it.skipIf(!existsSync(LAB_FILE))('passes every check once reopened, exactly like the lab that was exported', async () => {
      const topology = JSON.parse(readFileSync(LAB_FILE, 'utf8')) as TopologyExport;
      const result = await importTopology(topology);
      expect(result.warnings).toEqual([]);
      expect(result.connections).toHaveLength(topology.connections.length);
      expect(result.deviceInstances.size).toBe(topology.devices.length);
      useNetworkStore.getState().replaceTopology(result.deviceInstances, result.connections);
      expect(await failedChecks(byName())).toEqual([]);
    }, 300000);
  });
});
