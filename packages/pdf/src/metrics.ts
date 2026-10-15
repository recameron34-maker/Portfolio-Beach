/**
 * The widths of the standard 14 fonts (ISO 32000-1 section 9.6.2.2), from the Adobe font metrics
 * (AFM) files of the core set, in glyph space (1/1000 of the font size): Helvetica, Helvetica-Bold
 * and Courier (every Courier glyph is 600 wide). Helvetica-Oblique shares Helvetica's widths and
 * Helvetica-BoldOblique shares Helvetica-Bold's, as the AFM files do. The Times faces use the
 * Helvetica tables of the same weight: an approximation (Times is narrower, by about 10 percent
 * on running text), stated here and in the README, good enough to lay out a synthetic page and
 * to advance through a Times run when reading. Symbol and ZapfDingbats have no table: their
 * text is undecodable without a ToUnicode map and is reported so.
 */
import { WIN_ANSI_ENCODING, glyphToText, winAnsiCode } from './encodings.js';
import { PdfError } from './errors.js';

/** The standard 14 text faces the writer and the measurer accept by name. */
export type StandardFont =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique';

export const STANDARD_FONTS: readonly StandardFont[] = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
];

export function isStandardFont(name: string): name is StandardFont {
  return (STANDARD_FONTS as readonly string[]).includes(name);
}

const HELVETICA =
  'space 278 exclam 278 quotedbl 355 numbersign 556 dollar 556 percent 889 ampersand 667 ' +
  'quoteright 222 parenleft 333 parenright 333 asterisk 389 plus 584 comma 278 hyphen 333 ' +
  'period 278 slash 278 zero 556 one 556 two 556 three 556 four 556 five 556 six 556 seven 556 ' +
  'eight 556 nine 556 colon 278 semicolon 278 less 584 equal 584 greater 584 question 556 ' +
  'at 1015 A 667 B 667 C 722 D 722 E 667 F 611 G 778 H 722 I 278 J 500 K 667 L 556 M 833 N 722 ' +
  'O 778 P 667 Q 778 R 722 S 667 T 611 U 722 V 667 W 944 X 667 Y 667 Z 611 bracketleft 278 ' +
  'backslash 278 bracketright 278 asciicircum 469 underscore 556 quoteleft 222 a 556 b 556 ' +
  'c 500 d 556 e 556 f 278 g 556 h 556 i 222 j 222 k 500 l 222 m 833 n 556 o 556 p 556 q 556 ' +
  'r 333 s 500 t 278 u 556 v 500 w 722 x 500 y 500 z 500 braceleft 334 bar 260 braceright 334 ' +
  'asciitilde 584 exclamdown 333 cent 556 sterling 556 fraction 167 yen 556 florin 556 ' +
  'section 556 currency 556 quotesingle 191 quotedblleft 333 guillemotleft 556 ' +
  'guilsinglleft 333 guilsinglright 333 fi 500 fl 500 endash 556 dagger 556 daggerdbl 556 ' +
  'periodcentered 278 paragraph 537 bullet 350 quotesinglbase 222 quotedblbase 333 ' +
  'quotedblright 333 guillemotright 556 ellipsis 1000 perthousand 1000 questiondown 611 ' +
  'grave 333 acute 333 circumflex 333 tilde 333 macron 333 breve 333 dotaccent 333 ' +
  'dieresis 333 ring 333 cedilla 333 hungarumlaut 333 ogonek 333 caron 333 emdash 1000 ' +
  'AE 1000 ordfeminine 370 Lslash 556 Oslash 778 OE 1000 ordmasculine 365 ae 889 ' +
  'dotlessi 278 lslash 222 oslash 611 oe 944 germandbls 611 Idieresis 278 eacute 556 ' +
  'abreve 556 uhungarumlaut 556 ecaron 556 Ydieresis 667 divide 584 Yacute 667 ' +
  'Acircumflex 667 aacute 556 Ucircumflex 722 yacute 500 scommaaccent 500 ecircumflex 556 ' +
  'Uring 722 Udieresis 722 aogonek 556 Uacute 722 uogonek 556 Edieresis 667 Dcroat 722 ' +
  'commaaccent 250 copyright 737 Emacron 667 ccaron 500 aring 556 Ncommaaccent 722 ' +
  'lacute 222 agrave 556 Tcommaaccent 611 Cacute 722 atilde 556 Edotaccent 667 scaron 500 ' +
  'scedilla 500 iacute 278 lozenge 471 Rcaron 722 Gcommaaccent 778 ucircumflex 556 ' +
  'acircumflex 556 Amacron 667 rcaron 333 ccedilla 500 Zdotaccent 611 Thorn 667 Omacron 778 ' +
  'Racute 722 Sacute 667 dcaron 643 Umacron 722 uring 556 threesuperior 334 Ograve 778 ' +
  'Agrave 667 Abreve 667 multiply 584 uacute 556 Tcaron 611 partialdiff 476 ydieresis 500 ' +
  'Nacute 722 icircumflex 278 Ecircumflex 667 adieresis 556 edieresis 556 cacute 500 ' +
  'nacute 556 umacron 556 Ncaron 722 Iacute 278 plusminus 584 brokenbar 260 registered 737 ' +
  'Gbreve 778 Idotaccent 278 summation 600 Egrave 667 racute 333 omacron 556 Zacute 611 ' +
  'Zcaron 611 greaterequal 549 Eth 722 Ccedilla 722 lcommaaccent 222 tcaron 317 eogonek 556 ' +
  'Uogonek 722 Aacute 667 Adieresis 667 egrave 556 zacute 500 iogonek 222 Oacute 778 ' +
  'oacute 556 amacron 556 sacute 500 idieresis 278 Ocircumflex 778 Ugrave 722 Delta 612 ' +
  'thorn 556 twosuperior 333 Odieresis 778 mu 556 igrave 278 ohungarumlaut 556 Eogonek 667 ' +
  'dcroat 556 threequarters 834 Scedilla 667 lcaron 299 Kcommaaccent 667 Lacute 556 ' +
  'trademark 1000 edotaccent 556 Igrave 278 Imacron 278 Lcaron 556 onehalf 834 lessequal 549 ' +
  'ocircumflex 556 ntilde 556 Uhungarumlaut 722 Eacute 667 emacron 556 gbreve 556 ' +
  'onequarter 834 Scaron 667 Scommaaccent 667 Ohungarumlaut 778 degree 400 ograve 556 ' +
  'Ccaron 722 ugrave 556 radical 453 Dcaron 722 rcommaaccent 333 Ntilde 722 otilde 556 ' +
  'Rcommaaccent 722 Lcommaaccent 556 Atilde 667 Aogonek 667 Aring 667 Otilde 778 ' +
  'zdotaccent 500 Ecaron 667 Iogonek 278 kcommaaccent 500 minus 584 Icircumflex 278 ' +
  'ncaron 556 tcommaaccent 278 logicalnot 584 odieresis 556 udieresis 556 notequal 549 ' +
  'gcommaaccent 556 eth 556 zcaron 500 ncommaaccent 556 onesuperior 333 imacron 278 Euro 556';

const HELVETICA_BOLD =
  'space 278 exclam 333 quotedbl 474 numbersign 556 dollar 556 percent 889 ampersand 722 ' +
  'quoteright 278 parenleft 333 parenright 333 asterisk 389 plus 584 comma 278 hyphen 333 ' +
  'period 278 slash 278 zero 556 one 556 two 556 three 556 four 556 five 556 six 556 seven 556 ' +
  'eight 556 nine 556 colon 333 semicolon 333 less 584 equal 584 greater 584 question 611 ' +
  'at 975 A 722 B 722 C 722 D 722 E 667 F 611 G 778 H 722 I 278 J 556 K 722 L 611 M 833 N 722 ' +
  'O 778 P 667 Q 778 R 722 S 667 T 611 U 722 V 667 W 944 X 667 Y 667 Z 611 bracketleft 333 ' +
  'backslash 278 bracketright 333 asciicircum 584 underscore 556 quoteleft 278 a 556 b 611 ' +
  'c 556 d 611 e 556 f 333 g 611 h 611 i 278 j 278 k 556 l 278 m 889 n 611 o 611 p 611 q 611 ' +
  'r 389 s 556 t 333 u 611 v 556 w 778 x 556 y 556 z 500 braceleft 389 bar 280 braceright 389 ' +
  'asciitilde 584 exclamdown 333 cent 556 sterling 556 fraction 167 yen 556 florin 556 ' +
  'section 556 currency 556 quotesingle 238 quotedblleft 500 guillemotleft 556 ' +
  'guilsinglleft 333 guilsinglright 333 fi 611 fl 611 endash 556 dagger 556 daggerdbl 556 ' +
  'periodcentered 278 paragraph 556 bullet 350 quotesinglbase 278 quotedblbase 500 ' +
  'quotedblright 500 guillemotright 556 ellipsis 1000 perthousand 1000 questiondown 611 ' +
  'grave 333 acute 333 circumflex 333 tilde 333 macron 333 breve 333 dotaccent 333 ' +
  'dieresis 333 ring 333 cedilla 333 hungarumlaut 333 ogonek 333 caron 333 emdash 1000 ' +
  'AE 1000 ordfeminine 370 Lslash 611 Oslash 778 OE 1000 ordmasculine 365 ae 889 ' +
  'dotlessi 278 lslash 278 oslash 611 oe 944 germandbls 611 Idieresis 278 eacute 556 ' +
  'abreve 556 uhungarumlaut 611 ecaron 556 Ydieresis 667 divide 584 Yacute 667 ' +
  'Acircumflex 722 aacute 556 Ucircumflex 722 yacute 556 scommaaccent 556 ecircumflex 556 ' +
  'Uring 722 Udieresis 722 aogonek 556 Uacute 722 uogonek 611 Edieresis 667 Dcroat 722 ' +
  'commaaccent 250 copyright 737 Emacron 667 ccaron 556 aring 556 Ncommaaccent 722 ' +
  'lacute 278 agrave 556 Tcommaaccent 611 Cacute 722 atilde 556 Edotaccent 667 scaron 556 ' +
  'scedilla 556 iacute 278 lozenge 494 Rcaron 722 Gcommaaccent 778 ucircumflex 611 ' +
  'acircumflex 556 Amacron 722 rcaron 389 ccedilla 556 Zdotaccent 611 Thorn 667 Omacron 778 ' +
  'Racute 722 Sacute 667 dcaron 743 Umacron 722 uring 611 threesuperior 333 Ograve 778 ' +
  'Agrave 722 Abreve 722 multiply 584 uacute 611 Tcaron 611 partialdiff 494 ydieresis 556 ' +
  'Nacute 722 icircumflex 278 Ecircumflex 667 adieresis 556 edieresis 556 cacute 556 ' +
  'nacute 611 umacron 611 Ncaron 722 Iacute 278 plusminus 584 brokenbar 280 registered 737 ' +
  'Gbreve 778 Idotaccent 278 summation 600 Egrave 667 racute 389 omacron 611 Zacute 611 ' +
  'Zcaron 611 greaterequal 549 Eth 722 Ccedilla 722 lcommaaccent 278 tcaron 389 eogonek 556 ' +
  'Uogonek 722 Aacute 722 Adieresis 722 egrave 556 zacute 500 iogonek 278 Oacute 778 ' +
  'oacute 611 amacron 556 sacute 556 idieresis 278 Ocircumflex 778 Ugrave 722 Delta 612 ' +
  'thorn 611 twosuperior 333 Odieresis 778 mu 611 igrave 278 ohungarumlaut 611 Eogonek 667 ' +
  'dcroat 611 threequarters 834 Scedilla 667 lcaron 400 Kcommaaccent 722 Lacute 611 ' +
  'trademark 1000 edotaccent 556 Igrave 278 Imacron 278 Lcaron 611 onehalf 834 lessequal 549 ' +
  'ocircumflex 611 ntilde 611 Uhungarumlaut 722 Eacute 667 emacron 556 gbreve 611 ' +
  'onequarter 834 Scaron 667 Scommaaccent 667 Ohungarumlaut 778 degree 400 ograve 611 ' +
  'Ccaron 722 ugrave 611 radical 549 Dcaron 722 rcommaaccent 389 Ntilde 722 otilde 611 ' +
  'Rcommaaccent 722 Lcommaaccent 611 Atilde 722 Aogonek 722 Aring 722 Otilde 778 ' +
  'zdotaccent 500 Ecaron 667 Iogonek 278 kcommaaccent 556 minus 584 Icircumflex 278 ' +
  'ncaron 611 tcommaaccent 333 logicalnot 584 odieresis 611 udieresis 611 notequal 549 ' +
  'gcommaaccent 611 eth 611 zcaron 500 ncommaaccent 611 onesuperior 333 imacron 278 Euro 556';

const COURIER_WIDTH = 600;

function parseTable(source: string): Map<string, number> {
  const out = new Map<string, number>();
  const parts = source.split(' ');
  for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i] ?? '', Number(parts[i + 1]));
  return out;
}

const HELVETICA_WIDTHS = parseTable(HELVETICA);
const HELVETICA_BOLD_WIDTHS = parseTable(HELVETICA_BOLD);

/** A width table: glyph name to width in glyph space, with the width for an unknown glyph. */
export interface WidthTable {
  /** The width of a glyph by name, or null when the table has no such glyph. */
  width(glyphName: string): number | null;
}

const helveticaTable = (widths: Map<string, number>): WidthTable => ({
  width: (glyphName) => widths.get(glyphName) ?? null,
});
const courierTable: WidthTable = {
  width: (glyphName) => (glyphToText(glyphName) === null ? null : COURIER_WIDTH),
};

/** The width table of a standard font, or null for Symbol, ZapfDingbats and unknown names. */
export function standardWidths(font: string): WidthTable | null {
  const standard = standardFontFor(font);
  if (standard === null) return null;
  if (standard.startsWith('Courier')) return courierTable;
  const bold =
    standard === 'Helvetica-Bold' ||
    standard === 'Helvetica-BoldOblique' ||
    standard === 'Times-Bold' ||
    standard === 'Times-BoldItalic';
  return helveticaTable(bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS);
}

/**
 * The standard font a base font name stands for, with the subset tag (`ABCDEF+`) dropped and
 * the usual aliases folded (Arial to Helvetica, TimesNewRoman to Times, CourierNew to Courier,
 * the `,Bold` and `-BoldMT` style suffixes), or null when it is none of the 12 text faces.
 */
export function standardFontFor(baseFont: string): StandardFont | null {
  let name = baseFont;
  const plus = name.indexOf('+');
  if (plus === 6) name = name.slice(7);
  if (isStandardFont(name)) return name;
  const lower = name.toLowerCase().replace(/[\s_]/g, '');
  const bold = /bold|black|heavy|semibold|demibold/.test(lower);
  const italic = /italic|oblique/.test(lower);
  let family: 'Helvetica' | 'Times' | 'Courier';
  if (lower.startsWith('courier') || lower.startsWith('mono')) family = 'Courier';
  else if (lower.startsWith('times') || lower.startsWith('georgia') || lower.startsWith('cambria'))
    family = 'Times';
  else if (
    lower.startsWith('helvetica') ||
    lower.startsWith('arial') ||
    lower.startsWith('calibri') ||
    lower.startsWith('verdana') ||
    lower.startsWith('segoe') ||
    lower.startsWith('tahoma')
  )
    family = 'Helvetica';
  else return null;
  if (family === 'Times') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return `${family}${suffix}` as StandardFont;
}

/**
 * The width of `text` set in a standard font at `size` points, from the embedded metrics
 * (WinAnsi text only; a character WinAnsi cannot carry is refused, as the writer refuses it).
 */
export function measureText(text: string, font: StandardFont, size: number): number {
  if (!isStandardFont(font)) {
    throw new PdfError(
      `${String(font)} is not one of the standard fonts the measurer knows`,
      'invalid_input',
    );
  }
  if (!Number.isFinite(size) || size < 0) {
    throw new PdfError(`A font size of ${size} cannot be measured`, 'invalid_input');
  }
  const table = standardWidths(font);
  if (!table) throw new PdfError(`${font} has no width table`, 'invalid_input');
  let total = 0;
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code < 0) {
      throw new PdfError(
        `The text "${text}" holds the character "${char}" (U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}), which WinAnsiEncoding cannot carry`,
        'invalid_input',
      );
    }
    const glyph = WIN_ANSI_ENCODING[code] ?? 'bullet';
    total += table.width(glyph) ?? 0;
  }
  return (total * size) / 1000;
}
