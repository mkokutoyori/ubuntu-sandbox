/**
 * `AddressObject` — l'objet adresse et sa correspondance.
 *
 * BRD-Firewall §8.3. Aucun des quatre constructeurs n'ecrit d'adresse
 * litterale dans une regle de production, et FortiOS l'INTERDIT. Un socle
 * qui n'aurait que des litteraux ne pourrait reproduire aucune
 * configuration realiste.
 *
 * Le choix de conception que ces cas fixent : `subnet` et `wildcard` ne
 * sont PAS deux mecanismes. Les deux repondent « ce bit doit-il
 * correspondre ? », et la seule difference est que le masque d'un
 * sous-reseau est contigu quand celui d'un masque generique ne l'est pas.
 * L'implementation les ramene donc a un unique MASQUE DE BITS SIGNIFICATIFS
 * normalise a la construction, ce qui evite deux chemins de correspondance
 * qui pourraient un jour se contredire.
 *
 * La consequence pratique est que la convention d'ecriture devient une
 * affaire de CONSTRUCTEUR et non de moteur : Cisco ecrit un masque
 * generique ou le bit a 1 est « peu importe », d'autres ecrivent l'inverse.
 * `addressFromCiscoWildcard` convertit a l'entree ; le moteur n'a qu'une
 * regle.
 *
 * `fqdn` sans resolveur ne correspond a RIEN, et c'est deliberé : un objet
 * FQDN fige a la creation serait un litteral deguise, et une regle qui
 * correspondrait « par defaut » serait une faille.
 */

import { describe, it, expect } from 'vitest';
import {
  addressObjectMatches,
  anyAddress,
  fqdnAddress,
  hostAddress,
  rangeAddress,
  subnetAddress,
  addressFromCiscoWildcard,
  wildcardAddress,
  type AddressMatchContext,
} from '@/network/devices/firewall/model/AddressObject';

const NO_CONTEXT: AddressMatchContext = {};

function resolver(map: Record<string, string[]>): AddressMatchContext {
  return { resolveFqdn: (name) => map[name] ?? [] };
}

describe('AddressObject — hote', () => {
  it('correspond a son adresse exacte', () => {
    const obj = hostAddress('SRV_WEB', '192.168.50.10');

    expect(addressObjectMatches(obj, '192.168.50.10', NO_CONTEXT)).toBe(true);
  });

  it('ne correspond a aucune autre adresse', () => {
    const obj = hostAddress('SRV_WEB', '192.168.50.10');

    expect(addressObjectMatches(obj, '192.168.50.11', NO_CONTEXT)).toBe(false);
  });
});

describe('AddressObject — sous-reseau', () => {
  it('correspond a une adresse du sous-reseau', () => {
    const obj = subnetAddress('LAN', '192.168.1.0', '255.255.255.0');

    expect(addressObjectMatches(obj, '192.168.1.42', NO_CONTEXT)).toBe(true);
  });

  it('ne correspond pas a une adresse hors du sous-reseau', () => {
    const obj = subnetAddress('LAN', '192.168.1.0', '255.255.255.0');

    expect(addressObjectMatches(obj, '192.168.2.42', NO_CONTEXT)).toBe(false);
  });

  it('un /32 se comporte comme un hote', () => {
    const obj = subnetAddress('UN_SEUL', '10.0.0.7', '255.255.255.255');

    expect(addressObjectMatches(obj, '10.0.0.7', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '10.0.0.8', NO_CONTEXT)).toBe(false);
  });

  it('un /0 correspond a tout', () => {
    const obj = subnetAddress('TOUT', '0.0.0.0', '0.0.0.0');

    expect(addressObjectMatches(obj, '203.0.113.5', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '10.0.0.1', NO_CONTEXT)).toBe(true);
  });

  it('accepte la notation en longueur de prefixe', () => {
    const obj = subnetAddress('LAN', '192.168.1.0', 24);

    expect(addressObjectMatches(obj, '192.168.1.42', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '192.168.2.42', NO_CONTEXT)).toBe(false);
  });
});

describe('AddressObject — plage', () => {
  it('correspond aux deux bornes INCLUSES', () => {
    const obj = rangeAddress('POOL', '192.168.1.10', '192.168.1.20');

    expect(addressObjectMatches(obj, '192.168.1.10', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '192.168.1.20', NO_CONTEXT)).toBe(true);
  });

  it('correspond a une adresse interieure', () => {
    const obj = rangeAddress('POOL', '192.168.1.10', '192.168.1.20');

    expect(addressObjectMatches(obj, '192.168.1.15', NO_CONTEXT)).toBe(true);
  });

  it('ne correspond pas juste en dehors des bornes', () => {
    const obj = rangeAddress('POOL', '192.168.1.10', '192.168.1.20');

    expect(addressObjectMatches(obj, '192.168.1.9', NO_CONTEXT)).toBe(false);
    expect(addressObjectMatches(obj, '192.168.1.21', NO_CONTEXT)).toBe(false);
  });

  it('une plage aux bornes inversees ne correspond a RIEN', () => {
    const obj = rangeAddress('INVERSEE', '192.168.1.20', '192.168.1.10');

    expect(addressObjectMatches(obj, '192.168.1.15', NO_CONTEXT)).toBe(false);
  });

  it('traverse correctement une frontiere d\'octet', () => {
    const obj = rangeAddress('POOL', '192.168.1.250', '192.168.2.5');

    expect(addressObjectMatches(obj, '192.168.1.255', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '192.168.2.1', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '192.168.2.6', NO_CONTEXT)).toBe(false);
  });
});

describe('AddressObject — masque generique', () => {
  it('correspond sur les bits significatifs, meme non contigus', () => {
    const obj = wildcardAddress('PAIRS', '10.0.0.0', '255.255.255.254');

    expect(addressObjectMatches(obj, '10.0.0.0', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '10.0.0.1', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '10.0.0.2', NO_CONTEXT)).toBe(false);
  });

  it('la forme Cisco INVERSE le masque — 0 doit correspondre, 1 est « peu importe »', () => {
    const cisco = addressFromCiscoWildcard('SOUS_RESEAU', '192.168.1.0', '0.0.0.255');

    expect(addressObjectMatches(cisco, '192.168.1.42', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(cisco, '192.168.2.42', NO_CONTEXT)).toBe(false);
  });

  it('la forme Cisco et la forme en masque significatif decrivent le meme ensemble', () => {
    const cisco = addressFromCiscoWildcard('A', '192.168.1.0', '0.0.0.255');
    const direct = wildcardAddress('B', '192.168.1.0', '255.255.255.0');

    for (const candidate of ['192.168.1.1', '192.168.1.254', '192.168.2.1', '10.0.0.1']) {
      expect(addressObjectMatches(cisco, candidate, NO_CONTEXT))
        .toBe(addressObjectMatches(direct, candidate, NO_CONTEXT));
    }
  });
});

describe('AddressObject — any', () => {
  it('correspond a toute adresse', () => {
    const obj = anyAddress();

    expect(addressObjectMatches(obj, '0.0.0.0', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '255.255.255.255', NO_CONTEXT)).toBe(true);
    expect(addressObjectMatches(obj, '192.168.1.1', NO_CONTEXT)).toBe(true);
  });

  it('est predefini', () => {
    expect(anyAddress().predefined).toBe(true);
  });
});

describe('AddressObject — FQDN', () => {
  it('correspond a une adresse que le resolveur rend', () => {
    const obj = fqdnAddress('SITE', 'www.example.com');
    const ctx = resolver({ 'www.example.com': ['203.0.113.5', '203.0.113.6'] });

    expect(addressObjectMatches(obj, '203.0.113.5', ctx)).toBe(true);
    expect(addressObjectMatches(obj, '203.0.113.6', ctx)).toBe(true);
  });

  it('ne correspond pas a une adresse que le resolveur ne rend pas', () => {
    const obj = fqdnAddress('SITE', 'www.example.com');
    const ctx = resolver({ 'www.example.com': ['203.0.113.5'] });

    expect(addressObjectMatches(obj, '203.0.113.9', ctx)).toBe(false);
  });

  it('SANS resolveur, ne correspond a RIEN — un FQDN fige serait un litteral deguise', () => {
    const obj = fqdnAddress('SITE', 'www.example.com');

    expect(addressObjectMatches(obj, '203.0.113.5', NO_CONTEXT)).toBe(false);
  });

  it('suit un changement de resolution — c\'est tout l\'interet d\'un objet FQDN', () => {
    const obj = fqdnAddress('SITE', 'www.example.com');
    const avant = resolver({ 'www.example.com': ['203.0.113.5'] });
    const apres = resolver({ 'www.example.com': ['198.51.100.7'] });

    expect(addressObjectMatches(obj, '203.0.113.5', avant)).toBe(true);
    expect(addressObjectMatches(obj, '203.0.113.5', apres)).toBe(false);
    expect(addressObjectMatches(obj, '198.51.100.7', apres)).toBe(true);
  });
});

describe('AddressObject — robustesse', () => {
  it('une adresse candidate invalide ne correspond a rien et ne leve pas', () => {
    for (const obj of [
      hostAddress('H', '10.0.0.1'),
      subnetAddress('S', '10.0.0.0', 8),
      rangeAddress('R', '10.0.0.1', '10.0.0.9'),
      wildcardAddress('W', '10.0.0.0', '255.0.0.0'),
    ]) {
      expect(() => addressObjectMatches(obj, 'pas-une-adresse', NO_CONTEXT)).not.toThrow();
      expect(addressObjectMatches(obj, 'pas-une-adresse', NO_CONTEXT)).toBe(false);
    }
  });

  it('any correspond meme a une chaine invalide — il ne regarde pas l\'adresse', () => {
    expect(addressObjectMatches(anyAddress(), 'peu-importe', NO_CONTEXT)).toBe(true);
  });

  it('les objets rendus sont geles', () => {
    expect(Object.isFrozen(hostAddress('H', '10.0.0.1'))).toBe(true);
    expect(Object.isFrozen(anyAddress())).toBe(true);
  });

  it('porte son nom et sa famille', () => {
    const obj = hostAddress('SRV', '10.0.0.1');

    expect(obj.name).toBe('SRV');
    expect(obj.family).toBe('ipv4');
  });
});
