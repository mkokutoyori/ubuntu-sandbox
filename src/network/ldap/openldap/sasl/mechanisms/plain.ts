import { SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec, type ClientMechanism, type SaslClientParams, type SaslInteract, type StepOutcome } from '../saslTypes';
import { getAuthid, getUserid, isFatal, makePrompts } from '../pluginUtils';

const encoder = new TextEncoder();

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

export const plainMechanism: ClientMechanism = {
  name: 'PLAIN',
  maxSsf: 0,
  securityFlags: SaslSec.NOANONYMOUS | SaslSec.PASS_CREDENTIALS,
  features: SaslFeat.WANT_CLIENT_FIRST | SaslFeat.ALLOWS_PROXY,
  requiredPrompts: null,
  create() {
    return {
      step(params: SaslClientParams, _serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome {
        if (params.props.minSsf > params.externalSsf) {
          params.seterror('SSF requested of PLAIN plugin');
          return { rc: SaslRc.TOOWEAK };
        }
        let userResult: number = SaslRc.OK;
        let authResult: number = SaslRc.OK;
        let passResult: number = SaslRc.OK;
        let authid: string | null = null;
        let user: string | null = null;
        let password: Uint8Array | null = null;
        if (params.oparams.authid === null) {
          const got = getAuthid(params, prompts);
          authResult = got.rc;
          authid = got.value;
          if (isFatal(authResult)) return { rc: authResult };
        }
        if (params.oparams.user === null) {
          const got = getUserid(params, prompts);
          userResult = got.rc;
          user = got.value;
          if (isFatal(userResult)) return { rc: userResult };
        }
        const gotPassword = params.getPassword(prompts);
        passResult = gotPassword.rc;
        password = gotPassword.value;
        if (isFatal(passResult)) return { rc: passResult };
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
        if (password === null) {
          params.seterror('Parameter error in plain.c');
          return { rc: SaslRc.BADPARAM };
        }
        let result: number;
        if (user === null || user === '') {
          result = params.canonUser(authid ?? '', SASL_CU_AUTHID | SASL_CU_AUTHZID);
        } else {
          result = params.canonUser(user, SASL_CU_AUTHZID);
          if (result !== SaslRc.OK) return { rc: result };
          result = params.canonUser(authid ?? '', SASL_CU_AUTHID);
        }
        if (result !== SaslRc.OK) return { rc: result };
        const zero = new Uint8Array([0]);
        const out = concatBytes([
          user !== null && user !== '' ? encoder.encode(params.oparams.user ?? '') : new Uint8Array(0),
          zero,
          encoder.encode(params.oparams.authid ?? ''),
          zero,
          password,
        ]);
        params.oparams.done = true;
        params.oparams.mechSsf = 0;
        params.oparams.maxOutbuf = 0;
        params.oparams.encode = null;
        params.oparams.decode = null;
        return { rc: SaslRc.OK, out };
      },
    };
  },
};
