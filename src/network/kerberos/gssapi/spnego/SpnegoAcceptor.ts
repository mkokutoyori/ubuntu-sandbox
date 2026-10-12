import { GssAcceptor, type GssAcceptorOptions, type GssAcceptStep } from '../GssAcceptor';
import { GssTokenError, type GssSecurityContext } from '../GssSecurityContext';
import { GSS_C_INTEG_FLAG, KRB5_MECHANISM_OID } from '../GssToken';
import { KrbErrorCode } from '../../types';
import { NegState, decodeSpnegoToken, encodeNegTokenResp } from './SpnegoToken';

const MICROSOFT_KRB5_MECHANISM_OID = '1.2.840.48018.1.2.2';
const KERBEROS_MECHANISMS: readonly string[] = [KRB5_MECHANISM_OID, MICROSOFT_KRB5_MECHANISM_OID];

function refused(message: string): GssAcceptStep {
  return { kind: 'error', errorCode: KrbErrorCode.KRB_AP_ERR_BAD_INTEGRITY, message };
}

export class SpnegoAcceptor {
  private readonly kerberos: GssAcceptor;

  constructor(options: GssAcceptorOptions) {
    this.kerberos = new GssAcceptor(options);
  }

  get securityContext(): GssSecurityContext | null {
    return this.kerberos.securityContext;
  }

  step(input: Uint8Array): GssAcceptStep {
    const token = decodeSpnegoToken(input);
    if (token === null || token.kind !== 'init') return refused('the token is not a SPNEGO NegTokenInit');
    const preferred = token.mechTypes[0];
    if (preferred === undefined || !KERBEROS_MECHANISMS.includes(preferred)) {
      return refused('the preferred mechanism of the initiator is not Kerberos');
    }
    if (token.mechToken === null) return refused('the NegTokenInit carries no optimistic mechanism token');
    const accepted = this.kerberos.step(token.mechToken);
    if (accepted.kind === 'error') return accepted;

    let mechListMic: Uint8Array | null = null;
    if (token.mechListMic !== null) {
      const context = this.securityContext!;
      if ((accepted.flags & GSS_C_INTEG_FLAG) === 0) return refused('a mechListMIC arrived on a context without integrity');
      try {
        context.verifyMic(token.mechTypesDer, token.mechListMic);
      } catch (error) {
        if (!(error instanceof GssTokenError)) throw error;
        return refused('the mechListMIC of the initiator does not verify');
      }
      mechListMic = context.getMic(token.mechTypesDer);
    }
    const output = encodeNegTokenResp({
      negState: NegState.ACCEPT_COMPLETE, supportedMech: preferred, responseToken: accepted.output, mechListMic,
    });
    return { ...accepted, output };
  }
}
