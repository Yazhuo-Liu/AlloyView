// Byte-level reading of the per-atom rows of text structure files.
//
// The text parsers split decoded lines on /\s+/ and convert tokens with
// Number(). Reading the bytes directly avoids building a string for every
// line and token. Both must give identical results, so the byte reader handles
// only input on which they provably agree and throws FALLBACK for everything
// else. The caller then decodes the bytes and runs its text parser, which
// produces the result or its own error message:
//
// - Only ASCII is read. A byte >= 0x80 may belong to a Unicode whitespace
//   character (U+00A0, U+2028, U+FEFF, ...) that splits tokens in the text
//   parser, so it forces the fallback. Within ASCII, the blanks inside a line
//   are exactly those of /\s/: tab, vertical tab, form feed, carriage return
//   and space. Lines end at LF, as with split(/\r?\n/); a CR before the LF is
//   one of the blanks.
// - A plain decimal token, `[+-]digits[.digits][(e|E)[+-]digits]` with at
//   least one mantissa digit, whose digits form an integer below 2^53 and
//   whose decimal exponent lies in [-22, 22], is converted as mantissa × 10^k
//   or mantissa / 10^k. Both operands are exact doubles and the operation
//   rounds once, so this is the correctly rounded value, which Number() also
//   returns (Clinger's fast path). A zero mantissa gives ±0 for any exponent.
//   Every other token (more digits, larger exponents, hexadecimal, Infinity,
//   NaN, Fortran `d` exponents, ...) is converted by Number() on its own text,
//   or by Number(text.replace(/[dD]/, 'e')) where the format accepts Fortran
//   exponents, exactly as the text parsers do.

const POW10 = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];
const EXACT_INTEGER_LIMIT = 2 ** 53;
const SHORT_TOKEN_BYTES = 6;

/** Token kinds for AsciiRowReader.readRow(). */
export const SKIP = 0;
export const NUMBER = 1;
export const TEXT = 2;
/** TEXT if the token starts with an ASCII letter, NUMBER otherwise. Such a
 * token is never a finite number for Number(), even after a Fortran `d` is
 * replaced; its value is reported as NaN. */
export const SYMBOL_OR_NUMBER = 3;

/** Thrown when only the text parser can decide the result. */
export const FALLBACK = Object.freeze({ fallback: true });

const textDecoder = new TextDecoder();

/** Byte-level parses attempted and those that fell back to the text parser
 * (for tests and diagnostics). */
export const byteParserStatistics = { attempts: 0, fallbacks: 0 };

/**
 * Run `parseBytes(bytes)`; if it returns null or throws, decode the bytes and
 * return `parseText(text)` instead, which also reports any format error.
 */
export function parseBytesWithFallback(bytes, parseBytes, parseText) {
  byteParserStatistics.attempts += 1;
  let result = null;
  try {
    result = parseBytes(bytes);
  } catch {
    result = null;
  }
  if (result) return result;
  byteParserStatistics.fallbacks += 1;
  return parseText(decodeText(bytes));
}

/** Whether a parser input is binary data rather than text. */
export function isByteInput(input) {
  return ArrayBuffer.isView(input) || Object.prototype.toString.call(input) === '[object ArrayBuffer]';
}

/** The bytes of a Uint8Array, ArrayBuffer or other view, without copying. */
export function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** Decode as Blob.text() does: UTF-8, a leading BOM removed, invalid
 * sequences replaced by U+FFFD. */
export function decodeText(bytes) {
  return textDecoder.decode(bytes);
}

/** The position after the `lineCount`-th LF at or after `from`, or -1. */
export function lineStartAfter(bytes, lineCount, from = 0) {
  let position = from;
  for (let line = 0; line < lineCount; line += 1) {
    const newline = bytes.indexOf(10, position);
    if (newline < 0) return -1;
    position = newline + 1;
  }
  return position;
}

/**
 * Decode only as many leading lines as a header needs. `readHeader(lines,
 * usableLines)` receives the lines as the text parser splits them; when only
 * the start of the data was decoded, the last element stands for the unread
 * rest, only the first `usableLines` elements are real lines, and
 * `readHeader` returns null if it needs more. The decoded prefix grows until
 * the header is complete. The lines equal those of the full text because a
 * UTF-8 sequence never spans a line feed and the prefix ends at one.
 */
export function readHeaderLines(bytes, readHeader) {
  for (let limit = 4096; ; limit *= 16) {
    const complete = limit >= bytes.length;
    const end = complete ? bytes.length : bytes.lastIndexOf(10, limit - 1) + 1;
    const lines = decodeText(bytes.subarray(0, end)).replace(/^\uFEFF/, '').split(/\r?\n/);
    const header = readHeader(lines, complete ? lines.length : lines.length - 1);
    if (header || complete) return header;
  }
}

/** Whether `bytes[from, to)` holds only ASCII blanks and line feeds. */
export function isAsciiBlank(bytes, from, to = bytes.length) {
  for (let index = from; index < to; index += 1) {
    const byte = bytes[index];
    if (byte !== 32 && (byte < 9 || byte > 13)) return false;
  }
  return true;
}

export class AsciiRowReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} position first byte of the first row
   * @param {{ fortranExponents?: boolean }} options convert the tokens that
   *   the fast path rejects as Number(text.replace(/[dD]/, 'e')) instead of
   *   Number(text)
   */
  constructor(bytes, position, { fortranExponents = false } = {}) {
    this.bytes = bytes;
    this.position = position;
    this.end = bytes.length;
    this.fortranExponents = fortranExponents;
    this.strings = new Map();
  }

  /** Whether no bytes remain. */
  atEnd() {
    return this.position >= this.end;
  }

  /** Skip blanks; if the line then starts with `marker` (a byte), skip the
   * line and return true. */
  skipLineStartingWith(marker) {
    const { bytes } = this;
    let position = this.position;
    let byte = bytes[position];
    while (byte === 32 || byte === 9 || byte === 13 || byte === 11 || byte === 12) byte = bytes[++position];
    if (byte !== marker) return false;
    const newline = bytes.indexOf(10, position);
    this.position = newline < 0 ? this.end : newline + 1;
    return true;
  }

  /**
   * Read the tokens of the current line and consume its line feed. Token `i`
   * is handled according to `kinds[i]` (tokens beyond `kinds` are skipped):
   * NUMBER stores its value in `values[i]` and, if the fast path did not
   * apply, its text in `texts[i]`; TEXT stores its text in `texts[i]` and NaN
   * in `values[i]`; SKIP only checks that it is ASCII. Returns the number of
   * tokens, which is 0 for a blank line.
   */
  readRow(kinds, values, texts) {
    // Reading past the end of a typed array yields undefined, which is not a
    // digit, sign, point or exponent marker and ends a token like a blank.
    const bytes = this.bytes;
    const kindCount = kinds.length;
    let position = this.position;
    let count = 0;
    for (;;) {
      let byte = bytes[position];
      while (byte === 32 || byte === 9 || byte === 13 || byte === 11 || byte === 12) byte = bytes[++position];
      if (byte === 10 || byte === undefined) break;
      let kind = count < kindCount ? kinds[count] : SKIP;
      if (kind === SYMBOL_OR_NUMBER) kind = (byte | 32) >= 97 && (byte | 32) <= 122 ? TEXT : NUMBER;
      if (kind === NUMBER) {
        const start = position;
        let negative = false;
        if (byte === 45) {
          negative = true;
          byte = bytes[++position];
        } else if (byte === 43) {
          byte = bytes[++position];
        }
        const integerStart = position;
        let mantissa = 0;
        while (byte >= 48 && byte <= 57) {
          mantissa = mantissa * 10 + (byte - 48);
          byte = bytes[++position];
        }
        let digits = position - integerStart;
        let exponent = 0;
        if (byte === 46) {
          const fractionStart = ++position;
          byte = bytes[position];
          while (byte >= 48 && byte <= 57) {
            mantissa = mantissa * 10 + (byte - 48);
            byte = bytes[++position];
          }
          exponent = fractionStart - position;
          digits -= exponent;
        }
        let exact = digits !== 0;
        if (exact && (byte === 101 || byte === 69)) {
          byte = bytes[++position];
          let exponentNegative = false;
          if (byte === 45) {
            exponentNegative = true;
            byte = bytes[++position];
          } else if (byte === 43) {
            byte = bytes[++position];
          }
          exact = byte >= 48 && byte <= 57;
          let written = 0;
          while (byte >= 48 && byte <= 57) {
            if (written < 1e6) written = written * 10 + (byte - 48);
            byte = bytes[++position];
          }
          exponent += exponentNegative ? -written : written;
        }
        // The token must end at a blank, a line feed or the end of the data.
        if (exact && !(byte > 32 || (byte < 32 && (byte < 9 || byte > 13))) && mantissa < EXACT_INTEGER_LIMIT
            && (mantissa === 0 || (exponent >= -22 && exponent <= 22))) {
          const magnitude = mantissa === 0 ? 0 : exponent < 0 ? mantissa / POW10[-exponent] : mantissa * POW10[exponent];
          values[count] = negative ? -magnitude : magnitude;
        } else {
          const end = this.tokenEnd(start);
          const text = this.text(start, end);
          texts[count] = text;
          values[count] = Number(this.fortranExponents ? text.replace(/[dD]/, 'e') : text);
          position = end;
        }
      } else if (kind === TEXT) {
        const end = this.tokenEnd(position);
        texts[count] = this.sharedText(position, end);
        values[count] = NaN;
        position = end;
      } else {
        position = this.tokenEnd(position);
      }
      count += 1;
    }
    this.position = bytes[position] === 10 ? position + 1 : position;
    return count;
  }

  tokenEnd(start) {
    const { bytes, end } = this;
    let position = start;
    while (position < end) {
      const byte = bytes[position];
      if (byte === 32 || (byte >= 9 && byte <= 13)) break;
      if (byte >= 0x80) throw FALLBACK;
      position += 1;
    }
    return position;
  }

  text(start, end) {
    let text = '';
    for (let index = start; index < end; index += 4096) {
      text += String.fromCharCode.apply(null, this.bytes.subarray(index, Math.min(end, index + 4096)));
    }
    return text;
  }

  // Short tokens such as element symbols repeat on most rows; return one
  // string per distinct token.
  sharedText(start, end) {
    const length = end - start;
    if (length > SHORT_TOKEN_BYTES) return this.text(start, end);
    const { bytes } = this;
    let key = length;
    for (let index = start; index < end; index += 1) key = key * 256 + bytes[index];
    let text = this.strings.get(key);
    if (text === undefined) {
      text = this.text(start, end);
      this.strings.set(key, text);
    }
    return text;
  }
}
