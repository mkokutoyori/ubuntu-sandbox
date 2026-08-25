/**
 * Une diffusion dirigee explose ou tombe — phase 2 du BRD du modele
 * TCP/IP, increment 4.
 *
 * MESURE DE DEPART. `ip directed-broadcast` etait accepte, range sur le
 * port (`Port.directedBroadcast`), rendu par `show running-config` — et
 * `isDirectedBroadcastEnabled()` n'avait qu'UN appelant dans tout le
 * depot : le rendu de la configuration. Aucun plan de donnees ne le
 * lisait. Sur le meme laboratoire, `ping -b 192.168.20.255` depuis un
 * hote de 192.168.10.0/24 rendait `100% packet loss` AVEC comme SANS la
 * commande : la seule difference observable entre les deux
 * configurations etait le texte de la configuration. C'est exactement ce
 * que le CLAUDE.md interdit — « ne jamais ranger un critere qu'on
 * n'evalue pas » — et le fait que la valeur par defaut soit la bonne
 * rendait l'inertie invisible : SANS la commande, le paquet tombait, et
 * il tombait pour la mauvaise raison (le routeur cherchait a resoudre
 * 192.168.20.255 en ARP, sans succes) et non parce qu'une regle en avait
 * decide.
 *
 * L'ATTESTATION. RFC 2644 (BCP 34, aout 1999) renverse le defaut de la
 * RFC 1812 : un routeur PEUT offrir l'option, mais elle « MUST default
 * to blocking receipt and blocking forwarding of network-prefix-directed
 * broadcasts ». Cisco l'applique depuis IOS 12.0, et la documentation de
 * la commande dit une chose qu'il ne fallait pas rater : elle « affects
 * only the final transmission of the directed broadcast on its ultimate
 * destination subnet » — ce n'est donc PAS une barriere generale
 * d'acheminement. Un paquet qui TRAVERSE un routeur vers le sous-reseau
 * cible est achemine normalement ; seul le dernier routeur, celui qui
 * est directement connecte a la cible, l'explose en diffusion physique
 * (option active) ou le jette (defaut). C'est pourquoi la regle est
 * posee la ou se decide « livrer ici / faire suivre / jeter », et pas
 * dans `forwardPacket`.
 *
 * DISCRIMINATION (`git stash` sur `Router.ts` et `InternetLayer.ts`) :
 * 7 des 9 cas tombent, et le detail compte plus que le nombre.
 *  - les 3 cas unitaires d'`isDirectedBroadcast` tombent pour une raison
 *    MECANIQUE — la fonction n'existe pas encore, donc l'import echoue.
 *    Ils ne prouvent rien du comportement de la machine et sont comptes
 *    ici pour ce qu'ils sont : la sonde de la regle elle-meme.
 *  - les 4 autres sont de vrais ecarts observes sur le fil.
 *  - « SANS la commande, aucune diffusion IPv4 ne part » est le TEMOIN
 *    et passe des deux cotes : avant correctif aucune ne partait non
 *    plus. Sans lui, le correctif le plus simple serait d'exploser
 *    TOUJOURS.
 *  - « la ligne est rendue dans la configuration » marchait deja, et
 *    c'est precisement ce qui rendait le defaut difficile a voir.
 *
 * DEUX CAS ONT ETE RENFORCES PARCE QU'ILS PASSAIENT POUR LA MAUVAISE
 * RAISON, et le dire vaut mieux que de garder le compte : « la cible
 * recoit » comptait n'importe quelle trame entrante, et « elle sort en
 * diffusion physique » cherchait ff:ff:ff:ff:ff:ff sans regarder
 * l'etherType — or AVANT correctif le routeur emettait justement une
 * requete ARP de diffusion pour resoudre 192.168.20.255. Les deux
 * passaient donc sur cet ARP. Ils comptent desormais les seules trames
 * IPv4, et tombent.
 *
 * CE QUE CELA REVELE AU PASSAGE : avant correctif, une diffusion dirigee
 * venue de l'exterieur faisait FUIR une requete ARP sur le sous-reseau
 * cible. Le paquet ne passait pas, mais le routeur parlait quand meme au
 * segment qu'on cherchait a atteindre.
 *
 * CE QUE LA MESURE A CORRIGE D'UNE DE MES SUPPOSITIONS : j'avais ecrit
 * un cas attendant que la cible REPONDE, donc que le ping aboutisse. Il
 * est tombe, et il avait tort. Un vrai Linux ne repond pas a un echo
 * adresse a une diffusion : `net.ipv4.icmp_echo_ignore_broadcasts` vaut
 * 1 par defaut, ce qui est precisement la contre-mesure Smurf que la RFC
 * 2644 vient completer cote routeur. L'observable de ce lot est donc la
 * LIVRAISON — la trame atteint le sous-reseau cible, en diffusion
 * physique — et non une reponse. Faire « marcher » le ping aurait
 * demande de casser cette contre-mesure-la.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { isDirectedBroadcast } from '@/network/layers/internet/InternetLayer';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(dirige: boolean) {
  const routeur = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const source = new LinuxPC('linux-pc', 'SRC', -200, 0);
  const cible = new LinuxPC('linux-pc', 'CIBLE', 200, 0);
  new Cable('gauche').connect(source.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
  new Cable('droite').connect(routeur.getPort('GigabitEthernet0/1')!, cible.getPort('eth0')!);

  await taper(routeur, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    'ip address 192.168.20.1 255.255.255.0', 'no shutdown',
    ...(dirige ? ['ip directed-broadcast'] : []), 'exit', 'end']);
  await taper(source, ['ip link set eth0 up',
    'ip addr add 192.168.10.10/24 dev eth0', 'ip route add default via 192.168.10.1']);
  await taper(cible, ['ip link set eth0 up',
    'ip addr add 192.168.20.10/24 dev eth0', 'ip route add default via 192.168.20.1']);
  return { routeur, source, cible };
}

describe('la regle de la RFC 2644 vit dans la couche internet', () => {
  const masque = new SubnetMask('255.255.255.0');
  const connecte = [{ address: new IPAddress('192.168.20.1'), mask: masque }];

  it('la diffusion du sous-reseau connecte est reconnue', () => {
    expect(isDirectedBroadcast(new IPAddress('192.168.20.255'), connecte)).toBe(true);
  });

  it('celle d\'un AUTRE sous-reseau ne l\'est pas', () => {
    expect(isDirectedBroadcast(new IPAddress('192.168.30.255'), connecte)).toBe(false);
  });

  it('ni la diffusion limitee, ni un hote ordinaire', () => {
    expect(isDirectedBroadcast(new IPAddress('255.255.255.255'), connecte)).toBe(false);
    expect(isDirectedBroadcast(new IPAddress('192.168.20.10'), connecte)).toBe(false);
  });
});

describe('et le routeur l\'applique', () => {
  async function diffusionsRecues(dirige: boolean): Promise<number> {
    const { routeur, source } = await laboratoire(dirige);
    const sortie = routeur.getPort('GigabitEthernet0/1')!;
    let vues = 0;
    const original = sortie.sendFrame.bind(sortie);
    (sortie as unknown as { sendFrame: unknown }).sendFrame =
      (f: { etherType: number; dstMAC: MACAddress }) => {
        if (f.etherType === ETHERTYPE_IPV4 && f.dstMAC.isBroadcast()) vues += 1;
        return original(f as never);
      };
    await source.executeCommand('ping -c 2 -b 192.168.20.255');
    return vues;
  }

  it('SANS la commande, aucune diffusion IPv4 ne part vers la cible', async () => {
    expect(await diffusionsRecues(false)).toBe(0);
  });

  it('AVEC la commande, la diffusion part vers la cible', async () => {
    expect(await diffusionsRecues(true)).toBeGreaterThan(0);
  });

  it('et SANS elle, rien du tout n\'atteint le sous-reseau cible', async () => {
    const { source, cible } = await laboratoire(false);
    const avant = cible.getPort('eth0')!.getCounters().framesIn;
    await source.executeCommand('ping -c 2 -b 192.168.20.255');
    expect(cible.getPort('eth0')!.getCounters().framesIn - avant).toBe(0);
  });

  it('et elle sort en diffusion PHYSIQUE, pas en unicast ni en ARP', async () => {
    const { routeur, source } = await laboratoire(true);
    const sortie = routeur.getPort('GigabitEthernet0/1')!;
    const ipv4 = new Map<string, number>();
    const original = sortie.sendFrame.bind(sortie);
    (sortie as unknown as { sendFrame: unknown }).sendFrame =
      (f: { etherType: number; dstMAC: MACAddress }) => {
        if (f.etherType === ETHERTYPE_IPV4) {
          const cle = f.dstMAC.toString().toLowerCase();
          ipv4.set(cle, (ipv4.get(cle) ?? 0) + 1);
        }
        return original(f as never);
      };
    await source.executeCommand('ping -c 1 -b 192.168.20.255');
    expect([...ipv4.keys()]).toEqual(['ff:ff:ff:ff:ff:ff']);
  });

  it('le TTL est decremente comme sur tout acheminement', async () => {
    const { routeur, source } = await laboratoire(true);
    const sortie = routeur.getPort('GigabitEthernet0/1')!;
    const ttls: number[] = [];
    const original = sortie.sendFrame.bind(sortie);
    (sortie as unknown as { sendFrame: unknown }).sendFrame =
      (f: { payload?: { ttl?: number } }) => {
        if (typeof f.payload?.ttl === 'number') ttls.push(f.payload.ttl);
        return original(f as never);
      };
    await source.executeCommand('ping -c 1 -b 192.168.20.255');
    expect(ttls.length).toBeGreaterThan(0);
    expect(ttls.every((t) => t < 64)).toBe(true);
  });

  it('la ligne est rendue dans la configuration', async () => {
    const { routeur } = await laboratoire(true);
    expect(await routeur.executeCommand('show running-config'))
      .toContain('ip directed-broadcast');
  });
});
