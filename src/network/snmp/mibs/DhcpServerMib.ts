export const DHCP_SHARED_NET_ENTRY = '1.3.6.1.4.1.9.10.102.1.4.1.1';
export const DHCP_FREE_ADDRESS_LOW = '1.3.6.1.4.1.9.10.102.0.2.0.1';
export const DHCP_FREE_ADDRESS_HIGH = '1.3.6.1.4.1.9.10.102.0.2.0.2';

export function snmpAdminStringIndex(name: string): string {
  const octets = Array.from(name, (c) => c.charCodeAt(0) & 0xff);
  return [octets.length, ...octets].join('.');
}
