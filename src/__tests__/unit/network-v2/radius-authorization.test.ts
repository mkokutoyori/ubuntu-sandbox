import { describe, it, expect } from 'vitest';
import { attr, type RadiusAttribute } from '@/network/radius/types';
import { parseAuthorization } from '@/network/radius/authorization';
import { CISCO_VENDOR_ID } from '@/network/radius/dictionary';

describe('RADIUS authorization parsing (RFC 3580, Cisco AV-pair)', () => {
  it('extracts privilege level from a Cisco shell:priv-lvl AV-pair', () => {
    const attrs: RadiusAttribute[] = [attr('vendor-specific', 'shell:priv-lvl=15', { id: CISCO_VENDOR_ID, type: 1 })];
    expect(parseAuthorization(attrs).privilegeLevel).toBe(15);
  });

  it('ignores an unrelated Cisco AV-pair', () => {
    const attrs: RadiusAttribute[] = [attr('vendor-specific', 'ip:inacl#1=deny', { id: CISCO_VENDOR_ID, type: 1 })];
    expect(parseAuthorization(attrs).privilegeLevel).toBeUndefined();
  });

  it('extracts Filter-Id', () => {
    const attrs: RadiusAttribute[] = [attr('filter-id', 'guest-acl')];
    expect(parseAuthorization(attrs).filterId).toBe('guest-acl');
  });

  it('extracts a dynamic VLAN only when Tunnel-Type says VLAN', () => {
    const attrs: RadiusAttribute[] = [
      attr('tunnel-type', 13),
      attr('tunnel-medium-type', 6),
      attr('tunnel-private-group-id', '100'),
    ];
    expect(parseAuthorization(attrs).vlanId).toBe(100);
  });

  it('does not extract a VLAN when Tunnel-Type is absent (Tunnel-Private-Group-ID alone is not enough)', () => {
    const attrs: RadiusAttribute[] = [attr('tunnel-private-group-id', '100')];
    expect(parseAuthorization(attrs).vlanId).toBeUndefined();
  });

  it('extracts Session-Timeout, Idle-Timeout and Reply-Message', () => {
    const attrs: RadiusAttribute[] = [
      attr('session-timeout', 3600),
      attr('idle-timeout', 300),
      attr('reply-message', 'Welcome!'),
    ];
    const auth = parseAuthorization(attrs);
    expect(auth.sessionTimeoutSec).toBe(3600);
    expect(auth.idleTimeoutSec).toBe(300);
    expect(auth.replyMessage).toBe('Welcome!');
  });

  it('returns an empty object for an empty attribute list', () => {
    expect(parseAuthorization([])).toEqual({});
  });
});
