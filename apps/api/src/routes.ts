import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';

export interface ImplementedRoute {
  method: string;
  path: string;
}

type ControllerClass = abstract new (...args: never[]) => unknown;

/** Lists the routes a set of Nest controllers implements, in the contract's `{param}` notation, for the parity test. */
export function listImplementedRoutes(controllers: readonly ControllerClass[]): ImplementedRoute[] {
  const out: ImplementedRoute[] = [];
  for (const controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (path === undefined || method === undefined) continue;
      const full = `/${[base, path].filter((p) => p.length > 0 && p !== '/').join('/')}`
        .replace(/\/+/g, '/')
        .replace(/:(\w+)/g, '{$1}');
      out.push({ method: RequestMethod[method] ?? String(method), path: full });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
