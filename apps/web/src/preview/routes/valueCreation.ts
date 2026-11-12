import {
  matchesValueCreationFilters,
  valueCreation,
  valueCreationExportQuery,
} from '@pb/contracts';
import { parseCsv, toCsv } from '@pb/validation';
import { getKey } from '../keys.js';
import { problem, textResponse } from '../problems.js';
import { defineSimRoute } from './common.js';

/*
 * The value creation export under the view's filters (docs/04 M13). The tabs filter and roll up
 * in the page over the one recorded answer, so the preview records nothing per filter; the export
 * is the one request that carries the filters. It is answered from the credential's own two
 * recordings: the rows of the recorded view that pass the filters, by the contract's rule
 * (matchesValueCreationFilters, the rule the API applies), pick the lines of the recorded CSV.
 * Nothing is computed and no column is rebuilt here, so the file is the API's own, narrowed.
 */

const VIEW_PATH = '/api/v1/analytics/value-creation';
const EXPORT_PATH = '/api/v1/analytics/value-creation/export';
/** The column that names the position of a line (VALUE_CREATION_CSV_COLUMNS in apps/api). */
const ID_COLUMN = 'investmentId';

/** GET /api/v1/analytics/value-creation/export: the recorded CSV, narrowed to the rows the filters leave. */
export const valueCreationExportRoute = defineSimRoute({
  method: 'GET',
  path: EXPORT_PATH,
  what: 'query',
  body: null,
  query: valueCreationExportQuery,
  handle: (req, ctx) => {
    const outside = (): Response =>
      problem(404, 'not-found', 'This request is outside the recorded preview', {
        instance: req.url.pathname,
      });
    const recorded = ctx.recordings.byKey(getKey(req.credential, EXPORT_PATH));
    if (recorded === undefined) return outside();
    const { asOf, ...filters } = req.query;
    const replay = (): Response =>
      new Response(recorded.text, {
        status: recorded.status,
        headers: { 'content-type': recorded.contentType, 'x-request-id': 'preview' },
      });
    // Whatever the API answered this credential that is not a file is replayed as it is.
    if (recorded.status !== 200) return replay();
    const view = ctx.recordings.read(req.credential, VIEW_PATH, valueCreation);
    if (view === undefined || (asOf !== undefined && asOf !== view.asOf)) return outside();
    if (Object.values(filters).every((value) => value === undefined)) return replay();
    const keep = new Set(
      view.positions.filter((p) => matchesValueCreationFilters(p, filters)).map((p) => p.id),
    );
    const table = parseCsv(recorded.text);
    const idAt = table.header.indexOf(ID_COLUMN);
    if (idAt < 0) return outside();
    return textResponse(
      200,
      toCsv(
        table.header,
        table.rows.filter((row) => keep.has(row[idAt] ?? '')),
      ),
      { mediaType: 'text/csv', fileName: `value-creation-${view.asOf}.csv`, simulated: true },
    );
  },
});
