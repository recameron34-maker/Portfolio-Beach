import type { ReactNode } from 'react';
import { EmptyState } from './ui.js';

/** Client look-through (commitments and share of vehicle positions). Implemented by the reporting pages; shared with Analytics. */
export function ClientLookThrough(): ReactNode {
  return (
    <EmptyState
      title="Client look-through is being built"
      detail="Commitments, ownership and the client's share of each vehicle's positions."
    />
  );
}
