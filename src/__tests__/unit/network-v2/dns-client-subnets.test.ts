/*
 * Structure — the store behind the client subnet cmdlets of a Windows DNS server, as [MS-DNSP] 3.1.4.1 describes the five
 * operations on a client subnet record: CreateClientSubnetRecord (the record exists already: refused),
 * DeleteClientSubnetRecord (it does not exist: refused), AddSubnetsInRecord (the record does not exist, or a subnet is
 * already in it: refused), DeleteSubnetsInRecord (the record does not exist, a subnet is not in it, or nothing would be
 * left: refused) and ResetClientSubnetRecord (the record does not exist, or no subnet is given: refused). Names are
 * matched without regard to case, a subnet is known by its address and length however it was written, and every refusal
 * leaves the record as it was. Discrimination (run on the tree before the change): every case falls, the module did not
 * exist.
 */
import { describe, it, expect } from 'vitest';
import { ClientSubnetStore, CLIENT_SUBNET_REFUSALS } from '@/network/devices/windows/server/dns/DnsClientSubnets';

function storeWith(name: string, ipv4: string[], ipv6: string[] = []): ClientSubnetStore {
  const store = new ClientSubnetStore();
  expect(store.create(name, ipv4, ipv6)).toBeNull();
  return store;
}

describe('creating a client subnet record', () => {
  it('keeps the name as written and the subnets in the order given', () => {
    const store = storeWith('NorthAmerica', ['172.21.33.0/16', '10.0.0.0/8'], ['0db8::1/28']);
    expect(store.list()).toEqual([{ name: 'NorthAmerica', ipv4: ['172.21.33.0/16', '10.0.0.0/8'], ipv6: ['0db8::1/28'] }]);
  });

  it('refuses a name that is taken, whatever its case, and keeps the first record', () => {
    const store = storeWith('Asia', ['10.0.0.0/8']);
    expect(store.create('ASIA', ['192.168.0.0/16'], [])).toBe(CLIENT_SUBNET_REFUSALS.existing);
    expect(store.list()).toEqual([{ name: 'Asia', ipv4: ['10.0.0.0/8'], ipv6: [] }]);
  });

  it.each([
    ['an address without a length', ['10.0.0.0'], []],
    ['a length above 32', ['10.0.0.0/33'], []],
    ['an octet above 255', ['300.0.0.0/8'], []],
    ['an IPv6 subnet where IPv4 is expected', ['0db8::1/28'], []],
    ['an IPv4 subnet where IPv6 is expected', [], ['10.0.0.0/8']],
    ['an IPv6 length above 128', [], ['0db8::1/129']],
    ['a text that is no subnet', ['not-a-subnet/8'], []],
  ])('refuses %s and creates nothing', (_label, ipv4, ipv6) => {
    const store = new ClientSubnetStore();
    expect(store.create('Bad', ipv4, ipv6)).toBe(CLIENT_SUBNET_REFUSALS.invalid);
    expect(store.list()).toEqual([]);
  });

  it('writes a subnet given twice, in two spellings, once', () => {
    const store = storeWith('Europe', ['10.0.0.0/8', '10.0.0.0/8'], ['0db8::1/28', 'db8::1/28']);
    expect(store.list()[0]).toMatchObject({ ipv4: ['10.0.0.0/8'], ipv6: ['0db8::1/28'] });
  });

  it('keeps a subnet without the blanks around it', () => {
    const store = storeWith('Padded', [' 10.0.0.0/8 '], [' 0db8::1/28 ']);
    expect(store.list()[0]).toMatchObject({ ipv4: ['10.0.0.0/8'], ipv6: ['0db8::1/28'] });
  });

  it('accepts a record with no subnet at all', () => {
    expect(new ClientSubnetStore().create('Empty', [], [])).toBeNull();
  });
});

describe('finding and listing', () => {
  it('finds a record whatever the case of the name', () => {
    const store = storeWith('Asia', ['10.0.0.0/8']);
    expect(store.find('aSiA')).toEqual({ name: 'Asia', ipv4: ['10.0.0.0/8'], ipv6: [] });
    expect(store.find('Europe')).toBeNull();
  });

  it('hands out copies that cannot change the record', () => {
    const store = storeWith('Asia', ['10.0.0.0/8']);
    (store.list()[0].ipv4 as string[]).push('1.0.0.0/8');
    (store.find('Asia')!.ipv4 as string[]).push('2.0.0.0/8');
    expect(store.find('Asia')!.ipv4).toEqual(['10.0.0.0/8']);
  });
});

describe('removing a client subnet record', () => {
  it('removes it, whatever the case of the name', () => {
    const store = storeWith('Asia', ['10.0.0.0/8']);
    expect(store.remove('ASIA')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('refuses a record that does not exist', () => {
    expect(new ClientSubnetStore().remove('Asia')).toBe(CLIENT_SUBNET_REFUSALS.missing);
  });
});

describe('ADD', () => {
  it('appends the subnets of either family', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('asia', 'ADD', ['192.168.0.4/16'], ['2001:db8::/32'])).toBeNull();
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['10.0.0.0/8', '192.168.0.4/16'], ipv6: ['0db8::1/28', '2001:db8::/32'] });
  });

  it('refuses a subnet the record holds already, written another way, and adds nothing of the request', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'ADD', ['192.168.0.0/16'], ['db8::1/28'])).toBe(CLIENT_SUBNET_REFUSALS.presentSubnet);
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['10.0.0.0/8'], ipv6: ['0db8::1/28'] });
  });

  it.each([
    ['an IPv4 subnet', ['10.0.0.0/8'], []],
    ['an IPv6 subnet', [], ['0db8::1/28']],
  ])('refuses %s the record holds already, even when nothing else is wrong', (_label, ipv4, ipv6) => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'ADD', ipv4, ipv6)).toBe(CLIENT_SUBNET_REFUSALS.presentSubnet);
  });

  it('refuses a record that does not exist', () => {
    expect(new ClientSubnetStore().change('Asia', 'ADD', ['10.0.0.0/8'], [])).toBe(CLIENT_SUBNET_REFUSALS.missing);
  });

  it('refuses a value that is no subnet and changes nothing', () => {
    const store = storeWith('Asia', ['10.0.0.0/8']);
    expect(store.change('Asia', 'ADD', ['10.0.0.0'], [])).toBe(CLIENT_SUBNET_REFUSALS.invalid);
    expect(store.find('Asia')!.ipv4).toEqual(['10.0.0.0/8']);
  });
});

describe('REMOVE', () => {
  it('takes the listed subnets out and keeps the others', () => {
    const store = storeWith('Asia', ['10.0.0.0/8', '192.168.0.0/16'], ['0db8::1/28']);
    expect(store.change('Asia', 'REMOVE', ['10.0.0.0/8'], [])).toBeNull();
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['192.168.0.0/16'], ipv6: ['0db8::1/28'] });
  });

  it('recognises a subnet by its address and length, not by how it was written', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28', '2001:db8::/32']);
    expect(store.change('Asia', 'REMOVE', [], ['db8::1/28'])).toBeNull();
    expect(store.find('Asia')!.ipv6).toEqual(['2001:db8::/32']);
  });

  it('refuses a subnet that is not in the record and removes none of the request', () => {
    const store = storeWith('Asia', ['10.0.0.0/8', '192.168.0.0/16']);
    expect(store.change('Asia', 'REMOVE', ['10.0.0.0/8', '172.16.0.0/12'], [])).toBe(CLIENT_SUBNET_REFUSALS.absentSubnet);
    expect(store.find('Asia')!.ipv4).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('refuses a length that differs from the one held', () => {
    const store = storeWith('Asia', ['10.0.0.0/8', '192.168.0.0/16']);
    expect(store.change('Asia', 'REMOVE', ['10.0.0.0/16'], [])).toBe(CLIENT_SUBNET_REFUSALS.absentSubnet);
  });

  it('refuses to leave the record without any subnet', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'REMOVE', ['10.0.0.0/8'], ['0db8::1/28'])).toBe(CLIENT_SUBNET_REFUSALS.lastAddress);
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['10.0.0.0/8'], ipv6: ['0db8::1/28'] });
  });

  it('allows emptying one family while the other keeps an address', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'REMOVE', ['10.0.0.0/8'], [])).toBeNull();
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: [], ipv6: ['0db8::1/28'] });
  });

  it('refuses a record that does not exist', () => {
    expect(new ClientSubnetStore().change('Asia', 'REMOVE', ['10.0.0.0/8'], [])).toBe(CLIENT_SUBNET_REFUSALS.missing);
  });
});

describe('REPLACE', () => {
  it('replaces the family it is given and leaves the other alone', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'REPLACE', [], ['0db8::1/8'])).toBeNull();
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['10.0.0.0/8'], ipv6: ['0db8::1/8'] });
  });

  it('replaces the IPv4 family on its own and leaves the IPv6 family alone', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'REPLACE', ['192.168.0.0/16'], [])).toBeNull();
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['192.168.0.0/16'], ipv6: ['0db8::1/28'] });
  });

  it('replaces both families when both are given', () => {
    const store = storeWith('Asia', ['10.0.0.0/8'], ['0db8::1/28']);
    expect(store.change('Asia', 'REPLACE', ['192.168.0.0/16'], ['2001:db8::/32'])).toBeNull();
    expect(store.find('Asia')).toEqual({ name: 'Asia', ipv4: ['192.168.0.0/16'], ipv6: ['2001:db8::/32'] });
  });

  it('refuses a request that gives no subnet at all', () => {
    const store = storeWith('Asia', ['10.0.0.0/8']);
    expect(store.change('Asia', 'REPLACE', [], [])).toBe(CLIENT_SUBNET_REFUSALS.lastAddress);
    expect(store.find('Asia')!.ipv4).toEqual(['10.0.0.0/8']);
  });

  it('refuses a record that does not exist', () => {
    expect(new ClientSubnetStore().change('Asia', 'REPLACE', ['10.0.0.0/8'], [])).toBe(CLIENT_SUBNET_REFUSALS.missing);
  });
});
