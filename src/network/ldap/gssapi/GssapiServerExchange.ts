import type { RandomSource } from '@/crypto/random';
import type { ApReplayCache } from '@/network/kerberos/ApReqVerifier';
import { GssAcceptor, type GssPeer } from '@/network/kerberos/gssapi/GssAcceptor';
import type { GssClock } from '@/network/kerberos/gssapi/GssInitiator';
import { GssTokenError, type GssSecurityContext } from '@/network/kerberos/gssapi/GssSecurityContext';
import { LAYER_CONFIDENTIALITY, LAYER_NONE, decodeLayerChoice, encodeLayerOffer, type LayerOffer } from './Rfc4752';

export interface GssapiServerOptions {
  readonly serviceKey: Uint8Array;
  readonly clock: GssClock;
  readonly replayCache: ApReplayCache;
  readonly offer: LayerOffer;
  readonly random?: RandomSource;
}

export interface EstablishedSecurityLayer {
  readonly context: GssSecurityContext;
  readonly privacy: boolean;
  readonly peerMaxBuffer: number;
}

export type GssapiServerStep =
  | { readonly kind: 'continue'; readonly credentials: Uint8Array }
  | {
    readonly kind: 'established'; readonly peer: GssPeer; readonly authzid: string;
    readonly layer: EstablishedSecurityLayer | null;
  }
  | { readonly kind: 'failed'; readonly reason: string };

export class GssapiServerExchange {
  private readonly acceptor: GssAcceptor;
  private state: 'token' | 'offer' | 'choice' = 'token';
  private peer: GssPeer | null = null;

  constructor(private readonly options: GssapiServerOptions) {
    this.acceptor = new GssAcceptor({
      serviceKey: options.serviceKey, clock: options.clock, replayCache: options.replayCache, random: options.random,
    });
  }

  step(credentials: Uint8Array | null): GssapiServerStep {
    if (this.state === 'token') return this.acceptToken(credentials);
    if (this.state === 'offer') return this.offerLayers(credentials);
    return this.readChoice(credentials);
  }

  private acceptToken(credentials: Uint8Array | null): GssapiServerStep {
    if (credentials === null || credentials.length === 0) return { kind: 'failed', reason: 'the first GSSAPI bind carries no token' };
    const accepted = this.acceptor.step(credentials);
    if (accepted.kind === 'error') return { kind: 'failed', reason: accepted.message };
    this.peer = accepted.peer;
    if (accepted.output !== null) {
      this.state = 'offer';
      return { kind: 'continue', credentials: accepted.output };
    }
    return this.offerLayers(null);
  }

  private offerLayers(credentials: Uint8Array | null): GssapiServerStep {
    if (credentials !== null && credentials.length > 0) return { kind: 'failed', reason: 'unexpected token before the security layer offer' };
    const context = this.acceptor.securityContext!;
    this.state = 'choice';
    return { kind: 'continue', credentials: context.wrap(encodeLayerOffer(this.options.offer), false) };
  }

  private readChoice(credentials: Uint8Array | null): GssapiServerStep {
    const context = this.acceptor.securityContext!;
    let token: Uint8Array;
    try {
      token = context.unwrap(credentials ?? new Uint8Array(0)).data;
    } catch (error) {
      if (!(error instanceof GssTokenError)) throw error;
      return { kind: 'failed', reason: error.message };
    }
    const choice = decodeLayerChoice(this.options.offer, token);
    if (choice.kind === 'refused') return { kind: 'failed', reason: `the chosen security layer is refused (${choice.reason})` };
    const layer: EstablishedSecurityLayer | null = choice.layer === LAYER_NONE
      ? null
      : { context, privacy: choice.layer === LAYER_CONFIDENTIALITY, peerMaxBuffer: choice.clientMaxBuffer };
    return { kind: 'established', peer: this.peer!, authzid: choice.authzid, layer };
  }
}
