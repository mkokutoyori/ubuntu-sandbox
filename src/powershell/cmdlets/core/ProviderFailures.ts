export interface ProviderFailure {
  readonly message: string;
  readonly exceptionType: string;
  readonly errorId: string;
  readonly category: string;
  readonly target: string | null;
}

export function driveNotFound(name: string): ProviderFailure {
  return {
    message: `Cannot find drive. A drive with the name '${name}' does not exist.`,
    exceptionType: 'System.Management.Automation.DriveNotFoundException',
    errorId: 'DriveNotFound',
    category: 'ObjectNotFound',
    target: name,
  };
}

export function pathNotFound(path: string): ProviderFailure {
  return {
    message: `Cannot find path '${path}' because it does not exist.`,
    exceptionType: 'System.Management.Automation.ItemNotFoundException',
    errorId: 'PathNotFound',
    category: 'ObjectNotFound',
    target: path,
  };
}
