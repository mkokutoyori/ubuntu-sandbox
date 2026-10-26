export interface ProviderFailure {
  readonly message: string;
  readonly exceptionType: string;
  readonly errorId: string;
  readonly category: string;
  readonly target: string | null;
  readonly targetType?: string;
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

export function directoryExists(path: string): ProviderFailure {
  return {
    message: `An item with the specified name ${path} already exists.`,
    exceptionType: 'System.IO.IOException',
    errorId: 'DirectoryExist',
    category: 'ResourceExists',
    target: path,
  };
}

export function copyOntoItself(path: string): ProviderFailure {
  return {
    message: `Cannot overwrite the item ${path} with itself.`,
    exceptionType: 'System.IO.IOException',
    errorId: 'CopyError',
    category: 'WriteError',
    target: path,
  };
}
