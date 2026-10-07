import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function WatchlistPage(): ReactNode {
  return <PhasePage title="Watchlist" phase="this build" modules="M9 monitoring flags" />;
}
