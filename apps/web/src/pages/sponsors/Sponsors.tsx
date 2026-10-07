import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function SponsorsPage(): ReactNode {
  return <PhasePage title="Sponsors" phase="this build" modules="M6 sponsor directory" />;
}

export function SponsorDetailPage(): ReactNode {
  return <PhasePage title="Sponsor" phase="this build" modules="M6 sponsor 360" />;
}
