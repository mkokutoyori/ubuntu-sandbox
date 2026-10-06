import type { DhcpIpEmission } from './types';

export const ISC_DHCP_EMISSION: DhcpIpEmission = { ttl: 128, tos: 0x10 };
export const WINDOWS_DHCP_EMISSION: DhcpIpEmission = { ttl: 128 };
export const NETWORK_OS_DHCP_EMISSION: DhcpIpEmission = { ttl: 255 };
