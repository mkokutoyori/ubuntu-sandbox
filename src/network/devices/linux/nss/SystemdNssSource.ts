import type { INssSource } from './INssSource';
import type { DynamicUser, DynamicUserTable } from './DynamicUserTable';
import { nssOk, nssNotFound, nssEnumOk, nssEnumEmpty } from './nssResult';
import type {
  NssEnumResult, NssResult,
  NssPasswdEntry, NssGroupEntry, NssShadowEntry, NssGshadowEntry,
} from './types';

const NOLOGIN = '/usr/sbin/nologin';

const SYNTH_PASSWD: Record<string, NssPasswdEntry> = {
  root:   { name: 'root',   passwd: 'x', uid: 0,     gid: 0,     gecos: 'Super User',  dir: '/root', shell: '/bin/sh' },
  nobody: { name: 'nobody', passwd: 'x', uid: 65534, gid: 65534, gecos: 'User Nobody', dir: '/',     shell: NOLOGIN },
};
const SYNTH_PASSWD_BY_UID = new Map<number, NssPasswdEntry>([
  [0, SYNTH_PASSWD.root], [65534, SYNTH_PASSWD.nobody],
]);
const SYNTH_GROUP: Record<string, NssGroupEntry> = {
  root:   { name: 'root',   passwd: 'x', gid: 0,     members: [] },
  nobody: { name: 'nobody', passwd: 'x', gid: 65534, members: [] },
};
const SYNTH_GROUP_BY_GID = new Map<number, NssGroupEntry>([
  [0, SYNTH_GROUP.root], [65534, SYNTH_GROUP.nobody],
]);

function lockedShadow(name: string): NssShadowEntry {
  return { name, passwd: '*', lstchg: '', min: '', max: '', warn: '', inact: '', expire: '', flag: '' };
}

function lockedGshadow(name: string): NssGshadowEntry {
  return { name, passwd: '!', admins: [], members: [] };
}

export class SystemdNssSource implements INssSource {
  readonly name = 'systemd';

  constructor(private readonly dynamic: DynamicUserTable) {}

  private dynPasswd(u: DynamicUser): NssPasswdEntry {
    return { name: u.name, passwd: 'x', uid: u.uid, gid: u.gid, gecos: 'Dynamic User', dir: '/', shell: NOLOGIN };
  }

  private dynGroup(u: DynamicUser): NssGroupEntry {
    return { name: u.name, passwd: 'x', gid: u.gid, members: [] };
  }

  getpwnam(name: string): NssResult<NssPasswdEntry> {
    if (SYNTH_PASSWD[name]) return nssOk(SYNTH_PASSWD[name]);
    const u = this.dynamic.byName(name);
    return u ? nssOk(this.dynPasswd(u)) : nssNotFound();
  }

  getpwuid(uid: number): NssResult<NssPasswdEntry> {
    const synth = SYNTH_PASSWD_BY_UID.get(uid);
    if (synth) return nssOk(synth);
    const u = this.dynamic.byUid(uid);
    return u ? nssOk(this.dynPasswd(u)) : nssNotFound();
  }

  enumPasswd(): NssEnumResult<NssPasswdEntry> {
    const entries = this.dynamic.list().map(u => this.dynPasswd(u));
    return entries.length ? nssEnumOk(entries) : nssEnumEmpty();
  }

  getgrnam(name: string): NssResult<NssGroupEntry> {
    if (SYNTH_GROUP[name]) return nssOk(SYNTH_GROUP[name]);
    const u = this.dynamic.byName(name);
    return u ? nssOk(this.dynGroup(u)) : nssNotFound();
  }

  getgrgid(gid: number): NssResult<NssGroupEntry> {
    const synth = SYNTH_GROUP_BY_GID.get(gid);
    if (synth) return nssOk(synth);
    const u = this.dynamic.byUid(gid);
    return u ? nssOk(this.dynGroup(u)) : nssNotFound();
  }

  enumGroup(): NssEnumResult<NssGroupEntry> {
    const entries = this.dynamic.list().map(u => this.dynGroup(u));
    return entries.length ? nssEnumOk(entries) : nssEnumEmpty();
  }

  getspnam(name: string): NssResult<NssShadowEntry> {
    if (SYNTH_PASSWD[name] || this.dynamic.byName(name)) return nssOk(lockedShadow(name));
    return nssNotFound();
  }

  enumShadow(): NssEnumResult<NssShadowEntry> {
    const entries = this.dynamic.list().map(u => lockedShadow(u.name));
    return entries.length ? nssEnumOk(entries) : nssEnumEmpty();
  }

  getsgnam(name: string): NssResult<NssGshadowEntry> {
    if (SYNTH_GROUP[name] || this.dynamic.byName(name)) return nssOk(lockedGshadow(name));
    return nssNotFound();
  }

  enumGshadow(): NssEnumResult<NssGshadowEntry> {
    const entries = this.dynamic.list().map(u => lockedGshadow(u.name));
    return entries.length ? nssEnumOk(entries) : nssEnumEmpty();
  }
}
