import {
  GSS_C_DELEG_FLAG, GSS_C_INTEG_FLAG, GSS_C_CONF_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG,
} from '@/network/kerberos/gssapi/GssToken';
import { GssInitiator } from '@/network/kerberos/gssapi/GssInitiator';
import { GssTokenError, type GssSecurityContext } from '@/network/kerberos/gssapi/GssSecurityContext';
import { describeGssFailure, gssFailureOfTokenError, type GssFailure } from '@/network/kerberos/gssapi/GssStatus';
import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract, type SaslLayerResult,
  type StepOutcome,
} from '../saslTypes';
import { PlugDecodeContext, getUserid, isFatal, makePrompts } from '../pluginUtils';

const LAYER_NONE = 1;
const LAYER_INTEGRITY = 2;
const LAYER_CONFIDENTIALITY = 4;
const K5_MAX_SSF = 256;
const MAX_BUFFER_FIELD = 0xffffff;
const SECURITY_TOKEN_BYTES = 4;

const encoder = new TextEncoder();

function gssError(params: SaslClientParams, failure: GssFailure): StepOutcome {
  params.seterror(`GSSAPI Error: ${describeGssFailure(failure)}`);
  return { rc: SaslRc.FAIL };
}

function bigEndian32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concatenated(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

class GssapiLayer {
  private readonly decoder: PlugDecodeContext;

  constructor(
    private readonly context: GssSecurityContext, private readonly privacy: boolean,
    maxReceive: number, private readonly params: SaslClientParams,
  ) {
    this.decoder = new PlugDecodeContext(maxReceive, () => undefined);
  }

  encode = (data: Uint8Array): SaslLayerResult => {
    const token = this.context.wrap(data, this.privacy);
    return { rc: SaslRc.OK, data: concatenated(bigEndian32(token.length), token) };
  };

  decode = (data: Uint8Array): SaslLayerResult => this.decoder.decode(data, (packet) => this.decodePacket(packet));

  private decodePacket(packet: Uint8Array): SaslLayerResult {
    try {
      return { rc: SaslRc.OK, data: this.context.unwrap(packet).data };
    } catch (error) {
      if (!(error instanceof GssTokenError)) throw error;
      this.params.seterror(`GSSAPI Error: ${describeGssFailure(gssFailureOfTokenError(error))}`);
      return { rc: SaslRc.FAIL, data: new Uint8Array(0) };
    }
  }
}

interface Request {
  readonly flags: number;
  readonly layerFlagsOnlyWhenRequested: boolean;
}

function requestOf(params: SaslClientParams): Request {
  let flags = GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG | GSS_C_INTEG_FLAG;
  let layerFlagsOnlyWhenRequested = false;
  if (params.props.maxSsf > params.externalSsf) {
    if (params.props.maxSsf - params.externalSsf > 1) flags |= GSS_C_CONF_FLAG;
  } else if (params.props.maxSsf <= 1) {
    layerFlagsOnlyWhenRequested = true;
  }
  if ((params.props.securityFlags & SaslSec.PASS_CREDENTIALS) !== 0) flags |= GSS_C_DELEG_FLAG;
  return { flags, layerFlagsOnlyWhenRequested };
}

function offeredLayers(contextFlags: number): number {
  if ((contextFlags & GSS_C_INTEG_FLAG) === 0) return LAYER_NONE;
  if ((contextFlags & GSS_C_CONF_FLAG) === 0) return LAYER_NONE | LAYER_INTEGRITY;
  return LAYER_NONE | LAYER_INTEGRITY | LAYER_CONFIDENTIALITY;
}

function gssapiSession(): ClientMechanismSession {
  let state: 'authneg' | 'ssfcap' | 'authenticated' = 'authneg';
  let user: string | null = null;
  let initiator: GssInitiator | null = null;
  let qop = 0;

  async function authneg(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): Promise<StepOutcome> {
    if (user === null) {
      const got = getUserid(params, prompts);
      if (isFatal(got.rc)) return { rc: got.rc };
      if (got.rc === SaslRc.INTERACT) {
        return { rc: SaslRc.INTERACT, prompts: makePrompts({ userPrompt: 'Please enter your authorization name' }) };
      }
      user = got.value;
    }
    const serverFqdn = params.serverFqdn;
    if (serverFqdn === null || serverFqdn === '') {
      params.seterror('GSSAPI Failure: no serverFQDN');
      return { rc: SaslRc.FAIL };
    }
    const input = serverIn !== null && serverIn.length > 0 ? serverIn : null;
    if (input === null && initiator !== null) initiator = null;

    const request = requestOf(params);
    if ((request.flags & GSS_C_DELEG_FLAG) !== 0) {
      params.seterror('GSSAPI Failure: forwarding the credentials (passcred) is not implemented by this simulator');
      return { rc: SaslRc.FAIL };
    }
    if (initiator === null) {
      if (params.gss === null) {
        params.seterror('GSSAPI Failure: no Kerberos library is available');
        return { rc: SaslRc.FAIL };
      }
      const acquired = await params.gss.acquire(params.service, serverFqdn);
      if (acquired.kind === 'failure') return gssError(params, acquired.failure);
      initiator = new GssInitiator({
        credential: acquired.credential, requestedFlags: request.flags,
        layerFlagsOnlyWhenRequested: request.layerFlagsOnlyWhenRequested, clock: params.gss.clock, random: params.random,
      });
    }

    const stepped = initiator.step(input);
    if (stepped.kind === 'error') return gssError(params, stepped.failure);
    qop = offeredLayers(initiator.flags);
    const out = stepped.output;
    if (stepped.kind === 'continue') return { rc: SaslRc.CONTINUE, out };

    const clientName = initiator.clientDisplayName;
    let result: number;
    if (user !== null && user !== '') {
      result = params.canonUser(user, SASL_CU_AUTHZID);
      if (result === SaslRc.OK) result = params.canonUser(clientName, SASL_CU_AUTHID);
    } else {
      result = params.canonUser(clientName, SASL_CU_AUTHID | SASL_CU_AUTHZID);
    }
    if (result !== SaslRc.OK) return { rc: result };
    state = 'ssfcap';
    return { rc: SaslRc.CONTINUE, out };
  }

  function ssfcap(params: SaslClientParams, serverIn: Uint8Array | null): StepOutcome {
    const context = initiator!.securityContext!;
    let offer: Uint8Array;
    try {
      offer = context.unwrap(serverIn ?? new Uint8Array(0)).data;
    } catch (error) {
      if (!(error instanceof GssTokenError)) throw error;
      return gssError(params, gssFailureOfTokenError(error));
    }
    if (offer.length !== SECURITY_TOKEN_BYTES) {
      params.seterror(offer.length < SECURITY_TOKEN_BYTES ? 'token too short' : 'token too long');
      return { rc: SaslRc.FAIL };
    }
    const props = params.props;
    const external = params.externalSsf;
    const mechSsf = context.sessionStrengthBits;
    if (props.minSsf > mechSsf + external) return { rc: SaslRc.TOOWEAK };
    if (props.minSsf > props.maxSsf) return { rc: SaslRc.BADPARAM };
    const allowed = props.maxSsf >= external ? props.maxSsf - external : 0;
    const need = props.minSsf >= external ? props.minSsf - external : 0;
    const serverHas = offer[0];

    let choice: number;
    let privacy = false;
    if ((qop & LAYER_CONFIDENTIALITY) !== 0 && allowed >= mechSsf && need <= mechSsf && (serverHas & LAYER_CONFIDENTIALITY) !== 0) {
      params.oparams.mechSsf = mechSsf;
      choice = LAYER_CONFIDENTIALITY;
      privacy = true;
    } else if ((qop & LAYER_INTEGRITY) !== 0 && allowed >= 1 && need <= 1 && (serverHas & LAYER_INTEGRITY) !== 0) {
      params.oparams.mechSsf = 1;
      choice = LAYER_INTEGRITY;
    } else if ((qop & LAYER_NONE) !== 0 && need <= 0 && (serverHas & LAYER_NONE) !== 0) {
      params.oparams.mechSsf = 0;
      choice = LAYER_NONE;
    } else {
      return { rc: SaslRc.TOOWEAK };
    }
    params.oparams.maxOutbuf = (offer[1] << 16) | (offer[2] << 8) | offer[3];
    if (params.oparams.mechSsf !== 0) {
      const limit = Math.max(0, params.oparams.maxOutbuf - context.wrapOverhead(true));
      params.oparams.maxOutbuf = limit;
    }

    const authzid = user !== null && user !== '' && params.oparams.user !== null ? encoder.encode(params.oparams.user) : new Uint8Array(0);
    const choiceToken = new Uint8Array(SECURITY_TOKEN_BYTES + authzid.length);
    if (choice > LAYER_NONE) choiceToken.set(bigEndian32(Math.min(props.maxBufsize, MAX_BUFFER_FIELD)).subarray(1), 1);
    choiceToken[0] = choice;
    choiceToken.set(authzid, SECURITY_TOKEN_BYTES);
    const out = context.wrap(choiceToken, false);

    if (choice === LAYER_NONE) {
      params.oparams.encode = null;
      params.oparams.decode = null;
    } else {
      const layer = new GssapiLayer(context, privacy, Math.min(props.maxBufsize, MAX_BUFFER_FIELD), params);
      params.oparams.encode = layer.encode;
      params.oparams.decode = layer.decode;
    }
    state = 'authenticated';
    params.oparams.done = true;
    return { rc: SaslRc.OK, out };
  }

  return {
    step(params, serverIn, prompts) {
      if (state === 'authneg') return authneg(params, serverIn, prompts);
      if (state === 'ssfcap') return ssfcap(params, serverIn);
      return { rc: SaslRc.FAIL };
    },
  };
}

export const gssapiMechanism: ClientMechanism = {
  name: 'GSSAPI',
  maxSsf: K5_MAX_SSF,
  securityFlags: SaslSec.NOPLAINTEXT | SaslSec.NOACTIVE | SaslSec.NOANONYMOUS | SaslSec.MUTUAL_AUTH | SaslSec.PASS_CREDENTIALS,
  features: SaslFeat.NEEDSERVERFQDN | SaslFeat.WANT_CLIENT_FIRST | SaslFeat.ALLOWS_PROXY | SaslFeat.CHANNEL_BINDING,
  requiredPrompts: [],
  create: () => gssapiSession(),
};
