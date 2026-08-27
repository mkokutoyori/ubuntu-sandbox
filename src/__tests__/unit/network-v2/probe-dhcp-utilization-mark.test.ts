/**
 * `utilization mark high|low` se configure, et ce qu'elle arme se
 * declenche vraiment.
 *
 * MESURE DE DEPART : `utilization mark high 80 log` sous `ip dhcp pool`
 * repond `% Invalid input detected` sur le routeur comme sur le
 * commutateur, pendant que `show ip dhcp pool` annonce
 * `Utilization mark (high/low) : 100 / 0` — deux constantes nommees,
 * lues nulle part ailleurs. Le seuil n'existait dans aucun magasin, donc
 * rien ne pouvait le franchir.
 *
 * CE QUE LA MESURE A TROUVE EN PLUS : le commutateur portait une SECONDE
 * mise en forme de `show ip dhcp pool`, sans appelant, qui annoncait
 * `Total addresses : 254` quel que soit le masque. Elle est supprimee.
 *
 * DISCRIMINATION : 8 des 13 cas tombent avant correctif. Les 5 autres
 * sont nommes ici plutot que laisses a decouvrir :
 *  - « un pourcentage hors plage est refuse » et « un seuil inconnu est
 *    refuse » : la commande ENTIERE etait refusee avant, donc le refus
 *    ne prouve pas le controle ; ils gardent l'analyse.
 *  - « `no utilization mark high` rend les defauts d'IOS » : avant, le
 *    `no` etait refuse ET les marques valaient deja 100 / 0, donc le
 *    resultat attendu etait vrai pour une raison qui ne prouve rien.
 *  - « sans `log`, aucune ligne de journal » : c'est le TEMOIN, dont
 *    l'objet est de passer des deux cotes.
 *  - « aucune notification quand les traps ne sont pas armes » : idem.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import type { Equipment } from '@/network/equipment/Equipment';

async function cfg(dev: { executeCommand(c: string): Promise<string> | string },
  lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(String(await dev.executeCommand(l)));
  return out;
}

/**
 * Le sous-reseau est un /24 mais le pool ne porte QUE deux adresses
 * louables : tout le reste est exclu. Un bail vaut donc 50 %, ce qui
 * rend le franchissement observable avec un seul client.
 */
async function lab(marks: string[], traps: string[] = []): Promise<{
  r: CiscoRouter; pc: LinuxPC; outputs: string[];
}> {
  const r = new CiscoRouter('R1');
  const pc = new LinuxPC('PC1');
  pc.powerOn();
  new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  const outputs = await cfg(r, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0',
    'no shutdown', 'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.252',
    ...traps,
    'ip dhcp pool LAN',
    'network 192.168.1.0 255.255.255.0',
    ...marks,
    'end',
  ]);
  return { r, pc, outputs };
}

function observeTraps(source: Equipment): string[] {
  const seen: string[] = [];
  source.getBus().subscribe('snmp.trap.sent', (e) => {
    seen.push((e.payload as { trapOid: string }).trapOid);
  });
  return seen;
}

describe('le seuil se configure', () => {
  it('`utilization mark high 80 log` est accepte', async () => {
    const { outputs } = await lab(['utilization mark high 80 log']);
    expect(outputs.join('\n')).not.toContain('Invalid input');
  });

  it('la vue lit le seuil configure au lieu de sa constante', async () => {
    const { r } = await lab(['utilization mark high 80 log', 'utilization mark low 20']);
    const out = String(await r.executeCommand('show ip dhcp pool'));
    expect(out).toContain('Utilization mark (high/low)    : 80 / 20');
  });

  it('la configuration rendue reproduit ce qui a ete tape', async () => {
    const { r } = await lab(['utilization mark high 80 log', 'utilization mark low 20']);
    const rc = String(await r.executeCommand('show running-config'));
    expect(rc).toContain(' utilization mark high 80 log');
    expect(rc).toContain(' utilization mark low 20');
    expect(rc).not.toContain(' utilization mark low 20 log');
  });

  it('`no utilization mark high` rend les defauts d\'IOS', async () => {
    const { r } = await lab(['utilization mark high 80 log']);
    await cfg(r, ['configure terminal', 'ip dhcp pool LAN',
      'no utilization mark high', 'end']);
    const out = String(await r.executeCommand('show ip dhcp pool'));
    expect(out).toContain('Utilization mark (high/low)    : 100 / 0');
    expect(String(await r.executeCommand('show running-config')))
      .not.toContain('utilization mark high');
  });

  it('un pourcentage hors plage est refuse', async () => {
    const { outputs } = await lab(['utilization mark high 101', 'utilization mark high 0']);
    expect(outputs.filter(o => o.includes('Invalid input'))).toHaveLength(2);
  });

  it('un seuil inconnu est refuse', async () => {
    const { outputs } = await lab(['utilization mark moyen 50']);
    expect(outputs.join('\n')).toContain('Invalid input');
  });

  it('le commutateur prend la meme commande', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    sw.powerOn();
    const outputs = await cfg(sw, [
      'enable', 'configure terminal', 'ip dhcp pool LAN',
      'network 10.0.0.0 255.255.255.0', 'utilization mark high 75 log', 'end']);
    expect(outputs.join('\n')).not.toContain('Invalid input');
    expect(String(await sw.executeCommand('show ip dhcp pool')))
      .toContain('Utilization mark (high/low)    : 75 / 0');
  });
});

describe('le franchissement se declenche', () => {
  it('`log` ecrit la ligne d\'IOS quand le bail franchit le seuil haut', async () => {
    const { r, pc } = await lab(['utilization mark high 50 log']);
    await pc.executeCommand('sudo dhclient eth0');
    const journal = String(await r.executeCommand('show logging'));
    expect(journal).toContain(
      "%DHCPD-6-HIGH_UTIL: Pool 'LAN' is in high utilization state (1 addresses used out of 2)");
  });

  it('sans `log`, aucune ligne de journal', async () => {
    const { r, pc } = await lab(['utilization mark high 50']);
    await pc.executeCommand('sudo dhclient eth0');
    expect(String(await r.executeCommand('show logging'))).not.toContain('HIGH_UTIL');
  });

  it('le seuil bas ne s\'annonce qu\'APRES le seuil haut', async () => {
    const { r, pc } = await lab(['utilization mark high 50 log', 'utilization mark low 0 log']);
    expect(String(await r.executeCommand('show logging'))).not.toContain('LOW_UTIL');
    await pc.executeCommand('sudo dhclient eth0');
    await cfg(r, ['clear ip dhcp binding *']);
    const journal = String(await r.executeCommand('show logging'));
    expect(journal).toContain('HIGH_UTIL');
    expect(journal).toContain(
      "%DHCPD-6-LOW_UTIL: Pool 'LAN' is in low utilization state (0 addresses used out of 2)");
  });

  it('le seuil haut ne s\'annonce qu\'UNE fois', async () => {
    const { r, pc } = await lab(['utilization mark high 50 log']);
    const pc2 = new LinuxPC('PC2');
    pc2.powerOn();
    new Cable('c2').connect(r.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1',
      'ip address 192.168.1.2 255.255.255.0', 'no shutdown', 'end']);
    await pc.executeCommand('sudo dhclient eth0');
    await pc2.executeCommand('sudo dhclient eth0');
    const journal = String(await r.executeCommand('show logging'));
    expect(journal).toContain('addresses used out of 2');
    expect(journal.split('\n').filter(l => l.includes('HIGH_UTIL'))).toHaveLength(1);
  });

  it('la notification part quand `snmp-server enable traps dhcp` l\'arme', async () => {
    const { pc, r } = await lab(['utilization mark high 50 log'], [
      'snmp-server community public RO',
      'snmp-server host 10.0.0.50 version 2c public',
      'snmp-server enable traps dhcp pool',
    ]);
    const traps = observeTraps(r);
    await pc.executeCommand('sudo dhclient eth0');
    expect(traps).toContain('1.3.6.1.4.1.9.10.102.0.2.0.1');
  });

  it('aucune notification quand les traps ne sont pas armes', async () => {
    const { pc, r } = await lab(['utilization mark high 50 log'], [
      'snmp-server community public RO',
      'snmp-server host 10.0.0.50 version 2c public',
    ]);
    const traps = observeTraps(r);
    await pc.executeCommand('sudo dhclient eth0');
    expect(traps).not.toContain('1.3.6.1.4.1.9.10.102.0.2.0.1');
  });
});
