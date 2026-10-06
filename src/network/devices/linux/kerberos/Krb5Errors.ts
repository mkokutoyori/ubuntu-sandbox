import { KrbErrorCode } from '@/network/kerberos/types';

export const KRB5_KDC_UNREACH = 'KDC_UNREACH';
export const KRB5_REALM_CANT_RESOLVE = 'REALM_CANT_RESOLVE';

const KRB5_ERROR_TEXT: Readonly<Record<number, string>> = {
  1: "Client's entry in database has expired",
  2: "Server's entry in database has expired",
  3: 'Requested protocol version not supported',
  4: "Client's key is encrypted in an old master key",
  5: "Server's key is encrypted in an old master key",
  8: 'Principal has multiple entries in Kerberos database',
  9: 'Client or server has a null key',
  10: 'Ticket is ineligible for postdating',
  11: 'Requested effective lifetime is negative or too short',
  12: 'KDC policy rejects request',
  13: "KDC can't fulfill requested option",
  14: 'KDC has no support for encryption type',
  15: 'KDC has no support for checksum type',
  16: 'KDC has no support for padata type',
  17: 'KDC has no support for transited type',
  18: "Client's credentials have been revoked",
  19: 'Credentials for server have been revoked',
  20: 'TGT has been revoked',
  21: 'Client not yet valid - try again later',
  22: 'Server not yet valid - try again later',
  23: 'Password has expired',
  24: 'Preauthentication failed',
  25: 'Additional pre-authentication required',
  26: "Requested server and ticket don't match",
  27: 'Server principal valid for user2user only',
  28: 'KDC policy rejects transited path',
  29: 'A service is not available that is required to process the request',
  31: 'Decrypt integrity check failed',
  32: 'Ticket expired',
  33: 'Ticket not yet valid',
};

export function kdcErrorMessage(code: number, clientName: string, serverName: string): string {
  switch (code) {
    case KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN: return `Client '${clientName}' not found in Kerberos database`;
    case KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN: return `Server ${serverName} not found in Kerberos database`;
    case KrbErrorCode.KDC_ERR_PREAUTH_FAILED: return 'Password incorrect';
    default: return KRB5_ERROR_TEXT[code] ?? `KRB5 error code ${code}`;
  }
}

export function unreachableKdc(realm: string): string {
  return `Cannot contact any KDC for realm '${realm}'`;
}

export function noKdcForRealm(realm: string): string {
  return `Cannot find KDC for realm "${realm}"`;
}
