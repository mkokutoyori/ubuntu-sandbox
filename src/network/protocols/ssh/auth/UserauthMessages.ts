import { SshReader, SshWriter } from '../wire/SshDataTypes';
import {
  SSH_CONNECTION_SERVICE, SSH_MSG_USERAUTH_BANNER, SSH_MSG_USERAUTH_FAILURE, SSH_MSG_USERAUTH_INFO_REQUEST,
  SSH_MSG_USERAUTH_INFO_RESPONSE, SSH_MSG_USERAUTH_PK_OK, SSH_MSG_USERAUTH_REQUEST, SSH_MSG_USERAUTH_SUCCESS,
} from '../transport/SshMessageNumbers';
import type { UserauthInfoRequest } from './ClientUserauth';

export type UserauthMethodRequest =
  | { readonly method: 'none' }
  | { readonly method: 'password'; readonly password: string }
  | {
    readonly method: 'publickey'; readonly algorithm: string; readonly publicKeyBlob: Uint8Array;
    readonly signature?: Uint8Array;
  }
  | { readonly method: 'keyboard-interactive'; readonly submethods: string }
  | { readonly method: string };

export type UserauthRequest = UserauthMethodRequest & {
  readonly user: string;
  readonly service: string;
};

export function encodeUserauthRequest(user: string, request: UserauthMethodRequest): Uint8Array {
  const writer = new SshWriter()
    .writeByte(SSH_MSG_USERAUTH_REQUEST)
    .writeString(user)
    .writeString(SSH_CONNECTION_SERVICE)
    .writeString(request.method);
  if ('password' in request) return writer.writeByte(0).writeString(request.password).toBytes();
  if ('publicKeyBlob' in request) {
    writer.writeByte(request.signature ? 1 : 0).writeString(request.algorithm).writeBytes(request.publicKeyBlob);
    if (request.signature) writer.writeBytes(request.signature);
    return writer.toBytes();
  }
  if ('submethods' in request) return writer.writeString('').writeString(request.submethods).toBytes();
  return writer.toBytes();
}

export function decodeUserauthRequest(payload: Uint8Array): UserauthRequest | null {
  try {
    const reader = new SshReader(payload);
    if (reader.readByte() !== SSH_MSG_USERAUTH_REQUEST) return null;
    const user = reader.readString();
    const service = reader.readString();
    const method = reader.readString();
    if (method === 'password') {
      if (reader.readByte() !== 0) return null;
      return { user, service, method, password: reader.readString() };
    }
    if (method === 'publickey') {
      const hasSignature = reader.readByte() !== 0;
      const algorithm = reader.readString();
      const publicKeyBlob = reader.readBytes();
      return hasSignature
        ? { user, service, method, algorithm, publicKeyBlob, signature: reader.readBytes() }
        : { user, service, method, algorithm, publicKeyBlob };
    }
    if (method === 'keyboard-interactive') {
      reader.readString();
      return { user, service, method, submethods: reader.readString() };
    }
    return { user, service, method };
  } catch {
    return null;
  }
}

export function encodeUserauthFailure(methods: readonly string[], partialSuccess: boolean): Uint8Array {
  return new SshWriter()
    .writeByte(SSH_MSG_USERAUTH_FAILURE).writeString(methods.join(',')).writeByte(partialSuccess ? 1 : 0)
    .toBytes();
}

export function decodeUserauthFailure(payload: Uint8Array): { methods: string; partialSuccess: boolean } | null {
  try {
    const reader = new SshReader(payload);
    if (reader.readByte() !== SSH_MSG_USERAUTH_FAILURE) return null;
    return { methods: reader.readString(), partialSuccess: reader.readByte() !== 0 };
  } catch {
    return null;
  }
}

export const USERAUTH_SUCCESS: Uint8Array = new Uint8Array([SSH_MSG_USERAUTH_SUCCESS]);

export function encodeUserauthBanner(message: string): Uint8Array {
  return new SshWriter().writeByte(SSH_MSG_USERAUTH_BANNER).writeString(message).writeString('').toBytes();
}

export function decodeUserauthBanner(payload: Uint8Array): string | null {
  try {
    const reader = new SshReader(payload);
    if (reader.readByte() !== SSH_MSG_USERAUTH_BANNER) return null;
    return reader.readString();
  } catch {
    return null;
  }
}

export function encodeUserauthPkOk(algorithm: string, publicKeyBlob: Uint8Array): Uint8Array {
  return new SshWriter().writeByte(SSH_MSG_USERAUTH_PK_OK).writeString(algorithm).writeBytes(publicKeyBlob).toBytes();
}

export function encodeUserauthInfoRequest(request: UserauthInfoRequest): Uint8Array {
  const writer = new SshWriter()
    .writeByte(SSH_MSG_USERAUTH_INFO_REQUEST)
    .writeString(request.name)
    .writeString(request.instruction)
    .writeString('')
    .writeUint32(request.prompts.length);
  for (const prompt of request.prompts) writer.writeString(prompt.prompt).writeByte(prompt.echo ? 1 : 0);
  return writer.toBytes();
}

export function decodeUserauthInfoRequest(payload: Uint8Array): UserauthInfoRequest | null {
  try {
    const reader = new SshReader(payload);
    if (reader.readByte() !== SSH_MSG_USERAUTH_INFO_REQUEST) return null;
    const name = reader.readString();
    const instruction = reader.readString();
    reader.readString();
    const count = reader.readUint32();
    const prompts = Array.from({ length: count }, () => ({ prompt: reader.readString(), echo: reader.readByte() !== 0 }));
    return { name, instruction, prompts };
  } catch {
    return null;
  }
}

export function encodeUserauthInfoResponse(responses: readonly string[]): Uint8Array {
  const writer = new SshWriter().writeByte(SSH_MSG_USERAUTH_INFO_RESPONSE).writeUint32(responses.length);
  for (const response of responses) writer.writeString(response);
  return writer.toBytes();
}

export function decodeUserauthInfoResponse(payload: Uint8Array): readonly string[] | null {
  try {
    const reader = new SshReader(payload);
    if (reader.readByte() !== SSH_MSG_USERAUTH_INFO_RESPONSE) return null;
    const count = reader.readUint32();
    if (count > 100) return null;
    return Array.from({ length: count }, () => reader.readString());
  } catch {
    return null;
  }
}
