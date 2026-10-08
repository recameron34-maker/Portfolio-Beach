import type { ReactNode } from 'react';
import { vi } from 'vitest';

export const navigate = vi.fn();

function hrefOf(to: string, params: Record<string, string> | undefined): string {
  return to.replace(/\$(\w+)/g, (_match, key: string) => params?.[key] ?? '');
}

/**
 * A stand-in for @tanstack/react-router in page tests: links render as anchors with the resolved
 * path, the outlet renders nothing. Use it as the factory of vi.mock('@tanstack/react-router').
 */
export function routerMock(): Record<string, unknown> {
  return {
    useNavigate: () => navigate,
    useParams: () => ({}),
    Outlet: () => null,
    Link: ({
      to,
      params,
      children,
    }: {
      to: string;
      params?: Record<string, string>;
      children?: ReactNode;
    }) => <a href={hrefOf(to, params)}>{children}</a>,
  };
}
