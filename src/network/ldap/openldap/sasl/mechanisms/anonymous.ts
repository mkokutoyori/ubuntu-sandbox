import { SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec, type ClientMechanism, type SaslClientParams, type SaslInteract, type StepOutcome } from '../saslTypes';
import { getUserid, isFatal, makePrompts } from '../pluginUtils';

const ANONYMOUS_ID = 'anonymous';
const encoder = new TextEncoder();

export const anonymousMechanism: ClientMechanism = {
  name: 'ANONYMOUS',
  maxSsf: 0,
  securityFlags: SaslSec.NOPLAINTEXT,
  features: SaslFeat.WANT_CLIENT_FIRST,
  requiredPrompts: [],
  create() {
    return {
      step(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome {
        if (serverIn !== null && serverIn.length !== 0) {
          params.seterror('Nonzero serverinlen in ANONYMOUS continue_step');
          return { rc: SaslRc.BADPROT };
        }
        if (params.props.minSsf > params.externalSsf) {
          params.seterror('SSF requested of ANONYMOUS plugin');
          return { rc: SaslRc.TOOWEAK };
        }
        const got = getUserid(params, prompts);
        if (isFatal(got.rc)) return { rc: got.rc };
        if (got.rc === SaslRc.INTERACT) {
          return {
            rc: SaslRc.INTERACT,
            prompts: makePrompts({ userPrompt: 'Please enter anonymous identification', userDefault: '' }),
          };
        }
        const user = got.value === null || got.value === '' ? ANONYMOUS_ID : got.value;
        const result = params.canonUser(ANONYMOUS_ID, SASL_CU_AUTHID | SASL_CU_AUTHZID);
        if (result !== SaslRc.OK) return { rc: result };
        params.oparams.done = true;
        params.oparams.mechSsf = 0;
        params.oparams.maxOutbuf = 0;
        params.oparams.encode = null;
        params.oparams.decode = null;
        return { rc: SaslRc.OK, out: encoder.encode(`${user}@${params.hostname}`) };
      },
    };
  },
};
