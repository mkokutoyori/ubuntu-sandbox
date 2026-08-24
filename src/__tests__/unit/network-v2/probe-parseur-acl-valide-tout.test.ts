/**
 * Une liste de controle se REFUSE quand elle est malformee.
 *
 * Signale par un utilisateur avec un exemple qui dit tout :
 * `access-list 100 permit deny 192.168.10.0 0.0.0.255 192.168.20.0
 * 0.0.0.255 eq 22` etait ACCEPTE, range, et rendu tel quel par
 * `show access-lists` — donc rejoue a l'import d'une topologie. Le mot
 * `deny` etait lu comme le PROTOCOLE, place que rien ne validait.
 *
 * La mesure a trouve la meme famille partout :
 *
 *   permit zorglub any any            -> accepte
 *   permit tcp any any eq 99999       -> accepte (un port qui n'existe pas)
 *   permit tcp any any eq 80abc       -> accepte, et range 80 : l'operateur
 *                                        croyait ecrire une regle, il en
 *                                        avait ecrit une AUTRE
 *   permit tcp any any range 200 100  -> accepte, et ne correspond a rien
 *   rule permit deny source ...       -> accepte sur VRP aussi
 *
 * La CAUSE tient en deux points. Le premier : `parseExtendedAce` prenait
 * `args[0]` pour un protocole sans jamais le juger. Le second est celui
 * que ce depot passe son temps a refermer — il y avait DEUX analyseurs
 * d'ACE etendue, `parseExtendedAce` et une copie complete inlinee dans
 * le gestionnaire d'`access-list <n>`, et c'est la copie qui avait
 * diverge ; le gestionnaire numerote DELEGUE desormais.
 *
 * `router/acl/AclSyntax.ts` porte le vocabulaire une seule fois — les
 * mots-cles de protocole d'IOS avec leurs numeros IANA, les noms de
 * port, la grammaire des operateurs — et Cisco comme Huawei le lisent :
 * deux tables qui divergeraient finiraient par accepter sur un
 * constructeur ce que l'autre refuse. `ACLEngine.getProtocolName` lit la
 * MEME table, de sorte qu'aucun protocole accepte a l'analyse ne reste
 * un critere que rien n'evalue.
 *
 * Discrimination par `git stash` sur les trois fichiers cables : 6 des
 * 11 cas tombent. Les 5 autres sont nommes plutot que laisses a
 * decouvrir. TROIS sont des TEMOINS, et ils sont la parce qu'un
 * analyseur qui refuserait TOUT passerait une sonde faite seulement de
 * refus : les deux regles bien formees, et le cas de bout en bout ou une
 * liste acceptee filtre encore un vrai paquet. UN porte sur ce qui etait
 * DEJA juste et garde qu'on ne l'a pas casse : l'adressage. Le dernier
 * est la sonde unitaire de la grammaire partagee, dont le module est
 * nouveau et purement additif.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import {
  parseIpProtocol, parseAclPort, parseAclPortSpec, protocolKeywordFor,
} from '@/network/devices/router/acl/AclSyntax';

const REFUS_IOS = "% Invalid input detected at '^' marker.";

async function cisco(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  for (const c of ['enable', 'configure terminal']) await r.executeCommand(c);
  return r;
}

async function vrp(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('R2');
  for (const c of ['system-view', 'acl 3000']) await r.executeCommand(c);
  return r;
}

describe('le parseur d ACL valide ce qu il accepte', () => {
  beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

  it('le cas signale par l utilisateur est refuse', async () => {
    const r = await cisco();
    expect(await r.executeCommand(
      'access-list 100 permit deny 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255 eq 22'))
      .toContain(REFUS_IOS);
    expect(await r.executeCommand('do show access-lists 100'))
      .toContain('% Access list 100 not found');
  }, 30000);

  it('IOS : un protocole inconnu, un port impossible, une plage a l envers', async () => {
    const r = await cisco();
    for (const mauvais of [
      'access-list 100 permit zorglub any any',
      'access-list 100 permit tcp any any eq 99999',
      'access-list 100 permit tcp any any eq 80abc',
      'access-list 100 permit tcp any any range 200 100',
      'access-list 100 permit tcp any any eq -1',
      'access-list 100 permit 256 any any',
    ]) {
      expect(await r.executeCommand(mauvais), mauvais).toContain(REFUS_IOS);
    }
    expect(await r.executeCommand('do show access-lists 100'))
      .toContain('% Access list 100 not found');
  }, 30000);

  it('IOS : un port n a de sens que sur un protocole qui en porte', async () => {
    const r = await cisco();
    for (const mauvais of [
      'access-list 100 permit icmp any any eq 80',
      'access-list 100 permit ospf any eq 22 any',
      'access-list 100 permit ip any any eq 80',
    ]) {
      expect(await r.executeCommand(mauvais), mauvais).toContain(REFUS_IOS);
    }
  }, 30000);

  it('IOS : une adresse malformee est refusee, pas construite', async () => {
    const r = await cisco();
    for (const mauvais of [
      'access-list 100 permit tcp 999.1.1.1 0.0.0.255 any',
      'access-list 100 permit tcp host 10.0.0.300 any',
      'access-list 100 permit tcp 10.0.0.0 zorglub any',
      'access-list 10 permit 10.0.0.300',
    ]) {
      expect(await r.executeCommand(mauvais), mauvais).toContain(REFUS_IOS);
    }
  }, 30000);

  it('IOS : la numerotation decide du type, et une liste standard ne porte pas de protocole', async () => {
    const r = await cisco();
    for (const horsPlage of ['200', '1299', '2700', '5000']) {
      expect(await r.executeCommand(`access-list ${horsPlage} permit ip any any`), horsPlage)
        .toContain(REFUS_IOS);
    }
    expect(await r.executeCommand('access-list 10 permit tcp any any')).toContain(REFUS_IOS);
    expect(await r.executeCommand('access-list 2000 permit any')).toContain(REFUS_IOS);

    expect(await r.executeCommand('access-list 10 permit 192.168.1.0 0.0.0.255')).toBe('');
    expect(await r.executeCommand('access-list 1300 permit any')).toBe('');
    expect(await r.executeCommand('access-list 1999 permit any')).toBe('');
    expect(await r.executeCommand('access-list 2000 permit tcp any any')).toBe('');
    expect(await r.executeCommand('access-list 2699 permit ip any any')).toBe('');
  }, 30000);

  it('IOS : un numero de protocole est rendu par son nom, comme IOS', async () => {
    const r = await cisco();
    expect(await r.executeCommand('access-list 100 permit 89 any any')).toBe('');
    expect(await r.executeCommand('do show access-lists 100')).toContain('permit ospf any any');
  }, 30000);

  it('VRP : les memes refus, avec les mots de VRP', async () => {
    const r = await vrp();
    for (const mauvais of [
      'rule 5 permit deny source 192.168.10.0 0.0.0.255',
      'rule 5 permit zorglub source any',
      'rule 15 permit tcp source any destination-port eq 99999',
      'rule 20 permit tcp source any destination-port eq 80abc',
      'rule 25 permit tcp source any destination-port range 200 100',
      'rule 30 permit icmp source any destination-port eq 80',
    ]) {
      expect(await r.executeCommand(mauvais), mauvais).toContain('Error: Unrecognized command');
    }
    expect(await r.executeCommand('display acl 3000')).toContain('0 rule(s)');
  }, 30000);

  it('TEMOIN, IOS : une regle bien formee est acceptee et rendue telle quelle', async () => {
    const r = await cisco();
    for (const bon of [
      'access-list 100 permit tcp 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255 eq 22',
      'access-list 100 deny tcp any host 10.0.0.1 range 100 200',
      'access-list 100 permit tcp any any eq www',
      'access-list 100 permit ip any any',
      'access-list 100 permit icmp any any echo',
    ]) {
      expect(await r.executeCommand(bon), bon).toBe('');
    }
    const vue = await r.executeCommand('do show access-lists 100');
    expect(vue).toContain('permit tcp 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255 eq 22');
    expect(vue).toContain('deny tcp any host 10.0.0.1 range 100 200');
    expect(vue).toContain('permit tcp any any eq 80');
  }, 30000);

  it('TEMOIN, VRP : une regle bien formee est acceptee', async () => {
    const r = await vrp();
    expect(await r.executeCommand('rule 5 permit tcp source 192.168.10.0 0.0.0.255 destination-port eq 22')).toBe('');
    expect(await r.executeCommand('display acl 3000'))
      .toContain('rule 5 permit tcp source 192.168.10.0 0.0.0.255 destination-port eq 22');
  }, 30000);

  it('TEMOIN e2e : une liste acceptee FILTRE encore vraiment', async () => {
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    const r = new CiscoRouter('R1');
    const permis = new LinuxPC('linux-pc', 'OUI');
    const refuse = new LinuxPC('linux-pc', 'NON');
    const cible = new LinuxPC('linux-pc', 'CIBLE');
    new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
    new Cable('b').connect(permis.getPort('eth0')!, sw.getPorts()[1]);
    new Cable('c').connect(refuse.getPort('eth0')!, sw.getPorts()[2]);
    new Cable('d').connect(cible.getPort('eth0')!, r.getPort('GigabitEthernet0/1')!);

    for (const c of [
      'enable', 'configure terminal',
      'access-list 100 deny ip host 10.0.0.3 any',
      'access-list 100 permit ip any any',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0',
      'ip access-group 100 in', 'no shutdown', 'end',
    ]) await r.executeCommand(c);
    for (const [pc, ip] of [[permis, '10.0.0.2'], [refuse, '10.0.0.3']] as Array<[LinuxPC, string]>) {
      pc.configureInterface('eth0', new IPAddress(ip), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('10.0.0.1'));
    }
    cible.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    cible.setDefaultGateway(new IPAddress('10.0.1.1'));

    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip access-group 100 in');
    await r.executeCommand('end');

    expect(await permis.executeCommand('ping -c 1 10.0.1.2')).toMatch(/, 0% packet loss/);
    expect(await refuse.executeCommand('ping -c 1 10.0.1.2')).toMatch(/, 100% packet loss/);
  }, 30000);

  it('la grammaire partagee juge protocole, port et operateur', () => {
    expect(parseIpProtocol('tcp')).toBe('tcp');
    expect(parseIpProtocol('TCP')).toBe('tcp');
    expect(parseIpProtocol('89')).toBe('ospf');
    expect(parseIpProtocol('200')).toBe('200');
    expect(parseIpProtocol('256')).toBeNull();
    expect(parseIpProtocol('deny')).toBeNull();
    expect(parseIpProtocol('zorglub')).toBeNull();

    expect(parseAclPort('80')).toBe(80);
    expect(parseAclPort('www')).toBe(80);
    expect(parseAclPort('65535')).toBe(65535);
    expect(parseAclPort('65536')).toBeNull();
    expect(parseAclPort('80abc')).toBeNull();
    expect(parseAclPort('-1')).toBeNull();

    expect(parseAclPortSpec(['range', '100', '200'], 0)?.spec)
      .toEqual({ op: 'range', port: 100, endPort: 200 });
    expect(parseAclPortSpec(['range', '200', '100'], 0)).toBeNull();
    expect(parseAclPortSpec(['zorglub', '80'], 0)).toBeNull();

    expect(protocolKeywordFor(6)).toBe('tcp');
    expect(protocolKeywordFor(89)).toBe('ospf');
    expect(protocolKeywordFor(200)).toBe('ip');
  });
});
