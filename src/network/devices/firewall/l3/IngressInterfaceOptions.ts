export interface IngressInterfaceOptions {
  readonly srcCheck: boolean;
  readonly dropFragment: boolean;
  readonly dropOverlappedFragment: boolean;
}

export const INGRESS_INTERFACE_DEFAULTS: IngressInterfaceOptions = Object.freeze({
  srcCheck: false,
  dropFragment: false,
  dropOverlappedFragment: false,
});

export type IngressInterfaceOptionsReader =
  (iface: string) => IngressInterfaceOptions;
