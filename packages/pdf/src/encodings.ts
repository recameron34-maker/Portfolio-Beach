/**
 * The simple-font encodings of ISO 32000-1 Annex D (StandardEncoding, WinAnsiEncoding,
 * MacRomanEncoding) as code-to-glyph-name tables, and the glyph list that maps a glyph name to
 * its Unicode text (the Adobe Glyph List entries those encodings and the standard 14 metrics
 * use, plus the `uniXXXX` and `uXXXX` forms). A name the list does not know decodes to nothing,
 * never to a guess.
 */

const ASCII_NAMES =
  'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright ' +
  'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine ' +
  'colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W ' +
  'X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l ' +
  'm n o p q r s t u v w x y z braceleft bar braceright asciitilde';

const LATIN1_UPPER =
  'Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex ' +
  'Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde ' +
  'Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave ' +
  'aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis ' +
  'igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis ' +
  'divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis';

const LATIN1_SYMBOLS =
  'space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine ' +
  'guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior ' +
  'acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter ' +
  'onehalf threequarters questiondown';

/** An encoding: the glyph name at each code, or undefined where the code is unused. */
export type Encoding = readonly (string | undefined)[];

function table(entries: Record<number, string>): Encoding {
  const out: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined);
  for (const [code, glyph] of Object.entries(entries)) out[Number(code)] = glyph;
  return out;
}

function fill(into: Record<number, string>, start: number, names: string): void {
  names.split(' ').forEach((glyph, i) => {
    into[start + i] = glyph;
  });
}

function buildStandard(): Encoding {
  const entries: Record<number, string> = {};
  fill(entries, 32, ASCII_NAMES);
  entries[39] = 'quoteright';
  entries[96] = 'quoteleft';
  fill(
    entries,
    161,
    'exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft ' +
      'guillemotleft guilsinglleft guilsinglright fi fl',
  );
  fill(entries, 177, 'endash dagger daggerdbl periodcentered');
  fill(
    entries,
    182,
    'paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand',
  );
  entries[191] = 'questiondown';
  fill(entries, 193, 'grave acute circumflex tilde macron breve dotaccent dieresis');
  fill(entries, 202, 'ring cedilla');
  fill(entries, 205, 'hungarumlaut ogonek caron emdash');
  entries[225] = 'AE';
  entries[227] = 'ordfeminine';
  fill(entries, 232, 'Lslash Oslash OE ordmasculine');
  entries[241] = 'ae';
  entries[245] = 'dotlessi';
  fill(entries, 248, 'lslash oslash oe germandbls');
  return table(entries);
}

function buildWinAnsi(): Encoding {
  const entries: Record<number, string> = {};
  fill(entries, 32, ASCII_NAMES);
  // Annex D note 3: the unused codes above 127 show a bullet in WinAnsi.
  for (let code = 127; code < 160; code += 1) entries[code] = 'bullet';
  fill(
    entries,
    128,
    'Euro bullet quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex ' +
      'perthousand Scaron guilsinglleft OE bullet Zcaron bullet bullet quoteleft quoteright ' +
      'quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe ' +
      'bullet zcaron Ydieresis',
  );
  fill(entries, 160, LATIN1_SYMBOLS);
  fill(entries, 192, LATIN1_UPPER);
  return table(entries);
}

function buildMacRoman(): Encoding {
  const entries: Record<number, string> = {};
  fill(entries, 32, ASCII_NAMES);
  fill(
    entries,
    128,
    'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex ' +
      'adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave ' +
      'icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ' +
      'ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls ' +
      'registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus ' +
      'lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ' +
      'ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin ' +
      'approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe ' +
      'endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis ' +
      'Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered ' +
      'quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave ' +
      'Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex ' +
      'Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek ' +
      'caron',
  );
  return table(entries);
}

export const STANDARD_ENCODING: Encoding = buildStandard();
export const WIN_ANSI_ENCODING: Encoding = buildWinAnsi();
export const MAC_ROMAN_ENCODING: Encoding = buildMacRoman();

/** The encoding a /Encoding name selects, or null for a name the reader does not know. */
export function encodingByName(name: string): Encoding | null {
  switch (name) {
    case 'StandardEncoding':
      return STANDARD_ENCODING;
    case 'WinAnsiEncoding':
      return WIN_ANSI_ENCODING;
    case 'MacRomanEncoding':
      return MAC_ROMAN_ENCODING;
    default:
      return null;
  }
}

const GLYPH_LIST_SOURCE: Record<string, number> = {
  quotesingle: 0x27,
  grave: 0x60,
  quoteright: 0x2019,
  quoteleft: 0x2018,
  exclamdown: 0xa1,
  cent: 0xa2,
  sterling: 0xa3,
  fraction: 0x2044,
  yen: 0xa5,
  florin: 0x192,
  section: 0xa7,
  currency: 0xa4,
  quotedblleft: 0x201c,
  guillemotleft: 0xab,
  guilsinglleft: 0x2039,
  guilsinglright: 0x203a,
  fi: 0xfb01,
  fl: 0xfb02,
  endash: 0x2013,
  dagger: 0x2020,
  daggerdbl: 0x2021,
  periodcentered: 0xb7,
  paragraph: 0xb6,
  bullet: 0x2022,
  quotesinglbase: 0x201a,
  quotedblbase: 0x201e,
  quotedblright: 0x201d,
  guillemotright: 0xbb,
  ellipsis: 0x2026,
  perthousand: 0x2030,
  questiondown: 0xbf,
  acute: 0xb4,
  circumflex: 0x2c6,
  tilde: 0x2dc,
  macron: 0xaf,
  breve: 0x2d8,
  dotaccent: 0x2d9,
  dieresis: 0xa8,
  ring: 0x2da,
  cedilla: 0xb8,
  hungarumlaut: 0x2dd,
  ogonek: 0x2db,
  caron: 0x2c7,
  emdash: 0x2014,
  AE: 0xc6,
  ordfeminine: 0xaa,
  Lslash: 0x141,
  Oslash: 0xd8,
  OE: 0x152,
  ordmasculine: 0xba,
  ae: 0xe6,
  dotlessi: 0x131,
  lslash: 0x142,
  oslash: 0xf8,
  oe: 0x153,
  germandbls: 0xdf,
  Euro: 0x20ac,
  Scaron: 0x160,
  scaron: 0x161,
  Zcaron: 0x17d,
  zcaron: 0x17e,
  trademark: 0x2122,
  Ydieresis: 0x178,
  brokenbar: 0xa6,
  copyright: 0xa9,
  logicalnot: 0xac,
  registered: 0xae,
  degree: 0xb0,
  plusminus: 0xb1,
  twosuperior: 0xb2,
  threesuperior: 0xb3,
  mu: 0xb5,
  onesuperior: 0xb9,
  onequarter: 0xbc,
  onehalf: 0xbd,
  threequarters: 0xbe,
  multiply: 0xd7,
  divide: 0xf7,
  Eth: 0xd0,
  eth: 0xf0,
  Thorn: 0xde,
  thorn: 0xfe,
  ydieresis: 0xff,
  notequal: 0x2260,
  infinity: 0x221e,
  lessequal: 0x2264,
  greaterequal: 0x2265,
  partialdiff: 0x2202,
  summation: 0x2211,
  product: 0x220f,
  pi: 0x3c0,
  integral: 0x222b,
  Omega: 0x3a9,
  radical: 0x221a,
  approxequal: 0x2248,
  Delta: 0x2206,
  lozenge: 0x25ca,
  apple: 0xf8ff,
  minus: 0x2212,
  nbspace: 0xa0,
  sfthyphen: 0xad,
  Amacron: 0x100,
  amacron: 0x101,
  Abreve: 0x102,
  abreve: 0x103,
  Aogonek: 0x104,
  aogonek: 0x105,
  Cacute: 0x106,
  cacute: 0x107,
  Ccaron: 0x10c,
  ccaron: 0x10d,
  Dcaron: 0x10e,
  dcaron: 0x10f,
  Dcroat: 0x110,
  dcroat: 0x111,
  Emacron: 0x112,
  emacron: 0x113,
  Edotaccent: 0x116,
  edotaccent: 0x117,
  Eogonek: 0x118,
  eogonek: 0x119,
  Ecaron: 0x11a,
  ecaron: 0x11b,
  Gbreve: 0x11e,
  gbreve: 0x11f,
  Gcommaaccent: 0x122,
  gcommaaccent: 0x123,
  Imacron: 0x12a,
  imacron: 0x12b,
  Iogonek: 0x12e,
  iogonek: 0x12f,
  Idotaccent: 0x130,
  Kcommaaccent: 0x136,
  kcommaaccent: 0x137,
  Lacute: 0x139,
  lacute: 0x13a,
  Lcommaaccent: 0x13b,
  lcommaaccent: 0x13c,
  Lcaron: 0x13d,
  lcaron: 0x13e,
  Nacute: 0x143,
  nacute: 0x144,
  Ncommaaccent: 0x145,
  ncommaaccent: 0x146,
  Ncaron: 0x147,
  ncaron: 0x148,
  Omacron: 0x14c,
  omacron: 0x14d,
  Ohungarumlaut: 0x150,
  ohungarumlaut: 0x151,
  Racute: 0x154,
  racute: 0x155,
  Rcommaaccent: 0x156,
  rcommaaccent: 0x157,
  Rcaron: 0x158,
  rcaron: 0x159,
  Sacute: 0x15a,
  sacute: 0x15b,
  Scedilla: 0x15e,
  scedilla: 0x15f,
  Tcommaaccent: 0x162,
  tcommaaccent: 0x163,
  Tcaron: 0x164,
  tcaron: 0x165,
  Umacron: 0x16a,
  umacron: 0x16b,
  Uring: 0x16e,
  uring: 0x16f,
  Uhungarumlaut: 0x170,
  uhungarumlaut: 0x171,
  Uogonek: 0x172,
  uogonek: 0x173,
  Zacute: 0x179,
  zacute: 0x17a,
  Zdotaccent: 0x17b,
  zdotaccent: 0x17c,
  Scommaaccent: 0x218,
  scommaaccent: 0x219,
  commaaccent: 0xf6c3,
};

function buildGlyphList(): Map<string, string> {
  const out = new Map<string, string>();
  ASCII_NAMES.split(' ').forEach((glyph, i) => out.set(glyph, String.fromCharCode(32 + i)));
  LATIN1_UPPER.split(' ').forEach((glyph, i) => out.set(glyph, String.fromCharCode(192 + i)));
  for (const [glyph, code] of Object.entries(GLYPH_LIST_SOURCE))
    out.set(glyph, String.fromCodePoint(code));
  return out;
}

const GLYPH_LIST = buildGlyphList();
const UNI_NAME = /^uni([0-9A-F]{4})$/;
const U_NAME = /^u([0-9A-F]{4,6})$/;

/**
 * The text a glyph name stands for, or null when the list does not know the name (a `gXX` or
 * `cidXX` name from a subset font, for example). `uniXXXX` and `uXXXX` names decode by their
 * code point; a `.sc`, `.alt` or similar suffix is dropped first, as the glyph list says.
 */
export function glyphToText(glyphName: string): string | null {
  const known = GLYPH_LIST.get(glyphName);
  if (known !== undefined) return known;
  const dot = glyphName.indexOf('.');
  if (dot > 0) return glyphToText(glyphName.slice(0, dot));
  const uni = UNI_NAME.exec(glyphName);
  if (uni) return String.fromCodePoint(Number.parseInt(uni[1] ?? '0', 16));
  const u = U_NAME.exec(glyphName);
  if (u) {
    const code = Number.parseInt(u[1] ?? '0', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : null;
  }
  return null;
}

/** The WinAnsi code of a character, or -1 when WinAnsiEncoding cannot carry it. */
export function winAnsiCode(char: string): number {
  return WIN_ANSI_BY_CHAR.get(char) ?? -1;
}

function buildWinAnsiByChar(): Map<string, number> {
  const out = new Map<string, number>();
  WIN_ANSI_ENCODING.forEach((glyph, code) => {
    if (glyph === undefined || glyph === 'bullet') return;
    const text = glyphToText(glyph);
    if (text !== null && !out.has(text)) out.set(text, code);
  });
  out.set('•', 149);
  out.set(' ', 160);
  out.set('­', 173);
  return out;
}

const WIN_ANSI_BY_CHAR = buildWinAnsiByChar();
