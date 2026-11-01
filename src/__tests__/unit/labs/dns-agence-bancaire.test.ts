/*
 * Lab "DNS - Agence bancaire" : builds the topology through the same store, shells and PowerShell the user
 * types into, exports it, and proves the exported file loads back into a fresh canvas and behaves like the lab
 * that was exported — the same checks run on the freshly built lab and on the reopened one.
 *
 * Measured first (the committed file reopened): Windows clients came back as static hosts without DNS servers,
 * DC1 had lost its forwarder, the web server's enabled virtual host (a symlink) was gone, and the DHCP server's
 * lease table was empty. Each is now carried by the export, which is why every check below must pass on both.
 *
 * Regenerate the committed file with:  UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/dns-agence-bancaire.test.ts
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
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { LAB_CHECKS, runLabChecks } from '@/labs/dnsAgenceBancaire/checks';
import { PROJECT_NAME } from '@/labs/dnsAgenceBancaire/plan';

const LAB_FILE = resolve(process.cwd(), 'labs/dns-agence-bancaire/topology.json');

const DEVICE_NAMES = [
  'R-ISP', 'SW-INFRA', 'SW-HEBERGEMENT', 'ROOT-NS', 'TLD-NS', 'NS1-BANK', 'NS2-BANK', 'WEB-BANK',
  'R-AGENCE', 'SW-AGENCE', 'DC1', 'DNS-RES', 'PC-GUICHET1', 'PC-GUICHET2', 'PC-CONSEILLER',
];

beforeEach(() => {
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

async function loadCommittedLab(): Promise<Map<string, Equipment>> {
  const topology = JSON.parse(readFileSync(LAB_FILE, 'utf8')) as TopologyExport;
  const result = await importTopology(topology);
  useNetworkStore.getState().replaceTopology(result.deviceInstances, result.connections);
  return byName();
}

async function failedChecks(devices: ReadonlyMap<string, Equipment>): Promise<string[]> {
  const results = await runLabChecks(devices);
  return results
    .filter((result) => result.missing.length > 0)
    .map((result) => `${result.check.id}: missing ${result.missing.join(' ')}\n${result.output}`);
}

describe('Lab DNS - agence bancaire', () => {
  it('declares one check per lesson, each with an expectation', () => {
    expect(LAB_CHECKS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(LAB_CHECKS.map((check) => check.id)).size).toBe(LAB_CHECKS.length);
    for (const check of LAB_CHECKS) expect(check.expects.length).toBeGreaterThan(0);
  });

  it('builds the topology, exports it as JSON, and the lab passes every check', async () => {
    await buildDnsAgenceBancaire();
    const { deviceInstances, connections } = useNetworkStore.getState();
    const topology = exportTopology(PROJECT_NAME, deviceInstances, connections);

    expect([...deviceInstances.values()].map((device) => device.getName()).sort()).toEqual([...DEVICE_NAMES].sort());
    expect(connections).toHaveLength(14);
    expect(topology.devices).toHaveLength(DEVICE_NAMES.length);

    if (process.env.UPDATE_LABS === '1') {
      mkdirSync(dirname(LAB_FILE), { recursive: true });
      writeFileSync(LAB_FILE, `${JSON.stringify(topology, null, 2)}\n`);
    }
    expect(await failedChecks(byName())).toEqual([]);
  }, 300000);

  describe('the committed topology file', () => {
    it.skipIf(!existsSync(LAB_FILE))('loads back into a fresh canvas with every device and cable', async () => {
      const devices = await loadCommittedLab();
      expect([...devices.keys()].sort()).toEqual([...DEVICE_NAMES].sort());
      expect(useNetworkStore.getState().connections).toHaveLength(14);
    }, 300000);

    it.skipIf(!existsSync(LAB_FILE))('passes every check once reopened, exactly like the lab that was exported', async () => {
      const devices = await loadCommittedLab();
      expect(await failedChecks(devices)).toEqual([]);
    }, 300000);
  });
});
