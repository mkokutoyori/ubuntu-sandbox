/**
 * STUB FILE - will be rebuilt with TDD
 * Filesystem implementation for Linux terminals
 */

export interface FileSystemEntry {
  name: string;
  type: 'file' | 'directory';
  content?: string;
  children?: Record<string, FileSystemEntry>;
  permissions?: string;
  owner?: string;
  group?: string;
  size?: number;
  modified?: Date;
}

export class FileSystem {
  private root: FileSystemEntry;

  constructor() {
    this.root = {
      name: '/',
      type: 'directory',
      children: {
        'home': {
          name: 'home',
          type: 'directory',
          children: {
            'user': {
              name: 'user',
              type: 'directory',
              children: {}
            }
          }
        },
        'etc': {
          name: 'etc',
          type: 'directory',
          children: {}
        },
        'var': {
          name: 'var',
          type: 'directory',
          children: {}
        },
        'tmp': {
          name: 'tmp',
          type: 'directory',
          children: {}
        }
      }
    };
  }

  readFile(path: string): string {
    return `STUB: File content for ${path}`;
  }

  writeFile(path: string, content: string): void {
    // Stub implementation
  }

  deleteFile(path: string): void {
    // Stub implementation
  }

  createDirectory(path: string): void {
    // Stub implementation
  }

  listDirectory(path: string): string[] {
    return [];
  }

  exists(path: string): boolean {
    return true;
  }

  isDirectory(path: string): boolean {
    return false;
  }

  isFile(path: string): boolean {
    return false;
  }

  resolvePath(currentPath: string, relativePath: string): string {
    if (relativePath.startsWith('/')) {
      return relativePath;
    }
    return `${currentPath}/${relativePath}`.replace(/\/+/g, '/');
  }

  getAbsolutePath(currentPath: string, path: string): string {
    return this.resolvePath(currentPath, path);
  }
}

export const fileSystem = new FileSystem();
