/**
 * IEEE Std 802.1Q-2022, 6.9 (Support of the EISS), docs/rfc/dot1q/8021Q-2022.pdf p.157-161:
 *
 *   6.9.1 a received frame is discarded when it is untagged and only
 *         VLAN-tagged frames are admitted; when its VID is FFF; when it is
 *         priority-tagged (VID 0) and only VLAN-tagged are admitted; when it
 *         carries a VID 001-FFE and only untagged and priority-tagged are
 *         admitted. Otherwise its vlan_identifier is the VID, or the PVID for
 *         an untagged or priority-tagged frame; priority and drop_eligible
 *         come from the PCP (and the DEI when Use_DEI), then priority is
 *         regenerated through the Priority Regeneration Table.
 *   6.9.2 a frame leaving through a Port that is a member of the untagged set
 *         for its VID carries no tag; otherwise a tag with PCP and DEI
 *         encoded by the Priority Code Point Encoding Table (Table 6-2).
 *   6.9.3 Tables 6-2 and 6-3: 8P0D, 7P1D, 6P2D, 5P3D; Use_DEI default False.
 *
 * Measured on a git worktree of HEAD before the change: the module does not
 * exist, so the file fails to load. No witness: the rules were scattered as
 * inline conditions in Switch.handleFrame, none of them tested against the text.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultEissParameters, encodePcp, decodePcp, indicate, request, IDENTITY_PRIORITY_REGENERATION,
  type EissPortParameters,
} from '@/network/layers/link/vlan/Eiss';
import { makeVlanTag } from '@/network/layers/link/vlan/VlanTag';

function port(over: Partial<EissPortParameters> = {}): EissPortParameters {
  return { ...defaultEissParameters(10, vid => vid === 10), ...over };
}

describe('6.9.1 data indications: what is discarded', () => {
  it('discards an untagged frame when only VLAN-tagged frames are admitted', () => {
    expect(indicate(undefined, 0, port({ acceptableFrameTypes: 'vlan-tagged-only' }))).toEqual({
      discard: true, reason: 'untagged-not-admitted',
    });
  });

  it('discards VID FFF whatever the acceptable frame types', () => {
    const tag = { tpid: 0x8100, pcp: 0, dei: 0, vid: 0xfff };
    for (const types of ['admit-all', 'vlan-tagged-only', 'untagged-and-priority-tagged-only'] as const) {
      expect(indicate(tag, 0, port({ acceptableFrameTypes: types })).reason).toBe('reserved-vid');
    }
  });

  it('discards a priority-tagged frame when only VLAN-tagged frames are admitted', () => {
    const tag = makeVlanTag({ vid: 0, pcp: 3 });
    expect(indicate(tag, 0, port({ acceptableFrameTypes: 'vlan-tagged-only' })).reason).toBe('priority-tagged-not-admitted');
  });

  it('discards a VLAN-tagged frame (VID 001-FFE) when only untagged and priority-tagged are admitted', () => {
    const tag = makeVlanTag({ vid: 20 });
    expect(indicate(tag, 0, port({ acceptableFrameTypes: 'untagged-and-priority-tagged-only' })).reason)
      .toBe('vlan-tagged-not-admitted');
  });
});

describe('6.9.1 data indications: what is delivered', () => {
  it('gives an untagged frame the PVID of the Port', () => {
    expect(indicate(undefined, 2, port({ pvid: 77 }))).toMatchObject({ discard: false, vid: 77, priority: 2, tagged: false });
  });

  it('gives a priority-tagged frame the PVID and keeps the priority it carried', () => {
    const tag = makeVlanTag({ vid: 0, pcp: 5 });
    expect(indicate(tag, 0, port({ pvid: 77 }))).toMatchObject({ discard: false, vid: 77, priority: 5, tagged: true });
  });

  it('gives a VLAN-tagged frame its own VID', () => {
    expect(indicate(makeVlanTag({ vid: 300, pcp: 6 }), 0, port())).toMatchObject({ vid: 300, priority: 6 });
  });

  it('regenerates the priority through the Priority Regeneration Table (6.9.4)', () => {
    const regeneration = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(indicate(makeVlanTag({ vid: 30, pcp: 6 }), 0, port({ priorityRegeneration: regeneration })).priority).toBe(0);
    expect(IDENTITY_PRIORITY_REGENERATION).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('ignores the DEI unless Use_DEI is true (default False), and honours it when true', () => {
    const tag = makeVlanTag({ vid: 30, pcp: 3, dei: 1 });
    expect(indicate(tag, 0, port()).dropEligible).toBe(false);
    expect(indicate(tag, 0, port({ useDei: true })).dropEligible).toBe(true);
  });
});

describe('6.9.3 Tables 6-2 and 6-3', () => {
  it('8P0D, the default: the PCP equals the priority', () => {
    for (let priority = 0; priority < 8; priority++) {
      expect(encodePcp('8P0D', priority, false)).toBe(priority);
      expect(encodePcp('8P0D', priority, true)).toBe(priority);
      expect(decodePcp('8P0D', priority)).toEqual({ priority, dropEligible: false });
    }
  });

  it('7P1D conveys drop eligibility for priority 4 only', () => {
    expect(encodePcp('7P1D', 5, true)).toBe(4);
    expect(decodePcp('7P1D', 4)).toEqual({ priority: 4, dropEligible: true });
    expect(decodePcp('7P1D', 5)).toEqual({ priority: 4, dropEligible: false });
  });

  it('6P2D and 5P3D convey drop eligibility for more priorities', () => {
    expect(decodePcp('6P2D', 2)).toEqual({ priority: 2, dropEligible: true });
    expect(encodePcp('6P2D', 3, true)).toBe(2);
    expect(decodePcp('5P3D', 0)).toEqual({ priority: 0, dropEligible: true });
    expect(encodePcp('5P3D', 1, true)).toBe(0);
  });
});

describe('6.9.2 data requests', () => {
  it('inserts no tag when the Port is in the untagged set for the VID', () => {
    expect(request(10, 3, false, port())).toEqual({ discard: false });
  });

  it('inserts a tag when it is not, encoding the priority in the PCP', () => {
    const result = request(20, 5, false, port());
    expect(result.tag).toMatchObject({ tpid: 0x8100, vid: 20, pcp: 5, dei: 0 });
  });

  it('encodes drop_eligible in the DEI when Use_DEI, in the PCP table otherwise', () => {
    expect(request(20, 4, true, port({ useDei: true })).tag).toMatchObject({ pcp: 4, dei: 1 });
    expect(request(20, 5, true, port({ pcpEncoding: '7P1D' })).tag).toMatchObject({ pcp: 4, dei: 0 });
  });

  it('discards a request for VID FFF', () => {
    expect(request(0xfff, 0, false, port()).discard).toBe(true);
  });
});
