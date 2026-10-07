import {
  GSS_C_DELEG_FLAG, GSS_C_INTEG_FLAG, GSS_C_CONF_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG,
} from '@/network/kerberos/gssapi/GssToken';
import { GssInitiator } from '@/network/kerberos/gssapi/GssInitiator';
import { GssTokenError } from '@/network/kerberos/gssapi/GssSecurityContext';
import { describeGssFailure, gssFailureOfTokenError, type GssFailure } from '@/network/kerberos/gssapi/GssStatus';
import { GssSaslLayer } from '../../../gssapi/GssSaslLayer';
import { LAYER_CONFIDENTIALITY, LAYER_NONE, MAX_BUFFER_FIELD, chooseClientLayer } from '../../../gssapi/Rfc4752';
import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract, type StepOutcome,
} from '../saslTypes';
import { getUserid, isFatal, makePrompts } from '../pluginUtils';

const K5_MAX_SSF = 256;

function gssError(params: SaslClientParams, failure: GssFailure): StepOutcome {
  params.seterror(`GSSAPI Error: ${describeGssFailure(failure)}`);
  return { rc: SaslRc.FAIL };
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

function gssapiSession(): ClientMechanismSession {
  let state: 'authneg' | 'ssfcap' | 'authenticated' = 'authneg';
  let user: string | null = null;
  let initiator: GssInitiator | null = null;

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
    const props = params.props;
    const authzid = user !== null && user !== '' && params.oparams.user !== null ? params.oparams.user : '';
    const chosen = chooseClientLayer(context, initiator!.flags, offer, {
      minSsf: props.minSsf, maxSsf: props.maxSsf, externalSsf: params.externalSsf, maxBufferSize: props.maxBufsize,
    }, authzid);
    if (chosen.kind === 'malformed') {
      params.seterror(chosen.message);
      return { rc: SaslRc.FAIL };
    }
    if (chosen.kind === 'too-weak') return { rc: SaslRc.TOOWEAK };
    if (chosen.kind === 'bad-param') return { rc: SaslRc.BADPARAM };

    params.oparams.mechSsf = chosen.mechSsf;
    params.oparams.maxOutbuf = chosen.maxOutbuf;
    const out = context.wrap(chosen.choiceToken, false);
    if (chosen.layer === LAYER_NONE) {
      params.oparams.encode = null;
      params.oparams.decode = null;
    } else {
      const layer = new GssSaslLayer(
        context, chosen.layer === LAYER_CONFIDENTIALITY, Math.min(props.maxBufsize, MAX_BUFFER_FIELD),
        (failure) => params.seterror(`GSSAPI Error: ${describeGssFailure(failure)}`),
      );
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
