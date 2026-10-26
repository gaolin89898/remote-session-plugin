/**
 * Local stand-in for `@deepseek-ai/dsh-spill-policy/notice` (browser-safe
 * helpers). The proxy shim cannot satisfy named exports through esbuild's
 * `__toESM`, so the two functions are implemented here verbatim from the
 * official package so spill notices still parse and no UI path crashes.
 */

const OPEN = '(';
const CLOSE = ')';
const LOCATION = ' Full formatted result stored at: ';
const GUIDANCE_SEPARATOR = '. ';
const SEPARATOR = '\n\n';

function describeOmitted(omitted: { kind: string; count?: number }, unit: string): string {
  switch (omitted.kind) {
    case 'none':
      return '';
    case 'exact':
      return `Omitted ${omitted.count} ${unit}.`;
    case 'unknown':
      return `More ${unit} were omitted.`;
    default:
      return '';
  }
}

const EXACT_OMISSION = describeOmitted({ kind: 'exact', count: 0 }, 'bytes');
const COUNT_OFFSET = EXACT_OMISSION.indexOf('0');
const COUNT_SUFFIX = EXACT_OMISSION.slice(COUNT_OFFSET + 1);

export function formatSpillNotice(
  omitted: { kind: string; count?: number },
  ref: { locator: string; retrievalHint: string },
  images = 0,
): string {
  const imageNotice = images > 0 ? ` Omitted ${images} images.` : '';
  return `${OPEN}${describeOmitted(omitted, 'bytes')}${imageNotice}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`;
}

function isOmission(text: string): boolean {
  const imageNotice = / Omitted ([1-9][0-9]*) images\.$/.exec(text);
  if (imageNotice !== null) {
    if (!Number.isSafeInteger(Number(imageNotice[1]))) return false;
    text = text.slice(0, imageNotice.index);
  }
  if (text === describeOmitted({ kind: 'none' }, 'bytes') || text === describeOmitted({ kind: 'unknown' }, 'bytes')) {
    return true;
  }
  const count = Number(text.slice(COUNT_OFFSET, text.length - COUNT_SUFFIX.length));
  return (
    Number.isSafeInteger(count) &&
    count >= 0 &&
    text === describeOmitted({ kind: 'exact', count }, 'bytes')
  );
}

export function hasSpillNotice(text: string): boolean {
  if (typeof text !== 'string' || !text.endsWith(CLOSE)) return false;
  let start = 0;
  for (;;) {
    const next = text.indexOf(`${SEPARATOR}${OPEN}`, start);
    const candidate = text.slice(start, next < 0 ? -CLOSE.length : next);
    const location = candidate.indexOf(LOCATION, OPEN.length);
    if (candidate.startsWith(OPEN) && location >= 0 && isOmission(candidate.slice(OPEN.length, location))) {
      return text.indexOf(GUIDANCE_SEPARATOR, start + location + LOCATION.length) >= 0;
    }
    if (next < 0) return false;
    start = next + SEPARATOR.length;
  }
}
