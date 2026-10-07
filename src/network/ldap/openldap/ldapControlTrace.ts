import { BerElement, LBER_DEFAULT } from './libber';
import { ControlOid } from './ldapControls';

const TAG_OCTET_STRING = 0x04;
const TAG_INTEGER = 0x02;
const TAG_SORT_ATTRTYPE = 0x80;
const TAG_VLV_CONTEXT = 0x04;
const TAG_CONSTRUCTED_CONTEXT = 0xa0;
const TAG_SYNC_COOKIE = 0x04;
const TAG_REFRESH_DELETES = 0x01;
const DEREF_OID = '1.3.6.1.4.1.4203.666.5.16';
const WHAT_FAILED_OID = '1.3.6.1.4.1.4203.666.5.17';

export function traceControlParse(oid: string, ber: BerElement, ldif: number): void {
  switch (oid) {
    case ControlOid.PAGEDRESULTS:
      ber.scanf('{io}');
      break;
    case ControlOid.PERSIST_ENTRY_CHANGE_NOTICE:
      traceEntryChange(ber);
      break;
    case ControlOid.SORTRESPONSE:
      if (ber.scanf('{e') !== LBER_DEFAULT && ber.peekTag().tag === TAG_SORT_ATTRTYPE) ber.scanf('ta');
      break;
    case ControlOid.VLVRESPONSE:
      if (ber.scanf('{iie') !== LBER_DEFAULT && ber.peekTag().tag === TAG_VLV_CONTEXT) ber.scanf('tO');
      break;
    case DEREF_OID:
      traceDeref(ber);
      break;
    case ControlOid.DIRSYNC:
      ber.scanf('{iio');
      break;
    case ControlOid.PRE_READ:
    case ControlOid.POST_READ:
      tracePrePostRead(ber);
      break;
    case ControlOid.SYNC_STATE:
      if (ldif === 0 && ber.scanf('{em') !== LBER_DEFAULT) ber.getStringbv(true);
      break;
    case ControlOid.SYNC_DONE:
      if (ldif === 0) traceSyncDone(ber);
      break;
    case WHAT_FAILED_OID:
      ber.scanf('[M]');
      break;
    default:
      break;
  }
}

function traceEntryChange(ber: BerElement): void {
  if (ber.scanf('{e') === LBER_DEFAULT) return;
  let peek = ber.peekTag();
  if (peek.length === 0) return;
  if (peek.tag === TAG_OCTET_STRING) {
    if (ber.getStringbv(true).tag === LBER_DEFAULT) return;
    peek = ber.peekTag();
  }
  if (peek.tag === TAG_INTEGER) ber.getInt();
}

function traceDeref(ber: BerElement): void {
  for (let element = ber.firstElement(); element.tag !== LBER_DEFAULT; element.tag = ber.nextElement(element.last)) {
    if (ber.scanf('{ao') === LBER_DEFAULT) return;
    if (ber.peekTag().tag === TAG_CONSTRUCTED_CONTEXT) {
      for (let inner = ber.firstElement(); inner.tag !== LBER_DEFAULT; inner.tag = ber.nextElement(inner.last)) {
        if (ber.scanf('{a[W]}') === LBER_DEFAULT) return;
      }
    }
    if (ber.scanf('}') === LBER_DEFAULT) return;
  }
}

function tracePrePostRead(ber: BerElement): void {
  if (ber.scanf('{m{') === LBER_DEFAULT) return;
  while (ber.scanf('{m') !== LBER_DEFAULT) {
    if (ber.scanf('[W]') === LBER_DEFAULT) return;
  }
}

function traceSyncDone(ber: BerElement): void {
  ber.skipTag();
  if (ber.peekTag().tag === TAG_SYNC_COOKIE) ber.scanf('m');
  if (ber.peekTag().tag === TAG_REFRESH_DELETES) ber.scanf('b');
}
