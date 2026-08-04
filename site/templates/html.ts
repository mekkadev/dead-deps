/**
 * Escaping and formatting primitives shared by every template.
 *
 * Dataset text is hand-written prose from `data/successors.yaml`: it contains
 * quotes, angle brackets, ampersands and the occasional `<script>` mention.
 * Nothing from the dataset reaches the output without passing through `esc`.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escape a value for both text nodes and quoted attribute values. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Collapse folded-YAML prose into a single clean line. */
export function plain(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** Split prose into paragraphs on blank lines, collapsing the rest. */
export function paragraphs(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '');
}

/**
 * Escaped prose with markdown-style `code spans` turned into real `<code>`
 * elements. The dataset is written by hand in a markdown habit, and printing
 * literal backticks on the page would look like a bug.
 */
export function prose(value: string | null | undefined): string {
  return esc(plain(value)).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/** Same prose with the backticks simply removed, for meta tags and JSON-LD. */
export function deticked(value: string | null | undefined): string {
  return plain(value).replace(/`/g, '');
}

/** Truncate on a word boundary, for meta descriptions. */
export function truncate(value: string, max: number): string {
  const text = plain(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const head = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.—-]+$/, '');
  return `${head}…`;
}

/**
 * Only `http(s)` survives. Evidence URLs are hand-typed, and a typo that turns
 * into a `javascript:` href would be a real vulnerability on a page whose whole
 * job is to be trusted.
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A package's page on npm. Scoped names keep their `@` and `/` — npm's URLs
 * use them literally — while anything else is percent-encoded.
 */
export function npmPackageUrl(name: string): string {
  const path = encodeURIComponent(name.trim()).replace(/%40/g, '@').replace(/%2F/gi, '/');
  return `https://www.npmjs.com/package/${path}`;
}

/** The host of a URL, without `www.`, for showing where a link goes. */
export function urlHost(raw: string): string {
  try {
    return new URL(raw).host.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2020-02` -> `February 2020`. Returns null for anything unparseable. */
export function formatMonth(since: string | null | undefined): string | null {
  if (!since) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(since.trim());
  if (!match) return null;
  const year = match[1];
  const monthIndex = Number(match[2]) - 1;
  const month = MONTHS[monthIndex];
  if (year === undefined || month === undefined) return null;
  return `${month} ${year}`;
}

/**
 * A JSON-LD block. `<`, `>` and `&` are escaped as unicode so the payload can
 * never terminate the script element, whatever the prose contains.
 */
export function jsonLd(data: unknown): string {
  const json = JSON.stringify(data, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/** Render `items` with `render`, dropping empties, joined by newlines. */
export function joinLines(items: readonly string[]): string {
  return items.filter((item) => item !== '').join('\n');
}
