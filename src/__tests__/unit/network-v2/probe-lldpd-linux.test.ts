/**
 * Une machine Linux fait tourner `lldpd`, et `lldpcli` le lit.
 *
 * Mesure de depart : les deux n'existaient NULLE PART -- ni l'unite, ni
 * le paquet, ni la commande -- alors que le moteur, lui, tournait
 * depuis toujours : `EndHost` porte un `LldpAgent` en reception seule
 * (le defaut de systemd-networkd, `LLDP=yes` / `EmitLLDP=no`) et
 * `networkctl lldp` le lisait deja. C'est le motif que ce depot referme
 * regulierement -- un moteur sans porte -- et il avait ici une
 * consequence de bout en bout : un poste Linux cable a un commutateur
 * qui fait `lldp run` etait INVISIBLE dans son `show lldp neighbors`,
 * parce que rien sur la machine ne pouvait allumer l'emission.
 *
 * `lldpd` n'est donc PAS un second moteur : demarrer l'unite allume
 * l'emission du meme agent, l'arreter l'eteint, et `lldpcli` est la
 * porte. Deux agents LLDP sur une meme machine finiraient par decrire
 * deux voisinages differents.
 *
 * Discrimine par `git stash` : 8 cas tombent avant correctif. J'en
 * avais annonce 9, et la mesure a corrige la prevision.
 *
 * Les 2 qui passent des deux cotes sont nommes :
 *  - « la reception marchait DEJA sans lldpd » est le TEMOIN, et c'est
 *    justement son objet -- il etablit que le defaut portait sur
 *    l'emission et sur la porte, pas sur le moteur, ce qui interdit de
 *    le « corriger » en ecrivant un second agent.
 *  - « sans lldpd, le voisin ne VOIT pas la machine » passait avant
 *    parce que la machine ne pouvait de toute facon rien emettre ; il
 *    garde qu'installer la porte n'a pas allume l'emission au repos.
 *
 * Le rendu vient du CODE de lldpd et non d'un souvenir :
 * `src/client/text_writer.c` donne la mise en page (separateur de 79
 * tirets, etiquette calee sur 13 caracteres, attributs separes par
 * `, `), `src/client/display.c` l'arbre des etiquettes
 * (`Interface` / `Chassis` / `ChassisID` / `SysName` / `SysDescr` /
 * `MgmtIP` / `Capability` / `Port` / `PortID` / `PortDescr`), les
 * symboles de capacite (`Bridge`, `Router`, `Tel`, `Station`, ...) et le
 * format d'age `%d day%s, %02d:%02d:%02d`.
 *
 * DEUX defauts de l'agent PARTAGE trouves en chemin, donc valables sur
 * les quatre plateformes et pas seulement sous Linux : l'adresse de
 * gestion annoncee incluait `127.0.0.1`, c'est-a-dire une adresse qui
 * n'identifie personne chez le voisin ; et la description systeme d'un
 * hote etait le TYPE d'equipement brut (`linux-pc`) la ou un vrai lldpd
 * annonce la chaine d'`uname`.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

async function labo() {
  const pc = new LinuxPC('linux-pc', 'srv1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
  new Cable('c').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  for (const c of ['enable', 'configure terminal', 'lldp run', 'end']) {
    await sw.executeCommand(c);
  }
  return { pc, sw };
}

describe('Linux : lldpd et lldpcli', () => {
  it('le TEMOIN : la reception marche DEJA sans lldpd', async () => {
    const { pc } = await labo();
    expect(pc.getLldpNeighbors()).toHaveLength(1);
  });

  it('sans lldpd, lldpcli rend le refus du vrai lldpctl', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('lldpcli show neighbors');
    expect(out).toContain('cannot connect to lldpd daemon');
    expect(out).toContain('is lldpd running?');
  });

  it('sans lldpd, le voisin ne VOIT pas la machine', async () => {
    const { sw } = await labo();
    expect(await sw.executeCommand('show lldp neighbors'))
      .toContain('Total entries displayed: 0');
  });

  it('demarrer lldpd fait VOIR la machine par le voisin', async () => {
    const { pc, sw } = await labo();
    await pc.executeCommand('sudo systemctl start lldpd');
    const out = await sw.executeCommand('show lldp neighbors');
    expect(out).toContain('srv1');
    expect(out).toContain('eth0');
  });

  it('arreter lldpd rend la machine muette a nouveau', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo systemctl start lldpd');
    expect(pc.getLldpAgent().isPortTransmitEnabled('eth0')).toBe(true);
    await pc.executeCommand('sudo systemctl stop lldpd');
    expect(pc.getLldpAgent().isPortTransmitEnabled('eth0')).toBe(false);
  });

  it('lldpcli show neighbors rend la mise en page de lldpd', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo systemctl start lldpd');
    const out = await pc.executeCommand('lldpcli show neighbors');
    expect(out).toContain('-'.repeat(79));
    expect(out).toContain('LLDP neighbors:');
    expect(out).toContain('Interface:    eth0, via: LLDP, RID: 1, Time: ');
    expect(out).toContain('  Chassis:');
    expect(out).toContain('    SysName:      SW1');
    expect(out).toContain('    Capability:   Bridge, on');
    expect(out).toContain('    PortID:       ifname FastEthernet0/1');
  });

  it('-f json rend le meme voisinage en JSON', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo systemctl start lldpd');
    const parsed = JSON.parse(await pc.executeCommand('lldpcli show neighbors -f json'));
    const iface = parsed.lldp.interface[0];
    expect(iface.name).toBe('eth0');
    expect(iface.chassis.name).toBe('SW1');
    expect(iface.port.id).toEqual({ type: 'ifname', value: 'FastEthernet0/1' });
  });

  it('show chassis decrit la machine, uname compris', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo systemctl start lldpd');
    const out = await pc.executeCommand('lldpcli show chassis');
    expect(out).toContain('Local chassis:');
    expect(out).toContain('SysName:      srv1');
    expect(out).toMatch(/SysDescr:\s+srv1 Linux \S+ x86_64/);
    expect(out).not.toContain('linux-pc');
    expect(out).not.toContain('127.0.0.1');
  });

  it('show statistics MESURE, et ignore la boucle locale', async () => {
    const { pc } = await labo();
    await pc.executeCommand('sudo systemctl start lldpd');
    const out = await pc.executeCommand('lldpcli show statistics');
    expect(out).toContain('LLDP statistics:');
    expect(out).toMatch(/Interface:    eth0\n  Transmitted:  [1-9]/);
    expect(out).toMatch(/Received:     [1-9]/);
    expect(out).not.toContain('Interface:    lo');
  });

  it('dpkg -l nomme le paquet que la machine execute', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('dpkg -l')).toContain('lldpd');
  });
});
