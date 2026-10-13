/**
 * Mesure de depart, dans le navigateur (spec e2e lab-akwa-ping-continu-5-minutes) puis rejouee en
 * Node : sur le lab « SSH_TP_LAN » de l'utilisateur, un `ping -t` d'Akwa vers le Head Office
 * repond une quarantaine de secondes puis tombe en « Request timed out » / « Destination net
 * unreachable ». Les bancs Node precedents ne le voyaient pas parce que la suite de tests demarre
 * les interfaces ALLUMEES (`__setInterfacesBootShutdown(false)`) alors que l'application les
 * demarre ETEINTES, comme un vrai routeur : le `no shutdown` de l'utilisateur est alors un vrai
 * changement d'etat.
 *
 * Chaine mesuree. `no shutdown` sur RT02 Gi0/1 alors que RT_HO Gi0/0 est encore eteinte : le port
 * n'a pas de porteuse, OSPF desactive l'interface (Down, minuteur de Hello arrete). Un Hello de
 * RT_HO arrive pourtant sur cette interface Down ; `processHello` lance une election de DR qui la
 * fait passer de Down a DR, SANS `interfaceUp`, donc sans minuteur de Hello. RT02 ne repete plus
 * jamais de Hello vers RT_HO ; au bout du Dead Interval (40 s) RT_HO perd son voisin, ses routes,
 * et Akwa perd le Head Office. RFC 2328 §9.1 : une interface Down n'emet ni ne recoit aucun trafic
 * de protocole.
 *
 * Correction : `OSPFEngine.processPacket` ecarte tout paquet recu sur une interface Down.
 *
 * Quatre cas, deux tombent avant la correction : le Hello recu sur une interface Down (moteur
 * seul) et le lab complet de l'utilisateur (minuteur de Hello manquant sur RT02 Gi0/1, puis
 * ping PC11 -> PC6 perdu). Les deux autres passent dans les deux etats : le TEMOIN prouve que le
 * refus ne vaut que pour Down (sinon le moteur ne parlerait plus a personne), et `interfaceUp`
 * apres un Hello recu pendant Down rend toujours un minuteur (non-regression : la chaine fautive
 * ne passe pas par `interfaceUp`, elle l'evite).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import {
  OSPF_VERSION_2, OSPF_BACKBONE_AREA, OSPF_DEFAULT_DEAD_INTERVAL, type OSPFHelloPacket,
} from '@/network/ospf/types';
import { importTopology } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installSimulationClock, __resetSimulationClock, type SimulationClock } from '@/events/SimulationClock';
import { __setInterfacesBootShutdown } from '@/network/devices/inspection/InterfaceStatusView';

const hello = (routerId: string): OSPFHelloPacket => ({
  type: 'ospf', version: OSPF_VERSION_2, packetType: 1, routerId, areaId: OSPF_BACKBONE_AREA,
  networkMask: '255.255.255.0', helloInterval: 10, options: 0x02, priority: 1,
  deadInterval: OSPF_DEFAULT_DEAD_INTERVAL, designatedRouter: '0.0.0.0',
  backupDesignatedRouter: '0.0.0.0', neighbors: [],
});

function engineWithInterface() {
  const engine = new OSPFEngine(1);
  engine.setRouterId('2.2.2.2');
  engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  const iface = engine.activateInterface('eth0', '10.0.0.2', '255.255.255.0', OSPF_BACKBONE_AREA, {
    networkType: 'broadcast',
  });
  return { engine, iface };
}

describe('OSPF: an interface in state Down neither receives nor reacts to protocol traffic', () => {
  it('a Hello received on a Down interface leaves it Down', () => {
    const { engine, iface } = engineWithInterface();
    engine.deactivateInterface('eth0');
    engine.processPacket('eth0', '10.0.0.1', hello('1.1.1.1'));
    expect(iface.state).toBe('Down');
    expect(iface.neighbors.size).toBe(0);
  });

  it('witness: the same Hello on a live interface is processed', () => {
    const { engine, iface } = engineWithInterface();
    engine.processPacket('eth0', '10.0.0.1', hello('1.1.1.1'));
    expect(iface.neighbors.has('1.1.1.1')).toBe(true);
  });

  it('an interface brought back up after a Hello during Down still owns its Hello timer', () => {
    const { engine, iface } = engineWithInterface();
    engine.deactivateInterface('eth0');
    engine.processPacket('eth0', '10.0.0.1', hello('1.1.1.1'));
    engine.interfaceUp('eth0');
    expect(iface.helloTimer).not.toBeNull();
  });
});

const EXPORT = join(__dirname, '..', 'new_firewall', 'SSH_TP_LAN.topology (7).json');
const ROUTERS = ['MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO', 'MAIN_RT_AKWA'];

interface Shell {
  executeCommand(cmd: string): Promise<string>;
  executeCmdCommand(cmd: string): Promise<string>;
  getPorts(): Array<{ getName(): string }>;
  ospfIntegration: { ospfEngine: { getInterfaces(): Map<string, { helloTimer: unknown; passive: boolean }> } | null };
}

describe('SSH_TP_LAN opened in the application (interfaces boot shut down), then `no shutdown` everywhere', () => {
  let clock: SimulationClock;
  let machines: Map<string, Shell>;

  beforeEach(async () => {
    __setInterfacesBootShutdown(true);
    EquipmentRegistry.resetInstance();
    clock = installSimulationClock();
    const imported = await importTopology(JSON.parse(readFileSync(EXPORT, 'utf8')));
    machines = new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d as unknown as Shell]));
    for (const name of ROUTERS) {
      const router = machines.get(name)!;
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

  afterEach(() => {
    __setInterfacesBootShutdown(false);
    __resetSimulationClock();
  });

  it('every OSPF interface keeps its Hello timer and PC11 still reaches PC6 five minutes later', async () => {
    for (let elapsed = 0; elapsed < 300_000; elapsed += 30_000) await clock.advance(30_000);
    for (const name of ROUTERS) {
      const engine = machines.get(name)!.ospfIntegration.ospfEngine!;
      for (const [iface, state] of engine.getInterfaces()) {
        expect(state.helloTimer, `${name} ${iface}`).not.toBeNull();
      }
      expect(await machines.get(name)!.executeCommand('show ip ospf neighbor'), name).toMatch(/FULL/);
    }
    expect(await machines.get('PC11')!.executeCmdCommand('ping -n 2 192.168.10.3')).toContain('Received = 2');
  }, 240_000);
});
