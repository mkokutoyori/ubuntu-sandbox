/**
 * NetworkPdu — the single central contract every protocol data unit in the
 * simulator implements.
 *
 * Historically each layer/protocol declared its own packet/frame/message shape
 * with an ad-hoc `type` discriminator and no shared ancestor. This is the
 * common base they all extend, so "a packet" has one representation across the
 * codebase (DRY) and generic tooling — capture, logging, serialization — can
 * handle any PDU through one contract.
 *
 * The `type` field is the discriminator (e.g. `'ipv4'`, `'arp'`, `'ospf'`,
 * `'radius'`). Concrete PDUs narrow it to a string literal.
 */
export interface NetworkPdu {
  /** Discriminator identifying the concrete PDU kind. */
  type: string;
}
