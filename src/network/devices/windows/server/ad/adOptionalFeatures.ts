import { AD_FUNCTIONAL_LEVELS } from './adFunctionalLevels';

export interface AdOptionalFeatureSpec {
  readonly name: string;
  readonly requiredForestKeyword: string;
}

export const RECYCLE_BIN_FEATURE = 'Recycle Bin Feature';
export const PRIVILEGED_ACCESS_MANAGEMENT_FEATURE = 'Privileged Access Management Feature';

export const AD_OPTIONAL_FEATURES: readonly AdOptionalFeatureSpec[] = [
  { name: RECYCLE_BIN_FEATURE, requiredForestKeyword: 'Win2008R2' },
  { name: PRIVILEGED_ACCESS_MANAGEMENT_FEATURE, requiredForestKeyword: 'WinThreshold' },
];

export function findOptionalFeature(name: string): AdOptionalFeatureSpec | null {
  const lower = name.trim().toLowerCase();
  return AD_OPTIONAL_FEATURES.find(f => f.name.toLowerCase() === lower) ?? null;
}

function rankOfKeyword(keyword: string): number {
  return AD_FUNCTIONAL_LEVELS.find(l => l.keyword === keyword)?.rank ?? 0;
}

function rankOfForestMode(forestMode: string): number {
  const lower = forestMode.trim().toLowerCase();
  return AD_FUNCTIONAL_LEVELS.find(l => l.forestMode.toLowerCase() === lower)?.rank ?? 0;
}

export function requiredForestModeFor(feature: AdOptionalFeatureSpec): string {
  return AD_FUNCTIONAL_LEVELS.find(l => l.keyword === feature.requiredForestKeyword)?.forestMode
    ?? feature.requiredForestKeyword;
}

export const TTL_WITHOUT_PAM_FEATURE = 'The parameter is incorrect.';

export function forestModeAdmits(feature: AdOptionalFeatureSpec, forestMode: string): boolean {
  return rankOfForestMode(forestMode) >= rankOfKeyword(feature.requiredForestKeyword);
}
