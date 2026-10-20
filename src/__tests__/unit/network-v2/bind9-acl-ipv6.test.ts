/**
 * Elements IPv6 d'une liste de correspondance d'adresses de named (`2001:db8:1::/64`, `::1`,
 * `localhost`, `localnets`), BIND 9 ARM « Address Match Lists » : un element IPv6 compare un client
 * IPv6, un element IPv4 un client IPv4, `any`/`none` les deux familles.
 *
 * Mesure avant correction : la liste ne savait pas lire un prefixe IPv6 (`dns64 ... { clients {
 * 2001:db8:1::/64; }; }` etait refuse comme « undefined ACL »), et un client IPv6 ne correspondait
 * jamais a `localhost` ni a `localnets`. Avec src remis avant, les 6 cas qui lisent ou comparent de
 * l'IPv6 tombent ; 3 passent dans les deux etats : le temoin IPv4, `any` pour un client IPv6 et le
 * refus d'un client IPv6 par un element IPv4, que l'absence de support satisfait aussi.
 *
 * Limite : le service named n'ecoute pas encore en IPv6 (voir `[udp6]` dans TODO.md) ; la liste est
 * evaluee ici directement et par `dns64 { clients }`.
 */
import { describe, it, expect } from 'vitest';
import { buildNamedConfig } from '@/network/devices/linux/bind9/NamedConfig';
import { parseNamedConf } from '@/network/devices/linux/bind9/NamedConfParser';
import type { AclHostEnvironment } from '@/network/devices/linux/bind9/NamedAcl';

const ENV: AclHostEnvironment = {
  localAddresses: ['10.0.1.10', '2001:db8:1::53'],
  localNetworks: [
    { address: '10.0.1.0', prefix: 24 },
    { address: '2001:db8:1::', prefix: 64 },
  ],
};

const allowQuery = (list: string) =>
  buildNamedConfig(parseNamedConf(`options { allow-query { ${list} }; };`)).options.allowQuery;

describe('named address match lists carry IPv6', () => {
  it('witness: an IPv4 prefix matches an IPv4 client and not another', () => {
    const acl = allowQuery('10.0.1.0/24;');
    expect(acl.matches('10.0.1.7', ENV)).toBe(true);
    expect(acl.matches('10.0.2.7', ENV)).toBe(false);
  });

  it('an IPv6 prefix matches inside the prefix and not outside', () => {
    const acl = allowQuery('2001:db8:1::/64;');
    expect(acl.matches('2001:db8:1::99', ENV)).toBe(true);
    expect(acl.matches('2001:db8:2::99', ENV)).toBe(false);
  });

  it('a bare IPv6 address is a /128', () => {
    const acl = allowQuery('2001:db8:1::5;');
    expect(acl.matches('2001:db8:1::5', ENV)).toBe(true);
    expect(acl.matches('2001:db8:1::6', ENV)).toBe(false);
  });

  it('an IPv4 element never matches an IPv6 client', () => {
    expect(allowQuery('10.0.1.0/24;').matches('2001:db8:1::99', ENV)).toBe(false);
  });

  it('any matches an IPv6 client', () => {
    expect(allowQuery('any;').matches('2001:db8:9::1', ENV)).toBe(true);
  });

  it('negation applies to an IPv6 element', () => {
    const acl = allowQuery('!2001:db8:1::/64; any;');
    expect(acl.matches('2001:db8:1::1', ENV)).toBe(false);
    expect(acl.matches('2001:db8:2::1', ENV)).toBe(true);
  });

  it('localhost matches ::1 and the host\'s own IPv6 address, not a neighbour', () => {
    const acl = allowQuery('localhost;');
    expect(acl.matches('::1', ENV)).toBe(true);
    expect(acl.matches('2001:db8:1::53', ENV)).toBe(true);
    expect(acl.matches('2001:db8:1::54', ENV)).toBe(false);
  });

  it('localnets matches an IPv6 client on a directly attached prefix', () => {
    const acl = allowQuery('localnets;');
    expect(acl.matches('2001:db8:1::54', ENV)).toBe(true);
    expect(acl.matches('2001:db8:7::54', ENV)).toBe(false);
  });

  it('a dns64 clients clause reads an IPv6 prefix', () => {
    const config = buildNamedConfig(parseNamedConf('options { dns64 64:ff9b::/96 { clients { 2001:db8:1::/64; }; }; };'));
    const clients = config.options.dns64[0].clients;
    expect(clients.matches('2001:db8:1::10', ENV)).toBe(true);
    expect(clients.matches('2001:db8:3::10', ENV)).toBe(false);
  });
});
