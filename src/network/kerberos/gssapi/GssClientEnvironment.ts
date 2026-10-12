import type { GssClock, GssCredential } from './GssInitiator';
import type { GssFailure } from './GssStatus';

export type GssAcquisition =
  | { readonly kind: 'credential'; readonly credential: GssCredential }
  | { readonly kind: 'failure'; readonly failure: GssFailure };

export type GssCredentialAcquisition =
  | { readonly kind: 'credentials'; readonly name: string }
  | { readonly kind: 'failure'; readonly failure: GssFailure };

export interface GssClientEnvironment {
  readonly clock: GssClock;
  acquire(service: string, host: string, delegate?: boolean): Promise<GssAcquisition>;
  acquireCredentials(name: string | null): Promise<GssCredentialAcquisition>;
}
