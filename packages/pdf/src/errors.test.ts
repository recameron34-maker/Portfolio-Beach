import { describe, expect, it } from 'vitest';
import { PdfError } from './errors.js';

describe('PdfError', () => {
  it('carries a code, a plain message and the cause', () => {
    const cause = new Error('zlib said no');
    const error = new PdfError('The stream could not be inflated', 'corrupt', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PdfError');
    expect(error.code).toBe('corrupt');
    expect(error.message).toBe('The stream could not be inflated');
    expect(error.cause).toBe(cause);
  });

  it('works without a cause', () => {
    const error = new PdfError('Not a PDF', 'not_pdf');
    expect(error.cause).toBeUndefined();
    expect(error.code).toBe('not_pdf');
  });
});
