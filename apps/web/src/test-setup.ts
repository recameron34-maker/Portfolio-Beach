import '@testing-library/jest-dom/vitest';

/**
 * Fluent's focus manager (tabster) hides from assistive technology every modal dialog that is not
 * the active one, and learns which one is active from a focus event. On a loaded machine jsdom
 * can open a dialog and give it the focus before tabster has registered it: Fluent then finds no
 * field to focus and focuses the dialog itself, tabster misses that it became active, no later
 * focus event comes, and the dialog stays hidden, so no role query can find it (seen as "Unable
 * to find role dialog" on a dialog that is on the page). A person would click into the dialog.
 * This does the same and nothing more: when the dialog that holds the focus on itself is marked
 * hidden, the focus moves to its first field, which is where Fluent puts it when all is well.
 */
const FIELDS =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])';

new MutationObserver((records) => {
  for (const record of records) {
    const dialog = record.target;
    if (
      dialog instanceof HTMLElement &&
      dialog.getAttribute('role') === 'dialog' &&
      dialog.getAttribute('aria-hidden') === 'true' &&
      document.activeElement === dialog
    )
      dialog.querySelector<HTMLElement>(FIELDS)?.focus();
  }
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['aria-hidden'],
  subtree: true,
});
