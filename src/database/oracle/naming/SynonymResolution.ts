import { OracleError } from '../../engine/types/DatabaseError';
import type { SynonymMeta } from '../../engine/storage/BaseStorage';

export interface ObjectName {
  schema: string;
  name: string;
}

export interface SynonymLookup {
  getSynonym(owner: string, name: string): SynonymMeta | undefined;
}

export interface SynonymResolutionOptions {
  exists: (target: ObjectName) => boolean;
  publicFallback: boolean;
}

const PUBLIC_OWNER = 'PUBLIC';
const MAX_CHAIN = 16;

export function followSynonyms(
  synonyms: SynonymLookup, start: ObjectName, options: SynonymResolutionOptions,
): ObjectName {
  let current = start;
  for (let hop = 0; hop < MAX_CHAIN; hop++) {
    if (options.exists(current)) return current;
    const synonym = synonyms.getSynonym(current.schema, current.name)
      ?? (hop === 0 && options.publicFallback ? synonyms.getSynonym(PUBLIC_OWNER, current.name) : undefined);
    if (!synonym) return current;
    current = { schema: synonym.tableOwner, name: synonym.tableName };
  }
  throw new OracleError(1775, 'looping chain of synonyms');
}
