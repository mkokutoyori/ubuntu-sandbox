import { GssTokenError, type GssSecurityContext } from '@/network/kerberos/gssapi/GssSecurityContext';
import { gssFailureOfTokenError, type GssFailure } from '@/network/kerberos/gssapi/GssStatus';
import { SaslRc, type SaslLayerResult } from '../openldap/sasl/saslTypes';
import { PlugDecodeContext } from '../openldap/sasl/pluginUtils';

const LENGTH_PREFIX_BYTES = 4;

function bigEndian32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export class GssSaslLayer {
  private readonly decoder: PlugDecodeContext;

  constructor(
    private readonly context: GssSecurityContext, private readonly privacy: boolean, maxReceive: number,
    private readonly onFailure: (failure: GssFailure) => void,
  ) {
    this.decoder = new PlugDecodeContext(maxReceive, () => undefined);
  }

  encode = (data: Uint8Array): SaslLayerResult => {
    const token = this.context.wrap(data, this.privacy);
    const framed = new Uint8Array(LENGTH_PREFIX_BYTES + token.length);
    framed.set(bigEndian32(token.length), 0);
    framed.set(token, LENGTH_PREFIX_BYTES);
    return { rc: SaslRc.OK, data: framed };
  };

  decode = (data: Uint8Array): SaslLayerResult => this.decoder.decode(data, (packet) => this.decodePacket(packet));

  private decodePacket(packet: Uint8Array): SaslLayerResult {
    try {
      return { rc: SaslRc.OK, data: this.context.unwrap(packet).data };
    } catch (error) {
      if (!(error instanceof GssTokenError)) throw error;
      this.onFailure(gssFailureOfTokenError(error));
      return { rc: SaslRc.FAIL, data: new Uint8Array(0) };
    }
  }
}
