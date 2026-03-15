/**
 * In-Memory Filesystem Mock for testing NanoClaw adapters
 * Simulates Node.js fs module operations
 */

export interface MockFile {
  content: string;
  isDirectory: boolean;
  mtime: Date;
}

export class MockFileSystem {
  private files: Map<string, MockFile> = new Map();

  private normalizePath(filePath: string): string {
    return filePath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }

  private getParentDir(filePath: string): string {
    const normalized = this.normalizePath(filePath);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return normalized.substring(0, lastSlash) || '/';
  }

  private getBaseName(filePath: string): string {
    const normalized = this.normalizePath(filePath);
    const lastSlash = normalized.lastIndexOf('/');
    return normalized.substring(lastSlash + 1);
  }

  mkdirSync(dirPath: string, options?: { recursive?: boolean }): void {
    const normalized = this.normalizePath(dirPath);

    if (!options?.recursive) {
      const parentDir = this.getParentDir(normalized);
      if (parentDir !== '/' && !this.existsSync(parentDir)) {
        throw new Error(
          `ENOENT: no such file or directory, mkdir '${dirPath}'`,
        );
      }
    }

    // Create all parent directories recursively
    if (options?.recursive) {
      const parts = normalized.split('/').filter(Boolean);
      let currentPath = '';
      for (const part of parts) {
        currentPath += `/${part}`;
        if (!this.files.has(currentPath)) {
          this.files.set(currentPath, {
            content: '',
            isDirectory: true,
            mtime: new Date(),
          });
        }
      }
    } else {
      this.files.set(normalized, {
        content: '',
        isDirectory: true,
        mtime: new Date(),
      });
    }
  }

  writeFileSync(filePath: string, data: string | Buffer): void {
    const normalized = this.normalizePath(filePath);
    const parentDir = this.getParentDir(normalized);

    if (parentDir !== '/' && !this.existsSync(parentDir)) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }

    this.files.set(normalized, {
      content: data.toString(),
      isDirectory: false,
      mtime: new Date(),
    });
  }

  readFileSync(filePath: string, encoding?: string): string | Buffer {
    const normalized = this.normalizePath(filePath);
    const file = this.files.get(normalized);

    if (!file) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }

    if (file.isDirectory) {
      throw new Error(`EISDIR: illegal operation on a directory, read`);
    }

    return encoding === 'utf-8' || encoding === 'utf8'
      ? file.content
      : Buffer.from(file.content);
  }

  existsSync(filePath: string): boolean {
    const normalized = this.normalizePath(filePath);
    return this.files.has(normalized);
  }

  readdirSync(dirPath: string): string[] {
    const normalized = this.normalizePath(dirPath);
    const dir = this.files.get(normalized);

    if (!dir) {
      throw new Error(
        `ENOENT: no such file or directory, scandir '${dirPath}'`,
      );
    }

    if (!dir.isDirectory) {
      throw new Error(`ENOTDIR: not a directory, scandir '${dirPath}'`);
    }

    const entries: string[] = [];
    const prefix = normalized === '/' ? '' : normalized;

    for (const [path, file] of this.files) {
      if (path === normalized) continue;

      const relativePath = path.substring(prefix.length);
      if (relativePath.startsWith('/')) {
        const parts = relativePath.substring(1).split('/');
        if (parts.length === 1 || (parts.length === 2 && parts[1] === '')) {
          entries.push(parts[0]);
        }
      }
    }

    return [...new Set(entries)];
  }

  unlinkSync(filePath: string): void {
    const normalized = this.normalizePath(filePath);

    if (!this.files.has(normalized)) {
      throw new Error(
        `ENOENT: no such file or directory, unlink '${filePath}'`,
      );
    }

    this.files.delete(normalized);
  }

  rmdirSync(dirPath: string): void {
    const normalized = this.normalizePath(dirPath);
    const dir = this.files.get(normalized);

    if (!dir) {
      throw new Error(`ENOENT: no such file or directory, rmdir '${dirPath}'`);
    }

    if (!dir.isDirectory) {
      throw new Error(`ENOTDIR: not a directory, rmdir '${dirPath}'`);
    }

    // Check if directory is empty
    const entries = this.readdirSync(dirPath);
    if (entries.length > 0) {
      throw new Error(`ENOTEMPTY: directory not empty, rmdir '${dirPath}'`);
    }

    this.files.delete(normalized);
  }

  statSync(filePath: string): {
    isDirectory: () => boolean;
    isFile: () => boolean;
    mtime: Date;
  } {
    const normalized = this.normalizePath(filePath);
    const file = this.files.get(normalized);

    if (!file) {
      throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    }

    return {
      isDirectory: () => file.isDirectory,
      isFile: () => !file.isDirectory,
      mtime: file.mtime,
    };
  }

  // Test helper methods
  reset(): void {
    this.files.clear();
  }

  getFiles(): Map<string, MockFile> {
    return new Map(this.files);
  }

  dump(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [path, file] of this.files) {
      result[path] = {
        isDirectory: file.isDirectory,
        content: file.isDirectory
          ? undefined
          : file.content.substring(0, 100) +
            (file.content.length > 100 ? '...' : ''),
      };
    }
    return result;
  }
}

// Create a singleton instance for tests
export const mockFs = new MockFileSystem();
