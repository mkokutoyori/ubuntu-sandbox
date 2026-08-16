/**
 * Le NAT d'un ASA 8.3+ : `nat (inside,outside) …` sous `object network`.
 *
 * Le moteur savait deja traduire ; ce qui manquait etait la GRAMMAIRE, et
 * une regle d'ordonnancement que la syntaxe seule ne donne pas.
 *
 * Ce que la documentation Cisco fixe et que ce fichier verifie :
 *
 *   1. La premiere interface est celle d'ENTREE, la seconde celle de
 *      SORTIE — `nat (inside,outside)` et `nat (outside,inside)` ne
 *      decrivent pas le meme trafic.
 *   2. `dynamic interface` traduit vers l'adresse de la SECONDE interface,
 *      pas de celle ou l'objet est defini.
 *   3. **L'AUTO NAT est evalue APRES le NAT manuel, quel que soit l'ordre
 *      de saisie.** C'est le piege le plus connu de l'ASA : une regle
 *      objet ecrite en premier ne s'applique pas en premier. Une
 *      implementation qui se contenterait d'empiler dans l'ordre tape
 *      donnerait la bonne reponse tant qu'on ne melange pas les deux, et
 *      la mauvaise le jour ou on les melange — c'est-a-dire le jour ou
 *      cela compte.
 *
 * La regle 8.3+ « on designe l'adresse REELLE, pas la traduite » est portee
 * par le profil (`policySeesPreNatDestination: false`) et verifiee ailleurs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { ASA_NAT_SECTIONS } from '@/network/devices/firewall/vendors/asa/AsaProfile';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function lab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  const shell = new AsaShell(fw);

  run(shell, 'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside',
    'ip address 192.168.1.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'nameif outside',
    'ip address 203.0.113.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/2', 'nameif dmz', 'security-level 50',
    'ip address 192.168.50.1 255.255.255.0', 'exit');

  return { fw, shell };
}

function run(shell: AsaShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

beforeEach(() => { Logger.reset(); });

describe('object network + nat — la grammaire', () => {
  it('`nat (inside,outside) dynamic interface` cree une regle', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface');

    expect(fw.getNatPolicy().size()).toBe(1);
  });

  it('la regle porte l\'objet comme source originale', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface');

    expect(fw.getNatPolicy().ordered()[0].originalSource).toEqual(['LAN']);
  });

  it('la premiere interface est l\'ENTREE, la seconde la SORTIE', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface');

    const rule = fw.getNatPolicy().ordered()[0];
    expect(rule.fromZone).toEqual(['inside']);
    expect(rule.toZone).toEqual(['outside']);
  });

  it('`nat (dmz,outside) static <ip>` cree une traduction statique', () => {
    const { fw, shell } = lab();

    run(shell, 'object network SRV_WEB', 'host 192.168.50.10',
      'nat (dmz,outside) static 203.0.113.10');

    const rule = fw.getNatPolicy().ordered()[0];
    expect(rule.type).toBe('static');
    expect(rule.sourceTranslation?.translatedAddress).toEqual(['203.0.113.10']);
  });

  it('`static` vers un OBJET est accepte aussi', () => {
    const { fw, shell } = lab();

    run(shell, 'object network PUB', 'host 203.0.113.10', 'exit',
      'object network SRV_WEB', 'host 192.168.50.10',
      'nat (dmz,outside) static PUB');

    expect(fw.getNatPolicy().ordered()[0].sourceTranslation?.translatedAddress)
      .toEqual(['PUB']);
  });

  it('une traduction statique est BIDIRECTIONNELLE — c\'est ce qui publie le serveur', () => {
    const { fw, shell } = lab();

    run(shell, 'object network SRV_WEB', 'host 192.168.50.10',
      'nat (dmz,outside) static 203.0.113.10');

    expect(fw.getNatPolicy().ordered()[0].bidirectional).toBe(true);
  });

  it('`dynamic` vers une adresse nommee plutot que l\'interface', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic 198.51.100.7');

    expect(fw.getNatPolicy().ordered()[0].sourceTranslation?.translatedAddress)
      .toEqual(['198.51.100.7']);
  });

  it('une interface inconnue est refusee, et rien n\'est stocke', () => {
    const { fw, shell } = lab();

    const out = run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (fantome,outside) dynamic interface');

    expect(out).toContain('Invalid input');
    expect(fw.getNatPolicy().size()).toBe(0);
  });

  it('une forme sans parentheses est refusee', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat inside,outside dynamic interface');

    expect(fw.getNatPolicy().size()).toBe(0);
  });

  it('`no nat` retire la regle de l\'objet', () => {
    const { fw, shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface');

    run(shell, 'no nat (inside,outside) dynamic interface');

    expect(fw.getNatPolicy().size()).toBe(0);
  });

  it('un objet ne porte QU\'UNE regle — la seconde remplace la premiere', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface',
      'nat (inside,outside) dynamic 198.51.100.7');

    expect(fw.getNatPolicy().size()).toBe(1);
    expect(fw.getNatPolicy().ordered()[0].sourceTranslation?.translatedAddress)
      .toEqual(['198.51.100.7']);
  });
});

describe('object network + nat — l\'AUTO NAT passe apres le MANUEL', () => {
  it('une regle objet est rangee dans la section auto', () => {
    const { fw, shell } = lab();

    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface');

    expect(fw.getNatPolicy().ordered()[0].section).toBe(ASA_NAT_SECTIONS.auto);
  });

  it('ecrite EN PREMIER, elle est evaluee EN SECOND', () => {
    const { fw, shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');

    fw.getNatPolicy().append({
      id: 'MANUELLE', type: 'dynamic-pat', section: ASA_NAT_SECTIONS.manual,
      fromZone: ['inside'], toZone: ['outside'],
    });

    expect(fw.getNatPolicy().ordered().map(rule => rule.id))
      .toEqual(['MANUELLE', 'LAN']);
  });

  it('le trafic suit cet ordre — la regle manuelle gagne', () => {
    const { fw, shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');
    fw.getNatPolicy().append({
      id: 'MANUELLE', type: 'dynamic-pat', section: ASA_NAT_SECTIONS.manual,
      fromZone: ['inside'], toZone: ['outside'], originalSource: ['LAN'],
      sourceTranslation: { kind: 'static-ip', translatedAddress: ['198.51.100.9'] },
    });

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/0', protocol: 'tcp',
      sourceIP: '192.168.1.10', sourcePort: 44001,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('198.51.100.9');
  });

  it('sans regle manuelle, la regle objet s\'applique bien — le temoin', () => {
    const { fw, shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/0', protocol: 'tcp',
      sourceIP: '192.168.1.10', sourcePort: 44001,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('203.0.113.1');
    expect(fw.getNatPolicy().size()).toBe(1);
  });
});

describe('object network + nat — la configuration rendue', () => {
  it('rend la ligne `nat` SOUS son objet', () => {
    const { shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'end');

    const out = run(shell, 'show running-config');

    expect(out).toContain('object network LAN');
    expect(out).toContain(' subnet 192.168.1.0 255.255.255.0');
    expect(out).toContain(' nat (inside,outside) dynamic interface');
  });

  it('elle reproduit une traduction statique telle qu\'elle a ete tapee', () => {
    const { shell } = lab();
    run(shell, 'object network SRV', 'host 192.168.50.10',
      'nat (dmz,outside) static 203.0.113.10', 'end');

    expect(run(shell, 'show running-config'))
      .toContain(' nat (dmz,outside) static 203.0.113.10');
  });

  it('`show nat` liste les regles dans l\'ordre EVALUE', () => {
    const { fw, shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');
    fw.getNatPolicy().append({
      id: 'MANUELLE', type: 'dynamic-pat', section: ASA_NAT_SECTIONS.manual,
      fromZone: ['inside'], toZone: ['outside'],
    });

    const out = run(shell, 'show nat');

    expect(out.indexOf('MANUELLE')).toBeLessThan(out.indexOf('LAN'));
  });

  it('`show nat` distingue les deux sections par leur nom', () => {
    const { shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface');

    expect(run(shell, 'show nat')).toContain('Auto NAT Policies');
  });
});

describe('object network + nat static — la traduction est BIDIRECTIONNELLE', () => {
  function published() {
    const l = lab();
    run(l.shell, 'object network SRV_WEB', 'host 192.168.50.10',
      'nat (dmz,outside) static 203.0.113.10', 'exit');
    l.fw.getPolicyStore().append({
      id: 'OUVRE', from: ['GigabitEthernet0/1'], to: ['GigabitEthernet0/2'], action: 'allow',
    });
    return l;
  }

  it('depuis dehors, l\'adresse PUBLIEE est de-NATee vers la reelle', () => {
    const { fw } = published();

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/1', protocol: 'tcp',
      sourceIP: '198.51.100.5', sourcePort: 51000,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedDestinationIP).toBe('192.168.50.10');
  });

  it('et le paquet ressort par l\'interface du serveur REEL', () => {
    const { fw } = published();

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/1', protocol: 'tcp',
      sourceIP: '198.51.100.5', sourcePort: 51000,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.egressPort).toBe('GigabitEthernet0/2');
    expect(result.allowed).toBe(true);
  });

  it('le sens sortant traduit toujours la source — le temoin', () => {
    const { fw } = published();

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/2', protocol: 'tcp',
      sourceIP: '192.168.50.10', sourcePort: 44001,
      destinationIP: '203.0.113.50', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('203.0.113.10');
  });

  it('une regle DYNAMIQUE n\'est PAS bidirectionnelle — rien n\'entre', () => {
    const { fw, shell } = lab();
    run(shell, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/1', protocol: 'tcp',
      sourceIP: '198.51.100.5', sourcePort: 51000,
      destinationIP: '203.0.113.1', destinationPort: 443,
    });

    expect(result.translatedDestinationIP).toBe(result.originalDestinationIP);
  });
});
