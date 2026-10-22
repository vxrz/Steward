export interface BuildInfo {
  /** Commit hash, null when unknown (no SM_BUILD_COMMIT and no git checkout) */
  commit: string | null;
  /** ISO date of the build */
  date: string;
}
export interface ThirdPartyPackage {
  name: string;
  version: string;
  license: string;
}
export function buildInfo(root: string): BuildInfo;
export function thirdPartyLicenses(root: string): ThirdPartyPackage[];
