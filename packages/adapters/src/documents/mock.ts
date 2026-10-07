import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { DocumentRef, DocumentStore, HealthStatus } from '../types.js';

/** Documents in a local folder of synthetic files (SharePoint via Graph in production). */
export class LocalFolderDocumentStore implements DocumentStore {
  readonly info = {
    name: 'documents.local_folder',
    kind: 'mock',
    killSwitch: 'adapter.documents',
  } as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private safePath(...parts: string[]): string {
    const full = resolve(this.root, ...parts);
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error('path escapes the document root');
    return full;
  }

  async list(folder: string): Promise<DocumentRef[]> {
    const dir = this.safePath(folder);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const refs: DocumentRef[] = [];
    for (const name of entries.sort()) {
      const path = join(dir, name);
      const s = await stat(path);
      if (!s.isFile()) continue;
      const bytes = await readFile(path);
      refs.push({
        id: relative(this.root, path).split(sep).join('/'),
        name,
        folder,
        sizeBytes: s.size,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        modifiedAt: s.mtime.toISOString(),
      });
    }
    return refs;
  }

  async read(id: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.safePath(id)));
  }

  async put(folder: string, name: string, bytes: Uint8Array): Promise<DocumentRef> {
    const dir = this.safePath(folder);
    await mkdir(dir, { recursive: true });
    const path = this.safePath(folder, name);
    await writeFile(path, bytes);
    const s = await stat(path);
    return {
      id: relative(this.root, path).split(sep).join('/'),
      name,
      folder,
      sizeBytes: s.size,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      modifiedAt: s.mtime.toISOString(),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await stat(this.root);
      return { ok: true };
    } catch {
      return { ok: false, detail: 'document root missing' };
    }
  }
}
