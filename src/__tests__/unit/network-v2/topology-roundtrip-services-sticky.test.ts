/**
 * Deux TP que la sauvegarde de topologie rendait sains d'eux-mêmes.
 *
 * 1) **Les services Linux.** `systemctl enable`/`disable` s'appuie sur un
 *    lien symbolique sous `multi-user.target.wants`, et la capture de
 *    fichiers ne consigne que ce qui EXISTE : un `disable`, qui travaille
 *    en RETIRANT ce lien, ne laissait donc aucune trace. La machine
 *    rouverte recréait le lien au démarrage et relançait le service. Un
 *    TP « diagnostiquez pourquoi SSH ne répond plus » revenait en pleine
 *    forme. `systemctl stop` sans `disable` avait le même sort.
 *
 * 2) **Les MAC sticky.** Le vrai problème n'était pas la sérialisation :
 *    `exportTopology` LEVAIT une exception dès qu'un commutateur
 *    générique se trouvait sur la toile (`sw.getDtpAgent is not a
 *    function`, depuis `buildRunningConfig`) — donc le bouton
 *    Enregistrer échouait pour la topologie ENTIÈRE, pas seulement pour
 *    cet équipement. Une fois cela réparé, les MAC sticky reviennent
 *    d'elles-mêmes : elles vivent dans la running-config, que l'import
 *    rejoue par la vraie CLI, exactement comme sur un vrai Cisco.
 *
 * Tout passe par les vraies commandes et le vrai exportateur/importateur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function roundTrip(devices: Equipment[]): Promise<Map<string, Equipment>> {
  const instances = new Map<string, Equipment>(devices.map((d) => [d.getId(), d]));
  const json = exportTopology('lab', instances, []);
  const reopened = await importTopology(JSON.parse(JSON.stringify(json)));
  return reopened.deviceInstances;
}

const byName = <T extends Equipment>(m: Map<string, Equipment>, name: string): T =>
  [...m.values()].find((d) => d.getName() === name)! as T;

describe('les unités systemd reviennent dans l\'état où on les a laissées', () => {
  it('un service désactivé ne se réactive pas au chargement', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    await pc.executeCommand('sudo systemctl disable ssh');

    const back = byName<LinuxPC>(await roundTrip([pc]), 'PC1');

    expect((await back.executeCommand('systemctl is-enabled ssh')).trim()).toBe('disabled');
  });

  it('un service arrêté ne redémarre pas tout seul', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    await pc.executeCommand('sudo systemctl stop ssh');

    const back = byName<LinuxPC>(await roundTrip([pc]), 'PC1');

    // Toujours activé au démarrage, mais arrêté — c'est la panne que le
    // TP a mise en place, et elle doit survivre au rechargement.
    expect((await back.executeCommand('systemctl is-enabled ssh')).trim()).toBe('enabled');
    expect((await back.executeCommand('systemctl is-active ssh')).trim()).toBe('inactive');
  });

  it('un service masqué reste masqué', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    await pc.executeCommand('sudo systemctl mask cron');

    const back = byName<LinuxPC>(await roundTrip([pc]), 'PC1');

    expect((await back.executeCommand('systemctl is-enabled cron')).trim()).toBe('masked');
  });

  it('une machine intacte revient intacte — la restauration ne casse rien', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();

    const back = byName<LinuxPC>(await roundTrip([pc]), 'PC1');

    expect((await back.executeCommand('systemctl is-enabled ssh')).trim()).toBe('enabled');
    expect((await back.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
  });

  it('le service reste vraiment mort : le client reçoit un refus', async () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
    b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
    a.powerOn(); b.powerOn();
    await b.executeCommand('sudo systemctl stop ssh');

    const back = await roundTrip([a, b]);
    const a2 = byName<LinuxPC>(back, 'A');
    const b2 = byName<LinuxPC>(back, 'B');
    // L'import reconstruit des équipements neufs : le câble d'origine
    // reliait les anciens.
    new Cable('c1').connect(a2.getPorts()[0], b2.getPorts()[0]);

    // Ce n'est pas la table des unités que le TP interroge, c'est le fil.
    expect(await a2.executeCommand('ssh alice@10.0.0.2 hostname'))
      .toContain('Connection refused');
  });
});

describe('un commutateur générique n\'empêche plus d\'enregistrer', () => {
  it('exporter une topologie qui en contient un ne lève plus', () => {
    const gsw = new GenericSwitch('switch-generic', 'GSW', 8, 0, 0);
    gsw.powerOn();

    expect(() => exportTopology('lab', new Map([[gsw.getId(), gsw as Equipment]]), []))
      .not.toThrow();
  });

  it('une MAC apprise en sticky est encore là après réouverture', async () => {
    const gsw = new GenericSwitch('switch-generic', 'GSW', 8, 0, 0);
    const port = gsw.getPorts()[0];
    port.getPortSecurity().enable();
    port.getPortSecurity().enableSticky();

    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
    new Cable('c1').connect(pc.getPorts()[0], port);
    gsw.powerOn(); pc.powerOn();
    // Du vrai trafic : c'est ainsi qu'une adresse devient sticky.
    await pc.executeCommand('ping -c 1 10.0.0.9');
    const learned = port.getPortSecurity().getEntries().map((e) => e.mac.toString());
    expect(learned).toHaveLength(1);

    const back = byName<GenericSwitch>(await roundTrip([gsw, pc]), 'GSW');
    const sec = back.getPorts()[0].getPortSecurity();

    expect(sec.isEnabled()).toBe(true);
    expect(sec.isStickyEnabled()).toBe(true);
    // Une entrée sticky qui reviendrait « dynamic » serait réapprise puis
    // oubliée : le verrou du TP ne tiendrait pas.
    expect(sec.getEntries().map((e) => [e.mac.toString(), e.type]))
      .toEqual([[learned[0], 'sticky']]);
  });

  it('sur un Cisco aussi — même chemin, la running-config rejouée', async () => {
    const csw = new CiscoSwitch('switch-cisco', 'CSW', 8);
    for (const c of [
      'enable', 'configure terminal', 'interface FastEthernet0/1',
      'switchport mode access', 'switchport port-security',
      'switchport port-security mac-address sticky',
      'switchport port-security mac-address sticky 0011.2233.4455',
      'end',
    ]) await csw.executeCommand(c);

    const back = byName<CiscoSwitch>(await roundTrip([csw]), 'CSW');
    const sec = back.getPorts()[0].getPortSecurity();

    expect(sec.getEntries().map((e) => [e.mac.toString(), e.type]))
      .toEqual([['00:11:22:33:44:55', 'sticky']]);
  });
});
