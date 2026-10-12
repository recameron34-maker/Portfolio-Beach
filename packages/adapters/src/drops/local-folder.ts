import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileDrop, FileRef, HealthStatus } from '../types.js';

/**
 * A drop folder stands in for the place a weekly report or an operations workbook is dropped
 * (docs/04 M2: file drops use the local folder adapter in the prototype). Files are read from
 * <root>/in; only the listed extensions count. Ids are bare file names: an id with a path segment is
 * refused, the same guard as the accounting folder, so a caller can never read outside the inbox.
 */
export class LocalFolderDrop implements FileDrop {
  readonly info: FileDrop['info'];
  private readonly inbox: string;
  private readonly extensions: readonly string[];

  /**
   * @param drop  The drop's name, such as weekly or ops_drop: it names the adapter
   *              (drop.local_folder.<drop>) and its kill switch (adapter.<drop>_drop or adapter.<drop>).
   * @param root  The folder whose `in` subfolder holds the files.
   * @param extensions  Lower-case extensions with their dot, such as ['.csv'].
   */
  constructor(drop: string, root: string, extensions: readonly string[]) {
    this.info = {
      name: `drop.local_folder.${drop}`,
      kind: 'mock',
      killSwitch: `adapter.${drop.endsWith('_drop') ? drop : `${drop}_drop`}`,
    };
    this.inbox = resolve(root, 'in');
    this.extensions = extensions.map((e) => e.toLowerCase());
  }

  async listFiles(): Promise<FileRef[]> {
    let names: string[];
    try {
      names = (await readdir(this.inbox))
        .filter((n) => this.extensions.some((e) => n.toLowerCase().endsWith(e)))
        .sort();
    } catch {
      return [];
    }
    const refs: FileRef[] = [];
    for (const name of names) {
      const s = await stat(join(this.inbox, name));
      if (!s.isFile()) continue;
      refs.push({ id: name, name, receivedAt: s.mtime.toISOString() });
    }
    return refs;
  }

  async readText(id: string): Promise<string> {
    return readFile(this.pathOf(id), 'utf8');
  }

  async readBytes(id: string): Promise<Uint8Array> {
    const bytes = await readFile(this.pathOf(id));
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true });
  }

  /** The file inside the inbox, or an error for an id that is not a bare file name of a listed kind. */
  private pathOf(id: string): string {
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..'))
      throw new Error('invalid drop id');
    if (!this.extensions.some((e) => id.toLowerCase().endsWith(e)))
      throw new Error('invalid drop id');
    return join(this.inbox, id);
  }
}
