import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function TaxonomyPage(): ReactNode {
  return <PhasePage title="Taxonomy" phase="this build" modules="docs/03 taxonomy" />;
}
