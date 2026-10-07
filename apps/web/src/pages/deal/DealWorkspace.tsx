import type { ReactNode } from 'react';
import { Outlet, useParams } from '@tanstack/react-router';
import { DEAL_TABS } from '../../app/nav.js';
import { TabNav } from '../../components/ui.js';

export function DealWorkspace(): ReactNode {
  const { id } = useParams({ from: '/app/portfolio/$id' });
  return (
    <>
      <TabNav
        label="Deal workspace"
        items={DEAL_TABS.map((t) => ({
          to: `/portfolio/${id}${t.path}`,
          label: t.label,
          exact: t.path === '',
        }))}
      />
      <Outlet />
    </>
  );
}
