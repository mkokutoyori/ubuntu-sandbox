/**
 * Une interface VIRTUELLE n'a pas de prise, donc aucun cable ne s'y branche.
 *
 * Mesure de depart, sur le canevas : `lo`, `dummy0`, `eth0.10`, `bond0`,
 * `veth0`, `Loopback0`, `Tunnel0`, `Port-channel1`, `LoopBack0` et `NULL0`
 * etaient TOUS proposes au cablage, cote a cote avec les ports physiques
 * et sans rien pour les distinguer.
 *
 * Discrimine par `git stash` : 17 cas sur 18 tombent avant correctif.
 * Le compte merite d'etre decoupe plutot qu'annonce en bloc, trois de ces
 * dix-sept tombant pour une raison STRUCTURELLE — `Port.acceptsCable()`
 * n'existait pas, donc l'appel leve — et non parce que la machine
 * repondait autre chose : « un port Serial reste cablable », « un port
 * deja cable ne se recable pas » et la moitie « pourquoi » du cas `veth`.
 * Ils gardent la portee de la regle, ils ne prouvent pas le defaut.
 *
 * Le seul cas qui passe des deux cotes est le TEMOIN, et c'est son objet :
 * sans lui, un laboratoire mal bati et une regle trop large seraient
 * indiscernables.
 *
 * Un cas a ete MAL PREDIT et le dire vaut mieux que de le taire : « le
 * port physique reste libre apres le refus » devait passer des deux
 * cotes, et il tombe. La raison est le defaut lui-meme, en pire que ce
 * que la mesure avait vu : avant correctif le cable pose sur la boucle
 * OCCUPAIT le port physique d'en face, si bien qu'une erreur de clic sur
 * `lo` consommait une vraie interface du voisin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { buildInterfaceList } from '@/components/network/interface-selector-logic';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { Cable } from '@/network/hardware/Cable';
import type { Equipment } from '@/network/equipment/Equipment';

type Shell = { executeCommand: (c: string) => Promise<string> | string };

function shell(device: Equipment): Shell {
  return device as unknown as Shell;
}

function ui(deviceId: string) {
  return useNetworkStore.getState().getDevices().find(d => d.id === deviceId)!;
}

function rows(deviceId: string) {
  const dev = ui(deviceId);
  const conns = useNetworkStore.getState().connections;
  return buildInterfaceList(deviceId, dev.interfaces, conns, 'ethernet');
}

function row(deviceId: string, name: string) {
  return rows(deviceId).find(r => r.name === name);
}

async function run(device: Equipment, commands: string[]): Promise<void> {
  for (const c of commands) await shell(device).executeCommand(c);
}

describe('un cable ne se branche pas sur une interface virtuelle', () => {
  let store: ReturnType<typeof useNetworkStore.getState>;

  beforeEach(() => {
    useNetworkStore.getState().clearAll();
    store = useNetworkStore.getState();
  });

  const linuxLab = async () => {
    const pcA = store.addDevice('linux-pc', 0, 0).id;
    const pcB = store.addDevice('linux-pc', 200, 0).id;
    const a = useNetworkStore.getState().deviceInstances.get(pcA)!;
    await run(a, [
      'ip link add dummy0 type dummy',
      'ip link add link eth0 name eth0.10 type vlan id 10',
      'ip link add bond0 type bond',
      'ip link add veth0 type veth peer name veth1',
    ]);
    return { pcA, pcB, a };
  };

  it('TEMOIN : un port physique se cable, et les deux machines se parlent', async () => {
    const { pcA, pcB } = await linuxLab();
    expect(row(pcA, 'eth0')?.isAvailable).toBe(true);

    const conn = store.addConnection(pcA, 'eth0', pcB, 'eth0');
    expect(conn).not.toBeNull();

    const a = useNetworkStore.getState().deviceInstances.get(pcA)!;
    const b = useNetworkStore.getState().deviceInstances.get(pcB)!;
    await run(a, ['ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 up']);
    await run(b, ['ip addr add 10.0.0.2/24 dev eth0', 'ip link set eth0 up']);
    const out = String(await shell(a).executeCommand('ping -c 2 10.0.0.2'));
    expect(out).toMatch(/, 0% packet loss/);
  });

  it('la boucle `lo` n est pas proposee au cablage', async () => {
    const { pcA } = await linuxLab();
    expect(row(pcA, 'lo')?.isAvailable).toBe(false);
    expect(row(pcA, 'lo')?.unavailableBecause).toBe('virtual');
  });

  it('le cable REFUSE la boucle, il ne se contente pas de ne pas la proposer', async () => {
    const { pcA, pcB, a } = await linuxLab();
    const b = useNetworkStore.getState().deviceInstances.get(pcB)!;
    const cable = new Cable('essai');
    expect(cable.connect(a.getPort('lo')!, b.getPort('eth0')!)).toBe(false);
    expect(a.getPort('lo')!.getCable()).toBeNull();
    expect(b.getPort('eth0')!.getCable()).toBeNull();
  });

  it('une sous-interface VLAN n est pas proposee au cablage', async () => {
    const { pcA } = await linuxLab();
    expect(row(pcA, 'eth0.10')?.isAvailable).toBe(false);
    expect(row(pcA, 'eth0.10')?.unavailableBecause).toBe('virtual');
  });

  it('une interface `dummy` n est pas proposee au cablage', async () => {
    const { pcA } = await linuxLab();
    expect(row(pcA, 'dummy0')?.isAvailable).toBe(false);
  });

  it('une agregation `bond` n est pas proposee au cablage : ce sont ses membres qui portent les cables', async () => {
    const { pcA } = await linuxLab();
    expect(row(pcA, 'bond0')?.isAvailable).toBe(false);
    expect(row(pcA, 'eth0')?.isAvailable).toBe(true);
  });

  it('une extremite `veth` A une prise — le selecteur la dit CABLEE et non virtuelle', async () => {
    const { pcA, a } = await linuxLab();
    expect(a.getPort('veth0')!.getCable()).not.toBeNull();
    expect(row(pcA, 'veth0')?.isAvailable).toBe(false);
    expect(row(pcA, 'veth0')?.unavailableBecause).toBe('cabled');
  });

  const ciscoLab = async () => {
    const rid = store.addDevice('router-cisco', 0, 0).id;
    const r = useNetworkStore.getState().deviceInstances.get(rid)!;
    await run(r, [
      'enable', 'configure terminal',
      'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
      'interface Tunnel0', 'exit',
      'interface Port-channel1', 'exit',
      'interface Serial0/0/0', 'exit',
    ]);
    return { rid, r };
  };

  it('une Loopback IOS n est pas proposee au cablage', async () => {
    const { rid } = await ciscoLab();
    expect(row(rid, 'Loopback0')?.isAvailable).toBe(false);
    expect(row(rid, 'Loopback0')?.unavailableBecause).toBe('virtual');
  });

  it('un Tunnel IOS n est pas propose au cablage', async () => {
    const { rid } = await ciscoLab();
    expect(row(rid, 'Tunnel0')?.isAvailable).toBe(false);
  });

  it('un Port-channel IOS n est pas propose au cablage', async () => {
    const { rid } = await ciscoLab();
    expect(row(rid, 'Port-channel1')?.isAvailable).toBe(false);
  });

  it('un port Serial reste cablable : la regle ne deborde pas sur du materiel', async () => {
    const { rid, r } = await ciscoLab();
    expect(r.getPort('Serial0/0/0')).toBeDefined();
    expect(r.getPort('Serial0/0/0')!.acceptsCable()).toBe(true);
    expect(row(rid, 'GigabitEthernet0/0')?.isAvailable).toBe(true);
  });

  const huaweiLab = async () => {
    const hid = store.addDevice('router-huawei', 0, 0).id;
    const h = useNetworkStore.getState().deviceInstances.get(hid)!;
    await run(h, [
      'system-view',
      'interface LoopBack0', 'ip address 2.2.2.2 32', 'quit',
      'interface NULL0', 'quit',
    ]);
    return { hid, h };
  };

  it('une LoopBack VRP n est pas proposee au cablage', async () => {
    const { hid } = await huaweiLab();
    expect(row(hid, 'LoopBack0')?.isAvailable).toBe(false);
    expect(row(hid, 'LoopBack0')?.unavailableBecause).toBe('virtual');
  });

  it('une interface NULL VRP n est pas proposee au cablage', async () => {
    const { hid } = await huaweiLab();
    expect(row(hid, 'NULL0')?.isAvailable).toBe(false);
  });

  it('le magasin refuse la connexion vers une boucle et n en garde aucune trace', async () => {
    const { pcA, pcB } = await linuxLab();
    expect(store.addConnection(pcA, 'lo', pcB, 'eth0')).toBeNull();
    expect(useNetworkStore.getState().connections).toHaveLength(0);
  });

  it('le geste du selecteur — startConnecting puis finishConnecting — ne cable pas une boucle', async () => {
    const { pcA, pcB } = await linuxLab();
    store.startConnecting(pcA, 'lo', 'ethernet');
    store.finishConnecting(pcB, 'eth0');
    expect(useNetworkStore.getState().connections).toHaveLength(0);
  });

  it('le port physique reste libre apres le refus', async () => {
    const { pcA, pcB } = await linuxLab();
    store.addConnection(pcA, 'lo', pcB, 'eth0');
    expect(store.addConnection(pcA, 'eth0', pcB, 'eth0')).not.toBeNull();
  });

  it('un port deja cable ne se recable pas', async () => {
    const { pcA, pcB, a } = await linuxLab();
    store.addConnection(pcA, 'eth0', pcB, 'eth0');
    expect(a.getPort('eth0')!.acceptsCable()).toBe(false);
    expect(row(pcA, 'eth0')?.isAvailable).toBe(false);
  });

  it('une topologie enregistree qui porte un cable sur une boucle le PERD au rechargement, sans tomber', async () => {
    const { pcA, pcB } = await linuxLab();
    const conn = {
      id: 'faux', type: 'ethernet' as const,
      sourceDeviceId: pcA, sourceInterfaceId: 'lo',
      targetDeviceId: pcB, targetInterfaceId: 'eth0',
      cable: new Cable('faux'),
    };
    const json = exportTopology('essai',
      useNetworkStore.getState().deviceInstances, [conn]);
    const back = await importTopology(json);
    expect(back.connections).toHaveLength(0);
    expect(back.deviceInstances.size).toBe(2);
  });
});
