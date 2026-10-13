/**
 * Lab de l'utilisateur (`SSH_TP_LAN.topology (7).json`, exporte depuis son navigateur) : un PC
 * d'Akwa (PC11, VLAN 40, derriere MAIN_RT_AKWA en router-on-a-stick) doit joindre un PC du Head
 * Office (PC6, 192.168.10.3, derriere MAIN_RT_HO). Signale : adjacence OSPF « INIT » cote RT01,
 * aucune route OSPF cote Akwa, « Destination net unreachable » de la passerelle d'Akwa, y compris
 * apres un `no shutdown` sur les interfaces des routeurs.
 *
 * Les defauts mesures sur ce lab, tous fermes ailleurs (voir les sondes
 * probe-ospf-sur-sous-interface-dot1q et probe-ospf-apres-import-de-topologie) : une
 * sous-interface dot1Q etait jugee sur son propre port, sans cable ni porteuse, donc ni Hello ni
 * ping ni sondage ne partaient d'elle ; et l'import rejouait la configuration des routeurs avant
 * celle des commutateurs sans jamais relancer la convergence. Cette sonde importe le fichier TEL
 * QUEL, horloge de simulation installee, et rejoue le geste de l'utilisateur.
 *
 * Sur les six cas, cinq tombent sur le code d'avant les correctifs (adjacences, route OSPF d'Akwa,
 * ping et tracert dans le sens Akwa -> Head Office, ping dans le sens inverse) ; le temoin « les
 * quatre routeurs et PC6 existent dans le fichier » passe dans les deux etats.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';

interface Shell {
  executeCommand(cmd: string): Promise<string>;
  executeCmdCommand(cmd: string): Promise<string>;
  getPorts(): Array<{ getName(): string }>;
}

const ROUTERS = ['MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO', 'MAIN_RT_AKWA'];
const EXPORT = join(__dirname, '..', 'new_firewall', 'SSH_TP_LAN.topology (7).json');

let machines: Map<string, Shell>;

const machine = (name: string): Shell => machines.get(name)!;

beforeAll(async () => {
  EquipmentRegistry.resetInstance();
  installSimulationClock();
  const imported = await importTopology(JSON.parse(readFileSync(EXPORT, 'utf8')));
  machines = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d as unknown as Shell]));
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
  }
}, 120_000);

afterAll(() => { __resetSimulationClock(); });

describe('SSH_TP_LAN export: Akwa reaches the Head Office', () => {
  it('witness: the four routers and both hosts are in the file', () => {
    for (const name of [...ROUTERS, 'PC6', 'PC11']) expect(machines.has(name), name).toBe(true);
  });

  it('every OSPF adjacency is Full, none stuck in INIT or EXSTART', async () => {
    for (const name of ROUTERS) {
      const neighbors = await machine(name).executeCommand('show ip ospf neighbor');
      expect(neighbors, name).toMatch(/FULL/);
      expect(neighbors, name).not.toMatch(/INIT|EXSTART|2WAY/);
    }
  });

  it('MAIN_RT_AKWA learns the Head Office LANs through OSPF', async () => {
    const routes = await machine('MAIN_RT_AKWA').executeCommand('show ip route');
    expect(routes).toMatch(/O\s+192\.168\.10\.0\/24.*via 10\.0\.20\.1/);
    expect(routes).toMatch(/O\s+192\.168\.20\.0\/24.*via 10\.0\.20\.1/);
  });

  it('PC11 pings PC6', async () => {
    expect(await machine('PC11').executeCmdCommand('ping -n 2 192.168.10.3')).toContain('Received = 2');
  });

  it('PC11 traces the route to PC6 through the four routers', async () => {
    const trace = await machine('PC11').executeCmdCommand('tracert -d 192.168.10.3');
    expect(trace).toContain('Trace complete');
    for (const hop of ['192.168.50.1', '10.0.20.1', '192.168.30.2', '10.0.10.2', '192.168.10.3']) {
      expect(trace, hop).toContain(hop);
    }
  });

  it('PC6 pings PC11 back', async () => {
    expect(await machine('PC6').executeCommand('ping -c 1 192.168.50.2')).toContain('1 received');
  });
});
