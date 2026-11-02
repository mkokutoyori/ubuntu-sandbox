import type { CaptureFrame } from './CaptureFrame';

const STP_LLC_BYTES = 3;
const SNAP_LLC_BYTES = 8;
const STP_SAP = 0x42;
const SNAP_SAP = 0xaa;
const PID_CDP = 0x2000;
const PID_PVST = 0x010b;
const PID_DTP = 0x2004;
const OUI_CISCO = 0x00000c;

export interface Ieee8023Payload {
  readonly lengthField: number;
  readonly llcBytes: number;
  readonly declaredBytes: number;
  readonly payload: number[];
}

export function ieee8023(frame: CaptureFrame): Ieee8023Payload {
  const sapAt = frame.rawLinkOffset - STP_LLC_BYTES;
  const llcBytes = frame.raw[sapAt] === STP_SAP && frame.raw[sapAt + 1] === STP_SAP ? STP_LLC_BYTES : SNAP_LLC_BYTES;
  const lengthAt = frame.rawLinkOffset - llcBytes - 2;
  const lengthField = (frame.raw[lengthAt] << 8) | frame.raw[lengthAt + 1];
  return {
    lengthField,
    llcBytes,
    declaredBytes: lengthField - llcBytes,
    payload: Array.from(frame.raw.slice(frame.rawLinkOffset, frame.rawLinkOffset + lengthField - llcBytes)),
  };
}

export function llcDescription(frame: CaptureFrame, payloadLength: number): string {
  const { llcBytes } = ieee8023(frame);
  if (llcBytes === STP_LLC_BYTES) {
    return 'LLC, dsap STP (0x42) Individual, ssap STP (0x42) Command, ctrl 0x03: ';
  }
  const pid = (frame.raw[frame.rawLinkOffset - 2] << 8) | frame.raw[frame.rawLinkOffset - 1];
  const oui = (frame.raw[frame.rawLinkOffset - 5] << 16) | (frame.raw[frame.rawLinkOffset - 4] << 8) | frame.raw[frame.rawLinkOffset - 3];
  const protocol = pid === PID_CDP ? 'CDP' : pid === PID_PVST ? 'PVST' : pid === PID_DTP ? 'DTP' : 'Unknown';
  const owner = oui === OUI_CISCO ? 'Cisco' : 'Unknown';
  return `LLC, dsap SNAP (0x${SNAP_SAP.toString(16)}) Individual, ssap SNAP (0x${SNAP_SAP.toString(16)}) Command, ctrl 0x03: `
    + `oui ${owner} (0x${oui.toString(16).padStart(6, '0')}), pid ${protocol} (0x${pid.toString(16).padStart(4, '0')}), length ${payloadLength}: `;
}
