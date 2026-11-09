/*
 * Lab "Entreprise Meridian" : siege FortiGate (LAN + DMZ), trois agences FortiGate reliees par IPsec IKEv2 en etoile,
 * Internet simule, DC1 (DNS), listener Oracle, web et SMTP en DMZ publies par VIP. Meme methode que les autres labs :
 * le lab est construit en tapant les commandes, exporte, puis reimporte dans un canevas vierge, et les memes
 * verifications doivent passer sur le lab neuf ET sur le lab rouvert.
 *
 * Regenerate the committed file with:  UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/entreprise-meridian.test.ts
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
import type { Equipment } from '@/network';
import { buildMeridian } from '@/labs/entrepriseMeridian/build';
import { MERIDIAN_CHECKS, runMeridianChecks } from '@/labs/entrepriseMeridian/checks';
import { PROJECT_NAME } from '@/labs/entrepriseMeridian/plan';

const LAB_FILE = resolve(process.cwd(), 'labs/entreprise-meridian/topology.json');

import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';

beforeEach(() => {
  resetExchangeOrganizations();
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
  return (await runMeridianChecks(devices))
    .filter((result) => result.missing.length > 0)
    .map((result) => `${result.check.id}: missing ${result.missing.join(' ')}\n${result.output}`);
}

describe('Lab Entreprise Meridian', () => {
  it('declares one check per lesson, each with an expectation', () => {
    expect(new Set(MERIDIAN_CHECKS.map((check) => check.id)).size).toBe(MERIDIAN_CHECKS.length);
    for (const check of MERIDIAN_CHECKS) expect(check.expects.length).toBeGreaterThan(0);
  });

  it('refuses nothing while it is typed in', async () => {
    const lab = await buildMeridian();
    const refused = lab.bench.transcript.filter((step) => /Command fail|command parse error|Unknown action|not found/i.test(step.output));
    expect(refused.map((step) => `${step.device}> ${step.command}\n${step.output}`)).toEqual([]);
  }, 300000);

  it('builds the topology, exports it as JSON, and the lab passes every check', async () => {
    await buildMeridian();
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
      useNetworkStore.getState().replaceTopology(result.deviceInstances, result.connections);
      expect(await failedChecks(byName())).toEqual([]);
    }, 300000);
  });
});
