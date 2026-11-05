import type { AclHostEnvironment, AddressMatchList } from './NamedAcl';

const ANY_V4 = '0.0.0.0';
const ANY_V6 = '::';
const LOOPBACK_V4 = '127.0.0.1';
const LOOPBACK_V6 = '::1';

export function listenAddresses(list: AddressMatchList, ipv6: boolean, environment: AclHostEnvironment): readonly string[] {
  if (list.matchesEveryAddress()) return [ipv6 ? ANY_V6 : ANY_V4];
  return [ipv6 ? LOOPBACK_V6 : LOOPBACK_V4, ...environment.localAddresses].filter(
    (address, index, all) => all.indexOf(address) === index && address.includes(':') === ipv6 && list.matches(address, environment),
  );
}
