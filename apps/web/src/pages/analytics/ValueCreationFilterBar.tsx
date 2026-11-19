import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import { Filter16Regular } from '@fluentui/react-icons';
import type { ValueCreationFilters, ValueCreationPosition } from '@pb/contracts';
import { Field, Toolbar } from '../../components/ui.js';
import { useNarrowScreen } from '../../lib/media.js';
import { FILTERS, filterOptions, hasFilters, withFilter } from './value-creation-filters.js';
import { positionsText } from './value-creation.js';
import './analytics.css';

/**
 * The filter row of the Value creation and Entry metrics tabs: vehicle, sponsor, sector, deal
 * type, entry year and status, each offering the values the caller's own positions hold, and
 * beside them how many positions pass. `positions` is every position of the response; the row
 * computes nothing.
 */
export function ValueCreationFilterBar({
  positions,
  shown,
  filters,
  onChange,
}: {
  positions: readonly ValueCreationPosition[];
  /** How many positions pass the filters. */
  shown: number;
  filters: ValueCreationFilters;
  onChange: (next: ValueCreationFilters) => void;
}): ReactNode {
  const narrow = useNarrowScreen();
  const [open, setOpen] = useState(false);
  const fieldsId = useId();
  const options = filterOptions(positions);
  const filtered = hasFilters(filters);
  const set = FILTERS.filter(({ key }) => filters[key] !== undefined).length;
  const fields = FILTERS.map(({ key, label, all }) => {
    const selected = filters[key] ?? '';
    const current = options[key].find((o) => o.value === selected);
    return (
      <Field key={key}>
        <Label htmlFor={`vc-filter-${key}`}>{label}</Label>
        <Dropdown
          id={`vc-filter-${key}`}
          className="pb-analytics-filter"
          size="small"
          // A value from a shared address that this reader's positions do not hold.
          value={selected === '' ? all : (current?.label ?? 'Not in this view')}
          selectedOptions={[selected]}
          onOptionSelect={(_e, d) => onChange(withFilter(filters, key, d.optionValue ?? ''))}
        >
          <Option value="">{all}</Option>
          {options[key].map((o) => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
      </Field>
    );
  });
  const end = (
    <>
      <span className="pb-meta" data-testid="value-creation-filter-count">
        {filtered
          ? `${shown} of ${positionsText(positions.length)}`
          : positionsText(positions.length)}
      </span>
      {filtered ? (
        <Button
          size="small"
          appearance="outline"
          data-testid="value-creation-filters-clear"
          onClick={() => onChange({})}
        >
          Clear filters
        </Button>
      ) : null}
    </>
  );
  return (
    <div className="pb-vc-filters" data-testid="value-creation-filters">
      {narrow ? (
        // On a phone the six fields fold under one button that says how many are set.
        <>
          <div className="pb-vc-filters-bar">
            <Button
              size="small"
              icon={<Filter16Regular />}
              aria-expanded={open}
              aria-controls={fieldsId}
              onClick={() => setOpen((was) => !was)}
            >
              {set === 0 ? 'Filters' : `Filters, ${set} set`}
            </Button>
            <span className="pb-vc-filters-end">{end}</span>
          </div>
          {open ? (
            <div id={fieldsId} className="pb-vc-filters-fields">
              {fields}
            </div>
          ) : null}
        </>
      ) : (
        <Toolbar end={end}>{fields}</Toolbar>
      )}
    </div>
  );
}
