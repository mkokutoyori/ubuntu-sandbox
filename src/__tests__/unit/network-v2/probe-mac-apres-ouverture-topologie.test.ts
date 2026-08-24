/**
 * Ouvrir une topologie, puis ajouter un equipement.
 *
 * Signale par un utilisateur comme « un bug avec le ping » : depuis un PC
 * a 192.168.10.15 que la liste de controle AUTORISE explicitement, quinze
 * reponses arrivent, puis vingt-huit se perdent, puis cent vingt-huit se
 * perdent avant que dix-neuf reviennent. Aucune regle ne decide cela.
 *
 * L'export de son laboratoire porte la reponse : son PC1 ajoute apres
 * coup a pour eth0 02:00:00:00:00:01, l'adresse de la GigabitEthernet0/0
 * du routeur, c'est-a-dire la passerelle de son LAN. Le commutateur n'a
 * qu'UNE entree pour cette adresse et elle bat entre le port du routeur
 * et celui du PC1 selon qui a emis en dernier ; tout ce que le PC2 envoie
 * a sa passerelle part chez PC1 pendant les fenetres ou PC1 a parle.
 *
 * Ce que la mesure a trouve derriere : `NetworkDesigner` appelait
 * `clearAll()` APRES `importTopology()`, et `clearAll()` remet les
 * generateurs a zero — donc il effacait le compteur que l'import venait
 * de pousser au-dela de chaque adresse restauree par `MACAddress.reserve`.
 * Le meme appel effacait le compteur de noms (d'ou deux « PC1 » et deux
 * « PC2 » dans son fichier) et VIDAIT le registre d'equipements que
 * l'import venait de remplir.
 *
 * Les cas qui passent des deux cotes sont nommes : « TEMOIN, canevas
 * neuf » (c'est son objet : sans ouverture il n'y a rien a ecraser) et
 * « le fichier decrit tous les ports » (le tour d'ordre interne a l'import
 * n'est atteignable que par un fichier incomplet).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { createDevice, resetDeviceCounters, reserveDeviceName } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { useNetworkStore, buildConnection, type Connection } from '@/store/networkStore';
import type { Equipment } from '@/network/equipment/Equipment';
import type { Router } from '@/network/devices/Router';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import type { LinuxServer } from '@/network/devices/LinuxServer';

function allMacs(devices: Iterable<Equipment>): string[] {
  const out: string[] = [];
  for (const d of devices) {
    for (const p of d.getPorts()) {
      const mac = p.getMAC().toString();
      if (mac !== '00:00:00:00:00:00') out.push(mac);
    }
  }
  return out;
}

function buildAclLab() {
  const router = createDevice('router-cisco', 0, 0) as Router;
  router.setName('Router1');
  const sw1 = createDevice('switch-cisco', 0, 0);
  sw1.setName('Switch1');
  const sw2 = createDevice('switch-cisco', 0, 0);
  sw2.setName('Switch2');
  const server = createDevice('linux-server', 0, 0) as LinuxServer;
  server.setName('Server1');

  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.10.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.20.1'), new SubnetMask('255.255.255.0'));
  server.configureInterface('eth0', new IPAddress('192.168.20.12'), new SubnetMask('255.255.255.0'));
  server.setDefaultGateway(new IPAddress('192.168.20.1'));

  const instances = new Map<string, Equipment>();
  for (const d of [router, sw1, sw2, server]) instances.set(d.getId(), d);

  const connections: Connection[] = [];
  for (const [a, ai, b, bi] of [
    [sw1, 'FastEthernet0/1', router, 'GigabitEthernet0/0'],
    [sw2, 'FastEthernet0/1', router, 'GigabitEthernet0/1'],
    [server, 'eth0', sw2, 'FastEthernet0/2'],
  ] as Array<[Equipment, string, Equipment, string]>) {
    const c = buildConnection(a, ai, b, bi, 'ethernet');
    if (c) connections.push(c);
  }
  return { instances, connections };
}

async function openSavedLab() {
  const { instances, connections } = buildAclLab();
  const json = exportTopology('ACL-LAB', instances, connections);
  const result = await importTopology(json);
  useNetworkStore.getState().replaceTopology(result.deviceInstances, result.connections);
  return result;
}

describe('ouvrir une topologie puis ajouter un equipement', () => {
  beforeEach(() => {
    useNetworkStore.getState().clearAll();
    resetDeviceCounters();
    resetCounters();
  });

  it('TEMOIN, canevas neuf : deux equipements crees a la suite ne partagent aucune adresse', () => {
    const store = useNetworkStore.getState();
    store.addDevice('router-cisco', 0, 0);
    store.addDevice('linux-pc', 0, 0);
    const macs = allMacs(useNetworkStore.getState().deviceInstances.values());
    expect(new Set(macs).size).toBe(macs.length);
  });

  it("l'equipement ajoute apres une ouverture ne porte l'adresse de personne", async () => {
    const opened = await openSavedLab();
    const restored = allMacs(opened.deviceInstances.values());

    useNetworkStore.getState().addDevice('linux-pc', 0, 0);
    const added = [...useNetworkStore.getState().deviceInstances.values()]
      .find((d) => !opened.deviceInstances.has(d.getId()))!;

    const collisions = allMacs([added]).filter((m) => restored.includes(m));
    expect(collisions).toEqual([]);
  });

  it("l'equipement ajoute apres une ouverture ne porte le nom de personne", async () => {
    const opened = await openSavedLab();
    const restoredNames = [...opened.deviceInstances.values()].map((d) => d.getName());

    useNetworkStore.getState().addDevice('linux-server', 0, 0);
    const added = [...useNetworkStore.getState().deviceInstances.values()]
      .find((d) => !opened.deviceInstances.has(d.getId()))!;

    expect(restoredNames).not.toContain(added.getName());
  });

  it('les equipements ouverts restent inscrits au registre', async () => {
    const opened = await openSavedLab();
    const registry = EquipmentRegistry.getInstance();
    for (const device of opened.deviceInstances.values()) {
      expect(registry.has(device.getId())).toBe(true);
    }
  });

  it('le PC ajoute apres une ouverture traverse vraiment le routeur', async () => {
    const opened = await openSavedLab();
    const byName = new Map([...opened.deviceInstances.values()].map((d) => [d.getName(), d]));
    const sw1 = byName.get('Switch1')!;

    useNetworkStore.getState().addDevice('linux-pc', 0, 0);
    const pc = [...useNetworkStore.getState().deviceInstances.values()]
      .find((d) => !opened.deviceInstances.has(d.getId())) as LinuxPC;
    useNetworkStore.getState().addConnection(pc.getId(), 'eth0', sw1.getId(), 'FastEthernet0/6', 'ethernet');

    pc.configureInterface('eth0', new IPAddress('192.168.10.15'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('192.168.10.1'));

    const out = await pc.executeCommand('ping -c 2 192.168.20.12');
    expect(out).toMatch(/, 0% packet loss/);
  }, 20_000);

  it('le fichier decrit tous les ports : une adresse restauree ne heurte aucune adresse generee', async () => {
    const opened = await openSavedLab();
    const macs = allMacs(opened.deviceInstances.values());
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('reserveDeviceName pousse le compteur du prefixe et ignore un nom sans nombre', () => {
    reserveDeviceName('PC7');
    expect((createDevice('linux-pc', 0, 0) as Equipment).getName()).toBe('PC8');
    reserveDeviceName('Coeur');
    expect((createDevice('linux-pc', 0, 0) as Equipment).getName()).toBe('PC9');
  });

  it("une adresse hors du bloc du generateur ne deplace pas le compteur", () => {
    MACAddress.reserve(new MACAddress('00:1a:2b:3c:4d:5e'));
    expect(MACAddress.generate().toString()).toBe('02:00:00:00:00:01');
  });
});
