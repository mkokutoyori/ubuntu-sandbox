/**
 * Un predicat de securite echouait OUVERT.
 *
 * `ManagementPlane.allowsAccess` rendait `true` des que l'interface
 * n'avait rien de declare :
 *
 *     const declared = this.allowed.get(iface);
 *     if (declared === undefined) return true;
 *
 * Le §6 dit l'inverse pour un moteur d'appariement : un critere que le
 * moteur ne sait pas trancher fait que l'entree NE correspond PAS.
 *
 * CE QUE LA MESURE A CORRIGE DANS MA PREMIERE IDEE. Fermer la branche
 * sans distinction fait tomber quatre cas : l'ASA ne peuple JAMAIS cette
 * table — sa configuration d'acces passe par un autre modele — et il
 * cessait de repondre a son propre ping. La branche portait donc deux
 * questions sous un seul `undefined` :
 *
 *   table VIDE            la plateforme n'utilise pas `allowaccess`
 *   entree absente d'une table NON vide   l'interface n'a pas ete ouverte
 *
 * La premiere reste ouverte, la seconde se ferme. `servedAnywhere`, juste
 * en dessous, faisait deja cette distinction — elle n'avait pas ete
 * reportee ici.
 *
 * PORTEE, dite plutot que suggeree : ce n'est pas un contournement
 * referme, c'est un durcissement. Depuis le plan de donnees, les deux
 * gardes passent par `Firewall.servingInterface`, qui rend toujours un
 * nom d'interface REEL — la branche fautive n'etait donc pas atteignable
 * par un paquet. Elle l'etait par tout appelant qui pose la question avec
 * un nom que la table ne connait pas : une zone, un alias, une interface
 * supprimee apres coup.
 *
 * Discrimination (`git stash push -- src/network/devices/firewall/mgmt/`) :
 * TROIS cas sur cinq tombent avant correctif. Les deux qui passent des
 * deux cotes sont les TEMOINS — une interface OUVERTE repond a ce qu'elle
 * autorise et refuse le reste — et sans eux trois refus ne prouveraient
 * qu'une maquette muette.
 *
 * Une mesure anterieure m'avait fait croire qu'une interface d'usine
 * jamais ouverte etait deja fermee : elle l'etait parce que je l'avais
 * touchee en configuration, ce qui lui cree une entree VIDE. Sans y
 * toucher, elle n'a pas d'entree du tout et tombait donc dans la branche
 * ouverte. Le cas est garde ici sous son vrai regime.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('la garde d acces echoue fermee', () => {
  let fw: FortiGate;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
    fw.powerOn();
    for (const line of [
      'config system interface',
      'edit port1', 'set ip 192.168.1.99 255.255.255.0', 'set allowaccess ping ssh', 'next',
      'end',
    ]) await fw.executeCommand(line);
  });

  it('an interface that was opened answers for what it allows', () => {
    expect(fw.allowsAccess('port1', 'ping')).toBe(true);
    expect(fw.allowsAccess('port1', 'ssh')).toBe(true);
  }, 60_000);

  it('an interface that was opened still refuses what it does not allow', () => {
    expect(fw.allowsAccess('port1', 'telnet')).toBe(false);
  }, 60_000);

  it('a factory interface nobody opened refuses every service', () => {
    for (const service of ['ping', 'ssh', 'https', 'http', 'telnet', 'snmp']) {
      expect(fw.allowsAccess('port3', service)).toBe(false);
    }
  }, 60_000);

  it('a name the access table does not know refuses every service', () => {
    for (const service of ['ping', 'ssh', 'https', 'http', 'telnet', 'snmp']) {
      expect(fw.allowsAccess('zorglub', service)).toBe(false);
    }
  }, 60_000);

  it('an interface removed from the access table stops answering', () => {
    for (const service of ['ping', 'ssh']) {
      expect(fw.allowsAccess('une-zone-jamais-declaree', service)).toBe(false);
    }
  }, 60_000);
});
