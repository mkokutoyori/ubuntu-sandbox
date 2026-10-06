import { DHCP_OPTION } from './DHCPPacket';
import type { DhcpClientPersonality } from './types';

export const ISC_DISCOVER_INTERVALS_SECONDS: readonly number[] = [3, 6, 12, 15, 15, 9];

export const WINDOWS_DISCOVER_INTERVALS_SECONDS: readonly number[] = [4, 8, 16, 32];

export const ISC_DHCLIENT_PERSONALITY: DhcpClientPersonality = {
  alwaysSendsClientIdentifier: true,
  parameterRequestList: [1, 28, 2, 3, 15, 6, 119, 12, 44, 47, 26, 121, 42],
  sendsFqdn: false,
  optionOrder: [
    DHCP_OPTION.MESSAGE_TYPE, DHCP_OPTION.CLIENT_IDENTIFIER, DHCP_OPTION.REQUESTED_IP,
    DHCP_OPTION.SERVER_IDENTIFIER, DHCP_OPTION.HOST_NAME, DHCP_OPTION.PARAMETER_REQUEST_LIST,
  ],
  discoverIntervalsSeconds: ISC_DISCOVER_INTERVALS_SECONDS,
};

export const WINDOWS_DHCP_CLIENT_PERSONALITY: DhcpClientPersonality = {
  alwaysSendsClientIdentifier: true,
  parameterRequestList: [1, 3, 6, 15, 31, 33, 43, 44, 46, 47, 119, 121, 249, 252],
  sendsFqdn: true,
  optionOrder: [
    DHCP_OPTION.MESSAGE_TYPE, DHCP_OPTION.CLIENT_IDENTIFIER, DHCP_OPTION.REQUESTED_IP,
    DHCP_OPTION.SERVER_IDENTIFIER, DHCP_OPTION.HOST_NAME, DHCP_OPTION.CLIENT_FQDN,
    DHCP_OPTION.VENDOR_CLASS, DHCP_OPTION.PARAMETER_REQUEST_LIST,
  ],
  discoverIntervalsSeconds: WINDOWS_DISCOVER_INTERVALS_SECONDS,
};
