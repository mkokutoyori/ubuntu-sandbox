import { OPENSSL_VERSION_TEXT } from '@/network/crypto/openssl/opensslVersion';

export const OPENSSH_UBUNTU_RELEASE = 'OpenSSH_8.9p1 Ubuntu-3ubuntu0.6';

export const SSH_SERVER_IDENTIFICATION = `SSH-2.0-${OPENSSH_UBUNTU_RELEASE}`;

export const SSH_SERVER_IDENTIFICATION_LINE = `${SSH_SERVER_IDENTIFICATION}\r\n`;

export const OPENSSH_UBUNTU_CLIENT_VERSION = `${OPENSSH_UBUNTU_RELEASE}, ${OPENSSL_VERSION_TEXT}`;

export const OPENSSH_WINDOWS_CLIENT_VERSION = 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3';

export const SSH_WINDOWS_IDENTIFICATION = 'SSH-2.0-OpenSSH_for_Windows_8.6';

export const SSH_HUAWEI_VRP_IDENTIFICATION = 'SSH-2.0-HUAWEI-1.5';

export function ciscoSshIdentification(configuredVersion: number): string {
  return `SSH-${configuredVersion === 2 ? '2.0' : '1.99'}-Cisco-1.25`;
}

export function opensshIdentificationFor(osType: string): string {
  return osType === 'windows' ? SSH_WINDOWS_IDENTIFICATION : SSH_SERVER_IDENTIFICATION;
}
