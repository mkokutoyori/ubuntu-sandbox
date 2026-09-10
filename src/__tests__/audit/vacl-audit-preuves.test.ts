/*
 * AUDIT — les VACL (`vlan access-map` / `vlan filter`). Non-regression.
 *
 * Sixieme lot de la serie ACL, apres les routeurs Cisco et VRP, les deux
 * commutateurs et les ACL IPv6. Le mecanisme, lui, existait : un VACL
 * pose sur un VLAN COUPE vraiment le trafic, et le refus implicite de
 * fin de carte est applique. Ce qui manquait tenait ailleurs.
 *
 * LE CONSTAT QUI DOMINE (W-03) : `vlan filter M vlan-list 10` n'etait
 * rendu NULLE PART dans la configuration. Les cartes revenaient a
 * l'import d'une topologie, la LIAISON non — donc le filtre cessait de
 * s'appliquer sans un mot. C'est le miroir exact du defaut IPv6 V-01,
 * ou la liaison etait rendue et la liste absente ; dans les deux cas le
 * resultat est le meme et c'est le pire : une ouverture silencieuse.
 *
 * REFERENCE : documentation Cisco (Catalyst / IR8340), lue et non tiree
 * de memoire — plage de sequence 0-65535, `no vlan access-map <nom>
 * <seq>` retire LA SEQUENCE et `no vlan access-map <nom>` la carte
 * entiere, une clause `match` accepte UNE OU PLUSIEURS ACL, et l'action
 * s'ecrit `{drop [log] | forward [capture | vlan <id>] | redirect ...}`.
 *
 * TROIS FAUSSES PISTES, ecartees en mesurant mieux plutot qu'en
 * corrigeant du code juste — elles sont citees parce qu'une sonde qui
 * ne dit pas ce qu'elle a ecarte laisse croire qu'elle a tout vu :
 *   - « `show vlan filter` n'affiche jamais de VLAN actif » : le
 *     laboratoire de la sonde ne CREAIT pas le VLAN. Le rendu distingue
 *     correctement configure et actif (cas C1) ;
 *   - « `show vlan access-map <nom>` ignore son argument » : la sonde
 *     n'avait qu'UNE carte, donc ne discriminait rien (cas C2) ;
 *   - « le rejeu d'une configuration ne restaure rien » : la sonde
 *     rejouait ligne a ligne au lieu d'appeler `replayVendorConfig`,
 *     qui revient a la vue de base entre deux blocs. C'est le vrai
 *     chemin d'import, et c'est lui qu'il faut mesurer.
 *
 * DISCRIMINATION (`git stash` des deux fichiers de production) : 9 des
 * 12 cas tombent — un de plus que prevu, `no vlan access-map <nom>` sans
 * sequence etant deja juste. Les 3 qui passent des deux cotes sont
 * nommes ici : cette suppression de carte entiere ; le VACL qui coupe
 * avec le refus implicite de fin de carte (acquis anterieur, et TEMOIN
 * que le laboratoire est sain, sans quoi une sonde faite de refus ne
 * prouverait rien) ; et l'ACE `deny` employee comme classifieur, deja
 * juste et que ce lot ne touche pas.
 *
 * Reference des identifiants W-xx : AUDIT-ACL-VACL.md.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { replayVendorConfig } from '@/store/topologySerializer';

async function switchOnly(commands: string[]): Promise<{ device: CiscoSwitch; out: string[] }> {
  const device = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const out: string[] = [];
  for (const command of commands) out.push(await device.executeCommand(command));
  return { device, out };
}

async function lan(name = 'SW1', cableA = 'a1', cableB = 'a2') {
  const device = new CiscoSwitch('switch-cisco', name, 8);
  const left = new LinuxPC(`${name}-pc1`, `${name}PC1`, 0, 0);
  const right = new LinuxPC(`${name}-pc2`, `${name}PC2`, 0, 0);
  new Cable(cableA).connect(left.getPorts()[0], device.getPort('FastEthernet0/1')!);
  new Cable(cableB).connect(right.getPorts()[0], device.getPort('FastEthernet0/2')!);
  for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit']) await device.executeCommand(c);
  for (const port of ['FastEthernet0/1', 'FastEthernet0/2']) {
    for (const c of [`interface ${port}`, 'switchport mode access', 'switchport access vlan 10', 'exit']) {
      await device.executeCommand(c);
    }
  }
  await device.executeCommand('end');
  await left.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await right.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { device, left, right };
}

const FILTER_LAB = [
  'enable', 'configure terminal',
  'ip access-list extended AL', 'permit ip host 10.0.0.1 any', 'exit',
  'vlan access-map M 10', 'match ip address AL', 'action drop', 'exit',
  'vlan access-map M 20', 'action forward', 'exit',
  'vlan filter M vlan-list 10', 'end',
];

describe('VACL — non-regression', () => {

  it('W-03 the running-config renders the BINDING, not only the maps', async () => {
    const { device } = await lan();
    for (const c of FILTER_LAB) await device.executeCommand(c);
    const config = await device.executeCommand('show running-config');
    expect(config).toContain('vlan access-map M 10');
    expect(config).toContain(' match ip address AL');
    expect(config).toContain('vlan filter M vlan-list 10');
  }, 30000);

  it('W-03 a filter survives a real topology round-trip and still drops', async () => {
    const { device, left } = await lan('SWA', 'b1', 'b2');
    for (const c of FILTER_LAB) await device.executeCommand(c);
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain('100% packet loss');

    const config = await device.executeCommand('show running-config');
    const { device: reloaded, left: reloadedLeft } = await lan('SWB', 'b3', 'b4');
    await replayVendorConfig(reloaded, config);

    expect(reloaded.getVlanAccessMapNames()).toEqual(['M']);
    expect([...reloaded.getVlanFilterBindings()]).toEqual([['M', [10]]]);
    expect(await reloadedLeft.executeCommand('ping -c 2 10.0.0.2')).toContain('100% packet loss');
  }, 40000);

  it('W-01 a match clause carries one or more ACLs', async () => {
    const { device } = await switchOnly([
      'enable', 'configure terminal', 'vlan access-map M 10', 'match ip address A1 A2',
    ]);
    expect(device.getVlanAccessMap('M')![0].matchIpAcls).toEqual(['A1', 'A2']);
  });

  it('W-01 any listed ACL matching makes the entry match', async () => {
    const { device, left } = await lan('SWC', 'c1', 'c2');
    for (const c of [
      'enable', 'configure terminal',
      'ip access-list extended FIRST', 'permit ip host 10.9.9.9 any', 'exit',
      'ip access-list extended SECOND', 'permit ip host 10.0.0.1 any', 'exit',
      'vlan access-map M 10', 'match ip address FIRST SECOND', 'action drop', 'exit',
      'vlan access-map M 20', 'action forward', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]) await device.executeCommand(c);
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain('100% packet loss');
  }, 30000);

  it('W-02 `no vlan access-map <name> <seq>` removes only that sequence', async () => {
    const { device } = await switchOnly([
      'enable', 'configure terminal',
      'vlan access-map M 10', 'action drop', 'exit',
      'vlan access-map M 20', 'action forward', 'exit',
      'no vlan access-map M 20',
    ]);
    expect(device.getVlanAccessMap('M')!.map((r) => r.sequence)).toEqual([10]);
  });

  it('W-02 `no vlan access-map <name>` still removes the whole map and unbinds it', async () => {
    const { device } = await switchOnly([
      'enable', 'configure terminal',
      'vlan access-map M 10', 'action drop', 'exit',
      'vlan filter M vlan-list 10',
      'no vlan access-map M',
    ]);
    expect(device.getVlanAccessMapNames()).toEqual([]);
    expect([...device.getVlanFilterBindings()]).toEqual([]);
  });

  it('W-04 `action forward capture` and `action drop log` are kept, not downgraded', async () => {
    const { device, out } = await switchOnly([
      'enable', 'configure terminal',
      'vlan access-map M 10', 'action forward capture', 'exit',
      'vlan access-map M 20', 'action drop log', 'exit', 'end',
    ]);
    expect(out[3]).toBe('');
    expect(out[6]).toBe('');
    const rules = device.getVlanAccessMap('M')!;
    expect(rules[0]).toMatchObject({ action: 'forward', capture: true });
    expect(rules[1]).toMatchObject({ action: 'drop', logDrop: true });
    const config = await device.executeCommand('show running-config');
    expect(config).toContain(' action forward capture');
    expect(config).toContain(' action drop log');
  });

  it('W-04 an unknown action qualifier is refused', async () => {
    const { out } = await switchOnly([
      'enable', 'configure terminal', 'vlan access-map M 10',
      'action forward zorglub', 'action drop zorglub',
    ]);
    expect(out[3]).toContain('Invalid input');
    expect(out[4]).toContain('Invalid input');
  });

  it('W-05 a sequence outside 0-65535 is refused', async () => {
    const { device, out } = await switchOnly([
      'enable', 'configure terminal',
      'vlan access-map M 70000', 'vlan access-map N abc', 'vlan access-map P 65535',
    ]);
    expect(out[2]).toContain('Invalid sequence number');
    expect(out[3]).toContain('Invalid sequence number');
    expect(out[4]).toBe('');
    expect(device.getVlanAccessMapNames()).toEqual(['P']);
  });

  it('W-06 an extra token after the sequence is refused', async () => {
    const { device, out } = await switchOnly([
      'enable', 'configure terminal', 'vlan access-map M 10 zorglub',
    ]);
    expect(out[2]).toContain('Invalid input');
    expect(device.getVlanAccessMapNames()).toEqual([]);
  });

  it('a VACL really drops, and unmatched traffic hits the implicit deny', async () => {
    const { device, left } = await lan('SWD', 'd1', 'd2');
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain('0% packet loss');
    for (const c of FILTER_LAB) await device.executeCommand(c);
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain('100% packet loss');

    const { device: strict, left: strictLeft } = await lan('SWE', 'e1', 'e2');
    for (const c of [
      'enable', 'configure terminal',
      'ip access-list extended OTHER', 'permit ip host 10.9.9.9 any', 'exit',
      'vlan access-map M 10', 'match ip address OTHER', 'action forward', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]) await strict.executeCommand(c);
    expect(await strictLeft.executeCommand('ping -c 2 10.0.0.2')).toContain('100% packet loss');
  }, 40000);

  it('a deny ACE is a classifier that does not match, not a drop', async () => {
    const { device, left } = await lan('SWF', 'f1', 'f2');
    for (const c of [
      'enable', 'configure terminal',
      'ip access-list extended AL', 'deny ip host 10.0.0.1 any', 'exit',
      'vlan access-map M 10', 'match ip address AL', 'action drop', 'exit',
      'vlan access-map M 20', 'action forward', 'exit',
      'vlan filter M vlan-list 10', 'end',
    ]) await device.executeCommand(c);
    expect(await left.executeCommand('ping -c 2 10.0.0.2')).toContain('0% packet loss');
  }, 30000);
});
