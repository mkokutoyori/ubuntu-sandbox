import type { Dot1QTag } from '../../../core/types';
import { VID_WILDCARD } from './VlanId';
import { makeVlanTag, TPID_C_TAG } from './VlanTag';

export type AcceptableFrameTypes = 'admit-all' | 'vlan-tagged-only' | 'untagged-and-priority-tagged-only';
export type PcpTableName = '8P0D' | '7P1D' | '6P2D' | '5P3D';

const PRIORITY_COLUMNS = [7, 6, 5, 4, 3, 2, 1, 0] as const;

const ENCODING: Readonly<Record<PcpTableName, readonly number[]>> = Object.freeze({
  '8P0D': [7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0],
  '7P1D': [7, 7, 6, 6, 5, 4, 5, 4, 3, 3, 2, 2, 1, 1, 0, 0],
  '6P2D': [7, 7, 6, 6, 5, 4, 5, 4, 3, 2, 3, 2, 1, 1, 0, 0],
  '5P3D': [7, 7, 6, 6, 5, 4, 5, 4, 3, 2, 3, 2, 1, 0, 1, 0],
});

const DECODING: Readonly<Record<PcpTableName, readonly string[]>> = Object.freeze({
  '8P0D': ['7', '6', '5', '4', '3', '2', '1', '0'],
  '7P1D': ['7', '6', '4', '4DE', '3', '2', '1', '0'],
  '6P2D': ['7', '6', '4', '4DE', '2', '2DE', '1', '0'],
  '5P3D': ['7', '6', '4', '4DE', '2', '2DE', '0', '0DE'],
});

export const IDENTITY_PRIORITY_REGENERATION: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);

export interface EissPortParameters {
  readonly pvid: number;
  readonly acceptableFrameTypes: AcceptableFrameTypes;
  readonly useDei: boolean;
  readonly pcpEncoding: PcpTableName;
  readonly pcpDecoding: PcpTableName;
  readonly priorityRegeneration: readonly number[];
  readonly untaggedVids: (vid: number) => boolean;
  readonly tpid: number;
}

export function defaultEissParameters(pvid: number, untaggedVids: (vid: number) => boolean): EissPortParameters {
  return Object.freeze({
    pvid, acceptableFrameTypes: 'admit-all' as const, useDei: false,
    pcpEncoding: '8P0D' as const, pcpDecoding: '8P0D' as const,
    priorityRegeneration: IDENTITY_PRIORITY_REGENERATION, untaggedVids, tpid: TPID_C_TAG,
  });
}

export function encodePcp(
  table: PcpTableName, priority: number, dropEligible: boolean,
): number {
  const column = PRIORITY_COLUMNS.indexOf(priority as (typeof PRIORITY_COLUMNS)[number]);
  return ENCODING[table][column * 2 + (dropEligible ? 1 : 0)];
}

export function decodePcp(
  table: PcpTableName, pcp: number,
): { priority: number; dropEligible: boolean } {
  const entry = DECODING[table][7 - pcp];
  return { priority: Number.parseInt(entry, 10), dropEligible: entry.endsWith('DE') };
}

export type EissDiscardReason =
  | 'untagged-not-admitted'
  | 'priority-tagged-not-admitted'
  | 'vlan-tagged-not-admitted'
  | 'reserved-vid';

export interface EissIndication {
  readonly discard: boolean;
  readonly reason?: EissDiscardReason;
  readonly vid?: number;
  readonly priority?: number;
  readonly dropEligible?: boolean;
  readonly tagged?: boolean;
}

export function indicate(
  tag: Dot1QTag | undefined, receivedPriority: number, port: EissPortParameters,
): EissIndication {
  const types = port.acceptableFrameTypes;
  if (tag === undefined) {
    if (types === 'vlan-tagged-only') return { discard: true, reason: 'untagged-not-admitted' };
    return deliver(port.pvid, receivedPriority, false, port, false);
  }
  if (tag.vid === VID_WILDCARD) return { discard: true, reason: 'reserved-vid' };
  if (tag.vid === 0) {
    if (types === 'vlan-tagged-only') return { discard: true, reason: 'priority-tagged-not-admitted' };
    const decoded = decodeTagPriority(tag, port);
    return deliver(port.pvid, decoded.priority, decoded.dropEligible, port, true);
  }
  if (types === 'untagged-and-priority-tagged-only') {
    return { discard: true, reason: 'vlan-tagged-not-admitted' };
  }
  const decoded = decodeTagPriority(tag, port);
  return deliver(tag.vid, decoded.priority, decoded.dropEligible, port, true);
}

function decodeTagPriority(tag: Dot1QTag, port: EissPortParameters): { priority: number; dropEligible: boolean } {
  const decoded = decodePcp(port.pcpDecoding, tag.pcp);
  return { priority: decoded.priority, dropEligible: decoded.dropEligible || (port.useDei && tag.dei === 1) };
}

function deliver(
  vid: number, priority: number, dropEligible: boolean, port: EissPortParameters, tagged: boolean,
): EissIndication {
  return {
    discard: false, vid, dropEligible, tagged,
    priority: port.priorityRegeneration[priority] ?? priority,
  };
}

export interface EissRequestResult {
  readonly discard: boolean;
  readonly tag?: Dot1QTag;
}

export function request(
  vid: number, priority: number, dropEligible: boolean, port: EissPortParameters,
): EissRequestResult {
  if (vid === VID_WILDCARD) return { discard: true };
  if (port.untaggedVids(vid)) return { discard: false };
  const pcp = port.useDei ? priority : encodePcp(port.pcpEncoding, priority, dropEligible);
  return { discard: false, tag: makeVlanTag({ vid, pcp, dei: port.useDei && dropEligible ? 1 : 0, tpid: port.tpid }) };
}
