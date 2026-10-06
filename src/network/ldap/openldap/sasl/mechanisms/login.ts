import { SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec, type ClientMechanism, type SaslClientParams, type SaslInteract, type StepOutcome } from '../saslTypes';
import { getAuthid, isFatal, makePrompts } from '../pluginUtils';

const encoder = new TextEncoder();

export const loginMechanism: ClientMechanism = {
  name: 'LOGIN',
  maxSsf: 0,
  securityFlags: SaslSec.NOANONYMOUS | SaslSec.PASS_CREDENTIALS,
  features: SaslFeat.SERVER_FIRST,
  requiredPrompts: null,
  create() {
    let state = 1;
    let password: Uint8Array | null = null;
    return {
      step(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome {
        if (state === 1) {
          if (params.props.minSsf > params.externalSsf) {
            params.seterror('SSF requested of LOGIN plugin');
            return { rc: SaslRc.TOOWEAK };
          }
          if (serverIn === null) {
            params.seterror("Server didn't issue challenge for USERNAME");
            return { rc: SaslRc.BADPROT };
          }
          let authResult: number = SaslRc.OK;
          let user: string | null = null;
          if (params.oparams.user === null) {
            const got = getAuthid(params, prompts);
            authResult = got.rc;
            user = got.value;
            if (isFatal(authResult)) return { rc: authResult };
          }
          if (authResult === SaslRc.INTERACT) {
            return { rc: SaslRc.INTERACT, prompts: makePrompts({ authPrompt: 'Please enter your authentication name' }) };
          }
          const result = params.canonUser(user ?? '', SASL_CU_AUTHID | SASL_CU_AUTHZID);
          if (result !== SaslRc.OK) return { rc: result };
          state = 2;
          return { rc: SaslRc.CONTINUE, out: encoder.encode(params.oparams.authid ?? '') };
        }
        if (state === 2) {
          if (serverIn === null) {
            params.seterror("Server didn't issue challenge for PASSWORD");
            return { rc: SaslRc.BADPROT };
          }
          let passResult: number = SaslRc.OK;
          if (password === null) {
            const got = params.getPassword(prompts);
            passResult = got.rc;
            password = got.value;
            if (isFatal(passResult)) return { rc: passResult };
          }
          if (passResult === SaslRc.INTERACT) {
            return { rc: SaslRc.INTERACT, prompts: makePrompts({ passPrompt: 'Please enter your password' }) };
          }
          if (password === null) {
            params.seterror('Parameter error in login.c');
            return { rc: SaslRc.BADPARAM };
          }
          params.oparams.done = true;
          params.oparams.mechSsf = 0;
          params.oparams.maxOutbuf = 0;
          params.oparams.encode = null;
          params.oparams.decode = null;
          return { rc: SaslRc.OK, out: password };
        }
        return { rc: SaslRc.FAIL };
      },
    };
  },
};
