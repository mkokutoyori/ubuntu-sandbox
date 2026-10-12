import { unitNameIsValid } from '../systemd/UnitName';

const SPECIAL_ROOT_SLICE = '-.slice';
const LETTERS_DIGITS = /^[A-Za-z0-9]+$/;

const unescape = (name: string): string => (name.startsWith('_') ? name.slice(1) : name);

function validSliceName(name: string): boolean {
  if (name.length < 'x.slice'.length) return false;
  return name.endsWith('.slice') && unitNameIsValid(unescape(name), { plain: true });
}

function skipSlashes(path: string, at: number): number {
  while (path[at] === '/') at++;
  return at;
}

function segmentEnd(path: string, at: number): number {
  const slash = path.indexOf('/', at);
  return slash < 0 ? path.length : slash;
}

function skipSlices(path: string): number {
  let at = 0;
  for (;;) {
    at = skipSlashes(path, at);
    const end = segmentEnd(path, at);
    if (!validSliceName(path.slice(at, end))) return at;
    at = end;
  }
}

function decodeUnit(cgroup: string, from: number): string | null {
  const end = segmentEnd(cgroup, from);
  if (end - from < 3) return null;
  const unit = unescape(cgroup.slice(from, end));
  return unitNameIsValid(unit, { plain: true, instance: true }) ? unit : null;
}

export function cgroupPathGetUnit(path: string): string | null {
  const unit = decodeUnit(path, skipSlices(path));
  if (unit === null || unit.endsWith('.slice')) return null;
  return unit;
}

function skipSession(path: string, from: number): number | null {
  if (from >= path.length) return null;
  let at = skipSlashes(path, from);
  const end = segmentEnd(path, at);
  const name = path.slice(at, end);
  if (name.length < 'session-x.scope'.length) return null;
  if (name.startsWith('session-') && name.endsWith('.scope')) {
    const id = name.slice(8, name.length - 6);
    if (id === '' || !LETTERS_DIGITS.test(id)) return null;
    at = skipSlashes(path, end);
    return at;
  }
  return null;
}

function skipUserManager(path: string, from: number): number | null {
  if (from >= path.length) return null;
  let at = skipSlashes(path, from);
  const end = segmentEnd(path, at);
  const name = path.slice(at, end);
  if (name.length < 'user@x.service'.length) return null;
  if (name.startsWith('user@') && name.endsWith('.service')) {
    const uid = name.slice(5, name.length - 8);
    if (!/^(0|[1-9][0-9]*)$/.test(uid) || Number(uid) >= 0xfffffffe) return null;
    at = skipSlashes(path, end);
    return at;
  }
  return null;
}

function skipUserPrefix(path: string): number | null {
  const afterSlices = skipSlices(path);
  const manager = skipUserManager(path, afterSlices);
  if (manager !== null) return manager;
  return skipSession(path, afterSlices);
}

export function cgroupPathGetUserUnit(path: string): string | null {
  const start = skipUserPrefix(path);
  return start === null ? null : cgroupPathGetUnit(path.slice(start));
}

export function cgroupPathGetSession(path: string): string | null {
  const unit = cgroupPathGetUnit(path);
  if (unit === null || !unit.startsWith('session-') || !unit.endsWith('.scope')) return null;
  const id = unit.slice(8, unit.length - 6);
  return id !== '' && LETTERS_DIGITS.test(id) ? id : null;
}

export function cgroupPathGetSlice(path: string): string | null {
  let last: number | null = null;
  let at = 0;
  for (;;) {
    at = skipSlashes(path, at);
    const end = segmentEnd(path, at);
    if (!validSliceName(path.slice(at, end))) return last === null ? SPECIAL_ROOT_SLICE : decodeUnit(path, last);
    last = at;
    at = end;
  }
}

export function cgroupPathGetOwnerUid(path: string): number | null {
  const slice = cgroupPathGetSlice(path);
  if (slice === null || !slice.startsWith('user-') || !slice.endsWith('.slice')) return null;
  const uid = slice.slice(5, slice.length - 6);
  return /^(0|[1-9][0-9]*)$/.test(uid) && Number(uid) < 0xfffffffe ? Number(uid) : null;
}

export function cgroupPathGetUserSlice(path: string): string | null {
  const start = skipUserPrefix(path);
  return start === null ? null : cgroupPathGetSlice(path.slice(start));
}

export function cgroupShiftPath(cgroup: string, root: string): string {
  const normalizedRoot = root === '' ? '/' : root;
  if (normalizedRoot === '/') return cgroup;
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  if (cgroup === normalizedRoot) return cgroup;
  return cgroup.startsWith(prefix) ? cgroup.slice(normalizedRoot.length) : cgroup;
}
