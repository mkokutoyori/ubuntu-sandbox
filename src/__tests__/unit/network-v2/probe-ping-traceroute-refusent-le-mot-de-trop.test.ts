/*
 * `ping 10.0.0.1 zorglub` etait ACCEPTE, et le mot de trop jete.
 *
 * L'analyseur partage des deux plateformes (`cisco/ciscoPing.ts`) et
 * celui de `traceroute` (`CiscoIOSShell._handleTraceroute`) finissent
 * tous deux leur boucle d'options par la meme ligne :
 *
 *     } else {
 *       i++;
 *     }
 *
 * Un mot qu'ils ne reconnaissent pas avance donc le curseur sans rien
 * dire. Quatre formes en decoulent, toutes silencieuses, et la sonde
 * les separe parce qu'elles ne se corrigent pas au meme endroit :
 *
 *   1. un mot INCONNU (`zorglub`) est avale ;
 *   2. un mot-cle SANS sa valeur (`repeat` en fin de ligne) tombe dans
 *      le meme `else`, donc la commande part avec le defaut ;
 *   3. une valeur NON NUMERIQUE (`repeat zorglub`) passe le
 *      `!isNaN(n)` en le manquant, et le compte reste celui du defaut ;
 *   4. une valeur HORS BORNE (`repeat 0`) est ecartee par le
 *      `n > 0` — donc lue, jugee, puis oubliee.
 *
 * Le cas 4 est le plus couteux des quatre, parce qu'il a toutes les
 * apparences d'avoir fonctionne : l'operateur qui tape `repeat 0` voit
 * cinq echos partir. C'est exactement ce que la regle nomme — un
 * critere que le moteur n'evalue pas est REFUSE, pas ignore — et la
 * variante la plus trompeuse, celle ou le moteur LIT la valeur et la
 * jette.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau, donc la sonde n'exige AUCUNE borne chiffree : elle exige
 * qu'un mot que l'aide n'annonce pas soit refuse, et qu'une valeur que
 * le moteur ecarte le soit aussi. Les bornes elles-memes restent celles
 * que le code portait deja.
 *
 * `ping` est joue sur les DEUX plateformes par une table unique, parce
 * que l'analyseur est partage : un correctif qui ne vaudrait que d'un
 * cote reussirait la moitie des cas en silence. `traceroute` n'existe
 * que sur le routeur — le commutateur ne l'enregistre pas — donc sa
 * table est a part, et c'est un fait mesure, pas un oubli.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 20 des 29 cas
 * tombent — 14 pour `ping` (sept formes sur deux plateformes) et 6
 * pour `traceroute`. Les 9 TEMOINS passent des deux cotes, et sans eux
 * la table ne prouverait rien — une sonde faite de refus est satisfaite par une
 * machine qui refuse tout. Ils verifient que la forme NUE marche, que
 * `repeat 2` envoie bien DEUX echos (et non cinq), que `size` et
 * `timeout` restent acceptes, et que `traceroute ttl 1 5` passe.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  powerOn: () => void;
};

const REFUS = /Invalid input|Incomplete command/;

let serie = 0;

const PLATEFORMES: Array<[string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serie++}`, 2, 2) as unknown as Cli],
  ['commutateur', () => new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli],
];

async function exec(make: () => Cli, ligne: string): Promise<string> {
  const d = make();
  d.powerOn();
  await d.executeCommand('enable');
  return String(await d.executeCommand(ligne));
}

describe.each(PLATEFORMES)('%s — `ping` refuse le mot de trop', (_nom, make) => {
  it.each([
    'ping 10.0.0.1 zorglub',
    'ping 10.0.0.1 repeat',
    'ping 10.0.0.1 repeat zorglub',
    'ping 10.0.0.1 repeat 0',
    'ping 10.0.0.1 size zorglub',
    'ping 10.0.0.1 timeout zorglub',
    'ping 10.0.0.1 source',
  ])('`%s`', async (ligne) => {
    expect(await exec(make, ligne), ligne).toMatch(REFUS);
  });

  it('la forme nue envoie ses cinq echos — le TEMOIN', async () => {
    expect(await exec(make, 'ping 10.0.0.1')).toMatch(/Sending 5, 100-byte ICMP Echos/);
  });

  it('`repeat 2` envoie DEUX echos — le TEMOIN qui compte', async () => {
    expect(await exec(make, 'ping 10.0.0.1 repeat 2'))
      .toMatch(/Sending 2, 100-byte ICMP Echos/);
  });

  it('`size 200` change la taille — TEMOIN', async () => {
    expect(await exec(make, 'ping 10.0.0.1 size 200'))
      .toMatch(/Sending 5, 200-byte ICMP Echos/);
  });

  it('`timeout 1` est accepte — TEMOIN', async () => {
    expect(await exec(make, 'ping 10.0.0.1 timeout 1'))
      .toMatch(/timeout is 1 seconds/);
  });
});

describe('routeur — `traceroute` refuse le mot de trop', () => {
  const make = PLATEFORMES[0][1];

  it.each([
    'traceroute 10.0.0.1 zorglub',
    'traceroute 10.0.0.1 ttl',
    'traceroute 10.0.0.1 ttl zorglub',
    'traceroute 10.0.0.1 probe zorglub',
    'traceroute 10.0.0.1 probe 0',
    'traceroute 10.0.0.1 timeout zorglub',
  ])('`%s`', async (ligne) => {
    expect(await exec(make, ligne), ligne).toMatch(REFUS);
  });

  it('`traceroute 10.0.0.1 ttl 1 5` passe — le TEMOIN', async () => {
    expect(await exec(make, 'traceroute 10.0.0.1 ttl 1 5'))
      .toMatch(/Tracing the route to 10\.0\.0\.1/);
  });
});
