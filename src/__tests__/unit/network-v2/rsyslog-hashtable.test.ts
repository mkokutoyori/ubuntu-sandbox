/**
 * Probe — engine/HashTable.ts, a port of runtime/hashtable.c and hashtable_itr.c of rsyslog 8.2608.0 (Christopher
 * Clark's chained table: prime sizes, 0.65 load factor, hash mixing of the java 1.4 table, head insertion, an
 * expansion that reverses each chain, iteration by bucket). The expected values were produced by compiling those two C
 * files with gcc and running them on the same keys: the hash of each key, and the iteration order after the
 * inserts - 10 names in a table of 53 slots, 60 keys that force one expansion to 97 slots, and a non-ASCII key whose
 * bytes are signed in hash_from_string.
 *
 * Measured against the base commit: the module does not exist there, so the import fails and all 6 cases fall; none
 * passes in both states.
 */
import { describe, expect, it } from 'vitest';
import { RsyslogHashTable, hashFromString, mixedHash } from '@/network/rsyslog/engine/HashTable';

const NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
const SIXTY = Array.from({ length: 60 }, (_, index) => `key${index + 1}`);
const NAMES_ORDER = 'ivan heidi grace dave carol frank bob eve judy alice';
const SIXTY_ORDER = 'key23 key29 key59 key24 key55 key44 key35 key58 key60 key54 key34 key12 key9 key38 key20 key49 key57 key15 key2 key14 key6 key25 key3 key7 key18 key48 key52 key47 key53 key4 key30 key22 key19 key13 key43 key50 key51 key10 key8 key39 key1 key16 key41 key28 key26 key32 key31 key36 key46 key5 key56 key42 key37 key33 key45 key17 key27 key21 key11 key40';

function filled(minSize: number, keys: string[]): RsyslogHashTable<number> {
  const table = new RsyslogHashTable<number>(minSize);
  keys.forEach((key, index) => table.insert(key, index));
  return table;
}

describe('rsyslog hashtable', () => {
  it('witness: a lookup answers what was inserted, whatever the order', () => {
    const table = filled(5, NAMES);
    expect(NAMES.every((name, index) => table.search(name) === index)).toBe(true);
    expect(table.search('zorglub')).toBeUndefined();
  });

  it('hashes the way hash() of hashtable.c does, the java 1.4 mixing included', () => {
    const table = new RsyslogHashTable<number>(5);
    expect(NAMES.slice(0, 5).map((name) => table.hash(name))).toEqual([915478804, 639611676, 1146815099, 3012361556, 3014305086]);
    expect(mixedHash('frank')).toBe(4209871661);
    expect(hashFromString('a')).toBe(1 * 33 + 97);
  });

  it('treats the bytes of a non-ASCII key as signed, like char on the C side', () => {
    expect(mixedHash('é')).toBe(3681873603);
  });

  it('iterates by bucket, the most recent insert first inside a chain', () => {
    expect(filled(5, NAMES).entries().map(([key]) => key).join(' ')).toBe(NAMES_ORDER);
  });

  it('expands at 65 percent load, reversing the chains, and iterates like the C table', () => {
    const table = filled(16, SIXTY);
    expect(table.count).toBe(60);
    expect(table.entries().map(([key]) => key).join(' ')).toBe(SIXTY_ORDER);
  });

  it('removes a key and counts it', () => {
    const table = filled(5, NAMES);
    expect(table.remove('carol')).toBe(2);
    expect(table.remove('carol')).toBeUndefined();
    expect(table.count).toBe(9);
    expect(table.entries().map(([key]) => key).join(' ')).toBe('ivan heidi grace dave frank bob eve judy alice');
  });
});
