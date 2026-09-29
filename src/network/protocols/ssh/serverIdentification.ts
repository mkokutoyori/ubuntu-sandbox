import { OPENSSL_VERSION_TEXT } from '@/network/crypto/openssl/opensslVersion';

export const OPENSSH_UBUNTU_RELEASE = 'OpenSSH_8.9p1 Ubuntu-3ubuntu0.6';

export const SSH_SERVER_IDENTIFICATION = `SSH-2.0-${OPENSSH_UBUNTU_RELEASE}`;

export const SSH_SERVER_IDENTIFICATION_LINE = `${SSH_SERVER_IDENTIFICATION}\r\n`;

export const OPENSSH_UBUNTU_CLIENT_VERSION = `${OPENSSH_UBUNTU_RELEASE}, ${OPENSSL_VERSION_TEXT}`;

export const OPENSSH_WINDOWS_CLIENT_VERSION = 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3';
