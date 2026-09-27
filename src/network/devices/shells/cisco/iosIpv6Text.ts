export function displayIpv6Address(ip: string): string {
  return ip.split('%')[0].toUpperCase();
}

export function displayIosAddress(address: string): string {
  return address.includes(':') ? displayIpv6Address(address) : address;
}
