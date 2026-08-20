/**
 * `ObjectStore` — le magasin d'objets et de groupes.
 *
 * BRD-Firewall §8.6 et §8.7. Un groupe et un objet se resolvent par la
 * MEME interface : c'est le patron Composite, et c'est ce qui permet a une
 * regle de referencer indifferemment l'un ou l'autre sans le savoir.
 *
 * Cinq invariants, dont trois sont des pieges pedagogiques :
 *
 * — I-G2 : la recursion est refusee A L'ECRITURE. Un cycle produirait une
 *   evaluation infinie ; le refuser au moment ou l'operateur le cree est la
 *   seule facon de le lui dire.
 * — I-G4 : un groupe VIDE est legal et ne correspond a RIEN. Un apprenant
 *   qui cree un groupe, l'utilise dans une regle et oublie d'y mettre des
 *   membres doit voir sa regle ne jamais correspondre — pas correspondre a
 *   tout. L'inverse serait une faille enseignee.
 * — I-A1 : un objet reference ne peut pas etre supprime, et le refus NOMME
 *   le referent.
 *
 * I-A5 est le plus subtil et vient d'une lecon deja payee dans ce depot :
 * `referenceCount` est CALCULE a la lecture, jamais stocke. La colonne
 * « Used by » de `lsmod` est calculee comme l'inverse des dependances
 * declarees pour exactement cette raison — « deux colonnes qui peuvent se
 * contredire sont pires qu'une colonne fausse ».
 *
 * I-R1 : l'aplatissement est calcule A L'EVALUATION, jamais memorise a
 * l'ecriture, sans quoi un objet FQDN dont l'adresse change, ou un groupe
 * dont un membre est ajoute, ne prendrait pas effet sur les regles
 * existantes.
 */

import { describe, it, expect } from 'vitest';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import { hostAddress, subnetAddress, fqdnAddress } from '@/network/devices/firewall/model/AddressObject';
import { tcpService, udpService } from '@/network/devices/firewall/model/ServiceObject';
import { IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';

function store(): ObjectStore {
  return new ObjectStore();
}

function withHosts(...specs: Array<[string, string]>): ObjectStore {
  const s = store();
  for (const [name, ip] of specs) s.addAddress(hostAddress(name, ip));
  return s;
}

describe('ObjectStore — objets adresse', () => {
  it('enregistre et retrouve un objet', () => {
    const s = withHosts(['SRV_WEB', '192.168.50.10']);

    expect(s.getAddress('SRV_WEB')?.name).toBe('SRV_WEB');
  });

  it('refuse un nom deja pris', () => {
    const s = withHosts(['SRV', '10.0.0.1']);

    const result = s.addAddress(hostAddress('SRV', '10.0.0.2'));

    expect(result.ok === false && result.error.kind).toBe('duplicate-name');
  });

  it('fournit `any` predefini des la construction', () => {
    expect(store().getAddress('any')?.predefined).toBe(true);
  });

  it('refuse de supprimer un objet predefini', () => {
    const result = store().removeAddress('any');

    expect(result.ok === false && result.error.kind).toBe('predefined-object');
  });

  it('supprime un objet que rien ne reference', () => {
    const s = withHosts(['SRV', '10.0.0.1']);

    expect(s.removeAddress('SRV').ok).toBe(true);
    expect(s.getAddress('SRV')).toBeUndefined();
  });

  it('refuse de supprimer un objet inconnu', () => {
    expect(store().removeAddress('fantome').ok).toBe(false);
  });
});

describe('ObjectStore — groupes d\'adresses', () => {
  it('cree un groupe et resout ses membres', () => {
    const s = withHosts(['A', '10.0.0.1'], ['B', '10.0.0.2']);
    s.addAddressGroup('SERVEURS', ['A', 'B']);

    expect(s.matchesAddress('SERVEURS', '10.0.0.1')).toBe(true);
    expect(s.matchesAddress('SERVEURS', '10.0.0.2')).toBe(true);
    expect(s.matchesAddress('SERVEURS', '10.0.0.3')).toBe(false);
  });

  it('un objet simple et un groupe se resolvent par la MEME interface', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('G', ['A']);

    expect(s.matchesAddress('A', '10.0.0.1')).toBe(true);
    expect(s.matchesAddress('G', '10.0.0.1')).toBe(true);
  });

  it('I-G4 : un groupe VIDE ne correspond a RIEN', () => {
    const s = store();
    s.addAddressGroup('VIDE', []);

    expect(s.matchesAddress('VIDE', '10.0.0.1')).toBe(false);
    expect(s.matchesAddress('VIDE', '0.0.0.0')).toBe(false);
  });

  it('resout un groupe IMBRIQUE', () => {
    const s = withHosts(['A', '10.0.0.1'], ['B', '10.0.0.2']);
    s.addAddressGroup('INTERNE', ['A']);
    s.addAddressGroup('TOUT', ['INTERNE', 'B']);

    expect(s.matchesAddress('TOUT', '10.0.0.1')).toBe(true);
    expect(s.matchesAddress('TOUT', '10.0.0.2')).toBe(true);
  });

  it('resout trois niveaux d\'imbrication', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('N1', ['A']);
    s.addAddressGroup('N2', ['N1']);
    s.addAddressGroup('N3', ['N2']);

    expect(s.matchesAddress('N3', '10.0.0.1')).toBe(true);
  });

  it('refuse un membre inconnu a la creation', () => {
    const result = store().addAddressGroup('G', ['FANTOME']);

    expect(result.ok === false && result.error.kind).toBe('unknown-member');
  });

  it('I-G2 : refuse un groupe qui se contient lui-meme', () => {
    const s = store();

    const result = s.addAddressGroup('G', ['G']);

    expect(result.ok === false && result.error.kind).toBe('unknown-member');
  });

  it('I-G2 : refuse un CYCLE cree par ajout de membre', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('G1', ['A']);
    s.addAddressGroup('G2', ['G1']);

    const result = s.addGroupMember('G1', 'G2');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('recursive-group');
  });

  it('I-G3 : refuse une imbrication au-dela de la profondeur declaree', () => {
    const s = new ObjectStore({ maxGroupNesting: 2 });
    s.addAddress(hostAddress('A', '10.0.0.1'));
    s.addAddressGroup('N1', ['A']);
    s.addAddressGroup('N2', ['N1']);

    const result = s.addAddressGroup('N3', ['N2']);

    expect(result.ok === false && result.error.kind).toBe('nesting-too-deep');
  });

  it('I-R1 : un membre ajoute APRES coup prend effet immediatement', () => {
    const s = withHosts(['A', '10.0.0.1'], ['B', '10.0.0.2']);
    s.addAddressGroup('G', ['A']);
    expect(s.matchesAddress('G', '10.0.0.2')).toBe(false);

    s.addGroupMember('G', 'B');

    expect(s.matchesAddress('G', '10.0.0.2')).toBe(true);
  });

  it('I-R1 : un membre retire cesse de correspondre immediatement', () => {
    const s = withHosts(['A', '10.0.0.1'], ['B', '10.0.0.2']);
    s.addAddressGroup('G', ['A', 'B']);

    s.removeGroupMember('G', 'B');

    expect(s.matchesAddress('G', '10.0.0.2')).toBe(false);
    expect(s.matchesAddress('G', '10.0.0.1')).toBe(true);
  });

  it('I-R1 : une resolution FQDN qui change prend effet immediatement', () => {
    let resolved = ['203.0.113.5'];
    const s = new ObjectStore({ resolveFqdn: () => resolved });
    s.addAddress(fqdnAddress('SITE', 'www.example.com'));
    s.addAddressGroup('G', ['SITE']);
    expect(s.matchesAddress('G', '203.0.113.5')).toBe(true);

    resolved = ['198.51.100.7'];

    expect(s.matchesAddress('G', '203.0.113.5')).toBe(false);
    expect(s.matchesAddress('G', '198.51.100.7')).toBe(true);
  });
});

describe('ObjectStore — references', () => {
  it('I-A5 : le compte de references est CALCULE, pas stocke', () => {
    const s = withHosts(['A', '10.0.0.1']);
    expect(s.referenceCount('A')).toBe(0);

    s.addAddressGroup('G', ['A']);
    expect(s.referenceCount('A')).toBe(1);

    s.addAddressGroup('G2', ['A']);
    expect(s.referenceCount('A')).toBe(2);

    s.removeGroupMember('G2', 'A');
    expect(s.referenceCount('A')).toBe(1);
  });

  it('I-A1 : refuse de supprimer un objet reference, en NOMMANT le referent', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('SERVEURS', ['A']);

    const result = s.removeAddress('A');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('object-referenced');
    expect(result.ok === false && result.error.kind === 'object-referenced'
      && result.error.referents).toContain('address-group SERVEURS');
    expect(s.getAddress('A')).toBeDefined();
  });

  it('autorise la suppression une fois la derniere reference retiree', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('G', ['A']);
    s.removeGroupMember('G', 'A');

    expect(s.removeAddress('A').ok).toBe(true);
  });

  it('compte aussi les references venues de l\'exterieur du magasin', () => {
    const s = new ObjectStore({
      externalReferences: (name) => (name === 'A' ? ['security rule "R1"'] : []),
    });
    s.addAddress(hostAddress('A', '10.0.0.1'));

    const result = s.removeAddress('A');

    expect(result.ok === false && result.error.kind === 'object-referenced'
      && result.error.referents).toEqual(['security rule "R1"']);
  });

  it('refuse de supprimer un groupe reference par un autre groupe', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('INTERNE', ['A']);
    s.addAddressGroup('TOUT', ['INTERNE']);

    expect(s.removeAddressGroup('INTERNE').ok).toBe(false);
  });
});

describe('ObjectStore — services et leurs groupes', () => {
  it('enregistre et fait correspondre un service', () => {
    const s = store();
    s.addService(tcpService('HTTP', 80));

    expect(s.matchesService('HTTP', { protocol: IP_PROTO_TCP, destPort: 80 })).toBe(true);
    expect(s.matchesService('HTTP', { protocol: IP_PROTO_TCP, destPort: 443 })).toBe(false);
  });

  it('resout un groupe de services', () => {
    const s = store();
    s.addService(tcpService('HTTP', 80));
    s.addService(tcpService('HTTPS', 443));
    s.addServiceGroup('WEB', ['HTTP', 'HTTPS']);

    expect(s.matchesService('WEB', { protocol: IP_PROTO_TCP, destPort: 80 })).toBe(true);
    expect(s.matchesService('WEB', { protocol: IP_PROTO_TCP, destPort: 443 })).toBe(true);
    expect(s.matchesService('WEB', { protocol: IP_PROTO_TCP, destPort: 22 })).toBe(false);
  });

  it('resout un groupe de services imbrique', () => {
    const s = store();
    s.addService(tcpService('HTTP', 80));
    s.addService(udpService('DNS_UDP', 53));
    s.addServiceGroup('WEB', ['HTTP']);
    s.addServiceGroup('TOUT', ['WEB', 'DNS_UDP']);

    expect(s.matchesService('TOUT', { protocol: IP_PROTO_TCP, destPort: 80 })).toBe(true);
    expect(s.matchesService('TOUT', { protocol: IP_PROTO_UDP, destPort: 53 })).toBe(true);
  });

  it('I-G4 : un groupe de services VIDE ne correspond a rien', () => {
    const s = store();
    s.addServiceGroup('VIDE', []);

    expect(s.matchesService('VIDE', { protocol: IP_PROTO_TCP, destPort: 80 })).toBe(false);
  });

  it('fournit `any` predefini pour les services', () => {
    const s = store();

    expect(s.getService('any')?.predefined).toBe(true);
    expect(s.matchesService('any', { protocol: IP_PROTO_TCP, destPort: 12345 })).toBe(true);
  });

  it('I-G1 : un groupe d\'adresses ne peut pas contenir un service', () => {
    const s = store();
    s.addService(tcpService('HTTP', 80));

    const result = s.addAddressGroup('G', ['HTTP']);

    expect(result.ok === false && result.error.kind).toBe('unknown-member');
  });
});

describe('ObjectStore — resolution d\'un nom inconnu', () => {
  it('un nom d\'adresse inconnu ne correspond a rien', () => {
    expect(store().matchesAddress('FANTOME', '10.0.0.1')).toBe(false);
  });

  it('un nom de service inconnu ne correspond a rien', () => {
    expect(store().matchesService('FANTOME', { protocol: IP_PROTO_TCP, destPort: 80 })).toBe(false);
  });

  it('matchesAnyAddress est vrai des qu\'un nom de la liste correspond', () => {
    const s = withHosts(['A', '10.0.0.1'], ['B', '10.0.0.2']);

    expect(s.matchesAnyAddress(['A', 'B'], '10.0.0.2')).toBe(true);
    expect(s.matchesAnyAddress(['A', 'B'], '10.0.0.9')).toBe(false);
  });

  it('matchesAnyAddress sur une liste VIDE est faux', () => {
    expect(withHosts(['A', '10.0.0.1']).matchesAnyAddress([], '10.0.0.1')).toBe(false);
  });
});

describe('ObjectStore — enumeration', () => {
  it('liste les adresses sans les predefinies quand on le demande', () => {
    const s = withHosts(['A', '10.0.0.1']);

    expect(s.listAddresses({ includePredefined: false }).map(o => o.name)).toEqual(['A']);
    expect(s.listAddresses().some(o => o.name === 'any')).toBe(true);
  });

  it('liste les groupes d\'adresses', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('G', ['A']);

    expect(s.listAddressGroups().map(g => g.name)).toEqual(['G']);
  });

  it('la vue d\'un groupe ne laisse pas muter ses membres', () => {
    const s = withHosts(['A', '10.0.0.1']);
    s.addAddressGroup('G', ['A']);

    const group = s.getAddressGroup('G')!;
    expect(() => (group.members as string[]).push('B')).toThrow();
  });

  it('un sous-reseau membre d\'un groupe fait correspondre toute sa plage', () => {
    const s = store();
    s.addAddress(subnetAddress('LAN', '192.168.1.0', 24));
    s.addAddressGroup('INTERNES', ['LAN']);

    expect(s.matchesAddress('INTERNES', '192.168.1.99')).toBe(true);
    expect(s.matchesAddress('INTERNES', '192.168.2.99')).toBe(false);
  });
});
