/**
 * `iptables -S` ecrit comme iptables 1.8.7 (variante nft) : nft.c `nft_rule_list_save` imprime D'ABORD les politiques (`-P chaine
 * POLITIQUE`) et les chaines utilisateur (`-N chaine`) -- `nft_rule_list_chain_save` --, PUIS les regles de toutes les chaines ;
 * nft-ipv4.c `save_ipv4_addr` ecrit l'adresse avec son masque (`-s 10.0.0.1/32`, `mask_to_str`) ; xshared/nft-shared `save_rule_details`
 * ecrit `-i`, `-o`, puis `-p` ; et les modules `tcp`, `udp`, `icmp` sont nommes (`-p tcp -m tcp --dport 80`), le noyau ne les chargeant
 * pas autrement.
 *
 * Mesure de depart : `-S` melangeait politique et regles chaine par chaine, ne disait rien des chaines utilisateur (`-N`), ecrivait
 * `-s 10.0.0.1` sans masque et `-p tcp --dport 80` sans `-m tcp`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let srv: LinuxServer;

async function run(command: string): Promise<string[]> {
  return (await srv.executeCommand(command)).split('\n');
}

beforeEach(async () => {
  srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  await srv.executeCommand('iptables -F');
});

describe('iptables -S', () => {
  it('ecrit les politiques et les chaines utilisateur avant toute regle', async () => {
    await srv.executeCommand('iptables -N WEB');
    await srv.executeCommand('iptables -A INPUT -j ACCEPT');
    expect(await run('iptables -S')).toEqual([
      '-P INPUT ACCEPT', '-P FORWARD ACCEPT', '-P OUTPUT ACCEPT', '-N WEB', '-A INPUT -j ACCEPT',
    ]);
  });

  it('une chaine utilisateur nommee commence par son -N', async () => {
    await srv.executeCommand('iptables -N WEB');
    await srv.executeCommand('iptables -A WEB -j DROP');
    expect(await run('iptables -S WEB')).toEqual(['-N WEB', '-A WEB -j DROP']);
  });

  it('une chaine native nommee commence par son -P', async () => {
    await srv.executeCommand('iptables -A INPUT -j DROP');
    expect(await run('iptables -S INPUT')).toEqual(['-P INPUT ACCEPT', '-A INPUT -j DROP']);
  });

  it('une adresse hote porte /32, inversee ou non', async () => {
    await srv.executeCommand('iptables -A INPUT ! -s 10.0.0.1 -d 10.0.0.2 -j DROP');
    expect(await run('iptables -S INPUT')).toContain('-A INPUT ! -s 10.0.0.1/32 -d 10.0.0.2/32 -j DROP');
  });

  it('un reseau garde son masque', async () => {
    await srv.executeCommand('iptables -A INPUT -s 10.0.0.0/24 -j DROP');
    expect(await run('iptables -S INPUT')).toContain('-A INPUT -s 10.0.0.0/24 -j DROP');
  });

  it('nomme le module tcp, udp ou icmp qui porte les options', async () => {
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
    await srv.executeCommand('iptables -A INPUT -i eth0 -p udp --sport 53 -j DROP');
    await srv.executeCommand('iptables -A INPUT -p icmp --icmp-type 8 -j DROP');
    const out = await run('iptables -S INPUT');
    expect(out).toContain('-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT');
    expect(out).toContain('-A INPUT -i eth0 -p udp -m udp --sport 53 -j DROP');
    expect(out).toContain('-A INPUT -p icmp -m icmp --icmp-type 8 -j DROP');
  });

  it('TEMOIN : un protocole sans option n\'appelle pas de module', async () => {
    await srv.executeCommand('iptables -A INPUT -p tcp -j ACCEPT');
    expect(await run('iptables -S INPUT')).toContain('-A INPUT -p tcp -j ACCEPT');
  });
});
