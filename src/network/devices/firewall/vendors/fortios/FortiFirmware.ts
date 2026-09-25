export interface FortiFirmwareImage {
  readonly build: string;
  readonly buildDate: string;
  readonly branch: string;
  readonly branchSuffix: string;
  readonly x86_64: boolean;
}

export const FORTI_FIRMWARE: FortiFirmwareImage = Object.freeze({
  build: '2660',
  buildDate: '250417',
  branch: 'GA',
  branchSuffix: 'M',
  x86_64: true,
});

export interface FortiFirmwareIdentity {
  readonly version: string;
  readonly build: string;
  readonly buildDate: string;
  readonly versionSuffix: string;
}

export function fortiFirmwareVersion(identity: FortiFirmwareIdentity): string {
  return `v${identity.version},build${identity.build},${identity.buildDate} (${identity.versionSuffix})`;
}

export function fortiVersionSuffix(image: FortiFirmwareImage): string {
  return image.branchSuffix === ''
    ? image.branch : `${image.branch}.${image.branchSuffix}`;
}
