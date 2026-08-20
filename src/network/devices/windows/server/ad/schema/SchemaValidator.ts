/**
 * SchemaValidator — RFC 4512 §4 extensible schema, minimal but real
 * (PRD-Windows-Server-Advanced.md §5 P7): `attributeSchema`/`classSchema`
 * definitions, validated on entry creation. Permissive by design for any
 * `objectClass` value that has no registered `classSchema` — every
 * already-delivered class (`user`, `group`, `computer`,
 * `organizationalUnit`, container/domain/site/subnet/... used internally
 * elsewhere) keeps working unchanged unless/until something explicitly
 * registers a schema entry for it (§6 test criterion 8).
 */

export interface AttributeSchema {
  readonly ldapDisplayName: string;
  readonly attributeSyntax: string; // syntax OID/name (string, integer, DN, boolean, ...) — informational, not deeply enforced
  readonly isSingleValued: boolean;
}

export interface ObjectClassSchema {
  readonly ldapDisplayName: string;
  readonly objectClassCategory: 'structural' | 'auxiliary' | 'abstract';
  readonly mustContain: readonly string[];
  readonly mayContain: readonly string[];
  readonly subClassOf?: string;
}

export interface SchemaOpResult { ok: boolean; message: string }

function key(name: string): string { return name.toLowerCase(); }

export class SchemaValidator {
  private readonly attributes = new Map<string, AttributeSchema>();
  private readonly classes = new Map<string, ObjectClassSchema>();

  addAttribute(schema: AttributeSchema): SchemaOpResult {
    if (this.attributes.has(key(schema.ldapDisplayName))) {
      return { ok: false, message: `An attribute named "${schema.ldapDisplayName}" already exists.` };
    }
    this.attributes.set(key(schema.ldapDisplayName), schema);
    return { ok: true, message: '' };
  }

  addObjectClass(schema: ObjectClassSchema): SchemaOpResult {
    if (this.classes.has(key(schema.ldapDisplayName))) {
      return { ok: false, message: `A class named "${schema.ldapDisplayName}" already exists.` };
    }
    if (schema.subClassOf && !this.classes.has(key(schema.subClassOf))) {
      return { ok: false, message: `Cannot find a class named "${schema.subClassOf}" to subclass.` };
    }
    this.classes.set(key(schema.ldapDisplayName), schema);
    return { ok: true, message: '' };
  }

  getAttribute(name: string): AttributeSchema | null { return this.attributes.get(key(name)) ?? null; }
  getObjectClass(name: string): ObjectClassSchema | null { return this.classes.get(key(name)) ?? null; }
  listAttributes(): AttributeSchema[] { return [...this.attributes.values()]; }
  listObjectClasses(): ObjectClassSchema[] { return [...this.classes.values()]; }

  /** `mustContain` across the whole `subClassOf` chain — a subclass inherits its ancestors' required attributes. */
  private effectiveMustContain(className: string): Set<string> {
    const out = new Set<string>();
    let current: ObjectClassSchema | null = this.classes.get(key(className)) ?? null;
    const seen = new Set<string>();
    while (current && !seen.has(key(current.ldapDisplayName))) {
      seen.add(key(current.ldapDisplayName));
      for (const attr of current.mustContain) out.add(key(attr));
      current = current.subClassOf ? this.classes.get(key(current.subClassOf)) ?? null : null;
    }
    return out;
  }

  /**
   * Validates a new entry's attributes against every one of its
   * `objectClass` values that has a registered `classSchema` — skips
   * entirely (`ok: true`) if none of them are registered, so unregistered
   * classes (every internal container/config class, and any class this
   * simulator hasn't been asked to model) are never blocked.
   */
  validateNewEntry(objectClasses: readonly string[], attributes: Record<string, string[]>): SchemaOpResult {
    const registered = objectClasses.map(oc => this.classes.get(key(oc))).filter((c): c is ObjectClassSchema => c !== undefined);
    if (registered.length === 0) return { ok: true, message: '' };

    const providedKeys = new Set(Object.keys(attributes).map(key));
    for (const cls of registered) {
      for (const required of this.effectiveMustContain(cls.ldapDisplayName)) {
        if (!providedKeys.has(required)) {
          return { ok: false, message: `objectClassViolation: attribute "${required}" is required by class "${cls.ldapDisplayName}" (mustContain)` };
        }
      }
    }
    for (const [attrName, values] of Object.entries(attributes)) {
      const attrSchema = this.attributes.get(key(attrName));
      if (attrSchema?.isSingleValued && values.length > 1) {
        return { ok: false, message: `objectClassViolation: attribute "${attrName}" is single-valued but ${values.length} values were supplied` };
      }
    }
    return { ok: true, message: '' };
  }
}
