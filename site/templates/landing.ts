/**
 * The landing page: what the tool is, the one-liner, and the complete index of
 * covered packages as real links (the index is the crawl surface — every
 * package page must be reachable from here in one hop).
 */

import { esc, joinLines, truncate } from './html.js';
import { absolute, href, type SiteContext } from './layout.js';
import { indexSummary, shortAnswer, type PageRecord } from './record.js';
import type { RenderedPage } from './package.js';

const DESCRIPTION =
  'dead-deps finds abandoned, deprecated and unmaintained npm dependencies in your lockfile and names the maintained fork or replacement that succeeded them, with evidence you can check.';

export function renderLandingPage(site: SiteContext, pages: readonly PageRecord[]): RenderedPage {
  const groups = groupByInitial(pages);
  const count = pages.length;
  // The dataset can legitimately be empty mid-write, and "the 0-row dataset"
  // reads like a bug, so every sentence that counts rows has a fallback.
  const datasetPhrase = count > 0 ? `${count}-row curated dataset indexed below` : 'curated succession dataset';

  const body = joinLines([
    '<h1>Find the dead dependencies in your lockfile — and what replaced them</h1>',
    `<p class="lede">${esc(
      'dead-deps reads your lockfile, works out which dependencies have genuinely stopped being maintained, and tells you what the ecosystem moved to instead. Every verdict comes with sources you can check.',
    )}</p>`,
    '<pre class="cmd"><code>npx dead-deps</code></pre>',
    '<p>No install, no account, no upload. It reads <code>package-lock.json</code>, <code>pnpm-lock.yaml</code>, <code>yarn.lock</code> or <code>package.json</code>, asks public registry indexes about each dependency, and prints the ones that have stopped moving — worst first. It exits <code>1</code> when something is flagged, so it works as a CI gate.</p>',

    '<h2 id="what">What it actually tells you</h2>',
    '<p>Most tools that look at dependency health return a number. A number cannot be acted on. dead-deps returns a <strong>state</strong> and a <strong>successor</strong>:</p>',
    `<ul>
<li><strong>The state</strong> — <code>active</code>, <code>stable-complete</code>, <code>low-activity</code>, <code>unmaintained</code>, <code>deprecated</code>, <code>abandoned</code> or <code>hijack-risk</code>. Never a boolean, because "no commits in three years" describes both an abandoned framework and a finished twelve-line utility.</li>
<li><strong>The evidence</strong> — the registry deprecation notice, the archived repository, the release cadence, the advisory. Each one is a line you can verify yourself. An unsourced verdict is a bug.</li>
<li><strong>The successor</strong> — drawn from the ${esc(datasetPhrase)}, so the answer to "so what do I use?" is in the same output.</li>
</ul>`,

    '<h2 id="quiet">A quiet package is not a dead package</h2>',
    `<p>The naive detector reads the date of the last release and calls anything old dead. It fails immediately, because the npm graph rests on tiny packages that were <em>finished</em> years ago — <code>once</code>, <code>inherits</code>, <code>wrappy</code>, <code>util-deprecate</code>. They do one small thing correctly, so nobody commits to them, and on release date alone they are indistinguishable from abandonware. A tool that tells you to migrate off <code>inherits</code> has not found a problem; it has become one.</p>`,
    `<p>So <code>stable-complete</code> is its own verdict, guarded by its own rules, and the false-positive rate over a hand-labelled corpus of finished packages is measured separately. That is the part worth reading: <a href="${esc(
      href(site, 'methodology/'),
    )}">how verdicts are produced, and the stable-complete guard</a>.</p>`,

    '<h2 id="dataset">The succession dataset</h2>',
    `<p>Knowing a package is dead is half an answer. The other half — what replaced it — cannot be computed, so it is curated by hand. ${esc(
      count > 0 ? `Each of the ${count} rows below records` : 'Each row records',
    )} how the succession happened (a community <em>fork</em>, a <em>rename</em>, an unrelated <em>replacement</em>, functionality <em>absorbed</em> into the platform, a successor the maintainers <em>declared</em> themselves, or a <em>reimplementation</em>), whether the successor is a drop-in, and at least one primary source.</p>`,
    '<p>Roughly a fifth of real successions do not point at a package at all. <code>left-pad</code> was absorbed by <code>String.prototype.padStart</code>; <code>q</code> by native promises. "Delete the dependency, the platform does this now" is a better answer than any package name, so the dataset can say it.</p>',
    `<p>Rows about small, finished, still-working packages are deliberately excluded. Being quiet is not being abandoned. <a href="${esc(
      site.repoUrl,
    )}/blob/main/data/SCHEMA.md">Read the schema and inclusion rules</a> before proposing a row.</p>`,

    indexSection(site, groups, pages.length),

    '<h2 id="mcp">From an editor or an agent</h2>',
    `<p>The same engine ships as an MCP server, so an assistant working in your repository can scan the lockfile, check a single package, or look up a successor without shelling out:</p>`,
    '<pre class="cmd"><code>npx dead-deps-mcp</code></pre>',
    `<p>It exposes <code>scan_lockfile</code>, <code>check_package</code> and <code>find_successor</code> over stdio. Point your MCP client at that command.</p>`,

    '<h2 id="links">Elsewhere</h2>',
    `<ul>
<li><a href="${esc(site.repoUrl)}">Source, issues and the dataset on GitHub</a></li>
<li><a href="${esc(site.npmUrl)}">dead-deps on npm</a></li>
<li><a href="${esc(href(site, 'methodology/'))}">Methodology: how a verdict is produced</a></li>
</ul>`,
  ]);

  return {
    meta: {
      title: 'dead-deps — find abandoned npm dependencies and what replaced them',
      description: DESCRIPTION,
      path: '',
      ogType: 'website',
      structuredData: [softwareSourceCode(site), itemList(site, pages)],
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface Group {
  key: string;
  label: string;
  anchor: string;
  pages: PageRecord[];
}

function groupByInitial(pages: readonly PageRecord[]): Group[] {
  const groups = new Map<string, Group>();
  for (const page of pages) {
    const initial = page.slug.charAt(0);
    const key = /[a-z]/.test(initial) ? initial : '#';
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: key === '#' ? '0–9' : key.toUpperCase(),
        anchor: key === '#' ? 'index-other' : `index-${key}`,
        pages: [page],
      });
    } else {
      existing.pages.push(page);
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function indexSection(site: SiteContext, groups: readonly Group[], total: number): string {
  const heading = `<h2 id="index">Every package covered${total > 0 ? ` (${esc(String(total))})` : ''}</h2>`;

  if (total === 0) {
    return joinLines([
      heading,
      '<p>The succession dataset is still being written. Once <code>data/successors.yaml</code> has rows, every one of them gets its own page and is listed here.</p>',
    ]);
  }

  const nav = `<ul class="index-nav" aria-label="Jump to letter">${groups
    .map((group) => `<li><a href="#${esc(group.anchor)}">${esc(group.label)}</a></li>`)
    .join('')}</ul>`;

  const sections = groups.map((group) => {
    const items = group.pages
      .map((page) => {
        const question = `Is ${page.record.from} still maintained?`;
        return `<li><a class="name" href="${esc(href(site, page.path))}" aria-label="${esc(question)}">${esc(
          page.record.from,
        )}</a><span class="says">${esc(truncate(indexSummary(page.record), 110))}</span></li>`;
      })
      .join('\n');
    return `<h3 id="${esc(group.anchor)}">${esc(group.label)}</h3>\n<ul class="pkg-list">\n${items}\n</ul>`;
  });

  return joinLines([
    heading,
    `<p>One page per package, each answering the question people actually type: is it still maintained, what replaced it, and is the replacement a drop-in.</p>`,
    nav,
    ...sections,
  ]);
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

function softwareSourceCode(site: SiteContext): unknown {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    '@id': `${site.baseUrl}#software`,
    name: 'dead-deps',
    alternateName: 'dead-deps CLI',
    description: DESCRIPTION,
    url: site.baseUrl,
    codeRepository: site.repoUrl,
    downloadUrl: site.npmUrl,
    programmingLanguage: { '@type': 'ComputerLanguage', name: 'TypeScript' },
    runtimePlatform: 'Node.js',
    license: 'https://opensource.org/licenses/MIT',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows',
    keywords: [
      'abandoned npm packages',
      'unmaintained dependencies',
      'deprecated packages',
      'dependency maintenance',
      'supply chain',
      'lockfile audit',
    ].join(', '),
    inLanguage: 'en',
  };
}

function itemList(site: SiteContext, pages: readonly PageRecord[]): unknown {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${site.baseUrl}#packages`,
    name: 'npm packages with a documented successor',
    numberOfItems: pages.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: pages.map((page, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: `Is ${page.record.from} still maintained? ${shortAnswer(page.record)}`,
      url: absolute(site, page.path),
    })),
  };
}
