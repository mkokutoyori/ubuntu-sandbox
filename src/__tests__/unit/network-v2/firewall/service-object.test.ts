/**
 * `ServiceObject` — l'objet service et sa correspondance.
 *
 * BRD-Firewall §8.4. Deux decisions de modele que ces cas fixent, chacune
 * parce que l'inverse etait possible et aurait rendu des configurations
 * reelles inexprimables :
 *
 * — §8.4.1 : `entries` est un TABLEAU. `HTTP` sur FortiOS est un service a
 *   une entree, mais `DNS` couvre TCP/53 ET UDP/53, `ALL_TCP` couvre toute
 *   la plage, et `service-http` de PAN-OS couvre 80 et 8080. Un service
 *   mono-protocole obligerait a creer des GROUPES la ou le constructeur
 *   cree un SERVICE — donc a ne pas reproduire sa configuration.
 * — §8.4.2 : le PORT SOURCE existe. Presque tous les cours l'ignorent et
 *   presque tous les constructeurs le proposent ; son absence rend
 *   impossible un exercice classique — filtrer un flux dont seul le port
 *   source est caracteristique. Une entree qui n'en declare pas ne le
 *   contraint pas, ce qui est le cas courant.
 *
 * ICMP se compare par type et code, et le code n'est verifie que lorsque
 * l'entree en declare un : `ALL_ICMP` ne doit pas cesser de correspondre
 * parce qu'un message porte un code inhabituel.
 */

import { describe, it, expect } from 'vitest';
import {
  anyService,
  icmpService,
  ipProtocolService,
  serviceObjectMatches,
  tcpService,
  udpService,
  makeService,
  type ServiceProbe,
} from '@/network/devices/firewall/model/ServiceObject';
import { IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';

const IP_PROTO_GRE = 47;

function probe(partial: Partial<ServiceProbe> & Pick<ServiceProbe, 'protocol'>): ServiceProbe {
  return { sourcePort: 12345, destPort: 80, ...partial };
}

describe('ServiceObject — TCP et UDP', () => {
  it('correspond au protocole et au port destination', () => {
    const http = tcpService('HTTP', 80);

    expect(serviceObjectMatches(http, probe({ protocol: IP_PROTO_TCP, destPort: 80 }))).toBe(true);
  });

  it('ne correspond pas a un autre port destination', () => {
    const http = tcpService('HTTP', 80);

    expect(serviceObjectMatches(http, probe({ protocol: IP_PROTO_TCP, destPort: 443 }))).toBe(false);
  });

  it('ne correspond pas a un autre protocole sur le meme port', () => {
    const http = tcpService('HTTP', 80);

    expect(serviceObjectMatches(http, probe({ protocol: IP_PROTO_UDP, destPort: 80 }))).toBe(false);
  });

  it('couvre plusieurs ports declares — le cas de service-http', () => {
    const web = tcpService('WEB', 80, 8080);

    expect(serviceObjectMatches(web, probe({ protocol: IP_PROTO_TCP, destPort: 80 }))).toBe(true);
    expect(serviceObjectMatches(web, probe({ protocol: IP_PROTO_TCP, destPort: 8080 }))).toBe(true);
    expect(serviceObjectMatches(web, probe({ protocol: IP_PROTO_TCP, destPort: 81 }))).toBe(false);
  });

  it('couvre une plage de ports, bornes incluses', () => {
    const plage = tcpService('HAUTS', { from: 8000, to: 8100 });

    expect(serviceObjectMatches(plage, probe({ protocol: IP_PROTO_TCP, destPort: 8000 }))).toBe(true);
    expect(serviceObjectMatches(plage, probe({ protocol: IP_PROTO_TCP, destPort: 8050 }))).toBe(true);
    expect(serviceObjectMatches(plage, probe({ protocol: IP_PROTO_TCP, destPort: 8100 }))).toBe(true);
    expect(serviceObjectMatches(plage, probe({ protocol: IP_PROTO_TCP, destPort: 8101 }))).toBe(false);
  });

  it('un service UDP correspond a UDP', () => {
    const ntp = udpService('NTP', 123);

    expect(serviceObjectMatches(ntp, probe({ protocol: IP_PROTO_UDP, destPort: 123 }))).toBe(true);
    expect(serviceObjectMatches(ntp, probe({ protocol: IP_PROTO_TCP, destPort: 123 }))).toBe(false);
  });
});

describe('ServiceObject — plusieurs entrees', () => {
  const dns = makeService('DNS', [
    { protocol: 'tcp', destinationPorts: [{ from: 53, to: 53 }] },
    { protocol: 'udp', destinationPorts: [{ from: 53, to: 53 }] },
  ]);

  it('correspond par la premiere entree', () => {
    expect(serviceObjectMatches(dns, probe({ protocol: IP_PROTO_TCP, destPort: 53 }))).toBe(true);
  });

  it('correspond par la seconde entree', () => {
    expect(serviceObjectMatches(dns, probe({ protocol: IP_PROTO_UDP, destPort: 53 }))).toBe(true);
  });

  it('ne correspond a aucune entree', () => {
    expect(serviceObjectMatches(dns, probe({ protocol: IP_PROTO_TCP, destPort: 54 }))).toBe(false);
  });

  it('un service sans aucune entree ne correspond a rien', () => {
    const vide = makeService('VIDE', []);

    expect(serviceObjectMatches(vide, probe({ protocol: IP_PROTO_TCP, destPort: 80 }))).toBe(false);
  });
});

describe('ServiceObject — port source', () => {
  const restreint = makeService('SOURCE_BASSE', [{
    protocol: 'tcp',
    sourcePorts: [{ from: 1, to: 1023 }],
    destinationPorts: [{ from: 80, to: 80 }],
  }]);

  it('correspond quand le port source est dans la plage declaree', () => {
    expect(serviceObjectMatches(restreint, probe({
      protocol: IP_PROTO_TCP, sourcePort: 500, destPort: 80,
    }))).toBe(true);
  });

  it('ne correspond PAS quand le port source est hors de la plage declaree', () => {
    expect(serviceObjectMatches(restreint, probe({
      protocol: IP_PROTO_TCP, sourcePort: 40000, destPort: 80,
    }))).toBe(false);
  });

  it('une entree SANS port source ne le contraint pas — le cas courant', () => {
    const http = tcpService('HTTP', 80);

    expect(serviceObjectMatches(http, probe({
      protocol: IP_PROTO_TCP, sourcePort: 1, destPort: 80,
    }))).toBe(true);
    expect(serviceObjectMatches(http, probe({
      protocol: IP_PROTO_TCP, sourcePort: 65535, destPort: 80,
    }))).toBe(true);
  });
});

describe('ServiceObject — ICMP', () => {
  it('correspond au type declare', () => {
    const echo = icmpService('PING', 8);

    expect(serviceObjectMatches(echo, probe({ protocol: IP_PROTO_ICMP, icmpType: 8 }))).toBe(true);
    expect(serviceObjectMatches(echo, probe({ protocol: IP_PROTO_ICMP, icmpType: 0 }))).toBe(false);
  });

  it('verifie le code quand l\'entree en declare un', () => {
    const injoignable = icmpService('PORT_INJOIGNABLE', 3, 3);

    expect(serviceObjectMatches(injoignable, probe({
      protocol: IP_PROTO_ICMP, icmpType: 3, icmpCode: 3,
    }))).toBe(true);
    expect(serviceObjectMatches(injoignable, probe({
      protocol: IP_PROTO_ICMP, icmpType: 3, icmpCode: 1,
    }))).toBe(false);
  });

  it('ne verifie PAS le code quand l\'entree n\'en declare pas', () => {
    const tousTypes3 = icmpService('INJOIGNABLE', 3);

    expect(serviceObjectMatches(tousTypes3, probe({
      protocol: IP_PROTO_ICMP, icmpType: 3, icmpCode: 0,
    }))).toBe(true);
    expect(serviceObjectMatches(tousTypes3, probe({
      protocol: IP_PROTO_ICMP, icmpType: 3, icmpCode: 13,
    }))).toBe(true);
  });

  it('une entree ICMP sans type couvre tous les types — le cas d\'ALL_ICMP', () => {
    const tout = makeService('ALL_ICMP', [{ protocol: 'icmp' }]);

    expect(serviceObjectMatches(tout, probe({ protocol: IP_PROTO_ICMP, icmpType: 8 }))).toBe(true);
    expect(serviceObjectMatches(tout, probe({ protocol: IP_PROTO_ICMP, icmpType: 11 }))).toBe(true);
  });

  it('n\'ignore pas les ports au point de correspondre a du TCP', () => {
    const echo = icmpService('PING', 8);

    expect(serviceObjectMatches(echo, probe({ protocol: IP_PROTO_TCP, destPort: 8 }))).toBe(false);
  });
});

describe('ServiceObject — protocole IP nu', () => {
  it('correspond au numero de protocole declare', () => {
    const gre = ipProtocolService('GRE', IP_PROTO_GRE);

    expect(serviceObjectMatches(gre, probe({ protocol: IP_PROTO_GRE }))).toBe(true);
    expect(serviceObjectMatches(gre, probe({ protocol: 50 }))).toBe(false);
  });

  it('ignore les ports — un protocole nu n\'en a pas', () => {
    const gre = ipProtocolService('GRE', IP_PROTO_GRE);

    expect(serviceObjectMatches(gre, probe({
      protocol: IP_PROTO_GRE, sourcePort: 0, destPort: 0,
    }))).toBe(true);
  });
});

describe('ServiceObject — any', () => {
  it('correspond a tout protocole et tout port', () => {
    const tout = anyService();

    expect(serviceObjectMatches(tout, probe({ protocol: IP_PROTO_TCP, destPort: 80 }))).toBe(true);
    expect(serviceObjectMatches(tout, probe({ protocol: IP_PROTO_UDP, destPort: 53 }))).toBe(true);
    expect(serviceObjectMatches(tout, probe({ protocol: IP_PROTO_ICMP, icmpType: 8 }))).toBe(true);
    expect(serviceObjectMatches(tout, probe({ protocol: IP_PROTO_GRE }))).toBe(true);
  });

  it('est predefini', () => {
    expect(anyService().predefined).toBe(true);
  });
});

describe('ServiceObject — immuabilite', () => {
  it('l\'objet et ses entrees sont geles', () => {
    const dns = makeService('DNS', [
      { protocol: 'tcp', destinationPorts: [{ from: 53, to: 53 }] },
    ]);

    expect(Object.isFrozen(dns)).toBe(true);
    expect(Object.isFrozen(dns.entries)).toBe(true);
    expect(Object.isFrozen(dns.entries[0])).toBe(true);
  });

  it('porte son nom', () => {
    expect(tcpService('HTTP', 80).name).toBe('HTTP');
  });
});
