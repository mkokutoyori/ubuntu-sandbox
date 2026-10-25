export const HEADER_SIZE = 272;
export const OBJECT_HEADER_SIZE = 16;
export const HASH_ITEM_SIZE = 16;
export const DATA_OBJECT_SIZE = 72;
export const FIELD_OBJECT_SIZE = 40;
export const ENTRY_OBJECT_SIZE = 64;
export const ENTRY_ARRAY_OBJECT_SIZE = 24;
export const TAG_OBJECT_SIZE = 64;
export const COMPACT_ITEM_SIZE = 4;
export const TAG_LENGTH = 32;
export const FIELD_HASH_TABLE_ITEMS = 333;
export const SIGNATURE = 'LPKSHHRH';

export const OBJECT_UNUSED = 0;
export const OBJECT_DATA = 1;
export const OBJECT_FIELD = 2;
export const OBJECT_ENTRY = 3;
export const OBJECT_DATA_HASH_TABLE = 4;
export const OBJECT_FIELD_HASH_TABLE = 5;
export const OBJECT_ENTRY_ARRAY = 6;
export const OBJECT_TAG = 7;

export const COMPATIBLE_SEALED = 1;
export const COMPATIBLE_TAIL_ENTRY_BOOT_ID = 2;
export const COMPATIBLE_SEALED_CONTINUOUS = 4;
export const INCOMPATIBLE_COMPRESSED_XZ = 1;
export const INCOMPATIBLE_COMPRESSED_LZ4 = 2;
export const INCOMPATIBLE_KEYED_HASH = 4;
export const INCOMPATIBLE_COMPRESSED_ZSTD = 8;
export const INCOMPATIBLE_COMPACT = 16;

export const STATE_OFFLINE = 0;
export const STATE_ONLINE = 1;
export const STATE_ARCHIVED = 2;

export const HEADER = {
  signature: 0, compatibleFlags: 8, incompatibleFlags: 12, state: 16, fileId: 24, machineId: 40, tailEntryBootId: 56, seqnumId: 72, headerSize: 88,
  arenaSize: 96, dataHashTableOffset: 104, dataHashTableSize: 112, fieldHashTableOffset: 120, fieldHashTableSize: 128, tailObjectOffset: 136,
  nObjects: 144, nEntries: 152, tailEntrySeqnum: 160, headEntrySeqnum: 168, entryArrayOffset: 176, headEntryRealtime: 184, tailEntryRealtime: 192,
  tailEntryMonotonic: 200, nData: 208, nFields: 216, nTags: 224, nEntryArrays: 232, dataHashChainDepth: 240, fieldHashChainDepth: 248,
  tailEntryArrayOffset: 256, tailEntryArrayNEntries: 260, tailEntryOffset: 264,
} as const;

export const DATA = { hash: 16, nextHashOffset: 24, nextFieldOffset: 32, entryOffset: 40, entryArrayOffset: 48, nEntries: 56, tailEntryArrayOffset: 64, tailEntryArrayNEntries: 68, payload: 72 } as const;
export const FIELD = { hash: 16, nextHashOffset: 24, headDataOffset: 32, payload: 40 } as const;
export const ENTRY = { seqnum: 16, realtime: 24, monotonic: 32, bootId: 40, xorHash: 56, items: 64 } as const;
export const ENTRY_ARRAY = { nextEntryArrayOffset: 16, items: 24 } as const;
export const TAG = { seqnum: 16, epoch: 24, tag: 32 } as const;

export const alignObject = (size: number): number => Math.ceil(size / 8) * 8;
