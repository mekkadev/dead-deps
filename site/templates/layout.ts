/**
 * The page shell: head metadata, masthead, footer.
 *
 * Every page is complete in its HTML — no client-side rendering, no fetches, no
 * JavaScript at all — so a crawler and a text browser see exactly what a person
 * with a browser sees.
 */

import { esc, joinLines, jsonLd } from './html.js';

export interface SiteContext {
  /** Absolute deployment root, always with a trailing slash. */
  baseUrl: string;
  /** Path portion of `baseUrl`, e.g. `/dead-deps/`. */
  basePath: string;
  name: string;
  tagline: string;
  repoUrl: string;
  npmUrl: string;
  /** Number of curated succession records in this build. */
  packageCount: number;
  /** ISO date (YYYY-MM-DD) used for footers and sitemap lastmod. */
  buildDate: string;
}

export interface PageMeta {
  /** `<title>`; also the Open Graph title. */
  title: string;
  description: string;
  /** Root-relative path of this page, e.g. `p/request/` or `` for the landing page. */
  path: string;
  ogType: 'website' | 'article';
  structuredData?: unknown[];
  /** When true, tell crawlers to skip the page (used for 404). */
  noindex?: boolean;
}

/** Resolve a site-relative path (no leading slash) against the deployment root. */
export function href(site: SiteContext, path: string): string {
  return `${site.basePath}${path}`;
}

/** Absolute URL for a site-relative path. */
export function absolute(site: SiteContext, path: string): string {
  return `${site.baseUrl}${path}`;
}

interface NavItem {
  path: string;
  label: string;
}

function nav(site: SiteContext, current: string): string {
  const items: NavItem[] = [
    { path: '', label: 'Home' },
    { path: '#index', label: 'Packages' },
    { path: 'methodology/', label: 'Methodology' },
  ];
  const links = items.map((item) => {
    const target = item.path.startsWith('#') ? `${href(site, '')}${item.path}` : href(site, item.path);
    const currentAttr = item.path !== '' && item.path === current ? ' aria-current="page"' : '';
    return `<a href="${esc(target)}"${currentAttr}>${esc(item.label)}</a>`;
  });
  links.push(`<a href="${esc(site.repoUrl)}">GitHub</a>`);
  return `<nav class="nav" aria-label="Site">${links.join('')}</nav>`;
}

export function renderPage(site: SiteContext, meta: PageMeta, body: string, stylesheet: string): string {
  const canonical = absolute(site, meta.path);
  const structured = (meta.structuredData ?? []).map((entry) => jsonLd(entry));

  const head = joinLines([
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    meta.noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">',
    '<meta name="color-scheme" content="light dark">',
    `<meta property="og:type" content="${esc(meta.ogType)}">`,
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    '<meta property="og:locale" content="en_US">',
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${esc(meta.title)}">`,
    `<meta name="twitter:description" content="${esc(meta.description)}">`,
    `<link rel="alternate" type="application/xml" href="${esc(absolute(site, 'sitemap.xml'))}" title="Sitemap">`,
    `<style>\n${stylesheet}\n</style>`,
    ...structured,
  ]);

  return `<!doctype html>
<html lang="en">
<head>
${indent(head, 2)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
  <div class="wrap">
    <a class="brand" href="${esc(href(site, ''))}">dead-deps<span class="dim"> — ${esc(site.tagline)}</span></a>
    ${nav(site, meta.path)}
  </div>
</header>
<main id="main">
  <div class="wrap">
${indent(body, 4)}
  </div>
</main>
<footer>
  <div class="wrap">
    <p>${esc(
      site.packageCount > 0
        ? `${site.packageCount} curated successions, each one hand-checked against primary sources.`
        : 'The succession dataset is still being written.',
    )} Last built ${esc(site.buildDate)}.</p>
    <p><a href="${esc(href(site, ''))}">Package index</a> · <a href="${esc(href(site, 'methodology/'))}">Methodology</a> · <a href="${esc(site.repoUrl)}">Source on GitHub</a> · <a href="${esc(site.npmUrl)}">dead-deps on npm</a> · MIT licensed</p>
  </div>
</footer>
</body>
</html>
`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n');
}
