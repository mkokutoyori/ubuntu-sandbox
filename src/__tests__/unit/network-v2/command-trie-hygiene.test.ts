/**
 * Command-tree hygiene: the CLI CommandTrie silently lets a later registration
 * overwrite an earlier one on the same path. That shadowing is almost always a
 * bug (a whole command handler becomes dead code), so this suite asserts the
 * Cisco command trees contain no *accidental* duplicate registrations.
 *
 * A small allow-list captures the remaining INTENTIONAL base/override pairs,
 * where the shared `CiscoShellBase` registers a default that a device-specific
 * module deliberately overrides (removing the base would break the other
 * vendor). Anything outside the allow-list fails the test — so a newly
 * introduced duplicate is caught immediately.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

function collectOverwrites(make: () => void): Set<string> {
  const seen = new Set<string>();
  CommandTrie.overwriteObserver = ({ path }) => { seen.add(path); };
  try { make(); } finally { CommandTrie.overwriteObserver = null; }
  return seen;
}

afterEach(() => { CommandTrie.overwriteObserver = null; });

// Intentional base-default / device-override pairs (shared CiscoShellBase
// registers a default; a vendor module overrides it on purpose).
const ROUTER_ALLOWED = new Set([
  'ip cef', 'no ip cef',        // base toggle ← CiscoSecurityCommands (CEF FIB)
  'no ip routing',              // base negation ← router CiscoOspfCommands
  'aaa', 'username', 'ip ssh',  // base mgmt defaults ← CiscoSecurityCommands
  'show ssh',                   // base mgmt default ← CiscoSecurityCommands
]);

const SWITCH_ALLOWED = new Set([
  'show mac address-table',     // base default ← CiscoSwitchShell (real table)
  'no ip routing',              // base configState toggle ← CiscoSwitchShell ack
  'show arp',                   // base ARP renderer ← CiscoSwitchShell SVI view
  'show ip arp',                // base ARP renderer ← CiscoSwitchShell SVI view
]);

describe('Cisco command tree has no accidental duplicate registrations', () => {
  it('CiscoRouter', () => {
    const dups = collectOverwrites(() => { new CiscoRouter('r', 'R', 0, 0); });
    const unexpected = [...dups].filter(p => !ROUTER_ALLOWED.has(p));
    expect(unexpected, `Unexpected duplicate trie registrations: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('CiscoSwitch', () => {
    const dups = collectOverwrites(() => { new CiscoSwitch('switch-cisco', 'SW', 26, 0, 0); });
    const unexpected = [...dups].filter(p => !SWITCH_ALLOWED.has(p));
    expect(unexpected, `Unexpected duplicate trie registrations: ${unexpected.join(', ')}`).toEqual([]);
  });
});
