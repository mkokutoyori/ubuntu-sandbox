import { LdapRc } from '../ldapErrors';
import { INT_MAX, SaslSec, type SaslSecurityProperties } from './saslTypes';

const GOT_MINSSF = 1;
const GOT_MAXSSF = 2;
const GOT_MAXBUF = 4;

interface SecpropKey {
  readonly key: string;
  readonly sflag: number;
  readonly ival: number;
  readonly idef: number;
}

const SPROPS: readonly SecpropKey[] = [
  { key: 'none', sflag: 0, ival: 0, idef: 0 },
  { key: 'nodict', sflag: SaslSec.NODICTIONARY, ival: 0, idef: 0 },
  { key: 'noplain', sflag: SaslSec.NOPLAINTEXT, ival: 0, idef: 0 },
  { key: 'noactive', sflag: SaslSec.NOACTIVE, ival: 0, idef: 0 },
  { key: 'passcred', sflag: SaslSec.PASS_CREDENTIALS, ival: 0, idef: 0 },
  { key: 'forwardsec', sflag: SaslSec.FORWARD_SECRECY, ival: 0, idef: 0 },
  { key: 'noanonymous', sflag: SaslSec.NOANONYMOUS, ival: 0, idef: 0 },
  { key: 'minssf=', sflag: 0, ival: GOT_MINSSF, idef: 0 },
  { key: 'maxssf=', sflag: 0, ival: GOT_MAXSSF, idef: INT_MAX },
  { key: 'maxbufsize=', sflag: 0, ival: GOT_MAXBUF, idef: 65536 },
];

function strtoul(text: string): { value: number; consumed: number } {
  const match = /^[ \t\n\v\f\r]*(\+|-)?(\d+)/.exec(text);
  if (match === null) return { value: 0, consumed: 0 };
  const magnitude = Number(match[2]);
  const value = match[1] === '-' ? (4294967296 - (magnitude % 4294967296)) % 4294967296 : magnitude % 4294967296;
  return { value, consumed: match[0].length };
}

export function parseSecprops(input: string, secprops: SaslSecurityProperties): number {
  const props = input.split(',');
  let sflags = 0;
  let gotSflags = 0;
  let maxSsf = 0;
  let gotMaxSsf = 0;
  let minSsf = 0;
  let gotMinSsf = 0;
  let maxbufsize = 0;
  let gotMaxbufsize = 0;
  for (const prop of props) {
    let matched = false;
    for (const candidate of SPROPS) {
      if (prop.length < candidate.key.length) continue;
      if (prop.slice(0, candidate.key.length).toLowerCase() !== candidate.key) continue;
      const tail = prop.slice(candidate.key.length);
      if (candidate.ival !== 0) {
        if (!/^\d/.test(tail)) continue;
        const parsed = strtoul(tail);
        if (parsed.consumed === 0 || parsed.consumed !== tail.length) continue;
        if (candidate.ival === GOT_MINSSF) { minSsf = parsed.value; gotMinSsf++; }
        else if (candidate.ival === GOT_MAXSSF) { maxSsf = parsed.value; gotMaxSsf++; }
        else { maxbufsize = parsed.value; gotMaxbufsize++; }
      } else {
        if (tail !== '') continue;
        if (candidate.sflag !== 0) sflags |= candidate.sflag;
        else sflags = 0;
        gotSflags++;
      }
      matched = true;
      break;
    }
    if (!matched) return LdapRc.NOT_SUPPORTED;
  }
  if (gotSflags > 0) secprops.securityFlags = sflags;
  if (gotMinSsf > 0) secprops.minSsf = minSsf;
  if (gotMaxSsf > 0) secprops.maxSsf = maxSsf;
  if (gotMaxbufsize > 0) secprops.maxBufsize = maxbufsize;
  return LdapRc.SUCCESS;
}

export function unparseSecprops(secprops: SaslSecurityProperties): string {
  const parts: string[] = [];
  for (const candidate of SPROPS) {
    if (candidate.ival !== 0) {
      let value = 0;
      if (candidate.ival === GOT_MINSSF) value = secprops.minSsf;
      else if (candidate.ival === GOT_MAXSSF) value = secprops.maxSsf;
      else value = secprops.maxBufsize;
      if (value === candidate.idef) continue;
      parts.push(`${candidate.key}${value}`);
    } else if (candidate.sflag !== 0) {
      if ((candidate.sflag & secprops.securityFlags) !== 0) parts.push(candidate.key);
    } else if (secprops.securityFlags === 0) {
      parts.push(candidate.key);
    }
  }
  return parts.join(',');
}
