/**
 * VRP a UN magasin LLDP, et `lldp tlv-select` retire vraiment le TLV.
 *
 * Mesure de depart sur un routeur Huawei, a un seul instant : le vrai
 * `LldpAgent` etait ACTIF et avait appris un voisin, pendant que
 * `display lldp local` repondait « Info: LLDP is disabled. » -- parce
 * que `lldp enable` ecrivait dans `_huaweiLldp`, un sac de chaines
 * brutes distinct de l'agent, tandis que la vue des voisins lisait
 * l'agent. Deux magasins pour un fait. Trouve avec :
 *  - `display lldp neighbor` rendait les libelles CISCO (`Local Intf:`,
 *    `Chassis id:`) sur une invite VRP ;
 *  - `Time remaining: 0 seconds` -- le rendu comptait sur `Date.now()`
 *    quand l'agent estampille sur l'horloge du planificateur ;
 *  - `display lldp statistics` repondait « No LLDP neighbors. », une
 *    phrase sur les voisins en reponse a une question sur les
 *    statistiques, via le glouton `display lldp` ;
 *  - `lldp enable` etait ABSENT de `display current-configuration`,
 *    donc perdu au rechargement d'une topologie.
 *
 * Discrimine par `git stash` : 17 cas tombent avant correctif. J'en
 * avais annonce 12 : la mesure a corrige la prevision, et l'ecart est
 * instructif -- j'avais compte la moitie VRP en oubliant que TOUTE la
 * famille `lldp tlv-select` tombe aussi, la commande n'existant pas du
 * tout avant.
 *
 * Les 3 qui passent des deux cotes, nommes :
 *  - « le TEMOIN : le voisin est appris » : l'agent fonctionnait deja,
 *    c'est la VUE qui mentait ; sans ce cas on ne saurait pas si le
 *    laboratoire tient debout.
 *  - « display lldp neighbor brief nomme le voisin » : cette vue-la
 *    lisait deja l'agent.
 *  - « un mot-cle de TLV inconnu est refuse » : il l'etait deja, le
 *    chemin `lldp tlv-select` n'existant pas du tout.
 *
 * References : capture reelle `ntc-templates`
 * `tests/huawei_vrp/display_lldp_neighbor/huawei_vrp_display_lldp_neighbor.raw`
 * (`Chassis type :macAddress`, `Chassis ID :f55f-c2c5-e180`,
 * `System capabilities supported :bridge router`, `Expired time :102s`,
 * et `X has 0 neighbors` pour une interface sans voisin) ; noms de
 * champs de `display lldp statistics` (Sent Frames / Received Frames /
 * Frames Discarded / Frames Error / TLVs Discarded / TLVs Unrecognized /
 * Neighbors Expired) issus de la documentation Huawei. Cote Cisco,
 * `lldp tlv-select` est une commande d'INTERFACE (guide de
 * configuration LLDP des Catalyst 9000 : « no lldp tlv-select
 * power-management »).
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

type Dev = { executeCommand(c: string): Promise<string> };

async function vue(d: Dev, ...cmds: string[]) {
  await d.executeCommand('system-view');
  for (const c of cmds) await d.executeCommand(c);
  await d.executeCommand('quit');
}

function paireRouteurs() {
  const a = new HuaweiRouter('R-A');
  const b = new HuaweiRouter('R-B');
  new Cable('c1').connect(a.getPorts()[0], b.getPorts()[0]);
  return { a, b };
}

async function labo() {
  const { a, b } = paireRouteurs();
  await vue(a, 'lldp enable');
  await vue(b, 'lldp enable');
  return { a, b };
}

describe('VRP : une seule verite LLDP', () => {
  it('le TEMOIN : le voisin est appris par l agent', async () => {
    const { a } = await labo();
    expect(a.getLldpAgent().getNeighbors()).toHaveLength(1);
  });

  it('display lldp local dit ACTIF quand l agent est actif', async () => {
    const { a } = await labo();
    const out = await a.executeCommand('display lldp local');
    expect(out).not.toContain('LLDP is disabled');
    expect(out).toContain('LLDP Status :enabled');
    expect(out).toContain('System name :R-A');
  });

  it('undo lldp enable coupe le vrai agent', async () => {
    const { a } = await labo();
    await vue(a, 'undo lldp enable');
    expect(a.getLldpAgent().getConfig().enabled).toBe(false);
    expect(await a.executeCommand('display lldp local')).toContain('LLDP Status :disabled');
  });

  it('display lldp neighbor porte les libelles VRP, pas ceux d IOS', async () => {
    const { a } = await labo();
    const out = await a.executeCommand('display lldp neighbor');
    expect(out).toContain('Chassis type :macAddress');
    expect(out).toContain('Port ID type :interfaceName');
    expect(out).not.toContain('Local Intf:');
    expect(out).not.toContain('Chassis id:');
  });

  it('l adresse de chassis est en triplets a TIRETS, forme VRP', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('display lldp neighbor'))
      .toMatch(/Chassis ID :[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('les capacites sont des MOTS VRP, pas des lettres IOS', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('display lldp neighbor'))
      .toContain('System capabilities supported :router');
  });

  it('Expired time compte sur l horloge du planificateur, pas 0', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('display lldp neighbor')).toContain('Expired time :120s');
  });

  it('une interface sans voisin le DIT, comme la vraie machine', async () => {
    const { a } = await labo();
    const out = await a.executeCommand('display lldp neighbor');
    expect(out).toContain('GigabitEthernet0/0/1 has 0 neighbors');
  });

  it('display lldp neighbor brief nomme le voisin', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('display lldp neighbor brief')).toContain('R-B');
  });

  it('display lldp statistics MESURE au lieu de parler des voisins', async () => {
    const { a } = await labo();
    const out = await a.executeCommand('display lldp statistics');
    expect(out).not.toContain('No LLDP neighbors');
    expect(out).toContain('LLDP statistics global Information:');
    expect(out).toMatch(/Statistics for GigabitEthernet0\/0\/0:/);
    expect(out).toMatch(/Sent Frames :[1-9]/);
    expect(out).toMatch(/Received Frames :[1-9]/);
  });

  it('reset lldp statistics remet les compteurs a zero', async () => {
    const { a } = await labo();
    await a.executeCommand('reset lldp statistics');
    expect(await a.executeCommand('display lldp statistics')).toContain('Sent Frames :0');
  });

  it('lldp enable est rendu dans la configuration, donc rejoue', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('display current-configuration')).toContain('lldp enable');
  });

  it('le commutateur VRP rend les MEMES vues que le routeur', async () => {
    const s1 = new HuaweiSwitch('switch-huawei', 'SW-1', 4);
    const s2 = new HuaweiSwitch('switch-huawei', 'SW-2', 4);
    new Cable('c').connect(s1.getPorts()[0], s2.getPorts()[0]);
    await vue(s1, 'lldp enable');
    await vue(s2, 'lldp enable');
    const out = await s1.executeCommand('display lldp neighbor');
    expect(out).toContain('Chassis type :macAddress');
    expect(out).toContain('System capabilities supported :bridge');
    expect(await s1.executeCommand('display lldp statistics'))
      .toContain('LLDP statistics global Information:');
  });
});

describe('Cisco : lldp tlv-select retire vraiment le TLV', () => {
  async function conf(d: Dev, ...cmds: string[]) {
    await d.executeCommand('enable');
    await d.executeCommand('configure terminal');
    for (const c of cmds) await d.executeCommand(c);
    await d.executeCommand('end');
  }

  function paire() {
    const a = new CiscoSwitch('switch-cisco', 'SW-A', 4);
    const b = new CiscoSwitch('switch-cisco', 'SW-B', 4);
    new Cable('c').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);
    return { a, b };
  }

  it('no lldp tlv-select system-name : le VOISIN ne voit plus le nom', async () => {
    const { a, b } = paire();
    await conf(a, 'lldp run');
    await conf(b, 'lldp run', 'interface FastEthernet0/1', 'no lldp tlv-select system-name');
    const n = a.getLldpAgent().getNeighbors()[0];
    expect(n).toBeDefined();
    expect(n.systemName).toBeUndefined();
    expect(await a.executeCommand('show lldp neighbors detail'))
      .toContain('System Name - not advertised');
  });

  it('no lldp tlv-select management-address retire l adresse', async () => {
    const { a, b } = paire();
    await conf(a, 'lldp run');
    await conf(b, 'lldp run',
      'interface FastEthernet0/2', 'no switchport', 'ip address 10.0.0.2 255.255.255.0',
      'interface FastEthernet0/1', 'no lldp tlv-select management-address');
    expect(a.getLldpAgent().getNeighbors()[0]?.managementAddresses).toBeUndefined();
  });

  it('le TLV retire est rendu dans la configuration, donc rejoue', async () => {
    const { a } = paire();
    await conf(a, 'lldp run', 'interface FastEthernet0/1',
      'no lldp tlv-select system-description');
    expect(await a.executeCommand('show running-config'))
      .toContain('no lldp tlv-select system-description');
  });

  it('lldp tlv-select remet le TLV', async () => {
    const { a, b } = paire();
    await conf(a, 'lldp run');
    await conf(b, 'lldp run', 'interface FastEthernet0/1', 'no lldp tlv-select system-name');
    expect(a.getLldpAgent().getNeighbors()[0]?.systemName).toBeUndefined();
    await conf(b, 'interface FastEthernet0/1', 'lldp tlv-select system-name');
    expect(a.getLldpAgent().getNeighbors()[0]?.systemName).toBe('SW-B');
  });

  it('un mot-cle de TLV inconnu est refuse', async () => {
    const { a } = paire();
    await a.executeCommand('enable');
    await a.executeCommand('configure terminal');
    await a.executeCommand('interface FastEthernet0/1');
    expect(await a.executeCommand('no lldp tlv-select zorglub')).toContain('Invalid input');
  });

  it('show lldp traffic MESURE les trames', async () => {
    const { a, b } = paire();
    await conf(a, 'lldp run');
    await conf(b, 'lldp run');
    const out = await a.executeCommand('show lldp traffic');
    expect(out).toContain('LLDP traffic statistics:');
    expect(out).toMatch(/Total frames out: [1-9]/);
    expect(out).toMatch(/Total frames in: [1-9]/);
  });

  it('show lldp local-info decrit ce que la machine ANNONCE vraiment', async () => {
    const { a } = paire();
    await conf(a, 'lldp run', 'interface FastEthernet0/1',
      'no lldp tlv-select system-name');
    const out = await a.executeCommand('show lldp local-info');
    expect(out).toContain('Local LLDP Information:');
    expect(out).toContain('System Name: SW-A');
    expect(out).toMatch(/Chassis ID: [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
  });
});
