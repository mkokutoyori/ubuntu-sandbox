import {
  parseTLV, parseAll, decodeOctetString, decodeBoolean, encodeSequence, encodeEnumerated,
  encodeContextPrimitiveString,
} from './Ber';

export const SORT_REQUEST_OID = '1.2.840.113556.1.4.473';
export const SORT_RESPONSE_OID = '1.2.840.113556.1.4.474';
export const DOMAIN_SCOPE_OID = '1.2.840.113556.1.4.1339';

export interface SortKey {
  readonly attributeType: string;
  readonly orderingRule: string | null;
  readonly reverseOrder: boolean;
}

export function decodeSortKeys(value: Uint8Array): SortKey[] | null {
  try {
    const root = parseTLV(value, 0);
    const keys: SortKey[] = [];
    for (const keyNode of parseAll(root.content)) {
      const parts = parseAll(keyNode.content);
      if (parts.length === 0) return null;
      let orderingRule: string | null = null;
      let reverseOrder = false;
      for (const part of parts.slice(1)) {
        if (part.tagClass !== 'context') return null;
        if (part.tagNumber === 0) orderingRule = decodeOctetString(part.content);
        else if (part.tagNumber === 1) reverseOrder = decodeBoolean(part.content);
      }
      keys.push({ attributeType: decodeOctetString(parts[0].content), orderingRule, reverseOrder });
    }
    return keys.length > 0 ? keys : null;
  } catch {
    return null;
  }
}

export function encodeSortResponse(result: number, attributeType: string | null): Uint8Array {
  const parts = [encodeEnumerated(result)];
  if (attributeType !== null) parts.push(encodeContextPrimitiveString(0, attributeType));
  return encodeSequence(parts);
}
