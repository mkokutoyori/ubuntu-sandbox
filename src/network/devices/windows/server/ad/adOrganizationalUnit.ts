export interface OuPropertySpec {
  readonly parameter: string;
  readonly ldap: string;
}

export const OU_PROPERTIES: readonly OuPropertySpec[] = [
  { parameter: 'City',          ldap: 'l' },
  { parameter: 'Country',       ldap: 'c' },
  { parameter: 'Description',   ldap: 'description' },
  { parameter: 'DisplayName',   ldap: 'displayName' },
  { parameter: 'ManagedBy',     ldap: 'managedBy' },
  { parameter: 'PostalCode',    ldap: 'postalCode' },
  { parameter: 'State',         ldap: 'st' },
  { parameter: 'StreetAddress', ldap: 'street' },
];

export const OU_PROPERTY_PARAMETERS: readonly string[] = OU_PROPERTIES.map(p => p.parameter);

export function ldapNameOfOuParameter(parameter: string): string | null {
  const lower = parameter.toLowerCase();
  return OU_PROPERTIES.find(p => p.parameter.toLowerCase() === lower)?.ldap ?? null;
}

export const PROTECTION_TRUSTEE = 'Everyone';
export const PROTECTION_OBJECT_RIGHTS: readonly string[] = ['Delete', 'DeleteTree'];
export const PROTECTION_PARENT_RIGHT = 'DeleteChild';

export function protectionAce(rights: string): {
  identitySam: string; rights: string; accessControlType: 'Deny';
  objectType: string; inheritanceType: string; inheritedObjectType: string;
} {
  return {
    identitySam: PROTECTION_TRUSTEE, rights, accessControlType: 'Deny',
    objectType: 'All', inheritanceType: 'None', inheritedObjectType: 'All',
  };
}

export function isProtectionAce(ace: { identitySam: string; rights: string; accessControlType: string }): boolean {
  return ace.accessControlType === 'Deny'
    && ace.identitySam.toLowerCase() === PROTECTION_TRUSTEE.toLowerCase()
    && (PROTECTION_OBJECT_RIGHTS.includes(ace.rights) || ace.rights === PROTECTION_PARENT_RIGHT);
}
