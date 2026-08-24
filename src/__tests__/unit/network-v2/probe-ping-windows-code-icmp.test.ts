/**
 * Le CODE d'un ICMP inatteignable decide de ce que `ping` ecrit.
 *
 * Mesure de depart, sur un seul laboratoire ou un routeur refuse par
 * liste de controle et n'a pas de route vers 172.31.9.9 :
 *
 *   Linux, refuse par ACL  -> From 10.0.2.1 icmp_seq=1 Packet filtered
 *   Windows, refuse par ACL-> Reply from 10.0.0.1: Destination host unreachable.
 *   Linux, sans route      -> From 10.0.2.1 icmp_seq=1 Destination Net Unreachable
 *   Windows, sans route    -> Reply from 10.0.0.1: Destination host unreachable.
 *
 * Le code VOYAGE — `EndHost` le range dans la chaine d'erreur et le
 * `ping` Linux le lit depuis toujours — mais la moitie Windows rendait
 * TOUT inatteignable par la meme phrase. Deux machines du meme
 * laboratoire diagnostiquaient donc le meme refus autrement, et celle
 * qui perd l'information est celle qui envoie l'apprenant verifier son
 * cablage au lieu de sa table de routage.
 *
 * La lecture de la chaine d'erreur est desormais UNE
 * (`core/icmpUnreachable.ts`) et chaque plateforme garde ses mots, ce
 * qui est la difference reelle entre les deux et non une duplication.
 *
 * Ce que les mots de Windows doivent au terrain plutot qu'a la memoire :
 * la forme `Reply from <ip>: <message>` et `Destination host
 * unreachable.` sont attestees par d'innombrables transcriptions ;
 * `Destination net unreachable.` l'est aussi (et ReactOS, qui ecrit
 * « network », est une reimplementation, pas une reference) ; `Packet
 * needs to be fragmented but DF set.` est la ligne du laboratoire MTU
 * classique. Le code 13 reste DELIBEREMENT rendu comme code 1, faute de
 * capture reelle de `ping.exe` sous ACL — c'est inscrit au TODO.
 *
 * `-f` n'est plus juge sur une constante locale : le message vient de
 * l'ICMP code 4 que le routeur emet vraiment, donc il suit le MTU du
 * LIEN et non un 1500 ecrit en dur.
 *
 * Les quatre cas qui passent des deux cotes sont nommes : « TEMOIN,
 * Linux lit deja le code » (c'est son objet : montrer que l'information
 * voyage) ; « TEMOIN, un echo qui aboutit » (aucun des deux cotes ne
 * casse le chemin nominal) ; « `-f` sous le MTU par defaut » (cas de
 * NON-REGRESSION : 1000 + 28 tenait sous les 1500 en dur, donc l'ancien
 * court-circuit ne se declenchait pas) ; et « un refus par liste de
 * controle », dont c'est justement l'objet de ne PAS changer tant que
 * les mots de `ping.exe` pour le code 13 ne sont pas attestes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

async function lab(routerCommands: string[] = []) {
  const r = new CiscoRouter('R1');
  const win = new WindowsPC('windows-pc', 'WIN');
  const lin = new LinuxPC('linux-pc', 'LIN');
  const cible = new LinuxPC('linux-pc', 'CIBLE');
  new Cable('c1').connect(win.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(lin.getPort('eth0')!, r.getPort('GigabitEthernet0/2')!);
  new Cable('c3').connect(cible.getPort('eth0')!, r.getPort('GigabitEthernet0/1')!);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...routerCommands, 'end',
  ]) await r.executeCommand(c);
  win.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  win.setDefaultGateway(new IPAddress('10.0.0.1'));
  lin.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
  lin.setDefaultGateway(new IPAddress('10.0.2.1'));
  cible.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  cible.setDefaultGateway(new IPAddress('10.0.1.1'));
  return { r, win, lin };
}

describe('le code ICMP decide de ce que ping ecrit', () => {
  beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

  it('TEMOIN, Linux lit deja le code : sans route il dit le reseau', async () => {
    const { lin } = await lab();
    expect(await lin.executeCommand('ping -c 1 172.31.9.9'))
      .toContain('Destination Net Unreachable');
  });

  it('TEMOIN, un echo qui aboutit reste un echo qui aboutit', async () => {
    const { win } = await lab();
    expect(await win.executeCommand('ping -n 1 10.0.1.2')).toMatch(/Reply from 10\.0\.1\.2: bytes=32/);
  });

  it('sans route, Windows dit le RESEAU et non l hote', async () => {
    const { win } = await lab();
    const out = await win.executeCommand('ping -n 1 172.31.9.9');
    expect(out).toContain('Reply from 10.0.0.1: Destination net unreachable.');
    expect(out).not.toContain('Destination host unreachable.');
  });

  it('les deux plateformes distinguent le meme refus de la meme facon', async () => {
    const { win, lin } = await lab();
    const winSansRoute = await win.executeCommand('ping -n 1 172.31.9.9');
    const winHote = await win.executeCommand('ping -n 1 10.0.1.55');
    expect(winSansRoute).not.toBe(winHote);
    expect(winSansRoute).toContain('net unreachable');
    expect(winHote).toContain('host unreachable');

    const linSansRoute = await lin.executeCommand('ping -c 1 172.31.9.9');
    const linHote = await lin.executeCommand('ping -c 1 10.0.1.55');
    expect(linSansRoute).toContain('Destination Net Unreachable');
    expect(linHote).not.toContain('Destination Net Unreachable');
  });

  it('`-f` suit le MTU du LIEN et non une constante', async () => {
    const { win } = await lab(['interface GigabitEthernet0/1', 'ip mtu 600', 'exit']);

    const gros = await win.executeCommand('ping -f -l 1000 -n 1 10.0.1.2');
    expect(gros).toContain('Reply from 10.0.0.1: Packet needs to be fragmented but DF set.');
    expect(gros).toContain('(100% loss)');

    const petit = await win.executeCommand('ping -f -l 100 -n 1 10.0.1.2');
    expect(petit).toMatch(/Reply from 10\.0\.1\.2: bytes=100/);
  });

  it('`-f` sous le MTU par defaut ne fabrique plus de refus', async () => {
    const { win } = await lab();
    expect(await win.executeCommand('ping -f -l 1000 -n 1 10.0.1.2'))
      .toMatch(/Reply from 10\.0\.1\.2: bytes=1000/);
  });

  it('le message porte le prefixe `Reply from` du vrai ping', async () => {
    const { win } = await lab(['interface GigabitEthernet0/1', 'ip mtu 600', 'exit']);
    const out = await win.executeCommand('ping -f -l 1000 -n 1 10.0.1.2');
    const lignes = out.split('\n').filter(l => l.includes('fragmented'));
    expect(lignes.length).toBe(1);
    expect(lignes[0]).toMatch(/^Reply from \d+\.\d+\.\d+\.\d+: /);
  });

  it('un refus par liste de controle reste rendu comme un hote injoignable, et c est dit', async () => {
    const { win } = await lab([
      'access-list 1 deny host 10.0.0.2', 'access-list 1 permit any',
      'interface GigabitEthernet0/1', 'ip access-group 1 out', 'exit',
    ]);
    expect(await win.executeCommand('ping -n 1 10.0.1.2'))
      .toContain('Reply from 10.0.0.1: Destination host unreachable.');
  });
});
