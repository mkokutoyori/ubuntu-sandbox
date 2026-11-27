/*
 * Probe: the check operators `=*` (the attribute is present in the request) and `!*` (it is absent). The users-file grammar and the rlm_sql `op` column refused them as
 * an invalid operator. Source of truth: FreeRADIUS v3.2.x src/include/token.h (T_OP_CMP_TRUE `=*`, T_OP_CMP_FALSE `!*`) and src/main/pair.c paircompare/radius_compare_vps
 * (an attribute absent from the request fails `=*` and satisfies `!*`; present, it satisfies `=*` and fails `!*`; the value is not compared). The sql `op` column accepts the same operators and its rows become the same entries, so one matcher decides both.
 *
 * Discriminated with git stash on src/network: 5 of 6 fall before the fix (the grammar refused the operators); the witness (a plain `==` check still selects the entry)
 * passes either way.
 */
import { describe, it, expect } from 'vitest';
import { parseUsersFile, matchUsersEntries, type UsersRequestView } from '@/network/devices/linux/freeradius/UsersFileParser';

const entriesOf = (source: string) => {
  const parsed = parseUsersFile(source, 'users', () => null);
  if (parsed.ok === false) throw new Error(parsed.error);
  return parsed.entries;
};

const requestWith = (present: Record<string, string>): UsersRequestView => (name) => present[name.toLowerCase()];

describe('check operators =* and !*', () => {
  const source = 'bob Calling-Station-Id =* ANY, Cleartext-Password := "pw"\nalice Calling-Station-Id !* ANY, Cleartext-Password := "pw"\n';

  it('witness: a == check still selects the entry', () => {
    const entries = entriesOf('bob Calling-Station-Id == "x", Cleartext-Password := "pw"\n');
    expect(matchUsersEntries(entries, 'bob', requestWith({ 'calling-station-id': 'x' }))).not.toBeNull();
  });

  it('=* parses', () => {
    expect(entriesOf(source)).toHaveLength(2);
  });

  it('=* selects the entry when the attribute is present, whatever its value', () => {
    expect(matchUsersEntries(entriesOf(source), 'bob', requestWith({ 'calling-station-id': 'anything' }))).not.toBeNull();
  });

  it('=* does not select the entry when the attribute is absent', () => {
    expect(matchUsersEntries(entriesOf(source), 'bob', requestWith({}))).toBeNull();
  });

  it('!* selects the entry when the attribute is absent', () => {
    expect(matchUsersEntries(entriesOf(source), 'alice', requestWith({}))).not.toBeNull();
  });

  it('!* does not select the entry when the attribute is present', () => {
    expect(matchUsersEntries(entriesOf(source), 'alice', requestWith({ 'calling-station-id': 'x' }))).toBeNull();
  });
});
