/**
 * `InterfaceTable` et `RouteTable` — les deux premiers services de couche 3,
 * par COMPOSITION et non par heritage (BRD §7.3.1, arbitrage A1).
 *
 * Audit prealable, mesure et non suppose. `Router.lookupRoute` est
 * enchevetre avec sept magasins `maximum-paths` par protocole, un curseur
 * ECMP, `isRouteUsable`, le rafraichissement du plan de controle et
 * l'integration IPsec — dans un fichier de 5615 lignes. Rien de tout cela
 * n'est ce dont un pare-feu a besoin. En revanche `core/RoutingTable.ts`
 * (39 lignes) porte les primitives de correspondance, et `core/ip.ts`
 * l'arithmetique d'adresses : les deux sont reutilisees telles quelles.
 *
 * Ce que ces cas fixent :
 *
 * — La correspondance est au PLUS LONG PREFIXE. Une route /24 l'emporte sur
 *   une /16, et la route par defaut ne gagne que faute de mieux.
 * — A prefixe egal, la DISTANCE ADMINISTRATIVE tranche, la plus basse
 *   gagnant — c'est ce qui fait qu'une route flottante est une route de
 *   secours et non une route active.
 * — Les routes CONNECTEES sont derivees des interfaces, jamais saisies. Une
 *   interface qui tombe retire sa route ; une interface qui monte la remet.
 *   Sans cela, un pare-feu continuerait d'acheminer vers un lien mort.
 * — Un saut suivant hors de tout sous-reseau connecte ne resout PAS. Ce
 *   depot connait deja ce defaut cote routeur (« aucune resolution
 *   recursive de saut suivant »), et le reproduire ici serait le repayer.
 */

import { describe, it, expect } from 'vitest';
import { InterfaceTable } from '@/network/devices/firewall/l3/InterfaceTable';
import { RouteTable } from '@/network/devices/firewall/l3/RouteTable';

function interfaces(): InterfaceTable {
  const t = new InterfaceTable();
  t.configure('port1', { ip: '192.168.1.1', mask: '255.255.255.0' });
  t.configure('port2', { ip: '203.0.113.1', mask: '255.255.255.0' });
  return t;
}

function routes(ifaces = interfaces()): RouteTable {
  return new RouteTable({ connectedRoutes: () => ifaces.connectedRoutes() });
}

describe('InterfaceTable', () => {
  it('configure une interface et la retrouve', () => {
    const t = interfaces();

    expect(t.get('port1')?.ip).toBe('192.168.1.1');
    expect(t.get('port1')?.mask).toBe('255.255.255.0');
  });

  it('accepte la longueur de prefixe', () => {
    const t = new InterfaceTable();
    t.configure('port1', { ip: '10.0.0.1', prefixLength: 8 });

    expect(t.get('port1')?.mask).toBe('255.0.0.0');
  });

  it('une interface est operationnelle par defaut', () => {
    expect(interfaces().isUp('port1')).toBe(true);
  });

  it('une interface abaissee n\'est plus operationnelle', () => {
    const t = interfaces();

    t.setUp('port1', false);

    expect(t.isUp('port1')).toBe(false);
  });

  it('dit quelle interface PORTE une adresse', () => {
    const t = interfaces();

    expect(t.owningInterface('192.168.1.1')).toBe('port1');
    expect(t.owningInterface('203.0.113.1')).toBe('port2');
    expect(t.owningInterface('10.0.0.1')).toBeUndefined();
  });

  it('dit quelle interface est sur le meme sous-reseau qu\'une destination', () => {
    const t = interfaces();

    expect(t.interfaceForDestination('192.168.1.99')).toBe('port1');
    expect(t.interfaceForDestination('203.0.113.7')).toBe('port2');
    expect(t.interfaceForDestination('8.8.8.8')).toBeUndefined();
  });

  it('une interface ABAISSEE ne porte plus de sous-reseau joignable', () => {
    const t = interfaces();
    t.setUp('port1', false);

    expect(t.interfaceForDestination('192.168.1.99')).toBeUndefined();
  });

  it('derive une route connectee par interface operationnelle et adressee', () => {
    const connected = interfaces().connectedRoutes();

    expect(connected.map(r => r.network).sort()).toEqual(['192.168.1.0', '203.0.113.0']);
    expect(connected.every(r => r.kind === 'connected')).toBe(true);
  });

  it('ne derive AUCUNE route d\'une interface sans adresse', () => {
    const t = new InterfaceTable();
    t.configure('port1', {});

    expect(t.connectedRoutes()).toHaveLength(0);
  });

  it('retire la route connectee d\'une interface qui tombe', () => {
    const t = interfaces();

    t.setUp('port1', false);

    expect(t.connectedRoutes().map(r => r.network)).toEqual(['203.0.113.0']);
  });

  it('remet la route quand l\'interface remonte', () => {
    const t = interfaces();
    t.setUp('port1', false);

    t.setUp('port1', true);

    expect(t.connectedRoutes()).toHaveLength(2);
  });

  it('liste les interfaces configurees', () => {
    expect(interfaces().names()).toEqual(['port1', 'port2']);
  });

  it('la vue rendue est gelee', () => {
    expect(Object.isFrozen(interfaces().get('port1'))).toBe(true);
  });
});

describe('RouteTable — correspondance au plus long prefixe', () => {
  it('resout une destination directement connectee', () => {
    const r = routes();

    const route = r.lookup('192.168.1.99');

    expect(route?.iface).toBe('port1');
    expect(route?.kind).toBe('connected');
  });

  it('le saut suivant d\'une destination connectee est la destination elle-meme', () => {
    const r = routes();

    expect(r.resolveNextHop('192.168.1.99')?.nextHop).toBe('192.168.1.99');
  });

  it('resout par une route statique', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.254');

    const route = r.lookup('10.5.5.5');

    expect(route?.iface).toBe('port2');
    expect(route?.nextHop).toBe('203.0.113.254');
  });

  it('le /24 l\'emporte sur le /16', () => {
    const r = routes();
    r.addStatic('172.16.0.0', '255.255.0.0', '203.0.113.10');
    r.addStatic('172.16.5.0', '255.255.255.0', '203.0.113.20');

    expect(r.lookup('172.16.5.9')?.nextHop).toBe('203.0.113.20');
    expect(r.lookup('172.16.9.9')?.nextHop).toBe('203.0.113.10');
  });

  it('la route par defaut ne gagne que faute de mieux', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.10');
    r.addDefault('203.0.113.254');

    expect(r.lookup('10.1.1.1')?.nextHop).toBe('203.0.113.10');
    expect(r.lookup('8.8.8.8')?.nextHop).toBe('203.0.113.254');
  });

  it('sans route, ne resout rien — et ne devine pas', () => {
    expect(routes().lookup('8.8.8.8')).toBeUndefined();
  });

  it('une route connectee l\'emporte sur une statique de meme prefixe', () => {
    const r = routes();
    r.addStatic('192.168.1.0', '255.255.255.0', '203.0.113.254');

    expect(r.lookup('192.168.1.99')?.kind).toBe('connected');
  });
});

describe('RouteTable — distance administrative', () => {
  it('a prefixe egal, la distance la plus BASSE gagne', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.10', { distance: 1 });
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.20', { distance: 200 });

    expect(r.lookup('10.1.1.1')?.nextHop).toBe('203.0.113.10');
  });

  it('la route flottante prend le relais quand la principale disparait', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.10', { distance: 1 });
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.20', { distance: 200 });

    r.removeStatic('10.0.0.0', '255.0.0.0', '203.0.113.10');

    expect(r.lookup('10.1.1.1')?.nextHop).toBe('203.0.113.20');
  });

  it('une statique vaut 1 par defaut', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.10');

    expect(r.lookup('10.1.1.1')?.distance).toBe(1);
  });

  it('une connectee vaut 0', () => {
    expect(routes().lookup('192.168.1.9')?.distance).toBe(0);
  });
});

describe('RouteTable — utilisabilite', () => {
  it('une route dont l\'interface de sortie est TOMBEE ne resout plus', () => {
    const ifaces = interfaces();
    const r = routes(ifaces);
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.254');

    ifaces.setUp('port2', false);

    expect(r.lookup('10.1.1.1')).toBeUndefined();
  });

  it('la route revient quand l\'interface remonte', () => {
    const ifaces = interfaces();
    const r = routes(ifaces);
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.254');
    ifaces.setUp('port2', false);

    ifaces.setUp('port2', true);

    expect(r.lookup('10.1.1.1')?.nextHop).toBe('203.0.113.254');
  });

  it('un saut suivant HORS de tout sous-reseau connecte ne resout PAS', () => {
    const r = routes();

    r.addStatic('10.0.0.0', '255.0.0.0', '198.51.100.9');

    expect(r.lookup('10.1.1.1')).toBeUndefined();
  });

  it('une route nommant explicitement son interface de sortie resout', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', undefined, { iface: 'port2' });

    expect(r.lookup('10.1.1.1')?.iface).toBe('port2');
  });
});

describe('RouteTable — enumeration', () => {
  it('liste les connectees et les statiques ensemble', () => {
    const r = routes();
    r.addStatic('10.0.0.0', '255.0.0.0', '203.0.113.254');

    expect(r.all()).toHaveLength(3);
  });

  it('la liste rendue ne laisse pas muter la table', () => {
    const r = routes();

    expect(() => (r.all() as unknown[]).push({})).toThrow();
  });

  it('les connectees suivent les interfaces sans etre stockees', () => {
    const ifaces = interfaces();
    const r = routes(ifaces);
    expect(r.all()).toHaveLength(2);

    ifaces.configure('port3', { ip: '10.10.10.1', mask: '255.255.255.0' });

    expect(r.all()).toHaveLength(3);
  });
});
