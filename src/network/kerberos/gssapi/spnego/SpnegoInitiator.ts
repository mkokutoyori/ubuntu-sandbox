import { GssTokenError } from '../GssSecurityContext';
import type { GssContextInitiator, GssStep } from '../GssInitiator';
import { GSS_S_BAD_MECH, GSS_S_DEFECTIVE_TOKEN, GSS_S_FAILURE, gssFailure } from '../GssStatus';
import { GSS_C_INTEG_FLAG, KRB5_MECHANISM_OID } from '../GssToken';
import { NegState, decodeSpnegoToken, encodeMechTypes, encodeNegTokenInit, encodeNegTokenResp, type NegTokenResp } from './SpnegoToken';

type TokenToSend = 'none' | 'initial' | 'continue';
type Failure = Extract<GssStep, { kind: 'error' }>;

const NEGOTIATION_FAILED = 'SPNEGO failed to negotiate a mechanism';
const NO_TOKEN_FROM_ACCEPTOR = 'SPNEGO acceptor did not return a valid token';
const NO_MINOR_CODE = 'Success';

function fail(major: number, minor: string): Failure {
  return { kind: 'error', failure: gssFailure(major, minor) };
}

export class SpnegoInitiator implements GssContextInitiator {
  private readonly mechTypes = [KRB5_MECHANISM_OID];
  private readonly mechTypesDer = encodeMechTypes(this.mechTypes);
  private started = false;
  private negotiationDone = false;
  private mechComplete = false;
  private micRequired = false;
  private micSent = false;
  private micReceived = false;

  constructor(private readonly inner: GssContextInitiator) {}

  get flags(): number {
    return this.inner.flags;
  }

  get clientDisplayName(): string {
    return this.inner.clientDisplayName;
  }

  get securityContext() {
    return this.inner.securityContext;
  }

  private get integrityAvailable(): boolean {
    return this.mechComplete && (this.flags & GSS_C_INTEG_FLAG) !== 0;
  }

  step(input: Uint8Array | null): GssStep {
    let response: NegTokenResp | null = null;
    let tokenToSend: TokenToSend = 'initial';
    if (this.started) {
      const decoded = input === null ? null : decodeSpnegoToken(input);
      if (decoded === null || decoded.kind !== 'resp') return fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
      response = decoded;
      const continued = this.continueNegotiation(decoded);
      if (continued.kind === 'error') return continued;
      tokenToSend = continued.tokenToSend;
    }
    this.started = true;

    let mechTokenOut: Uint8Array | null = null;
    if (!this.mechComplete) {
      const called = this.callMechanism(response, tokenToSend);
      if (called.kind === 'error') return called;
      mechTokenOut = called.output;
      tokenToSend = called.tokenToSend;
    }

    let negState: number = NegState.ACCEPT_INCOMPLETE;
    let micOut: Uint8Array | null = null;
    if (this.integrityAvailable) {
      const handled = this.handleMic(response?.mechListMic ?? null, mechTokenOut !== null && mechTokenOut.length > 0, tokenToSend);
      if (handled.kind === 'error') return handled;
      micOut = handled.micOut;
      negState = handled.negState;
      tokenToSend = handled.tokenToSend;
    }

    if (tokenToSend === 'none') return { kind: 'complete', output: null };
    const output = tokenToSend === 'initial'
      ? encodeNegTokenInit({ mechTypes: this.mechTypes, mechToken: mechTokenOut, mechListMic: micOut })
      : encodeNegTokenResp({ negState, supportedMech: null, responseToken: mechTokenOut, mechListMic: micOut });
    return negState === NegState.ACCEPT_COMPLETE ? { kind: 'complete', output } : { kind: 'continue', output };
  }

  private continueNegotiation(response: NegTokenResp): Failure | { kind: 'ok'; tokenToSend: TokenToSend } {
    if (response.negState === NegState.REJECT && response.responseToken === null) {
      return this.negotiationDone ? fail(GSS_S_FAILURE, NO_MINOR_CODE) : fail(GSS_S_BAD_MECH, NEGOTIATION_FAILED);
    }
    if (!this.negotiationDone) return this.negotiate(response);
    const missingToken = !this.mechComplete && response.responseToken === null;
    const spuriousToken = this.mechComplete && response.responseToken !== null;
    if (missingToken || spuriousToken) return fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
    const undecided = !this.mechComplete || (this.micRequired && this.integrityAvailable);
    return { kind: 'ok', tokenToSend: undecided ? 'continue' : 'none' };
  }

  private negotiate(response: NegTokenResp): Failure | { kind: 'ok'; tokenToSend: TokenToSend } {
    this.negotiationDone = true;
    if ((response.supportedMech ?? KRB5_MECHANISM_OID) !== KRB5_MECHANISM_OID) return fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
    const token = response.responseToken;
    if (token === null) {
      return this.mechComplete ? { kind: 'ok', tokenToSend: 'none' } : fail(GSS_S_DEFECTIVE_TOKEN, NO_TOKEN_FROM_ACCEPTOR);
    }
    if (this.mechComplete) {
      return token.length === 0 ? { kind: 'ok', tokenToSend: 'none' } : fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
    }
    return { kind: 'ok', tokenToSend: 'continue' };
  }

  private callMechanism(response: NegTokenResp | null, tokenToSend: TokenToSend):
    Failure | { kind: 'ok'; output: Uint8Array | null; tokenToSend: TokenToSend } {
    const stepped = this.inner.step(response?.responseToken ?? null);
    if (stepped.kind === 'error') return stepped;
    if (response?.negState === NegState.REJECT) return fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
    if (stepped.kind === 'continue') return { kind: 'ok', output: stepped.output, tokenToSend };
    this.mechComplete = true;
    const emptyOutput = stepped.output === null || stepped.output.length === 0;
    const nothingMoreToSay = tokenToSend === 'continue' && emptyOutput && (!this.micRequired || !this.integrityAvailable);
    return { kind: 'ok', output: stepped.output, tokenToSend: nothingMoreToSay ? 'none' : tokenToSend };
  }

  private handleMic(micIn: Uint8Array | null, sendsMechToken: boolean, tokenToSend: TokenToSend):
    Failure | { kind: 'ok'; micOut: Uint8Array | null; negState: number; tokenToSend: TokenToSend } {
    if (micIn !== null && this.micReceived) return fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
    if (micIn === null && this.micRequired && !sendsMechToken) return fail(GSS_S_DEFECTIVE_TOKEN, NO_MINOR_CODE);
    const context = this.securityContext!;
    if (micIn !== null) {
      try {
        context.verifyMic(this.mechTypesDer, micIn);
      } catch (error) {
        if (!(error instanceof GssTokenError)) throw error;
        return fail(GSS_S_FAILURE, NO_MINOR_CODE);
      }
      this.micRequired = true;
      this.micReceived = true;
    }
    let micOut: Uint8Array | null = null;
    if (this.micRequired && !this.micSent) {
      micOut = context.getMic(this.mechTypesDer);
      this.micSent = true;
    }
    if (this.micSent && this.micReceived) {
      return { kind: 'ok', micOut, negState: NegState.ACCEPT_COMPLETE, tokenToSend: micOut === null ? 'none' : 'continue' };
    }
    return { kind: 'ok', micOut, negState: NegState.ACCEPT_INCOMPLETE, tokenToSend };
  }
}
