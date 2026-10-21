import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredBlob {
  key: string;
  sha256: string;
  size: number;
}

/**
 * Object storage abstraction. Local filesystem for development; an S3-compatible adapter
 * (server-side encryption, signed short-lived URLs) replaces it in hosted environments.
 * Callers must authorize access to the owning record BEFORE calling get().
 */
export interface BlobStore {
  put(tenantId: string, content: Buffer): Promise<StoredBlob>;
  get(key: string): Promise<Buffer>;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(tenantId: string, content: Buffer): Promise<StoredBlob> {
    const key = `${tenantId}/${randomUUID()}`;
    const file = path.join(this.root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return { key, sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
  }

  async get(key: string): Promise<Buffer> {
    if (key.includes('..')) throw new Error('invalid blob key');
    return readFile(path.join(this.root, key));
  }
}
