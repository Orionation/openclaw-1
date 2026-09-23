export function preparePackageChokidarBundle(
  cwd?: string,
  onStageAcquired?: () => void,
): Promise<boolean>;
export function restorePackageChokidarBundle(cwd?: string): Promise<boolean>;
