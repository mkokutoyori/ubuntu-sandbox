import { SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec, type ClientMechanism, type SaslClientParams, type SaslInteract, type StepOutcome } from '../saslTypes';
import { getUserid, isFatal, makePrompts } from '../pluginUtils';

const encoder = new TextEncoder();

export const externalMechanism: ClientMechanism = {
  name: 'EXTERNAL',
  maxSsf: 0,
  securityFlags: SaslSec.NOANONYMOUS | SaslSec.NOPLAINTEXT | SaslSec.NODICTIONARY,
  features: SaslFeat.WANT_CLIENT_FIRST | SaslFeat.ALLOWS_PROXY,
  requiredPrompts: [],
  create(params: SaslClientParams) {
    if (params.externalAuthId === null) return SaslRc.NOMECH;
    return {
      step(stepParams: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome {
        const externalAuthId = stepParams.externalAuthId;
        if (externalAuthId === null) return { rc: SaslRc.BADPROT };
        if (serverIn !== null && serverIn.length !== 0) return { rc: SaslRc.BADPROT };
        const got = getUserid(stepParams, prompts);
        if (isFatal(got.rc)) return { rc: got.rc };
        if (got.rc === SaslRc.INTERACT) {
          return {
            rc: SaslRc.INTERACT,
            prompts: makePrompts({ userPrompt: 'Please enter your authorization name', userDefault: '' }),
          };
        }
        const user = got.value;
        let out: Uint8Array;
        if (user !== null && user !== '') {
          let result = stepParams.canonUser(user, SASL_CU_AUTHZID);
          if (result !== SaslRc.OK) return { rc: result };
          result = stepParams.canonUser(externalAuthId, SASL_CU_AUTHID);
          if (result !== SaslRc.OK) return { rc: result };
          out = encoder.encode(user);
        } else {
          const result = stepParams.canonUser(externalAuthId, SASL_CU_AUTHID | SASL_CU_AUTHZID);
          if (result !== SaslRc.OK) return { rc: result };
          out = new Uint8Array(0);
        }
        stepParams.oparams.done = true;
        stepParams.oparams.mechSsf = 0;
        stepParams.oparams.maxOutbuf = 0;
        stepParams.oparams.encode = null;
        stepParams.oparams.decode = null;
        return { rc: SaslRc.OK, out };
      },
    };
  },
};
