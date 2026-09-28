import { HUAWEI_ERRORS, refuseMotInattenduVrp } from '../cli-utils';
import {
  RSA_PEER_KEY_ENCODINGS, type RsaPeerKeyEncoding, type RsaPeerPublicKey,
} from '../../router/management/RouterManagementService';

export interface RsaPeerKeyStore {
  setRsaPeerPublicKey(key: RsaPeerPublicKey): void;
  removeRsaPeerPublicKey(name: string): boolean;
}

const ENTER_PUBLIC_KEY_VIEW = 'Enter "RSA public key" view, return system view with "peer-public-key end".';
const ENTER_KEY_CODE_VIEW = 'Enter "RSA key code" view, return last view with "public-key-code end".';

function abbreviates(word: string | undefined, keyword: string, minimum: number): boolean {
  return word !== undefined && word.length >= minimum && keyword.startsWith(word.toLowerCase());
}

export class RsaPeerPublicKeyEditor {
  private draft: { name: string; encoding: RsaPeerKeyEncoding; code: string[] } | null = null;
  private inKeyCode = false;

  isEditing(): boolean {
    return this.draft !== null;
  }

  viewSuffix(): string | null {
    if (this.draft === null) return null;
    return this.inKeyCode ? '-rsa-key-code' : '-rsa-public-key';
  }

  open(args: readonly string[]): string {
    const [name, keyword, encodingWord] = args;
    const line = `rsa peer-public-key ${args.join(' ')}`;
    if (!name) return 'Error: Incomplete command.';
    let encoding: RsaPeerKeyEncoding = 'der';
    if (keyword !== undefined) {
      if (!abbreviates(keyword, 'encoding-type', 1)) return refuseMotInattenduVrp(line, keyword);
      if (encodingWord === undefined) return 'Error: Incomplete command.';
      const chosen = RSA_PEER_KEY_ENCODINGS.find((e) => abbreviates(encodingWord, e, 1));
      if (!chosen) return refuseMotInattenduVrp(line, encodingWord);
      if (args.length > 3) return refuseMotInattenduVrp(line, args[3]);
      encoding = chosen;
    }
    this.draft = { name, encoding, code: [] };
    this.inKeyCode = false;
    return ENTER_PUBLIC_KEY_VIEW;
  }

  handle(line: string, store: RsaPeerKeyStore | null): string {
    const draft = this.draft;
    if (draft === null) return '';
    const words = line.trim().split(/\s+/);
    if (this.inKeyCode) {
      if (words.length === 2 && abbreviates(words[0], 'public-key-code', 2) && abbreviates(words[1], 'end', 1)) {
        this.inKeyCode = false;
      } else {
        draft.code.push(line.trim());
      }
      return '';
    }
    if (words.length === 2 && abbreviates(words[0], 'public-key-code', 2) && abbreviates(words[1], 'begin', 1)) {
      this.inKeyCode = true;
      return ENTER_KEY_CODE_VIEW;
    }
    if (words.length === 2 && abbreviates(words[0], 'peer-public-key', 2) && abbreviates(words[1], 'end', 1)) {
      store?.setRsaPeerPublicKey({ name: draft.name, encoding: draft.encoding, code: [...draft.code] });
      this.draft = null;
      return '';
    }
    return HUAWEI_ERRORS.UNRECOGNIZED(line.trim(), 0);
  }
}
