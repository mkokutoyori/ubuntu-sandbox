import { GssInitiator } from '@/network/kerberos/gssapi/GssInitiator';
import { GSS_S_NO_CRED, describeGssFailure, type GssFailure } from '@/network/kerberos/gssapi/GssStatus';
import { GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG, decapsulateInitialContextToken } from '@/network/kerberos/gssapi/GssToken';
import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract, type StepOutcome,
} from '../saslTypes';
import { getAuthid, getUserid, isFatal, makePrompts } from '../pluginUtils';

const MAXIMUM_OUTPUT_BUFFER = 0xffffff;
const encoder = new TextEncoder();

function escapeAuthzid(authzid: string): string {
  return authzid.replace(/=/g, '=3D').replace(/,/g, '=2C');
}

function gs2Error(params: SaslClientParams, failure: GssFailure): StepOutcome {
  params.seterror(`GS2 Error: ${describeGssFailure(failure)}`);
  return { rc: SaslRc.FAIL };
}

function header(params: SaslClientParams, authzid: string | null): Uint8Array {
  const flag = params.channelBindingDisposition === 'used'
    ? `p=${params.channelBindingName}`
    : params.channelBindingDisposition === 'want' ? 'y' : 'n';
  return encoder.encode(`${flag},${authzid === null ? '' : `a=${escapeAuthzid(authzid)}`},`);
}

function concatenated(first: Uint8Array, second: Uint8Array | null): Uint8Array {
  if (second === null) return first;
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

function gs2Session(): ClientMechanismSession {
  let initiator: GssInitiator | null = null;
  let clientName: string | null = null;
  let holdsCredentials = false;
  let password: Uint8Array | null = null;
  let bindings: Uint8Array | null = null;

  async function initialCredentials(params: SaslClientParams, prompts: SaslInteract[] | null): Promise<StepOutcome | null> {
    let authid: string | null = null;
    let userid: string | null = null;
    let authResult: number = SaslRc.OK;
    let userResult: number = SaslRc.OK;
    let passResult: number = SaslRc.OK;
    let result: number = SaslRc.OK;
    let failure: GssFailure | null = null;

    if (params.oparams.authid === null) {
      const got = getAuthid(params, prompts);
      authResult = got.rc;
      authid = got.value;
      if (isFatal(authResult)) return { rc: authResult };
    }
    if (params.oparams.user === null) {
      const got = getUserid(params, prompts);
      userResult = got.rc;
      userid = got.value;
      if (isFatal(userResult)) return { rc: userResult };
    }

    if (authResult === SaslRc.OK && userResult === SaslRc.OK && params.oparams.authid === null) {
      if (userid === null || userid === '') {
        result = params.canonUser(authid ?? '', SASL_CU_AUTHID | SASL_CU_AUTHZID);
      } else {
        result = params.canonUser(authid ?? '', SASL_CU_AUTHID);
        if (result !== SaslRc.OK) return { rc: result };
        result = params.canonUser(userid, SASL_CU_AUTHZID);
        if (result !== SaslRc.OK) return { rc: result };
      }
      if (params.oparams.authid !== null) clientName = params.oparams.authid;
    }

    if (!holdsCredentials && params.oparams.authid === null && params.gss !== null) {
      const acquired = await params.gss.acquireCredentials(null);
      if (acquired.kind === 'failure') return gs2Error(params, acquired.failure);
      holdsCredentials = true;
      clientName = acquired.name;
      if (userid === null || userid === '') {
        result = params.canonUser(acquired.name, SASL_CU_AUTHID | SASL_CU_AUTHZID);
      } else {
        result = params.canonUser(acquired.name, SASL_CU_AUTHID);
        if (result !== SaslRc.OK) return { rc: result };
        result = params.canonUser(acquired.name, SASL_CU_AUTHZID);
        if (result !== SaslRc.OK) return { rc: result };
      }
    }

    if (!holdsCredentials && clientName !== null && params.gss !== null) {
      const acquired = await params.gss.acquireCredentials(clientName);
      if (acquired.kind === 'credentials') holdsCredentials = true;
      else if (acquired.failure.major !== GSS_S_NO_CRED) failure = acquired.failure;
    }

    if (failure === null && !holdsCredentials) {
      if (password === null) {
        const got = params.getPassword(prompts);
        passResult = got.rc;
        password = got.value;
        if (isFatal(passResult)) return { rc: passResult };
      }
      if (password !== null) {
        failure = { major: GSS_S_NO_CRED, minor: 'Password authentication is not available in this simulator' };
      }
    }

    if (failure !== null) return gs2Error(params, failure);
    if (userResult === SaslRc.INTERACT || authResult === SaslRc.INTERACT || passResult === SaslRc.INTERACT) {
      return {
        rc: SaslRc.INTERACT,
        prompts: makePrompts({
          userPrompt: userResult === SaslRc.INTERACT ? 'Please enter your authorization name' : undefined,
          authPrompt: authResult === SaslRc.INTERACT ? 'Please enter your authentication name' : undefined,
          passPrompt: passResult === SaslRc.INTERACT ? 'Please enter your password' : undefined,
        }),
      };
    }
    return result === SaslRc.OK ? null : { rc: result };
  }

  async function authenticate(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): Promise<StepOutcome> {
    const first = initiator === null;
    if (first) {
      const prepared = await initialCredentials(params, prompts);
      if (prepared !== null) return prepared;
      const serverFqdn = params.serverFqdn;
      if (serverFqdn === null || serverFqdn === '') {
        params.seterror('GS2 Failure: no serverFQDN');
        return { rc: SaslRc.FAIL };
      }
      if (params.gss === null) {
        params.seterror('GS2 Failure: no Kerberos library is available');
        return { rc: SaslRc.FAIL };
      }
      const acquired = await params.gss.acquire(params.service, serverFqdn);
      if (acquired.kind === 'failure') return gs2Error(params, acquired.failure);
      const authzid = params.oparams.user !== params.oparams.authid ? params.oparams.user : null;
      const flagsHeader = header(params, authzid);
      bindings = params.channelBindingDisposition === 'used' && params.channelBinding !== null
        ? concatenated(flagsHeader, params.channelBinding)
        : flagsHeader;
      initiator = new GssInitiator({
        credential: acquired.credential, requestedFlags: GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG,
        channelBindings: bindings, clock: params.gss.clock, random: params.random,
      });
      const stepped = initiator.step(null);
      if (stepped.kind === 'error') return gs2Error(params, stepped.failure);
      const token = decapsulateInitialContextToken(stepped.output);
      if (token === null) return { rc: SaslRc.FAIL };
      return { rc: SaslRc.CONTINUE, out: concatenated(flagsHeader, token) };
    }
    const stepped = initiator!.step(serverIn !== null && serverIn.length > 0 ? serverIn : null);
    if (stepped.kind === 'error') return gs2Error(params, stepped.failure);
    if (stepped.kind === 'continue') return { rc: SaslRc.CONTINUE, out: stepped.output };
    params.oparams.encode = null;
    params.oparams.decode = null;
    params.oparams.mechSsf = 0;
    params.oparams.maxOutbuf = MAXIMUM_OUTPUT_BUFFER;
    params.oparams.done = true;
    return { rc: SaslRc.OK, out: stepped.output };
  }

  return { step: authenticate };
}

export const gs2Krb5Mechanism: ClientMechanism = {
  name: 'GS2-KRB5',
  maxSsf: 0,
  securityFlags: SaslSec.NOPLAINTEXT | SaslSec.NOACTIVE | SaslSec.NOANONYMOUS | SaslSec.MUTUAL_AUTH | SaslSec.PASS_CREDENTIALS,
  features: SaslFeat.WANT_CLIENT_FIRST | SaslFeat.CHANNEL_BINDING | SaslFeat.GSS_FRAMING | SaslFeat.NEEDSERVERFQDN,
  requiredPrompts: null,
  create: () => gs2Session(),
};
