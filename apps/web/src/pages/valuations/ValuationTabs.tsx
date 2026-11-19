import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { meQuery } from '../../app/queries.js';
import { TabNav } from '../../components/ui.js';
import { valuationTabsFor } from './suggestions.js';

/**
 * The tab row of the Valuations area. The Suggestions tab is shown to the roles that read
 * suggestions; for anyone else, and until the roles are known, the row holds the other tabs only.
 */
export function ValuationTabs(): ReactNode {
  const me = useQuery(meQuery);
  return <TabNav label="Valuations" items={valuationTabsFor(me.data?.roles ?? [])} />;
}
