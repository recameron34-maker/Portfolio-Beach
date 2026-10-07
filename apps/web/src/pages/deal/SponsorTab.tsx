import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function SponsorTab(): ReactNode {
  return <PhasePage title="Sponsor and contacts" phase="this build" modules="M6 sponsor summary" />;
}
