/**
 * TypeRegistry — Oracle object-type catalogue (`CREATE TYPE …`).
 *
 * Backs the native dictionary triple DBA_TYPES / DBA_TYPE_ATTRS /
 * DBA_COLL_TYPES. Holds (a) abstract types with attributes (the SQL
 * `CREATE TYPE BODY` source can also be carried so future PL/SQL
 * execution can read it) and (b) collection types (VARRAY / NESTED
 * TABLE). The registry is seeded with the system-supplied types
 * Oracle ships in a fresh CDB$ROOT (XMLTYPE, SDO_GEOMETRY, …) so
 * monitoring scripts that query DBA_TYPES find the expected catalogue.
 */

export type TypeKind = 'OBJECT' | 'COLLECTION';

export interface ObjectTypeAttribute {
  readonly name: string;
  readonly position: number;
  readonly typeName: string;
  readonly typeMod: string | null;
  readonly typeOwner: string | null;
  readonly length: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
}

export interface ObjectType {
  readonly owner: string;
  readonly typeName: string;
  readonly typeOid: string;
  readonly typeCode: 'OBJECT' | 'COLLECTION';
  readonly attributes: ObjectTypeAttribute[];
  /** FINAL / NOT FINAL — defaulted to FINAL. */
  readonly finalType: boolean;
  /** INSTANTIABLE / NOT INSTANTIABLE. */
  readonly instantiable: boolean;
  readonly predefined: boolean;
  readonly incomplete: boolean;
  readonly local: boolean;
  readonly typeCategory: 'NULL' | 'COLLECTION' | 'OBJECT';
  readonly supertypeOwner: string | null;
  readonly supertypeName: string | null;
}

export interface CollectionType {
  readonly owner: string;
  readonly typeName: string;
  readonly collType: 'VARRAY' | 'TABLE';
  readonly upperBound: number | null;
  readonly elemTypeMod: string | null;
  readonly elemTypeOwner: string | null;
  readonly elemTypeName: string;
  readonly length: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
}

export class TypeRegistry {
  private objectTypes: ObjectType[] = [];
  private collectionTypes: CollectionType[] = [];
  private oidCounter = 1;

  constructor(seedDefaults: boolean = true) {
    if (seedDefaults) this.seedSystemTypes();
  }

  private seedSystemTypes(): void {
    // System-supplied types every Oracle DB has out of the box.
    this.addObjectType('SYS', 'ANYDATA', [], { predefined: true });
    this.addObjectType('SYS', 'ANYDATASET', [], { predefined: true });
    this.addObjectType('SYS', 'ANYTYPE', [], { predefined: true });
    this.addObjectType('XDB', 'XMLTYPE', [], { predefined: true });
    this.addObjectType('MDSYS', 'SDO_GEOMETRY', [
      { name: 'SDO_GTYPE',    typeName: 'NUMBER', precision: 38, scale: 0 },
      { name: 'SDO_SRID',     typeName: 'NUMBER', precision: 38, scale: 0 },
      { name: 'SDO_POINT',    typeName: 'SDO_POINT_TYPE', typeOwner: 'MDSYS' },
      { name: 'SDO_ELEM_INFO', typeName: 'SDO_ELEM_INFO_ARRAY', typeOwner: 'MDSYS' },
      { name: 'SDO_ORDINATES', typeName: 'SDO_ORDINATE_ARRAY', typeOwner: 'MDSYS' },
    ], { predefined: true });
    this.addObjectType('MDSYS', 'SDO_POINT_TYPE', [
      { name: 'X', typeName: 'NUMBER' },
      { name: 'Y', typeName: 'NUMBER' },
      { name: 'Z', typeName: 'NUMBER' },
    ], { predefined: true });
    // Two seeded VARRAYs used by SDO_GEOMETRY.
    this.addCollectionType('MDSYS', 'SDO_ELEM_INFO_ARRAY', {
      collType: 'VARRAY', upperBound: 1048576, elemTypeName: 'NUMBER',
    });
    this.addCollectionType('MDSYS', 'SDO_ORDINATE_ARRAY', {
      collType: 'VARRAY', upperBound: 1048576, elemTypeName: 'NUMBER',
    });
  }

  // ── Public API ─────────────────────────────────────────────────────

  addObjectType(
    owner: string, typeName: string,
    attrs: Array<Partial<ObjectTypeAttribute> & { name: string; typeName: string }>,
    opts: Partial<Pick<ObjectType, 'finalType' | 'instantiable' | 'predefined' | 'incomplete' | 'local' | 'supertypeOwner' | 'supertypeName'>> = {},
  ): ObjectType {
    const o = owner.toUpperCase();
    const t = typeName.toUpperCase();
    const ot: ObjectType = {
      owner: o, typeName: t,
      typeOid: `OID_${(this.oidCounter++).toString(16).toUpperCase().padStart(16, '0')}`,
      typeCode: 'OBJECT',
      attributes: attrs.map((a, i) => ({
        name: a.name.toUpperCase(), position: i + 1,
        typeName: a.typeName.toUpperCase(),
        typeMod: a.typeMod ?? null,
        typeOwner: a.typeOwner ? a.typeOwner.toUpperCase() : null,
        length: a.length ?? null, precision: a.precision ?? null, scale: a.scale ?? null,
      })),
      finalType: opts.finalType ?? true,
      instantiable: opts.instantiable ?? true,
      predefined: opts.predefined ?? false,
      incomplete: opts.incomplete ?? false,
      local: opts.local ?? true,
      typeCategory: 'OBJECT',
      supertypeOwner: opts.supertypeOwner ? opts.supertypeOwner.toUpperCase() : null,
      supertypeName: opts.supertypeName ? opts.supertypeName.toUpperCase() : null,
    };
    this.objectTypes = this.objectTypes.filter(x => !(x.owner === o && x.typeName === t));
    this.objectTypes.push(ot);
    return ot;
  }

  addCollectionType(
    owner: string, typeName: string,
    init: Pick<CollectionType, 'collType' | 'elemTypeName'> & Partial<CollectionType>,
  ): CollectionType {
    const o = owner.toUpperCase();
    const t = typeName.toUpperCase();
    const ct: CollectionType = {
      owner: o, typeName: t,
      collType: init.collType,
      upperBound: init.upperBound ?? null,
      elemTypeMod: init.elemTypeMod ?? null,
      elemTypeOwner: init.elemTypeOwner ? init.elemTypeOwner.toUpperCase() : null,
      elemTypeName: init.elemTypeName.toUpperCase(),
      length: init.length ?? null, precision: init.precision ?? null, scale: init.scale ?? null,
    };
    this.collectionTypes = this.collectionTypes.filter(x => !(x.owner === o && x.typeName === t));
    this.collectionTypes.push(ct);
    // Mirror as an OBJECT row so DBA_TYPES surfaces the collection too —
    // exactly the way real Oracle does (one row in DBA_TYPES per type
    // regardless of code).
    if (!this.objectTypes.some(x => x.owner === o && x.typeName === t)) {
      this.objectTypes.push({
        owner: o, typeName: t,
        typeOid: `OID_${(this.oidCounter++).toString(16).toUpperCase().padStart(16, '0')}`,
        typeCode: 'COLLECTION', attributes: [],
        finalType: true, instantiable: true, predefined: false, incomplete: false,
        local: true, typeCategory: 'COLLECTION',
        supertypeOwner: null, supertypeName: null,
      });
    }
    return ct;
  }

  dropType(owner: string, typeName: string): boolean {
    const o = owner.toUpperCase(), t = typeName.toUpperCase();
    const before = this.objectTypes.length + this.collectionTypes.length;
    this.objectTypes = this.objectTypes.filter(x => !(x.owner === o && x.typeName === t));
    this.collectionTypes = this.collectionTypes.filter(x => !(x.owner === o && x.typeName === t));
    return (this.objectTypes.length + this.collectionTypes.length) < before;
  }

  // ── Snapshots ──────────────────────────────────────────────────────

  getObjectTypes(): readonly ObjectType[] { return this.objectTypes; }
  getCollectionTypes(): readonly CollectionType[] { return this.collectionTypes; }
  /**
   * Flattened attribute rows (for DBA_TYPE_ATTRS). Notice that the
   * attribute itself carries a `typeName` (its data type); we publish
   * the *parent* type name as a separate field so view files do not
   * have to disambiguate.
   */
  getAllAttributes(): Array<{
    parentOwner: string; parentTypeName: string;
    attrName: string; attrPosition: number;
    attrTypeName: string; attrTypeOwner: string | null; attrTypeMod: string | null;
    length: number | null; precision: number | null; scale: number | null;
  }> {
    const out: ReturnType<TypeRegistry['getAllAttributes']> = [];
    for (const ot of this.objectTypes) {
      for (const a of ot.attributes) {
        out.push({
          parentOwner: ot.owner, parentTypeName: ot.typeName,
          attrName: a.name, attrPosition: a.position,
          attrTypeName: a.typeName, attrTypeOwner: a.typeOwner, attrTypeMod: a.typeMod,
          length: a.length, precision: a.precision, scale: a.scale,
        });
      }
    }
    return out;
  }
}
