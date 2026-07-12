/**
 * Nested group membership (`Add-ADGroupMember` where the member is
 * itself a group) previously had no public path at all — `addGroupMember`
 * only resolved users/computers. Now it also resolves groups, with a
 * cycle check (real AD's `Cannot make a group a member of itself`)
 * refusing direct or transitive self-membership.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — nested group membership', () => {
  it('allows adding one group as a member of another', () => {
    const s = store();
    s.newGroup('Inner');
    s.newGroup('Outer');
    const res = s.addGroupMember('Outer', 'Inner');
    expect(res.ok).toBe(true);
    expect(s.getGroup('Outer')!.members).toContain('Inner');
  });

  it('refuses direct self-membership', () => {
    const s = store();
    s.newGroup('Eng');
    const res = s.addGroupMember('Eng', 'Eng');
    expect(res.ok).toBe(false);
  });

  it('refuses a two-level cycle (A contains B, then B tries to contain A)', () => {
    const s = store();
    s.newGroup('A');
    s.newGroup('B');
    expect(s.addGroupMember('A', 'B').ok).toBe(true);
    const res = s.addGroupMember('B', 'A');
    expect(res.ok).toBe(false);
  });

  it('refuses a three-level cycle (A contains B contains C, then C tries to contain A)', () => {
    const s = store();
    s.newGroup('A');
    s.newGroup('B');
    s.newGroup('C');
    expect(s.addGroupMember('A', 'B').ok).toBe(true);
    expect(s.addGroupMember('B', 'C').ok).toBe(true);
    const res = s.addGroupMember('C', 'A');
    expect(res.ok).toBe(false);
  });

  it('allows a non-cyclic diamond (A and B both contain C)', () => {
    const s = store();
    s.newGroup('A');
    s.newGroup('B');
    s.newGroup('C');
    expect(s.addGroupMember('A', 'C').ok).toBe(true);
    expect(s.addGroupMember('B', 'C').ok).toBe(true);
    expect(s.getGroup('A')!.members).toContain('C');
    expect(s.getGroup('B')!.members).toContain('C');
  });

  it('removeGroupMember can remove a nested group member', () => {
    const s = store();
    s.newGroup('Inner');
    s.newGroup('Outer');
    s.addGroupMember('Outer', 'Inner');
    const res = s.removeGroupMember('Outer', 'Inner');
    expect(res.ok).toBe(true);
    expect(s.getGroup('Outer')!.members).not.toContain('Inner');
  });
});
