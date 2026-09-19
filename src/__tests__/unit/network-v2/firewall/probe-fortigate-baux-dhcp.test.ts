/**
 * `execute dhcp lease-list' ecrivait une colonne qu'aucun FortiOS n'ecrit,
 * perdait le nom que le client mettait sur le fil, et datait l'expiration
 * a UTC sur un equipement regle ailleurs.
 *
 * AUTORITE. FortiOS est proprietaire et la documentation de Fortinet n'est
 * pas joignable d'ici. La reference est la sortie CAPTUREE que
 * `ntc-templates' conserve pour eprouver `fortinet_execute_dhcp_lease-list'
 * — c'est-a-dire le texte que de vrais equipements ont rendu. Le gabarit
 * connait DEUX mises en page, et nulle part une colonne `SERVER-ID' :
 *
 *   Vlan1
 *     IP            MAC-Address             Hostname            VCI ...
 *     10.32.159.11  cc:6b:1e:14:15:e1       NLZ0637-02          MSFT 5.0 ...
 *
 * Celle-ci, a SEPT colonnes, est la recente (baux dates de 2023) ; l'autre,
 * a CINQ, vient d'un 6.0 de 2019. Cet equipement annonce `v7.6.3' par
 * `get system status', donc c'est la mise en page a sept colonnes qu'il
 * doit rendre. La lecture qu'il fallait ecarter est « les deux colonnes de
 * plus viennent du sans-fil » : c'est l'inverse, et les captures le
 * disent. Celle a CINQ colonnes porte `Staff_Wifi' et `Guest_Wifi' et n'a
 * ni `SSID' ni `AP' ; celle a SEPT porte `Vlan1', `Vlan2', `Vlan3' et les
 * a. La difference est donc de VERSION, pas d'equipement. `SSID' et `AP' restent vides : ce simulateur
 * n'a pas de controleur sans-fil, et la capture les montre vides elle
 * aussi des que le bail est filaire. `VCI' reste vide pour une raison
 * differente et dite : l'option 60 n'est pas dans la table d'options de
 * `DHCPPacket', donc rien ne la met sur le fil — la colonne est vide
 * parce que la valeur n'existe pas, pas parce qu'on l'a oubliee.
 *
 * LES COLONNES SONT MESUREES, pas estimees. Sur les lignes de donnees des
 * deux captures, les champs tombent aux colonnes 2, 16, 40, 60, 80, 100 et
 * 120 ; une largeur contient donc son propre blanc (14, 24, 20, 20, 20,
 * 20). Une valeur qui deborde n'est pas tronquee, elle POUSSE la suite :
 * la ligne dont le `VCI' fait 44 caracteres porte sa date a la colonne 144
 * et non 120, soit exactement les 24 caracteres de debordement. C'est le
 * `FIXED_TABLE' du depot, gap 0, et non un tableau a separateur.
 *
 * L'EXPIRATION EST EN FORME `ctime'. La capture ecrit
 * `Sat Aug 10 04:55:47 2019', et `Fri Aug  9 21:12:36 2019' montre le jour
 * cale sur DEUX caracteres — c'est le `%.3s %.3s%3d %.2d:%.2d:%.2d %d' de
 * `asctime'. Ce qui etait rendu, `toUTCString()', donne
 * `Sat, 10 Aug 2019 04:55:47 GMT' : ni la meme forme, ni la meme heure.
 *
 * ET C'EST L'HEURE DE L'EQUIPEMENT. Un lot precedent a corrige `date=' et
 * `time=' du journal, qui portaient UTC pendant qu'`execute time'
 * annoncait l'heure locale ; le meme defaut etait reste ici. Deux vues de
 * la MEME machine au MEME instant ne peuvent pas se contredire
 * (`CLAUDE.md' §3), et c'est la troisieme fois que ce fuseau manque a une
 * vue.
 *
 * LE NOM DU CLIENT EST SUR LE FIL ET ETAIT JETE. `EndHost' branche le nom
 * de la machine sur son client DHCP, `DhcpServerChannel' le met en option
 * 12 dans le DISCOVER comme dans le REQUEST, `DHCPDiscoverParams.hostName'
 * et `DHCPRequestParams.hostName' l'attendent — et `DhcpServerExchange',
 * qui decode le paquet cote serveur, ne le lit jamais. Le serveur ISC de
 * Linux (`LinuxDhcpdService', l.310) et celui de Windows
 * (`WindowsDhcpServerRole', l.273) lisent pourtant la meme option depuis
 * toujours : le fait traversait le reseau et un seul des trois lecteurs le
 * perdait.
 *
 * L'ADRESSE MATERIELLE EST EN MINUSCULES, et ici la capture le prouve
 * vraiment. Les adresses de la capture a sept colonnes ne sont PAS
 * anonymisees — `b8:27:eb' est la Raspberry Pi Foundation, `74:ac:b9'
 * Ubiquiti, `34:db:fd' un Cisco SPA : ce sont de vraies adresses, dans
 * leur casse d'origine. Le gabarit va dans le meme sens, sa classe de
 * caracteres etant `[a-f0-9]', qui refuse les majuscules. Le moteur DHCP
 * du depot, lui, force `chaddr' en MAJUSCULES (`DHCPPacket', neuf sites) :
 * la vue FortiOS repasse donc par `MACAddress' pour rendre la forme
 * canonique, plutot que de recopier la chaine du moteur.
 *
 * DEUX CONSTATS MESURES QUE CE LOT NE FERME PAS, dits ici plutot que
 * laisses a decouvrir :
 *
 *   - `hostnamectl set-hostname' ecrit `/etc/hostname' pendant que
 *     `Equipment.getHostname()' garde le nom de l'equipement, et c'est ce
 *     dernier que `EndHost' branche sur le client DHCP. Un poste renomme
 *     par `hostnamectl' met donc son ANCIEN nom sur le fil. Deux magasins
 *     pour un meme fait, mais `getHostname()' a 446 lecteurs dans le
 *     depot : les reunir est un lot a soi, pas un passager de celui-ci.
 *   - L'option 60 (VCI) n'est pas dans la table d'options de
 *     `DHCPPacket'. La colonne existe parce que la vraie machine l'ecrit ;
 *     elle est vide parce que rien ne met cette valeur sur le fil.
 *
 * MESURE : 9 cas tombent sur 12.
 * Les 3 qui passent des deux cotes sont nommes :
 *   - TEMOIN : un vrai poste obtient un vrai bail par un vrai DISCOVER, et
 *     la vue le montre. Sans lui, une sonde faite de refus ne distinguerait
 *     pas « la colonne est fausse » de « rien n'a jamais ete attribue » ;
 *   - NON-REGRESSION de STRUCTURE : le nom de l'interface etait deja seul
 *     sur sa ligne et sans retrait ; la refonte du tableau ne devait pas
 *     l'emporter avec elle ;
 *   - NON-REGRESSION : sans bail, la vue reste vide et ne dessine pas un
 *     en-tete orphelin.
 *
 * Un quatrieme cas passait des deux cotes a la premiere mesure et ne le
 * devait pas : « sur un pare-feu a UTC, l'expiration est l'instant du
 * bail » lisait l'heure par une expression `ctime' qui ne trouvait rien
 * dans l'ancienne sortie, et un `|| 0' rendait alors zero — le decalage
 * attendu. Un cas qui passe faute d'avoir rien lu ne prouve rien ; il
 * rend maintenant `NaN' quand la forme manque.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
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

const NOM_DU_CLIENT = 'PC';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, lignes: readonly string[]): Promise<string> {
  let out = '';
  for (const ligne of lignes) out = String(await d.executeCommand(ligne));
  return out;
}

async function laboratoire(zone: string): Promise<{ fw: FortiGate; poste: LinuxPC }> {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  fw.powerOn();
  poste.powerOn();
  new Cable('lan').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  await taper(fw, [
    'config system global', `set timezone ${zone}`, 'end',
    'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'next', 'end',
  ]);
  await taper(poste, ['ip link set eth0 up']);
  return { fw, poste };
}

async function serveurDhcp(fw: FortiGate): Promise<void> {
  await taper(fw, [
    'config system dhcp server', 'edit 1',
    'set interface "port1"',
    'set default-gateway 192.168.1.1',
    'set netmask 255.255.255.0',
    'set lease-time 3600',
    'config ip-range', 'edit 1',
    'set start-ip 192.168.1.100', 'set end-ip 192.168.1.150', 'next', 'end',
    'next', 'end',
  ]);
}

async function bailAttribue(zone: string): Promise<{ fw: FortiGate; vue: string }> {
  const { fw, poste } = await laboratoire(zone);
  await serveurDhcp(fw);
  await taper(poste, ['dhclient eth0']);
  return { fw, vue: String(await fw.executeCommand('execute dhcp lease-list')) };
}

const EN_TETE = '  IP            MAC-Address             Hostname            VCI'
  + '                 SSID                AP                  Expiry';

const CTIME = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d\d:\d\d:\d\d \d{4}/;

function decalageMinutes(vue: string, expireA: number): number {
  const lu = CTIME.exec(vue)?.[0];
  if (lu === undefined) return Number.NaN;
  return Math.round((Date.parse(`${lu} UTC`) - expireA) / 60000) + 0;
}

function ligneDuBail(vue: string): string {
  return vue.split('\n').find(l => /192\.168\.1\.1\d\d/.test(l)) ?? '';
}

describe('`execute dhcp lease-list` rend la vue qu_un vrai FortiOS rend', () => {
  it('TEMOIN : un vrai poste obtient un vrai bail, et la vue le montre', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(vue).toMatch(/192\.168\.1\.1[0-5]\d/);
  }, 30000);

  it('l en-tete est celui des SEPT colonnes, a la lettre', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(vue.split('\n')).toContain(EN_TETE);
  }, 30000);

  it('aucune colonne `SERVER-ID` : aucun FortiOS n en ecrit', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(vue).not.toContain('SERVER-ID');
  }, 30000);

  it('le nom de l interface est seul sur sa ligne, sans retrait', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(vue.split('\n')[0]).toBe('port1');
  }, 30000);

  it('les lignes du tableau portent DEUX espaces de retrait', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(ligneDuBail(vue).startsWith('  1')).toBe(true);
  }, 30000);

  it('les colonnes tombent aux positions mesurees sur la capture', async () => {
    const { fw, vue } = await bailAttribue('UTC');
    const ligne = ligneDuBail(vue);
    const bail = fw.getDhcp().leases()[0];

    expect(ligne.indexOf(bail.ip)).toBe(2);
    expect(ligne.toLowerCase().indexOf(bail.mac.toLowerCase())).toBe(16);
    expect(ligne.indexOf(NOM_DU_CLIENT)).toBe(40);
    expect(CTIME.exec(ligne)?.index).toBe(120);
  }, 30000);

  it('l expiration est en forme `ctime`, pas en RFC 1123', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(vue).toMatch(CTIME);
    expect(vue).not.toContain('GMT');
  }, 30000);

  it('sur un pare-feu a UTC, l expiration est l instant du bail', async () => {
    const { fw, vue } = await bailAttribue('UTC');
    expect(decalageMinutes(vue, fw.getDhcp().leases()[0].expiresAt)).toBe(0);
  }, 30000);

  it('sur `Asia/Kolkata`, elle porte l heure de l EQUIPEMENT', async () => {
    const { fw, vue } = await bailAttribue('Asia/Kolkata');
    expect(decalageMinutes(vue, fw.getDhcp().leases()[0].expiresAt)).toBe(330);
  }, 30000);

  it('la colonne `Hostname` porte le nom mis sur le fil par le client', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(ligneDuBail(vue).slice(40, 60).trim()).toBe(NOM_DU_CLIENT);
  }, 30000);

  it('l adresse materielle est rendue en MINUSCULES, comme la capture', async () => {
    const { vue } = await bailAttribue('UTC');
    expect(ligneDuBail(vue).slice(16, 40).trim())
      .toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  }, 30000);

  it('NON-REGRESSION : sans bail, la vue reste vide', async () => {
    const { fw } = await laboratoire('UTC');
    await serveurDhcp(fw);
    expect(String(await fw.executeCommand('execute dhcp lease-list'))).toBe('');
  }, 30000);
});
