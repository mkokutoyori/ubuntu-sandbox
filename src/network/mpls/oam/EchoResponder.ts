import type { IPAddress } from '@/network/core/types';
import type { IlmEntry } from '../Lfib';
import { MplsLabel } from '../MplsLabel';
import {
  DDMAP_ALL_ROUTERS, DDMAP_UNKNOWN_DOWNSTREAM, DdmapAddressType, GlobalFlag, ReturnCode,
  type Ddmap, type EchoMessage, type ErroredTlv, type InterfaceAndLabelStack, type TargetFec,
} from './EchoCodec';

export interface FecMapping {
  readonly present: boolean;
  readonly label: number | null;
  readonly protocolOnInterface: boolean;
}

export interface DownstreamPath {
  readonly nextHop: IPAddress;
  readonly mtu: number;
  readonly labels: readonly number[];
  readonly protocol: number;
}

export interface EchoResponderHost {
  ilm(label: MplsLabel): IlmEntry | undefined;
  downstream(entry: IlmEntry, received: readonly number[]): DownstreamPath | null;
  mplsEnabled(iface: string): boolean;
  fecMapping(fec: TargetFec, receivedOn: string): FecMapping;
}

export interface EchoReceipt {
  readonly interfaceName: string;
  readonly routerAddress: IPAddress;
  readonly interfaceAddress: IPAddress;
  readonly labels: readonly number[];
  readonly topTtl: number | null;
}

export type EchoVerdict =
  | { readonly reply: false }
  | {
    readonly reply: true;
    readonly returnCode: number;
    readonly returnSubcode: number;
    readonly interfaceAndLabelStack: InterfaceAndLabelStack | null;
    readonly ddmaps: readonly Ddmap[];
    readonly erroredTlvs: readonly ErroredTlv[];
  };

const FEC_OK = 0;
const FEC_FAILED = 1;
const FEC_IMPLICIT_NULL = 2;
const IMPLICIT_NULL = MplsLabel.IMPLICIT_NULL.value;

function answer(returnCode: number, returnSubcode: number, extra: Partial<Extract<EchoVerdict, { reply: true }>> = {}): EchoVerdict {
  return { reply: true, returnCode, returnSubcode, interfaceAndLabelStack: null, ddmaps: [], erroredTlvs: [], ...extra };
}

function isPopAndContinue(label: MplsLabel, entry: IlmEntry | undefined): boolean {
  if (label.isExplicitNull() || label.equals(MplsLabel.ROUTER_ALERT)) return true;
  return entry !== undefined && (entry.kind === 'vrf' || entry.kind === 'pw' || entry.kind === 'tp-lsp' || (entry.kind === 'pop' && entry.iface === null));
}

function validateFec(
  fec: TargetFec, label: number, receivedOn: string, host: EchoResponderHost,
): { status: number; code: number } {
  if (fec.kind === 'nil') {
    const reserved = label === MplsLabel.IPV4_EXPLICIT_NULL.value || label === MplsLabel.ROUTER_ALERT.value;
    return reserved ? { status: FEC_OK, code: ReturnCode.None } : { status: FEC_FAILED, code: ReturnCode.MappingIsNotTheLabel };
  }
  const mapping = host.fecMapping(fec, receivedOn);
  if (!mapping.present) return { status: FEC_FAILED, code: ReturnCode.NoMapping };
  const implicit = mapping.label === IMPLICIT_NULL;
  if (!implicit && mapping.label !== label) return { status: FEC_FAILED, code: ReturnCode.MappingIsNotTheLabel };
  if (!mapping.protocolOnInterface) return { status: FEC_FAILED, code: ReturnCode.ProtocolNotAssociated };
  return { status: implicit ? FEC_IMPLICIT_NULL : FEC_OK, code: ReturnCode.None };
}

function receivedStack(receipt: EchoReceipt): InterfaceAndLabelStack {
  return { address: receipt.routerAddress, interfaceAddress: receipt.interfaceAddress, labels: receipt.labels };
}

const IMPLICIT_NULL_LABELS = (labels: readonly number[]) => labels.filter(label => label !== IMPLICIT_NULL);

function bypassesVerification(ddmap: Ddmap): boolean {
  const address = ddmap.downstreamAddress.toString();
  return address === DDMAP_UNKNOWN_DOWNSTREAM || address === DDMAP_ALL_ROUTERS;
}

function matchesReceipt(ddmap: Ddmap, receipt: EchoReceipt): boolean {
  if (ddmap.addressType !== DdmapAddressType.Ipv4Numbered) return false;
  const address = ddmap.downstreamAddress;
  if (!address.equals(receipt.routerAddress) && !address.equals(receipt.interfaceAddress)) return false;
  if (!ddmap.downstreamInterface.equals(receipt.interfaceAddress)) return false;
  const expected = IMPLICIT_NULL_LABELS(ddmap.labelStack.map(entry => entry.label));
  return expected.length === receipt.labels.length && expected.every((label, index) => label === receipt.labels[index]);
}

function downstreamMapping(path: DownstreamPath): Ddmap {
  return {
    mtu: path.mtu, addressType: DdmapAddressType.Ipv4Numbered, interfaceAndLabelStackRequested: false, nonIp: false,
    downstreamAddress: path.nextHop, downstreamInterface: path.nextHop, returnCode: ReturnCode.None, returnSubcode: 0,
    multipathType: 0, multipathInformation: new Uint8Array(0),
    labelStack: path.labels.map(label => ({ label, protocol: path.protocol })), fecStackChanges: [],
  };
}

export function evaluateEchoRequest(request: EchoMessage, receipt: EchoReceipt, host: EchoResponderHost): EchoVerdict {
  if (request.unrecognisedMandatory.length > 0) {
    return answer(ReturnCode.TlvNotUnderstood, 0, { erroredTlvs: request.unrecognisedMandatory });
  }
  if (request.targetFecs.length === 0) return answer(ReturnCode.Malformed, 0);
  if ((request.globalFlags & GlobalFlag.RespondOnlyIfTtlExpired) !== 0 && receipt.topTtl !== null && receipt.topTtl > 1) {
    return { reply: false };
  }

  const ddmap = request.ddmaps[0];
  const stack = receipt.labels;
  const popped: number[] = [];
  for (let depth = stack.length; depth > 0; depth--) {
    const label = MplsLabel.of(stack[stack.length - depth]);
    const entry = host.ilm(label);
    if (isPopAndContinue(label, entry)) {
      popped.push(label.value);
      continue;
    }
    if (entry === undefined) return answer(ReturnCode.NoLabelEntry, depth);
    if (entry.kind !== 'vrf' && entry.kind !== 'pw' && entry.kind !== 'tp-lsp' && entry.iface !== null && !host.mplsEnabled(entry.iface)) {
      return answer(ReturnCode.SwitchedNoMplsForwarding, depth);
    }
    if (ddmap === undefined) return answer(ReturnCode.Switched, depth);
    let code: number = ReturnCode.Switched;
    let report: InterfaceAndLabelStack | null = ddmap.interfaceAndLabelStackRequested ? receivedStack(receipt) : null;
    if (ddmap.downstreamAddress.toString() === DDMAP_UNKNOWN_DOWNSTREAM) {
      code = ReturnCode.UpstreamInterfaceUnknown;
      report = receivedStack(receipt);
    } else if (!bypassesVerification(ddmap) && !matchesReceipt(ddmap, receipt)) {
      return answer(ReturnCode.DownstreamMismatch, depth, { interfaceAndLabelStack: receivedStack(receipt) });
    }
    const path = host.downstream(entry, stack.slice(stack.length - depth));
    return answer(code, depth, { interfaceAndLabelStack: report, ddmaps: path === null ? [] : [downstreamMapping(path)] });
  }

  if (ddmap !== undefined && !bypassesVerification(ddmap) && !matchesReceipt(ddmap, receipt)) {
    return answer(ReturnCode.DownstreamMismatch, 1, { interfaceAndLabelStack: receivedStack(receipt) });
  }
  const labels = popped.length > 0 ? popped : [IMPLICIT_NULL];
  const fecs = request.targetFecs;
  if (fecs[0].kind === 'nil') return answer(ReturnCode.Egress, 1);

  let labelIndex = 0;
  let validated = 1;
  for (let index = 0; index < fecs.length; index++) {
    validated = index + 1;
    const outcome = validateFec(fecs[index], labels[labelIndex], receipt.interfaceName, host);
    if (outcome.status === FEC_FAILED) {
      return answer(outcome.code, validated, { interfaceAndLabelStack: receivedStack(receipt) });
    }
    if (outcome.status === FEC_OK) {
      labelIndex++;
      if (labelIndex >= labels.length) break;
    }
  }
  return answer(ReturnCode.Egress, validated, {
    interfaceAndLabelStack: ddmap?.interfaceAndLabelStackRequested === true ? receivedStack(receipt) : null,
  });
}
