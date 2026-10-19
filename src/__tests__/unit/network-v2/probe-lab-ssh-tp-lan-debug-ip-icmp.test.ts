/**
 * Lab de l'utilisateur (`SSH_TP_LAN.topology (7).json`) : `debug ip icmp` lance
 * pendant un ping de PC11 vers PC6 n'affichait rien sur MAIN_RT02 et MAIN_RT_HO,
 * et imprimait en double sur MAIN_RT_AKWA et MAIN_RT01 un trafic qui ne fait que
 * les traverser.
 *
 * Mesure sur le code d'avant les correctifs (src remis a HEAD par git stash) : 2 des 3
 * cas tombent (le trafic en transit imprimait des lignes ICMP ; la console de
 * MAIN_RT_HO restait muette sous `no logging on`). Le temoin « PC11 joint PC6 »
 * passe dans les deux etats : il prouve que le lab transmet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';

interface Machine {
  executeCommand(cmd: string): Promise<string>;
  executeCmdCommand(cmd: string): Promise<string>;
  getPorts(): Array<{ getName(): string }>;
  getDebugService(): { subscribe(listener: (line: string) => void): () => void };
}

const ROUTERS = ['MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO', 'MAIN_RT_AKWA'];
const EXPORT = join(__dirname, '..', 'new_firewall', 'SSH_TP_LAN.topology (7).json');

let machines: Map<string, Machine>;
const lines = new Map<string, string[]>();
const machine = (name: string): Machine => machines.get(name)!;
const icmp = (name: string): string[] => lines.get(name)!.filter((l) => l.includes('ICMP:'));

beforeAll(async () => {
  EquipmentRegistry.resetInstance();
  installSimulationClock();
  const imported = await importTopology(JSON.parse(readFileSync(EXPORT, 'utf8')));
  machines = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d as unknown as Machine]));
  for (const name of ROUTERS) {
    const router = machine(name);
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    for (const port of router.getPorts()) {
      await router.executeCommand(`interface ${port.getName()}`);
      await router.executeCommand('no shutdown');
      await router.executeCommand('exit');
    }
    await router.executeCommand('end');
    await router.executeCommand('debug ip icmp');
    lines.set(name, []);
    router.getDebugService().subscribe((line) => lines.get(name)!.push(line));
  }
}, 120_000);

afterAll(() => { __resetSimulationClock(); });

describe('SSH_TP_LAN: debug ip icmp', () => {
  it('witness: PC11 reaches PC6 across the four routers', async () => {
    expect(await machine('PC11').executeCmdCommand('ping -n 2 192.168.10.3')).toContain('Received = 2');
  });

  it('prints nothing on a router the ping only crosses', async () => {
    for (const name of ROUTERS) expect(icmp(name), name).toEqual([]);
  });

  it('MAIN_RT_HO, configured with no logging on, still prints on its console for a ping to itself', async () => {
    const before = icmp('MAIN_RT_HO').length;
    expect(await machine('PC11').executeCmdCommand('ping -n 1 10.0.10.2')).toContain('Received = 1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const added = icmp('MAIN_RT_HO').slice(before);
    expect(added.some((l) => /echo received, src 192\.168\.50\.2, dst 10\.0\.10\.2/.test(l))).toBe(true);
    expect(added.some((l) => /echo reply sent, src 10\.0\.10\.2, dst 192\.168\.50\.2/.test(l))).toBe(true);
  });
});
