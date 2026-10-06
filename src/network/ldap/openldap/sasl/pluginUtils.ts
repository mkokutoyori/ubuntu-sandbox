import { SaslCb, SaslRc, type SaslClientParams, type SaslInteract, type SaslLayerResult } from './saslTypes';

export interface PromptSpec {
  readonly userPrompt?: string;
  readonly userDefault?: string | null;
  readonly authPrompt?: string;
  readonly authDefault?: string | null;
  readonly passPrompt?: string;
  readonly echoChallenge?: string | null;
  readonly echoPrompt?: string;
  readonly echoDefault?: string | null;
  readonly realmChallenge?: string | null;
  readonly realmPrompt?: string;
  readonly realmDefault?: string | null;
}

export function makePrompts(spec: PromptSpec): SaslInteract[] {
  const prompts: SaslInteract[] = [];
  if (spec.userPrompt !== undefined) {
    prompts.push({
      id: SaslCb.USER, challenge: 'Authorization Name', prompt: spec.userPrompt,
      defresult: spec.userDefault ?? null, result: null,
    });
  }
  if (spec.authPrompt !== undefined) {
    prompts.push({
      id: SaslCb.AUTHNAME, challenge: 'Authentication Name', prompt: spec.authPrompt,
      defresult: spec.authDefault ?? null, result: null,
    });
  }
  if (spec.passPrompt !== undefined) {
    prompts.push({ id: SaslCb.PASS, challenge: 'Password', prompt: spec.passPrompt, defresult: null, result: null });
  }
  if (spec.echoPrompt !== undefined) {
    prompts.push({
      id: SaslCb.ECHOPROMPT, challenge: spec.echoChallenge ?? null, prompt: spec.echoPrompt,
      defresult: spec.echoDefault ?? null, result: null,
    });
  }
  if (spec.realmPrompt !== undefined) {
    prompts.push({
      id: SaslCb.GETREALM, challenge: spec.realmChallenge ?? null, prompt: spec.realmPrompt,
      defresult: spec.realmDefault ?? null, result: null,
    });
  }
  prompts.push({ id: SaslCb.LIST_END, challenge: null, prompt: null, defresult: null, result: null });
  return prompts;
}

export function utf8Text(bytes: Uint8Array | null): string {
  return bytes === null ? '' : new TextDecoder().decode(bytes);
}

export function getAuthid(params: SaslClientParams, prompts: SaslInteract[] | null): { rc: number; value: string | null } {
  const result = params.getSimple(SaslCb.AUTHNAME, true, prompts);
  return { rc: result.rc, value: result.value === null ? null : utf8Text(result.value) };
}

export function getUserid(params: SaslClientParams, prompts: SaslInteract[] | null): { rc: number; value: string | null } {
  const result = params.getSimple(SaslCb.USER, false, prompts);
  return { rc: result.rc, value: result.value === null ? null : utf8Text(result.value) };
}

export function isFatal(rc: number): boolean {
  return rc !== SaslRc.OK && rc !== SaslRc.INTERACT;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function saslDecode64(text: string, outputMax: number): { rc: number; bytes: Uint8Array | null } {
  const out: number[] = [];
  if (text.length > 0 && text[0] === '\r') return { rc: SaslRc.FAIL, bytes: null };
  const sextet = (character: string): number => BASE64_ALPHABET.indexOf(character);
  let position = 0;
  let sawEqual = false;
  while (text.length - position > 3) {
    if (sawEqual) return { rc: SaslRc.BADPROT, bytes: null };
    const quad = [text[position], text[position + 1], text[position + 2], text[position + 3]];
    position += 4;
    if (sextet(quad[0]) === -1 || sextet(quad[1]) === -1) return { rc: SaslRc.BADPROT, bytes: null };
    if (quad[2] !== '=' && sextet(quad[2]) === -1) return { rc: SaslRc.BADPROT, bytes: null };
    if (quad[3] !== '=' && sextet(quad[3]) === -1) return { rc: SaslRc.BADPROT, bytes: null };
    if (quad[2] === '=' && quad[3] !== '=') return { rc: SaslRc.BADPROT, bytes: null };
    if (quad[2] === '=' || quad[3] === '=') sawEqual = true;
    out.push((sextet(quad[0]) << 2) | (sextet(quad[1]) >> 4));
    if (out.length >= outputMax) return { rc: SaslRc.BUFOVER, bytes: null };
    if (quad[2] !== '=') {
      out.push(((sextet(quad[1]) << 4) & 0xf0) | (sextet(quad[2]) >> 2));
      if (out.length >= outputMax) return { rc: SaslRc.BUFOVER, bytes: null };
      if (quad[3] !== '=') {
        out.push(((sextet(quad[2]) << 6) & 0xc0) | sextet(quad[3]));
        if (out.length >= outputMax) return { rc: SaslRc.BUFOVER, bytes: null };
      }
    }
  }
  if (text.length - position !== 0) {
    return { rc: sawEqual ? SaslRc.BADPROT : SaslRc.CONTINUE, bytes: null };
  }
  return { rc: SaslRc.OK, bytes: new Uint8Array(out) };
}

export class PlugDecodeContext {
  private needSize = 4;
  private readonly sizeBuffer = new Uint8Array(4);
  private size = 0;
  private packet: number[] = [];

  constructor(private readonly maxBuffer: number, private readonly logError: (message: string) => void) {}

  decode(input: Uint8Array, decodePacket: (packet: Uint8Array) => SaslLayerResult): SaslLayerResult {
    const output: number[] = [];
    let position = 0;
    while (position < input.length) {
      if (this.needSize > 0) {
        const toCopy = Math.min(input.length - position, this.needSize);
        this.sizeBuffer.set(input.subarray(position, position + toCopy), 4 - this.needSize);
        this.needSize -= toCopy;
        position += toCopy;
        if (this.needSize > 0) return { rc: SaslRc.OK, data: new Uint8Array(output) };
        this.size = ((this.sizeBuffer[0] << 24) | (this.sizeBuffer[1] << 16) | (this.sizeBuffer[2] << 8) | this.sizeBuffer[3]) >>> 0;
        this.packet = [];
      }
      if (this.size === 0) return { rc: SaslRc.FAIL, data: new Uint8Array(0) };
      if (this.size > this.maxBuffer) {
        this.logError(`encoded packet size too big (${this.size} > ${this.maxBuffer})`);
        return { rc: SaslRc.FAIL, data: new Uint8Array(0) };
      }
      const missing = this.size - this.packet.length;
      if (input.length - position < missing) {
        for (let index = position; index < input.length; index++) this.packet.push(input[index]);
        return { rc: SaslRc.OK, data: new Uint8Array(output) };
      }
      for (let index = 0; index < missing; index++) this.packet.push(input[position + index]);
      position += missing;
      const decoded = decodePacket(Uint8Array.from(this.packet));
      if (decoded.rc !== SaslRc.OK) return { rc: decoded.rc, data: new Uint8Array(0) };
      for (const byte of decoded.data) output.push(byte);
      this.needSize = 4;
    }
    return { rc: SaslRc.OK, data: new Uint8Array(output) };
  }
}
