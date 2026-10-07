import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AccountingSystem, FileRef, HealthStatus } from '../types.js';

/** Generic CSV drop folders stand in for the accounting system's export and upload files. */
export class LocalFolderAccountingSystem implements AccountingSystem {
  readonly info = {
    name: 'accounting.local_folder',
    kind: 'mock',
    killSwitch: 'adapter.accounting',
  } as const;
  private readonly inbox: string;
  private readonly outbox: string;

  constructor(root: string) {
    this.inbox = resolve(root, 'in');
    this.outbox = resolve(root, 'out');
  }

  async listExports(): Promise<FileRef[]> {
    let names: string[];
    try {
      names = (await readdir(this.inbox)).filter((n) => n.endsWith('.csv')).sort();
    } catch {
      return [];
    }
    const refs: FileRef[] = [];
    for (const name of names) {
      const s = await stat(join(this.inbox, name));
      refs.push({ id: name, name, receivedAt: s.mtime.toISOString() });
    }
    return refs;
  }

  async readExport(id: string): Promise<string> {
    if (id.includes('/') || id.includes('..')) throw new Error('invalid export id');
    return readFile(join(this.inbox, id), 'utf8');
  }

  async writeUpload(name: string, csv: string): Promise<FileRef> {
    if (name.includes('/') || name.includes('..')) throw new Error('invalid upload name');
    await mkdir(this.outbox, { recursive: true });
    await writeFile(join(this.outbox, name), csv, 'utf8');
    const s = await stat(join(this.outbox, name));
    return { id: name, name, receivedAt: s.mtime.toISOString() };
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true });
  }
}
