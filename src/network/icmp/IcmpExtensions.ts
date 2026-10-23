export const ICMP_EXTENSION_CLASS_MPLS_LABEL_STACK = 1;
export const ICMP_EXTENSION_CTYPE_INCOMING_LABEL_STACK = 1;

export interface IcmpMplsStackEntry {
  readonly label: number;
  readonly trafficClass: number;
  readonly bottom: boolean;
  readonly ttl: number;
}

export interface IcmpMplsLabelStackObject {
  readonly classNum: typeof ICMP_EXTENSION_CLASS_MPLS_LABEL_STACK;
  readonly cType: typeof ICMP_EXTENSION_CTYPE_INCOMING_LABEL_STACK;
  readonly stack: readonly IcmpMplsStackEntry[];
}

export type IcmpExtensionObject = IcmpMplsLabelStackObject;

export function mplsLabelStackObject(
  stack: ReadonlyArray<{ readonly label: { readonly value: number }; readonly trafficClass: number; readonly bottom: boolean; readonly ttl: number }>,
): IcmpMplsLabelStackObject {
  return {
    classNum: ICMP_EXTENSION_CLASS_MPLS_LABEL_STACK,
    cType: ICMP_EXTENSION_CTYPE_INCOMING_LABEL_STACK,
    stack: stack.map(entry => ({
      label: entry.label.value, trafficClass: entry.trafficClass, bottom: entry.bottom, ttl: entry.ttl,
    })),
  };
}

export function formatMplsLabelStack(object: IcmpMplsLabelStackObject): string {
  return object.stack
    .map(entry => `<MPLS:L=${entry.label},E=${entry.trafficClass},S=${entry.bottom ? 1 : 0},T=${entry.ttl}>`)
    .join(' ');
}
