export interface UserPropertySpec {
  readonly parameter: string;
  readonly ldap: string;
}

export const USER_PROPERTIES: readonly UserPropertySpec[] = [
  { parameter: 'City',              ldap: 'l' },
  { parameter: 'Company',           ldap: 'company' },
  { parameter: 'Country',           ldap: 'c' },
  { parameter: 'Department',        ldap: 'department' },
  { parameter: 'Description',       ldap: 'description' },
  { parameter: 'DisplayName',       ldap: 'displayName' },
  { parameter: 'Division',          ldap: 'division' },
  { parameter: 'EmailAddress',      ldap: 'mail' },
  { parameter: 'EmployeeID',        ldap: 'employeeID' },
  { parameter: 'EmployeeNumber',    ldap: 'employeeNumber' },
  { parameter: 'Fax',               ldap: 'facsimileTelephoneNumber' },
  { parameter: 'GivenName',         ldap: 'givenName' },
  { parameter: 'HomeDirectory',     ldap: 'homeDirectory' },
  { parameter: 'HomeDrive',         ldap: 'homeDrive' },
  { parameter: 'HomePage',          ldap: 'wWWHomePage' },
  { parameter: 'HomePhone',         ldap: 'homePhone' },
  { parameter: 'Initials',          ldap: 'initials' },
  { parameter: 'LogonWorkstations', ldap: 'userWorkStations' },
  { parameter: 'Manager',           ldap: 'manager' },
  { parameter: 'MobilePhone',       ldap: 'mobile' },
  { parameter: 'Office',            ldap: 'physicalDeliveryOfficeName' },
  { parameter: 'OfficePhone',       ldap: 'telephoneNumber' },
  { parameter: 'Organization',      ldap: 'o' },
  { parameter: 'OtherName',         ldap: 'middleName' },
  { parameter: 'POBox',             ldap: 'postOfficeBox' },
  { parameter: 'PostalCode',        ldap: 'postalCode' },
  { parameter: 'ProfilePath',       ldap: 'profilePath' },
  { parameter: 'ScriptPath',        ldap: 'scriptPath' },
  { parameter: 'State',             ldap: 'st' },
  { parameter: 'StreetAddress',     ldap: 'streetAddress' },
  { parameter: 'Surname',           ldap: 'sn' },
  { parameter: 'Title',             ldap: 'title' },
  { parameter: 'UserPrincipalName', ldap: 'userPrincipalName' },
];

export const USER_PROPERTY_PARAMETERS: readonly string[] = USER_PROPERTIES.map(p => p.parameter);

export const USER_ACCOUNT_CONTROL = {
  ACCOUNTDISABLE: 0x0002,
  HOMEDIR_REQUIRED: 0x0008,
  LOCKOUT: 0x0010,
  PASSWD_NOTREQD: 0x0020,
  PASSWD_CANT_CHANGE: 0x0040,
  ENCRYPTED_TEXT_PWD_ALLOWED: 0x0080,
  NORMAL_ACCOUNT: 0x0200,
  WORKSTATION_TRUST_ACCOUNT: 0x1000,
  SERVER_TRUST_ACCOUNT: 0x2000,
  DONT_EXPIRE_PASSWORD: 0x10000,
  SMARTCARD_REQUIRED: 0x40000,
  TRUSTED_FOR_DELEGATION: 0x80000,
  NOT_DELEGATED: 0x100000,
  USE_DES_KEY_ONLY: 0x200000,
  DONT_REQ_PREAUTH: 0x400000,
} as const;

export interface UserFlagSpec {
  readonly parameter: string;
  readonly bit: number;
  readonly inverted: boolean;
}

export const USER_FLAGS: readonly UserFlagSpec[] = [
  { parameter: 'Enabled',                           bit: USER_ACCOUNT_CONTROL.ACCOUNTDISABLE,             inverted: true },
  { parameter: 'PasswordNeverExpires',              bit: USER_ACCOUNT_CONTROL.DONT_EXPIRE_PASSWORD,       inverted: false },
  { parameter: 'PasswordNotRequired',               bit: USER_ACCOUNT_CONTROL.PASSWD_NOTREQD,             inverted: false },
  { parameter: 'SmartcardLogonRequired',            bit: USER_ACCOUNT_CONTROL.SMARTCARD_REQUIRED,         inverted: false },
  { parameter: 'TrustedForDelegation',              bit: USER_ACCOUNT_CONTROL.TRUSTED_FOR_DELEGATION,     inverted: false },
  { parameter: 'AccountNotDelegated',               bit: USER_ACCOUNT_CONTROL.NOT_DELEGATED,              inverted: false },
  { parameter: 'AllowReversiblePasswordEncryption', bit: USER_ACCOUNT_CONTROL.ENCRYPTED_TEXT_PWD_ALLOWED, inverted: false },
];

export const USER_FLAG_PARAMETERS: readonly string[] = USER_FLAGS.map(f => f.parameter);

export function applyUserFlag(uac: number, spec: UserFlagSpec, wanted: boolean): number {
  const set = spec.inverted ? !wanted : wanted;
  return set ? (uac | spec.bit) >>> 0 : (uac & ~spec.bit) >>> 0;
}

export function readUserFlag(uac: number, spec: UserFlagSpec): boolean {
  const set = (uac & spec.bit) !== 0;
  return spec.inverted ? !set : set;
}

export const CHANGE_PASSWORD_TRUSTEES: readonly string[] = ['Everyone', 'NT AUTHORITY\\SELF'];
export const CHANGE_PASSWORD_RIGHT = 'ExtendedRight';
export const CHANGE_PASSWORD_OBJECT_TYPE = 'User-Change-Password';

export function cannotChangePasswordAce(identitySam: string): {
  identitySam: string; rights: string; accessControlType: 'Deny';
  objectType: string; inheritanceType: string; inheritedObjectType: string;
} {
  return {
    identitySam, rights: CHANGE_PASSWORD_RIGHT, accessControlType: 'Deny',
    objectType: CHANGE_PASSWORD_OBJECT_TYPE, inheritanceType: 'None', inheritedObjectType: 'All',
  };
}

export function isCannotChangePasswordAce(ace: { rights: string; accessControlType: string; objectType: string }): boolean {
  return ace.accessControlType === 'Deny'
    && ace.rights === CHANGE_PASSWORD_RIGHT
    && ace.objectType === CHANGE_PASSWORD_OBJECT_TYPE;
}

export const NEVER_EXPIRES = '9223372036854775807';

export function accountExpiresValue(date: Date | null): string {
  if (date === null) return NEVER_EXPIRES;
  return String(BigInt(date.getTime() + 11644473600000) * 10000n);
}

export function accountExpiresDate(raw: string): Date | null {
  if (raw === '' || raw === '0' || raw === NEVER_EXPIRES) return null;
  const ticks = BigInt(raw);
  return new Date(Number(ticks / 10000n) - 11644473600000);
}
