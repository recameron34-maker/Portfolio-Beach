/**
 * The content stream interpreter (ISO 32000-1 sections 8.4, 9.3 and 9.4): the graphics state
 * stack (q, Q, cm), the text object (BT, ET), the text state (Tf, Tc, Tw, Tz, TL, Ts), text
 * positioning (Td, TD, Tm, T*) and text showing (Tj, TJ, ', "). Every string shown becomes one
 * run positioned by the text rendering matrix (font size and rise, then the text matrix, then
 * the current transformation matrix), so x and y are page coordinates with y up. Form XObjects
 * are entered with their /Matrix and resources; images, paths, color, clipping, shading and
 * every other operator are skipped (their operands dropped). Inline images are skipped by their
 * `ID ... EI` extent. Operators are counted against the read limit across the whole document.
 */
import { PdfError } from './errors.js';
import { loadFont, undecodableFont, type LoadedFont } from './fonts.js';
import {
  Parser,
  isArray,
  isDict,
  isName,
  isNumber,
  isOperator,
  isStream,
  isString,
  type PdfDict,
  type PdfObject,
  type PdfStream,
} from './objects.js';
import type { PdfFile } from './xref.js';

/** A transformation matrix [a b c d e f] (section 8.3.3). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied first, then `n` (the PDF convention: `m × n`). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export interface TextRun {
  /** The start of the baseline, in page units (y up). */
  x: number;
  y: number;
  /** The advance along the baseline, in page units. */
  width: number;
  /** The font size as it appears on the page (the text matrix and the CTM applied). */
  size: number;
  /** The base font name, or the resource name when the font has none. */
  font: string;
  text: string;
  /** Present when the font could not decode the run; `text` is then empty, never a guess. */
  undecodable?: true;
}

/** The budget one document's content streams share. */
export interface OperatorBudget {
  used: number;
  max: number;
}

interface GraphicsState {
  ctm: Matrix;
  font: LoadedFont | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  leading: number;
  rise: number;
}

interface Context {
  file: PdfFile;
  budget: OperatorBudget;
  fontCache: Map<PdfDict, LoadedFont>;
  /** Form XObjects on the way in, to stop a form that draws itself. */
  entered: Set<PdfStream>;
  runs: TextRun[];
}

export interface InterpretOptions {
  file: PdfFile;
  /** The page's initial transformation (the media box origin moved to 0,0). */
  ctm: Matrix;
  resources: PdfDict | null;
  budget: OperatorBudget;
  fontCache: Map<PdfDict, LoadedFont>;
}

const number = (o: PdfObject | undefined): number => (isNumber(o) ? o : 0);

async function fontFor(
  context: Context,
  resources: PdfDict | null,
  resourceName: string,
): Promise<LoadedFont> {
  const fonts = await context.file.get(resources, 'Font');
  const dict = isDict(fonts) ? await context.file.get(fonts, resourceName) : null;
  if (!isDict(dict)) return undecodableFont(resourceName);
  const cached = context.fontCache.get(dict);
  if (cached) return cached;
  const loaded = await loadFont(context.file, dict, resourceName);
  context.fontCache.set(dict, loaded);
  return loaded;
}

class Interpreter {
  private state: GraphicsState;
  private readonly stack: GraphicsState[] = [];
  private textMatrix: Matrix = IDENTITY;
  private lineMatrix: Matrix = IDENTITY;

  constructor(
    private readonly context: Context,
    private readonly resources: PdfDict | null,
    ctm: Matrix,
    private readonly depth: number,
    inherited?: GraphicsState,
  ) {
    this.state = inherited
      ? { ...inherited, ctm }
      : {
          ctm,
          font: null,
          fontSize: 0,
          charSpacing: 0,
          wordSpacing: 0,
          horizontalScale: 1,
          leading: 0,
          rise: 0,
        };
  }

  async run(data: Uint8Array): Promise<void> {
    const parser = new Parser(data, {
      maxDepth: this.context.file.limits.maxDepth,
      allowRefs: false,
    });
    let operands: PdfObject[] = [];
    for (let object = parser.parse(); object !== undefined; object = parser.parse()) {
      if (!isOperator(object)) {
        operands.push(object);
        if (operands.length > 64) operands = operands.slice(-64);
        continue;
      }
      this.context.budget.used += 1;
      if (this.context.budget.used > this.context.budget.max) {
        throw new PdfError(
          `The document holds more than the ${this.context.budget.max} content operators the reader accepts`,
          'too_large',
        );
      }
      if (object.op === 'ID') {
        skipInlineImage(parser);
      } else {
        await this.execute(object.op, operands);
      }
      operands = [];
    }
  }

  private async execute(op: string, args: PdfObject[]): Promise<void> {
    const n = (i: number): number => number(args[i]);
    switch (op) {
      case 'q':
        this.stack.push({ ...this.state });
        if (this.stack.length > this.context.file.limits.maxDepth) {
          throw new PdfError(
            `A content stream nests more than the ${this.context.file.limits.maxDepth} saved states the reader accepts`,
            'too_large',
          );
        }
        break;
      case 'Q': {
        const restored = this.stack.pop();
        if (restored) this.state = restored;
        break;
      }
      case 'cm':
        if (args.length >= 6) {
          this.state.ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], this.state.ctm);
        }
        break;
      case 'BT':
        this.textMatrix = IDENTITY;
        this.lineMatrix = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const name = args[0];
        this.state.fontSize = n(1);
        this.state.font = isName(name)
          ? await fontFor(this.context, this.resources, name.name)
          : null;
        break;
      }
      case 'Td':
        this.newLine(n(0), n(1));
        break;
      case 'TD':
        this.state.leading = -n(1);
        this.newLine(n(0), n(1));
        break;
      case 'Tm':
        if (args.length >= 6) {
          this.lineMatrix = [n(0), n(1), n(2), n(3), n(4), n(5)];
          this.textMatrix = this.lineMatrix;
        }
        break;
      case 'T*':
        this.newLine(0, -this.state.leading);
        break;
      case 'TL':
        this.state.leading = n(0);
        break;
      case 'Tc':
        this.state.charSpacing = n(0);
        break;
      case 'Tw':
        this.state.wordSpacing = n(0);
        break;
      case 'Tz':
        this.state.horizontalScale = n(0) / 100;
        break;
      case 'Ts':
        this.state.rise = n(0);
        break;
      case 'Tj': {
        const text = args[args.length - 1];
        if (isString(text)) this.show(text.bytes);
        break;
      }
      case "'": {
        this.newLine(0, -this.state.leading);
        const text = args[args.length - 1];
        if (isString(text)) this.show(text.bytes);
        break;
      }
      case '"': {
        this.state.wordSpacing = n(0);
        this.state.charSpacing = n(1);
        this.newLine(0, -this.state.leading);
        const text = args[2];
        if (isString(text)) this.show(text.bytes);
        break;
      }
      case 'TJ': {
        const list = args[args.length - 1];
        if (!isArray(list)) break;
        for (const item of list.items) {
          if (isString(item)) this.show(item.bytes);
          else if (isNumber(item)) this.adjust(item);
        }
        break;
      }
      case 'Do': {
        const name = args[0];
        if (isName(name)) await this.drawXObject(name.name);
        break;
      }
      default:
        break;
    }
  }

  private newLine(tx: number, ty: number): void {
    this.lineMatrix = multiply(translation(tx, ty), this.lineMatrix);
    this.textMatrix = this.lineMatrix;
  }

  /** A TJ number: moves the text matrix by -adjustment/1000 in text space, scaled. */
  private adjust(adjustment: number): void {
    const tx = (-adjustment / 1000) * this.state.fontSize * this.state.horizontalScale;
    this.textMatrix = multiply(translation(tx, 0), this.textMatrix);
  }

  private show(bytes: Uint8Array): void {
    const { state } = this;
    const font = state.font ?? undecodableFont('');
    const start = this.renderingMatrix();
    const codes = font.codes(bytes);
    let text = '';
    let undecodable = false;
    for (const code of codes) {
      const piece = font.text(code);
      if (piece === null) undecodable = true;
      else text += piece;
      const advance =
        (font.width(code) * state.fontSize +
          state.charSpacing +
          (font.isWordSpace(code) ? state.wordSpacing : 0)) *
        state.horizontalScale;
      this.textMatrix = multiply(translation(advance, 0), this.textMatrix);
    }
    const end = this.renderingMatrix();
    const run: TextRun = {
      x: start[4],
      y: start[5],
      width: Math.hypot(end[4] - start[4], end[5] - start[5]),
      // The length of the rendering matrix's vertical unit vector: the font size as drawn.
      size: Math.hypot(start[2], start[3]),
      font: font.name,
      text: undecodable ? '' : text,
    };
    if (undecodable) run.undecodable = true;
    this.context.runs.push(run);
  }

  /** [Tfs×Th 0 0 Tfs 0 Ts] × Tm × CTM (section 9.4.4). */
  private renderingMatrix(): Matrix {
    const { state } = this;
    const params: Matrix = [
      state.fontSize * state.horizontalScale,
      0,
      0,
      state.fontSize,
      0,
      state.rise,
    ];
    return multiply(multiply(params, this.textMatrix), state.ctm);
  }

  private async drawXObject(resourceName: string): Promise<void> {
    const { file } = this.context;
    const xobjects = await file.get(this.resources, 'XObject');
    const stream = isDict(xobjects) ? await file.get(xobjects, resourceName) : null;
    if (!isStream(stream)) return;
    const subtype = await file.get(stream.dict, 'Subtype');
    if (!isName(subtype, 'Form')) return;
    if (this.context.entered.has(stream)) return;
    if (this.depth + 1 > file.limits.maxDepth) {
      throw new PdfError(
        `Forms nest deeper than the ${file.limits.maxDepth} levels the reader accepts`,
        'too_large',
      );
    }
    const matrixObject = await file.get(stream.dict, 'Matrix');
    let matrix: Matrix = IDENTITY;
    if (isArray(matrixObject) && matrixObject.items.length >= 6) {
      const values: number[] = [];
      for (const item of matrixObject.items.slice(0, 6))
        values.push(number(await file.resolve(item)));
      matrix = values as unknown as Matrix;
    }
    const ownResources = await file.get(stream.dict, 'Resources');
    const resources = isDict(ownResources) ? ownResources : this.resources;
    const ctm = multiply(matrix, this.state.ctm);
    this.context.entered.add(stream);
    try {
      const inner = new Interpreter(this.context, resources, ctm, this.depth + 1, this.state);
      await inner.run(await file.streamData(stream));
    } finally {
      this.context.entered.delete(stream);
    }
  }
}

/** Skips the binary data of an inline image: after `ID` and one white-space byte, up to `EI`. */
function skipInlineImage(parser: Parser): void {
  const { bytes } = parser.lexer;
  let i = parser.pos + 1;
  while (i + 1 < bytes.length) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      (i === 0 || isSpace(bytes[i - 1] ?? 0)) &&
      (i + 2 >= bytes.length || isSpace(bytes[i + 2] ?? 0))
    ) {
      parser.pos = i + 2;
      return;
    }
    i += 1;
  }
  parser.pos = bytes.length;
}

function isSpace(byte: number): boolean {
  return (
    byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0
  );
}

/** Interprets one page's content and returns its runs in drawing order. */
export async function interpretContent(
  data: Uint8Array,
  options: InterpretOptions,
): Promise<TextRun[]> {
  const context: Context = {
    file: options.file,
    budget: options.budget,
    fontCache: options.fontCache,
    entered: new Set(),
    runs: [],
  };
  const interpreter = new Interpreter(context, options.resources, options.ctm, 0);
  await interpreter.run(data);
  return context.runs;
}
