/**
 * Le NAT MANUEL d'un ASA — la section 1, dite « twice NAT ».
 *
 * Sa raison d'etre : traduire la source EN FONCTION de la destination. Une
 * regle objet ne sait pas faire cela, elle ne connait qu'un objet.
 *
 * **Le detail qui s'inverse sans qu'on le voie** : la clause `source`
 * s'ecrit REELLE puis TRADUITE, et la clause `destination` s'ecrit
 * TRADUITE puis REELLE. L'ordre est inverse entre les deux, et c'est
 * logique une fois dit — pour la destination, le paquet ARRIVE sur
 * l'adresse traduite, donc c'est elle qu'on nomme en premier, comme
 * critere. Une implementation qui aligne les deux clauses « pour la
 * cohérence » de-NATe vers la mauvaise machine, et rien ne le signale.
 *
 * La forme retenue est celle de l'exemple du BRD (§ tableau des commandes
 * ASA) : `nat (outside,dmz) source static any any destination static
 * PUB_IP SRV_WEB` — `PUB_IP` traduite, `SRV_WEB` reelle.
 *
 * `after-auto` range la regle en section 3, apres l'auto NAT : c'est la
 * seule facon d'ecrire une regle manuelle qui passe APRES une regle objet,
 * et sans elle la section 3 serait un rang que rien ne peut atteindre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { ASA_NAT_SECTIONS } from '@/network/devices/firewall/vendors/asa/AsaProfile';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function run(shell: AsaShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

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
    'ip address 192.168.50.1 255.255.255.0', 'exit',
    'object network SRV_WEB', 'host 192.168.50.10', 'exit',
    'object network PUB_IP', 'host 203.0.113.10', 'exit',
    'object network LAN', 'subnet 192.168.1.0 255.255.255.0', 'exit');

  return { fw, shell };
}

beforeEach(() => { Logger.reset(); });

describe('nat manuel — la grammaire', () => {
  it('`source static` cree une regle', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (inside,outside) source static LAN PUB_IP');

    expect(fw.getNatPolicy().size()).toBe(1);
  });

  it('la clause source s\'ecrit REELLE puis TRADUITE', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (inside,outside) source static LAN PUB_IP');

    const rule = fw.getNatPolicy().ordered()[0];
    expect(rule.originalSource).toEqual(['LAN']);
    expect(rule.sourceTranslation?.translatedAddress).toEqual(['PUB_IP']);
  });

  it('la clause destination s\'ecrit TRADUITE puis REELLE — l\'inverse', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (outside,dmz) source static any any destination static PUB_IP SRV_WEB');

    const rule = fw.getNatPolicy().ordered()[0];
    expect(rule.originalDestination).toEqual(['PUB_IP']);
    expect(rule.destinationTranslation?.translatedAddress).toBe('SRV_WEB');
  });

  it('`source dynamic ... interface` est accepte', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (inside,outside) source dynamic LAN interface');

    expect(fw.getNatPolicy().ordered()[0].sourceTranslation?.kind)
      .toBe('interface-address');
  });

  it('une regle manuelle va en SECTION 1', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (inside,outside) source static LAN PUB_IP');

    expect(fw.getNatPolicy().ordered()[0].section).toBe(ASA_NAT_SECTIONS.manual);
  });

  it('`after-auto` la range en SECTION 3', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (inside,outside) after-auto source static LAN PUB_IP');

    expect(fw.getNatPolicy().ordered()[0].section).toBe(ASA_NAT_SECTIONS.autoAfter);
  });

  it('et elle passe alors APRES une regle objet', () => {
    const { fw, shell } = lab();
    run(shell, 'object network AUTRE', 'subnet 10.0.0.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');

    run(shell, 'nat (inside,outside) after-auto source static LAN PUB_IP');

    expect(fw.getNatPolicy().ordered().map(rule => rule.originalSource[0]))
      .toEqual(['AUTRE', 'LAN']);
  });

  it('sans `after-auto`, elle passe AVANT', () => {
    const { fw, shell } = lab();
    run(shell, 'object network AUTRE', 'subnet 10.0.0.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'exit');

    run(shell, 'nat (inside,outside) source static LAN PUB_IP');

    expect(fw.getNatPolicy().ordered().map(rule => rule.originalSource[0]))
      .toEqual(['LAN', 'AUTRE']);
  });

  it('une interface inconnue est refusee', () => {
    const { fw, shell } = lab();

    const out = run(shell, 'nat (fantome,outside) source static LAN PUB_IP');

    expect(out).toContain('Invalid input');
    expect(fw.getNatPolicy().size()).toBe(0);
  });

  it('une clause `source` incomplete est refusee', () => {
    const { fw, shell } = lab();

    run(shell, 'nat (inside,outside) source static LAN');

    expect(fw.getNatPolicy().size()).toBe(0);
  });

  it('deux regles manuelles gardent leur ordre de saisie', () => {
    const { fw, shell } = lab();

    run(shell,
      'nat (inside,outside) source static LAN PUB_IP',
      'nat (inside,outside) source static SRV_WEB PUB_IP');

    expect(fw.getNatPolicy().ordered().map(rule => rule.originalSource[0]))
      .toEqual(['LAN', 'SRV_WEB']);
  });
});

describe('nat manuel — la traduction a lieu', () => {
  it('la source est traduite pour de bon', () => {
    const { fw, shell } = lab();
    run(shell, 'nat (inside,outside) source dynamic LAN interface');

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/0', protocol: 'tcp',
      sourceIP: '192.168.1.10', sourcePort: 44001,
      destinationIP: '203.0.113.50', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('203.0.113.1');
  });

  it('la destination est dé-NATée vers la machine REELLE', () => {
    const { fw, shell } = lab();
    run(shell, 'nat (outside,dmz) source static any any destination static PUB_IP SRV_WEB');
    fw.getPolicyStore().append({
      id: 'OUVRE', from: ['GigabitEthernet0/1'], to: ['GigabitEthernet0/2'], action: 'allow',
    });

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/1', protocol: 'tcp',
      sourceIP: '198.51.100.5', sourcePort: 51000,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedDestinationIP).toBe('192.168.50.10');
  });

  it('un flux qui ne correspond pas n\'est pas traduit — le temoin', () => {
    const { fw, shell } = lab();
    run(shell, 'nat (inside,outside) source dynamic LAN interface');

    const result = fw.simulate({
      ingressPort: 'GigabitEthernet0/2', protocol: 'tcp',
      sourceIP: '192.168.50.10', sourcePort: 44001,
      destinationIP: '203.0.113.50', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('192.168.50.10');
  });
});

describe('nat manuel — la configuration rendue', () => {
  it('reproduit la ligne telle qu\'elle a ete tapee', () => {
    const { shell } = lab();
    run(shell, 'nat (outside,dmz) source static any any destination static PUB_IP SRV_WEB',
      'end');

    expect(run(shell, 'show running-config'))
      .toContain('nat (outside,dmz) source static any any destination static PUB_IP SRV_WEB');
  });

  it('la ligne manuelle n\'est PAS rangee sous un objet', () => {
    const { shell } = lab();
    run(shell, 'nat (inside,outside) source static LAN PUB_IP', 'end');

    const lignes = run(shell, 'show running-config').split('\n');
    const index = lignes.findIndex(l => l.startsWith('nat ('));

    expect(index).toBeGreaterThan(-1);
    expect(lignes[index].startsWith(' ')).toBe(false);
  });

  it('`show nat` la montre en section 1', () => {
    const { shell } = lab();
    run(shell, 'nat (inside,outside) source static LAN PUB_IP');

    expect(run(shell, 'show nat')).toContain('Manual NAT Policies (Section 1)');
  });
});
