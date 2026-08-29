/**
 * « Pas de route » et « personne ne repond » sont DEUX diagnostics
 * (BRD-Modele-TCP-IP.md phase 8, lot 5).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `TcpStack.connectOutcome` rendait `'timeout'` pour une destination
 * qu'AUCUNE route ne dessert, et son propre commentaire assumait la
 * confusion : « 'timeout' when nothing comes back (silent DROP / no
 * route) ». Les deux ne sont pourtant pas la meme chose, et c'est la
 * distinction la plus couteuse a rendre a l'envers — « delai depasse »
 * envoie chercher un pare-feu qui jette en silence, quand la machine n'a
 * simplement aucun chemin et n'a rien emis du tout.
 *
 * Le lot 3 a rendu ce cas ATTEIGNABLE en retirant le repli « le premier
 * port adresse et up » : une sortie indecidable echoue desormais au lieu
 * de partir n'importe ou. La qualite du diagnostic compte donc a partir
 * de maintenant, ce qui n'etait pas le cas tant que la retombee masquait
 * la question.
 *
 * ── Ce que fait la vraie machine ────────────────────────────────────
 *
 * Cote noyau, `tcp_v4_connect()` (net/ipv4/tcp_ipv4.c) rend l'erreur de
 * `ip_route_connect()` telle quelle et compte `IPSTATS_MIB_OUTNOROUTES`
 * sur `-ENETUNREACH` : l'echec est IMMEDIAT et distinct d'un delai. Le
 * client le rend mot pour mot — `sshconnect.c:554` d'openssh-portable
 * ecrit `error("ssh: connect to host %s port %s: %s", …, strerror(errno))`,
 * donc `Network is unreachable` pour ENETUNREACH et non `No route to
 * host`, qui est EHOSTUNREACH, c'est-a-dire l'ARP qui echoue sur le lien
 * ou une erreur ICMP revenue.
 *
 * Cote IOS, la machine ecrit `% Destination unreachable; gateway or host
 * down` — message atteste par plusieurs fils independants de Cisco
 * Community —, la ou `% Connection timed out; remote host not
 * responding` est reserve au cas ou la route existe et le pair se tait.
 *
 * ── Ce qui a ete trouve en chemin, et corrige ───────────────────────
 *
 * Le chemin SCRIPTE d'IOS ne consultait pas la table de routage du tout :
 * il cherchait la machine dans la TOPOLOGIE (`findHostByAddress`) et
 * repondait « delai depasse » quand il ne la trouvait pas — donc une
 * adresse qu'aucune route ne dessert etait rendue comme un pair muet. Il
 * demande desormais la sortie a la vraie pile (`hasEgressTo`) avant tout
 * le reste. Sa seconde formule, `% Destination unreachable; gateway or
 * route not found`, n'est d'aucune machine reelle : elle est remplacee
 * par celle d'IOS.
 *
 * ── Une seule ecriture ─────────────────────────────────────────────
 *
 * Le verdict etait ecrit SEPT fois — `'open' | 'refused' | 'timeout'`
 * repete dans `sshLauncher`, `OpenSslHost`, `LinuxMachine`,
 * `LinuxCommandExecutor`, `LinuxNetKernel`, `ScanEngine` et la pile
 * elle-meme. Sept ecritures d'un meme fait ne restent pas egales, et
 * celle-ci devait justement gagner une valeur : `TcpWireOutcome` — le nom
 * qui existait deja dans `sshLauncher` — vit dans `tcp/types.ts` et les
 * sept la lisent.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * TROIS cas sur cinq tombent contre l'etat d'avant. Les DEUX autres sont
 * des TEMOINS et passent des deux cotes : le refus par un pair joignable,
 * dont c'est l'objet de ne pas changer, et la connexion qui aboutit —
 * sans eux, une pile qui repondrait `unreachable` a TOUT passerait cette
 * sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function maquette() {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, poste.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
    await routeur.executeCommand(c);
  }
  await poste.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');
  return { routeur, poste };
}

describe('une destination sans route n\'est pas un delai', () => {
  it('le verdict de la pile est `unreachable`, pas `timeout`', async () => {
    const { routeur } = await maquette();
    expect(routeur.getTcpStack().connectOutcome('203.0.113.9', 23)).toBe('unreachable');
  });

  it('IOS le dit dans SES mots', async () => {
    const { routeur } = await maquette();
    const sortie = await routeur.executeCommand('telnet 203.0.113.9');
    expect(sortie).toContain('% Destination unreachable; gateway or host down');
    expect(sortie).not.toContain('Connection timed out');
  });

  it('la pile ne pretend pas avoir une sortie qu\'elle n\'a pas', async () => {
    const { routeur } = await maquette();
    expect(routeur.getTcpStack().hasEgressTo('203.0.113.9')).toBe(false);
    expect(routeur.getTcpStack().hasEgressTo('10.0.0.2')).toBe(true);
  });

  it('openssl rend l\'errno de la vraie machine : 101, pas 110', async () => {
    const { poste } = await maquette();
    const sansRoute = await poste.executeCommand('openssl s_client -connect 203.0.113.9:443');
    expect(sansRoute).toContain('connect:errno=101');
    const refuse = await poste.executeCommand('openssl s_client -connect 10.0.0.1:9999');
    expect(refuse).toContain('connect:errno=111');
  });

  it('nmap donne la RAISON de nmap : net-unreach, pas no-response', async () => {
    const { poste } = await maquette();
    const lointain = new LinuxPC('LOIN');
    new Cable('c2').connect(lointain.getPorts()[0], poste.getPorts()[1]);
    lointain.getPorts()[0].configureIP(
      new IPAddress('172.16.9.9'), new SubnetMask('255.255.255.0'));

    const sortie = await poste.executeCommand('nmap --reason -p 22 172.16.9.9');
    expect(sortie).toContain('net-unreach');
    expect(sortie).not.toContain('no-response');
  });

  it('TEMOIN : un pair joignable qui n\'ecoute pas REFUSE, il n\'est pas injoignable', async () => {
    const { routeur } = await maquette();
    expect(routeur.getTcpStack().connectOutcome('10.0.0.2', 9999)).toBe('refused');
  });

  it('TEMOIN : un pair joignable qui ecoute est joint', async () => {
    const { routeur, poste } = await maquette();
    poste.getTcpStack().listen(9000, { onAccept: () => undefined });
    expect(routeur.getTcpStack().connectOutcome('10.0.0.2', 9000)).toBe('open');
  });
});
