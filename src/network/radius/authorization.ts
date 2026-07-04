/**
 * Turns the attributes of an Access-Accept into the normalized decisions a
 * NAS applies (RFC 3580 §3.31 dynamic VLAN, Cisco shell privilege, session/
 * idle timeouts, Filter-Id ACL, Reply-Message). Pure attribute → decision
 * mapping — callers (CLI login, 802.1X) decide what to actually do with it.
 */
import type { RadiusAttribute } from './types';
import { CISCO_VENDOR_ID } from './dictionary';

export interface RadiusAuthorization {
  /** From the Cisco AV-pair `shell:priv-lvl=N` (vendor 9, sub-type 1). */
  privilegeLevel?: number;
  /** Filter-Id (11) — an ACL name to apply to the session. */
  filterId?: string;
  /** From Tunnel-Private-Group-ID (81), only when Tunnel-Type (64) says VLAN (RFC 3580 §3.31). */
  vlanId?: number;
  sessionTimeoutSec?: number;
  idleTimeoutSec?: number;
  replyMessage?: string;
}

const PRIV_LVL_RE = /^shell:priv-lvl=(\d+)$/;
/** RFC 2868 §3.2 Tunnel-Type value meaning "Virtual LANs (VLAN)". */
const TUNNEL_TYPE_VLAN = 13;

export function parseAuthorization(attributes: RadiusAttribute[]): RadiusAuthorization {
  const out: RadiusAuthorization = {};
  let tunnelIsVlan = false;

  for (const a of attributes) {
    switch (a.type) {
      case 'filter-id':
        out.filterId = String(a.value);
        break;
      case 'session-timeout':
        out.sessionTimeoutSec = Number(a.value);
        break;
      case 'idle-timeout':
        out.idleTimeoutSec = Number(a.value);
        break;
      case 'reply-message':
        out.replyMessage = String(a.value);
        break;
      case 'tunnel-type':
        if (Number(a.value) === TUNNEL_TYPE_VLAN) tunnelIsVlan = true;
        break;
      case 'vendor-specific':
        if (a.vendor?.id === CISCO_VENDOR_ID && a.vendor.type === 1) {
          const m = PRIV_LVL_RE.exec(String(a.value));
          if (m) out.privilegeLevel = Number(m[1]);
        }
        break;
      default:
        break;
    }
  }

  if (tunnelIsVlan) {
    const groupId = attributes.find((a) => a.type === 'tunnel-private-group-id');
    if (groupId) {
      const vlanId = Number(groupId.value);
      if (!Number.isNaN(vlanId)) out.vlanId = vlanId;
    }
  }

  return out;
}
