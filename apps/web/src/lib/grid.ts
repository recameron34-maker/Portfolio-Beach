import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { derived, rgbTriplet, tokens } from '../app/theme.js';

ModuleRegistry.registerModules([AllCommunityModule]);

const headerRule = `rgba(${rgbTriplet(tokens.ui.bg)}, 0.18)`;
function quartz(rowHeight: number) {
  return themeQuartz.withParams({
    accentColor: tokens.brand.accent,
    backgroundColor: tokens.ui.bg,
    foregroundColor: tokens.ui.text,
    borderColor: tokens.ui.border,
    browserColorScheme: 'light',
    wrapperBorder: true,
    wrapperBorderRadius: 8,
    borderRadius: 4,
    headerBackgroundColor: tokens.brand.primary,
    headerTextColor: tokens.ui.bg,
    headerFontSize: 12,
    headerFontWeight: 600,
    headerHeight: 36,
    headerColumnBorder: { color: headerRule },
    headerColumnResizeHandleColor: `rgba(${rgbTriplet(tokens.ui.bg)}, 0.55)`,
    rowHeight,
    rowBorder: { color: derived.hairline },
    columnBorder: false,
    pinnedColumnBorder: { color: tokens.ui.border },
    oddRowBackgroundColor: tokens.ui.bg,
    rowHoverColor: derived.primaryTint4,
    selectedRowBackgroundColor: derived.primaryTint8,
    cellHorizontalPadding: 12,
    fontFamily: 'inherit',
    fontSize: 13,
    spacing: 6,
    iconSize: 14,
    focusShadow: `inset 0 0 0 2px ${tokens.brand.accent}`,
  });
}
/** The two row densities every grid offers; colours come only from brand tokens. */
export const gridThemes = { comfortable: quartz(36), compact: quartz(30) };
