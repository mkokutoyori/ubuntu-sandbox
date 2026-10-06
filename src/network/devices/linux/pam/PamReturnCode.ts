export const PamReturn = {
  SUCCESS: 0,
  OPEN_ERR: 1,
  SYMBOL_ERR: 2,
  SERVICE_ERR: 3,
  SYSTEM_ERR: 4,
  BUF_ERR: 5,
  PERM_DENIED: 6,
  AUTH_ERR: 7,
  CRED_INSUFFICIENT: 8,
  AUTHINFO_UNAVAIL: 9,
  USER_UNKNOWN: 10,
  MAXTRIES: 11,
  NEW_AUTHTOK_REQD: 12,
  ACCT_EXPIRED: 13,
  SESSION_ERR: 14,
  CRED_UNAVAIL: 15,
  CRED_EXPIRED: 16,
  CRED_ERR: 17,
  NO_MODULE_DATA: 18,
  CONV_ERR: 19,
  AUTHTOK_ERR: 20,
  AUTHTOK_RECOVERY_ERR: 21,
  AUTHTOK_LOCK_BUSY: 22,
  AUTHTOK_DISABLE_AGING: 23,
  TRY_AGAIN: 24,
  IGNORE: 25,
  ABORT: 26,
  AUTHTOK_EXPIRED: 27,
  MODULE_UNKNOWN: 28,
  BAD_ITEM: 29,
  CONV_AGAIN: 30,
  INCOMPLETE: 31,
} as const;

export type PamReturnCode = (typeof PamReturn)[keyof typeof PamReturn];

export const PAM_RETURN_VALUES = 32;

export const PAM_RETURN_TOKENS: readonly string[] = [
  'success', 'open_err', 'symbol_err', 'service_err', 'system_err', 'buf_err',
  'perm_denied', 'auth_err', 'cred_insufficient', 'authinfo_unavail', 'user_unknown',
  'maxtries', 'new_authtok_reqd', 'acct_expired', 'session_err', 'cred_unavail',
  'cred_expired', 'cred_err', 'no_module_data', 'conv_err', 'authtok_err',
  'authtok_recover_err', 'authtok_lock_busy', 'authtok_disable_aging', 'try_again',
  'ignore', 'abort', 'authtok_expired', 'module_unknown', 'bad_item', 'conv_again',
  'incomplete', 'default',
];

export const PamFlag = {
  SILENT: 0x8000,
  DISALLOW_NULL_AUTHTOK: 0x0001,
  ESTABLISH_CRED: 0x0002,
  DELETE_CRED: 0x0004,
  REINITIALIZE_CRED: 0x0008,
  REFRESH_CRED: 0x0010,
  CHANGE_EXPIRED_AUTHTOK: 0x0020,
  PRELIM_CHECK: 0x4000,
  UPDATE_AUTHTOK: 0x2000,
} as const;

export function pamStrError(code: number): string {
  switch (code) {
    case PamReturn.SUCCESS: return 'Success';
    case PamReturn.OPEN_ERR: return 'Failed to load module';
    case PamReturn.SYMBOL_ERR: return 'Symbol not found';
    case PamReturn.SERVICE_ERR: return 'Error in service module';
    case PamReturn.SYSTEM_ERR: return 'System error';
    case PamReturn.BUF_ERR: return 'Memory buffer error';
    case PamReturn.PERM_DENIED: return 'Permission denied';
    case PamReturn.AUTH_ERR: return 'Authentication failure';
    case PamReturn.CRED_INSUFFICIENT: return 'Insufficient credentials to access authentication data';
    case PamReturn.AUTHINFO_UNAVAIL: return 'Authentication service cannot retrieve authentication info';
    case PamReturn.USER_UNKNOWN: return 'User not known to the underlying authentication module';
    case PamReturn.MAXTRIES: return 'Have exhausted maximum number of retries for service';
    case PamReturn.NEW_AUTHTOK_REQD: return 'Authentication token is no longer valid; new one required';
    case PamReturn.ACCT_EXPIRED: return 'User account has expired';
    case PamReturn.SESSION_ERR: return 'Cannot make/remove an entry for the specified session';
    case PamReturn.CRED_UNAVAIL: return 'Authentication service cannot retrieve user credentials';
    case PamReturn.CRED_EXPIRED: return 'User credentials expired';
    case PamReturn.CRED_ERR: return 'Failure setting user credentials';
    case PamReturn.NO_MODULE_DATA: return 'No module specific data is present';
    case PamReturn.CONV_ERR: return 'Conversation error';
    case PamReturn.AUTHTOK_ERR: return 'Authentication token manipulation error';
    case PamReturn.AUTHTOK_RECOVERY_ERR: return 'Authentication information cannot be recovered';
    case PamReturn.AUTHTOK_LOCK_BUSY: return 'Authentication token lock busy';
    case PamReturn.AUTHTOK_DISABLE_AGING: return 'Authentication token aging disabled';
    case PamReturn.TRY_AGAIN: return 'Failed preliminary check by password service';
    case PamReturn.ABORT: return 'Critical error - immediate abort';
    case PamReturn.AUTHTOK_EXPIRED: return 'Authentication token expired';
    case PamReturn.MODULE_UNKNOWN: return 'Module is unknown';
    case PamReturn.BAD_ITEM: return 'Bad item passed to pam_*_item()';
    case PamReturn.CONV_AGAIN: return 'Conversation is waiting for event';
    case PamReturn.INCOMPLETE: return 'Application is not ready for the next call';
    default: return 'Unknown PAM error';
  }
}
