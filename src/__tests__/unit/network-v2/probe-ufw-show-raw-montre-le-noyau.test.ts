/**
 * `ufw show raw' rendait une table qu'il FABRIQUAIT, pas celle du noyau.
 *
 * MESURE DE DEPART sur `ffaf2c92', apres `ufw allow 22/tcp' et `ufw enable' :
 *
 *   IPV4 (raw):
 *   Chain ufw-user-input (1 references)
 *    pkts bytes target     prot opt in     out     source               destination
 *       0     0 ACCEPT     tcp  opt *      *      0.0.0.0/0            0.0.0.0/0 dpt:22
 *
 *   Chain ufw-user-output (1 references)
 *    pkts bytes target     prot opt in     out     source               destination
 *
 * Deux chaines, des compteurs a zero ecrits en dur, une colonne « opt »
 * inventee, et pas une ligne des chaines que `rebuildIptablesRules' avait
 * pourtant injectees dans le moteur iptables. Deux reponses a « qu'y a-t-il
 * dans le noyau ? », dont celle-ci ne regardait pas le noyau.
 *
 * AUTORITE. `backend_iptables.py:get_running_raw', l. 169-186 : `show raw'
 * n'est rien d'autre que
 *
 *   args = ['-n', '-v', '-x', '-L']   puis  ['-t', t] pour t dans
 *   filter, nat, mangle, raw   (et filter, mangle, raw en v6)
 *
 * Les autres `show' du meme appel sont la meme commande restreinte a des
 * chaines : `builtins' (INPUT/FORWARD/OUTPUT par table), `before-rules',
 * `user-rules', `after-rules', `logging-rules'.
 *
 * Et le format des compteurs vient du vrai `iptables', mesure sur l'hote en
 * chargeant des compteurs connus par `iptables-restore -c' :
 *
 *   -L INPUT -n -v      Chain INPUT (policy ACCEPT 123K packets, 9877M bytes)
 *                        pkts bytes target     prot opt in     out ...
 *                       99999 99999 ACCEPT     6    --  *      * ...
 *                        100K  100K ACCEPT     17   --  *      * ...
 *                         10M   10M ACCEPT     1    --  *      * ...
 *                         12G   12G DROP       0    --  *      * ...
 *
 *   -L INPUT -n -v -x   Chain INPUT (policy ACCEPT 123456 packets, 9876543210 bytes)
 *                           pkts      bytes target     prot opt in     out ...
 *                          99999    99999 ACCEPT     6    --  *      * ...
 *                       12345678901 12345678901 DROP       0    --  *      * ...
 *
 * Deux ecarts s'y lisent. Le moteur n'annoncait PAS les compteurs de la
 * chaine dans son en-tete, alors qu'il les porte (`IptablesChain.pkts' et
 * `.bytes' existaient, personne ne les rendait) ; et `-x' etait avale par
 * la branche par defaut de l'analyseur d'arguments — accepte, sans effet,
 * exactement la forme que la regle 6 nomme.
 *
 * L'abreviation est celle de `print_num' : au-dessus de 99999, diviser par
 * 1000 en arrondissant, et suffixer K, M, G puis T tant que le quotient
 * depasse 9999. Les cinq valeurs ci-dessus la verifient.
 *
 * MESURE : 8 cas tombent sur 11 (`git stash' sur LinuxFirewallManager.ts et
 * LinuxIptablesManager.ts). Les trois cas qui passent des deux cotes :
 *   - TEMOIN : `ufw show raw' nomme bien `ufw-user-input' et le port 22 —
 *     sans lui, une sonde faite de refus ne prouverait pas que le lab pose
 *     une regle ;
 *   - NON-REGRESSION : `iptables -L -n' sans `-v' garde son en-tete court ;
 *   - NON-REGRESSION : `ufw show added' rend toujours la commande ufw.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function pareFeu(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'SRV1');
  await srv.executeCommand('ufw allow 22/tcp');
  await srv.executeCommand('ufw enable');
  return srv;
}

describe('`ufw show` regarde le moteur iptables, et lui seul', () => {
  it('TEMOIN : show raw nomme la chaine utilisateur et le port ouvert', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show raw'));
    expect(out).toContain('ufw-user-input');
    expect(out).toContain('dpt:22');
  });

  it('show raw montre les chaines de base, pas seulement celles de ufw', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show raw'));
    expect(out).toContain('Chain INPUT (policy');
    expect(out).toContain('Chain FORWARD (policy');
    expect(out).toContain('Chain OUTPUT (policy');
  });

  it('show raw montre les chaines before et after que ufw a posees', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show raw'));
    expect(out).toContain('Chain ufw-before-input');
    expect(out).toContain('Chain ufw-after-input');
  });

  it('show raw annonce la famille v6 comme la v4', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show raw'));
    expect(out).toContain('IPV4 (raw):');
    expect(out).toContain('IPV6 (raw):');
  });

  it('show raw emploie les colonnes exactes de `-x`', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show raw'));
    expect(out).toContain('    pkts      bytes target     prot opt in     out');
    expect(out).not.toContain(' pkts bytes target     prot opt in     out');
  });

  it('show builtins ne montre que les chaines de base', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show builtins'));
    expect(out).toContain('IPV4 (builtins):');
    expect(out).toContain('Chain INPUT (policy');
    expect(out).not.toContain('Chain ufw-user-input');
  });

  it('show user-rules ne montre que les chaines utilisateur', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show user-rules'));
    expect(out).toContain('IPV4 (user):');
    expect(out).toContain('Chain ufw-user-input');
    expect(out).not.toContain('Chain INPUT (policy');
  });

  it('un `show` inconnu rend la syntaxe invalide et son mode d emploi', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show zorglub'));
    expect(out).toContain('ERROR: Invalid syntax');
    expect(out).toContain('Usage: ufw COMMAND');
  });

  it('NON-REGRESSION : show added rend toujours la commande ufw', async () => {
    const out = String(await (await pareFeu()).executeCommand('ufw show added'));
    expect(out).toContain('ufw allow 22/tcp');
  });
});

describe('les compteurs de `iptables -L` suivent le vrai binaire', () => {
  it('`-v` annonce les compteurs de la chaine dans son en-tete', async () => {
    const srv = await pareFeu();
    const out = String(await srv.executeCommand('iptables -L INPUT -n -v'));
    expect(out).toMatch(/^Chain INPUT \(policy \w+ \d+\w? packets, \d+\w? bytes\)/m);
  });

  it('NON-REGRESSION : sans `-v`, l en-tete reste court', async () => {
    const srv = await pareFeu();
    const out = String(await srv.executeCommand('iptables -L INPUT -n'));
    expect(out).toMatch(/^Chain INPUT \(policy \w+\)$/m);
    expect(out).toContain('target     prot opt source               destination');
  });
});
