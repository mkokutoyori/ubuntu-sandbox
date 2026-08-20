/**
 * SchemaPartition — the `cn=schema,cn=configuration,<domain>` partition
 * (PRD-Windows-Server-Advanced.md §5 P7, RFC 4512 §4), materialized as an
 * ordinary `DirectoryTree` subtree (not a parallel data structure):
 * `New-ADAttribute`/`New-ADObjectClass` both register the definition
 * with the live `SchemaValidator` (so `DirectoryTree.addEntry` can
 * enforce it immediately) and write a real `attributeSchema`/
 * `classSchema` entry, so the schema is genuinely LDAP-searchable and
 * replicates to other DCs like everything else (§5 P4).
 */
import { DirectoryTree } from '../ldap/DirectoryTree';
import { parseDN, type DistinguishedName } from '../ldap/LdapDN';
import { SchemaValidator, type AttributeSchema, type ObjectClassSchema, type SchemaOpResult } from './SchemaValidator';

export class SchemaPartition {
  private readonly configDn: DistinguishedName;
  private readonly schemaDn: DistinguishedName;

  constructor(private readonly tree: DirectoryTree, readonly validator: SchemaValidator) {
    const rootDn = tree.getRootDn();
    this.configDn = [...parseDN('CN=Configuration'), ...rootDn];
    this.schemaDn = [...parseDN('CN=Schema'), ...this.configDn];
  }

  private ensureContainers(): void {
    if (!this.tree.getByDn(this.configDn)) this.tree.addEntry(this.configDn, { objectClass: ['top', 'container'], cn: ['Configuration'] });
    if (!this.tree.getByDn(this.schemaDn)) this.tree.addEntry(this.schemaDn, { objectClass: ['top', 'container'], cn: ['Schema'] });
  }

  newAttribute(schema: AttributeSchema): SchemaOpResult {
    this.ensureContainers();
    const res = this.validator.addAttribute(schema);
    if (!res.ok) return res;
    this.tree.addEntry([...parseDN(`CN=${schema.ldapDisplayName}`), ...this.schemaDn], {
      objectClass: ['top', 'attributeSchema'],
      cn: [schema.ldapDisplayName],
      lDAPDisplayName: [schema.ldapDisplayName],
      attributeSyntax: [schema.attributeSyntax],
      isSingleValued: [String(schema.isSingleValued)],
    });
    return { ok: true, message: '' };
  }

  newObjectClass(schema: ObjectClassSchema): SchemaOpResult {
    this.ensureContainers();
    const res = this.validator.addObjectClass(schema);
    if (!res.ok) return res;
    this.tree.addEntry([...parseDN(`CN=${schema.ldapDisplayName}`), ...this.schemaDn], {
      objectClass: ['top', 'classSchema'],
      cn: [schema.ldapDisplayName],
      lDAPDisplayName: [schema.ldapDisplayName],
      objectClassCategory: [schema.objectClassCategory],
      mustContain: [...schema.mustContain],
      mayContain: [...schema.mayContain],
      subClassOf: schema.subClassOf ? [schema.subClassOf] : [],
    });
    return { ok: true, message: '' };
  }

  listAttributes(): AttributeSchema[] { return this.validator.listAttributes(); }
  listObjectClasses(): ObjectClassSchema[] { return this.validator.listObjectClasses(); }
}

/**
 * Seeds the built-in classes this simulator has always shipped (`user`,
 * `group`, `computer`, `organizationalUnit`) as real schema entries
 * instead of hardcoded special cases (§6 test criterion 8) — loose
 * enough (only the attributes `DirectoryStore` already always supplies)
 * that every existing code path keeps validating cleanly.
 */
export function seedDefaultSchema(partition: SchemaPartition): void {
  partition.newAttribute({ ldapDisplayName: 'cn', attributeSyntax: 'string', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'sAMAccountName', attributeSyntax: 'string', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'ou', attributeSyntax: 'string', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'userPrincipalName', attributeSyntax: 'string', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'displayName', attributeSyntax: 'string', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'userAccountControl', attributeSyntax: 'integer', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'userPassword', attributeSyntax: 'string', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'groupType', attributeSyntax: 'integer', isSingleValued: true });
  partition.newAttribute({ ldapDisplayName: 'member', attributeSyntax: 'DN', isSingleValued: false });
  partition.newAttribute({ ldapDisplayName: 'memberOf', attributeSyntax: 'DN', isSingleValued: false });
  partition.newAttribute({ ldapDisplayName: 'gPLink', attributeSyntax: 'string', isSingleValued: false });

  partition.newObjectClass({ ldapDisplayName: 'top', objectClassCategory: 'abstract', mustContain: [], mayContain: [] });
  partition.newObjectClass({
    ldapDisplayName: 'organizationalUnit', objectClassCategory: 'structural',
    mustContain: ['ou'], mayContain: ['gPLink'], subClassOf: 'top',
  });
  partition.newObjectClass({
    ldapDisplayName: 'user', objectClassCategory: 'structural',
    mustContain: ['cn', 'sAMAccountName'],
    mayContain: ['displayName', 'userPassword', 'userAccountControl', 'userPrincipalName', 'memberOf'],
    subClassOf: 'top',
  });
  partition.newObjectClass({
    ldapDisplayName: 'group', objectClassCategory: 'structural',
    mustContain: ['cn', 'sAMAccountName'], mayContain: ['member', 'groupType'], subClassOf: 'top',
  });
  partition.newObjectClass({
    ldapDisplayName: 'computer', objectClassCategory: 'structural',
    mustContain: [], mayContain: [], subClassOf: 'user',
  });
}
