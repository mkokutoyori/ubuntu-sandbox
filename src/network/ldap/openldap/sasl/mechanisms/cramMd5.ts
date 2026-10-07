import { hmac } from '@/crypto/mac/hmac';
import { MD5 } from '@/crypto/hash/md5';
import { SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec, type ClientMechanism, type SaslClientParams, type SaslInteract, type StepOutcome } from '../saslTypes';
import { getAuthid, isFatal, makePrompts } from '../pluginUtils';

const encoder = new TextEncoder();
const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

export const cramMd5Mechanism: ClientMechanism = {
  name: 'CRAM-MD5',
  maxSsf: 0,
  securityFlags: SaslSec.NOPLAINTEXT | SaslSec.NOANONYMOUS,
  features: SaslFeat.SERVER_FIRST,
  requiredPrompts: null,
  create() {
    return {
      step(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome {
        const challenge = serverIn ?? new Uint8Array(0);
        if (challenge.length > 1024) {
          params.seterror('CRAM-MD5 input longer than 1024 bytes');
          return { rc: SaslRc.BADPROT };
        }
        if (params.props.minSsf > params.externalSsf) {
          params.seterror('SSF requested of CRAM-MD5 plugin');
          return { rc: SaslRc.TOOWEAK };
        }
        let authResult: number = SaslRc.OK;
        let authid: string | null = null;
        if (params.oparams.authid === null) {
          const got = getAuthid(params, prompts);
          authResult = got.rc;
          authid = got.value;
          if (isFatal(authResult)) return { rc: authResult };
        }
        const gotPassword = params.getPassword(prompts);
        const passResult = gotPassword.rc;
        const password = gotPassword.value;
        if (isFatal(passResult)) return { rc: passResult };
        if (authResult === SaslRc.INTERACT || passResult === SaslRc.INTERACT) {
          return {
            rc: SaslRc.INTERACT,
            prompts: makePrompts({
              authPrompt: authResult === SaslRc.INTERACT ? 'Please enter your authentication name' : undefined,
              passPrompt: passResult === SaslRc.INTERACT ? 'Please enter your password' : undefined,
            }),
          };
        }
        if (password === null) {
          params.seterror('Parameter error in cram.c');
          return { rc: SaslRc.BADPARAM };
        }
        const result = params.canonUser(authid ?? '', SASL_CU_AUTHID | SASL_CU_AUTHZID);
        if (result !== SaslRc.OK) return { rc: result };
        const digest = toHex(hmac(MD5, password, challenge));
        params.oparams.done = true;
        params.oparams.mechSsf = 0;
        params.oparams.maxOutbuf = 0;
        params.oparams.encode = null;
        params.oparams.decode = null;
        return { rc: SaslRc.OK, out: encoder.encode(`${params.oparams.authid} ${digest}`) };
      },
    };
  },
};
