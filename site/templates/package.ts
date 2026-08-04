/**
 * One page per dataset row.
 *
 * Each page has to stand on its own: the verdict, the date, the successor, the
 * migration hint, the alternatives and every source, written out. A page that
 * only restates its title is a doorway page, and search engines are right to
 * drop those.
 */

import type { SuccessorRecord } from '../../src/types.js';
import {
  deticked,
  esc,
  joinLines,
  npmPackageUrl,
  paragraphs,
  plain,
  prose,
  safeUrl,
  truncate,
  urlHost,
} from './html.js';
import { absolute, href, type PageMeta, type SiteContext } from './layout.js';
import {
  capitalise,
  confidenceSentence,
  dropInLabel,
  dropInSentence,
  indexSummary,
  metaDescription,
  pageHeading,
  pageTitle,
  sinceMonth,
  successionSentence,
  successorQuestion,
  typeLabel,
  type PageRecord,
} from './record.js';

export interface RenderedPage {
  meta: PageMeta;
  body: string;
}

export function renderPackagePage(
  site: SiteContext,
  page: PageRecord,
  related: readonly PageRecord[],
  byName: ReadonlyMap<string, PageRecord>,
): RenderedPage {
  const record = page.record;
  const name = record.from;
  const month = sinceMonth(record);
  const question = successorQuestion(record);
  const notes = paragraphs(record.notes);
  const migration = plain(record.migration);
  const evidence = record.evidence
    .map((item) => ({ label: plain(item.label), url: safeUrl(item.url) }))
    .filter((item): item is { label: string; url: string } => item.url !== null && item.label !== '');

  const body = joinLines([
    breadcrumb(site, name),
    `<h1>${esc(pageHeading(record))}</h1>`,
    `<p class="lede">${esc(leadSentence(record))}</p>`,
    tags(record),
    verdictCard(site, record, byName),
    `<h2 id="successor">${esc(question)}</h2>`,
    `<p>${esc(successionSentence(record))} ${esc(dropInSentence(record))}</p>`,
    migration === ''
      ? `<p>The dataset carries no single-step migration hint for ${esc(name)}: the change depends on which parts of its API you use. Start from the sources under <a href="#evidence">evidence</a>.</p>`
      : joinLines([
          `<h3 id="migration">${esc(migrationHeading(record))}</h3>`,
          `<p>${prose(migration)}</p>`,
        ]),
    `<h2 id="why">Why ${esc(name)} is on this list</h2>`,
    notes.length === 0
      ? `<p>${esc(name)} is recorded as no longer maintained${month === null ? '' : ` as of ${esc(month)}`}. See the sources below.</p>`
      : notes.map((part) => `<p>${prose(part)}</p>`).join('\n'),
    `<p class="muted">${esc(confidenceSentence(record))}</p>`,
    alternativesSection(site, record, byName),
    checkSection(site, record),
    evidenceSection(evidence, name),
    relatedSection(site, related, name),
  ]);

  return {
    meta: {
      title: pageTitle(record),
      description: metaDescription(record),
      path: page.path,
      ogType: 'article',
      structuredData: [faqPage(site, page, question, evidence), breadcrumbData(site, page)],
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function breadcrumb(site: SiteContext, name: string): string {
  return `<nav class="small muted" aria-label="Breadcrumb"><a href="${esc(href(site, ''))}">dead-deps</a> / <a href="${esc(href(site, '#index'))}">Packages</a> / ${esc(name)}</nav>`;
}

function leadSentence(record: SuccessorRecord): string {
  const month = sinceMonth(record);
  const opening =
    month === null
      ? `No. ${record.from} is no longer maintained.`
      : `No — ${record.from} stopped being maintained around ${month}.`;
  return `${opening} ${successionSentence(record)}`;
}

function tags(record: SuccessorRecord): string {
  const items = [
    { text: typeLabel(record.type), accent: true },
    { text: `${record.confidence} confidence`, accent: false },
    { text: record.toKind === 'package' && record.dropIn ? 'drop-in' : `${record.toKind} successor`, accent: false },
  ];
  return `<ul class="tags">${items
    .map((item) => `<li class="tag${item.accent ? ' tag-accent' : ''}">${esc(item.text)}</li>`)
    .join('')}</ul>`;
}

function verdictCard(site: SiteContext, record: SuccessorRecord, byName: ReadonlyMap<string, PageRecord>): string {
  const month = sinceMonth(record);
  const rows: Array<[string, string]> = [
    ['Status', 'No longer maintained'],
    ['Last maintained', month === null ? 'Not pinned to a month' : month],
    ['Use instead', successorMarkup(site, record, byName)],
    ['Succession', esc(capitalise(typeLabel(record.type)))],
    ['Drop-in', esc(dropInLabel(record))],
    ['Confidence', esc(record.confidence)],
  ];
  const dl = rows
    .map(([term, value]) => `    <dt>${esc(term)}</dt>\n    <dd>${term === 'Use instead' ? value : esc(value)}</dd>`)
    .join('\n');
  return `<div class="verdict">\n  <dl>\n${dl}\n  </dl>\n</div>`;
}

/** The successor, linked to its own page when the dataset also covers it. */
function successorMarkup(
  site: SiteContext,
  record: SuccessorRecord,
  byName: ReadonlyMap<string, PageRecord>,
): string {
  const to = plain(record.to);
  if (record.toKind === 'none' || to === '') return '<em>Nothing directly — remove the dependency</em>';
  const target = record.toKind === 'package' ? byName.get(to.toLowerCase()) : undefined;
  const label = `<code>${esc(to)}</code>`;
  if (target !== undefined) {
    return `${label} <span class="muted small">— <a href="${esc(href(site, target.path))}">also covered here</a></span>`;
  }
  if (record.toKind === 'package') {
    return `${label} <span class="muted small">— <a href="${esc(npmPackageUrl(to))}">on npm</a></span>`;
  }
  return label;
}

function migrationHeading(record: SuccessorRecord): string {
  const to = plain(record.to);
  if (record.toKind === 'none' || to === '') return `Getting off ${record.from}`;
  return `How to migrate from ${record.from} to ${to}`;
}

function alternativesSection(
  site: SiteContext,
  record: SuccessorRecord,
  byName: ReadonlyMap<string, PageRecord>,
): string {
  const heading = `<h2 id="alternatives">${esc(record.from)} alternatives</h2>`;
  const alternatives = record.alternatives.map((item) => plain(item)).filter((item) => item !== '');
  if (alternatives.length === 0) {
    const to = plain(record.to);
    const line =
      record.toKind === 'none' || to === ''
        ? `The dataset lists no credible alternative to ${record.from}. Removing the dependency, or writing the small piece of it you actually use, is usually the honest answer.`
        : `The dataset lists no second option: ${to} is where the ecosystem went, and nothing else has meaningful adoption.`;
    return joinLines([heading, `<p>${esc(line)}</p>`]);
  }
  const items = alternatives.map((item) => {
    const covered = byName.get(item.toLowerCase());
    const label = `<code>${esc(item)}</code>`;
    if (covered !== undefined) {
      return `<li>${label} — <a href="${esc(href(site, covered.path))}">also succeeded; see its page</a></li>`;
    }
    return `<li>${label} — <a href="${esc(npmPackageUrl(item))}">view on npm</a></li>`;
  });
  return joinLines([
    heading,
    `<p>Beyond the primary recommendation, these are credible for ${esc(record.from)}'s use case:</p>`,
    `<ul>\n${items.join('\n')}\n</ul>`,
  ]);
}

function checkSection(site: SiteContext, record: SuccessorRecord): string {
  return joinLines([
    `<h2 id="check">Check your own project for ${esc(record.from)}</h2>`,
    `<pre class="cmd"><code>npx dead-deps --all --min-state unmaintained</code></pre>`,
    `<p>Run that in the directory holding your lockfile. If <code>${esc(record.from)}</code> is anywhere in your tree — a direct dependency or buried under something else — it appears in the report with this verdict, this successor and the same evidence links, alongside anything else that has stopped moving. Nothing is uploaded; the scan reads your lockfile locally and queries public registry metadata.</p>`,
    `<p class="small muted">Exit code 1 means something was flagged, which makes <code>npx dead-deps --min-state deprecated</code> usable as a CI gate. See <a href="${esc(href(site, 'methodology/'))}">how verdicts are produced</a>.</p>`,
  ]);
}

function evidenceSection(evidence: ReadonlyArray<{ label: string; url: string }>, name: string): string {
  const heading = `<h2 id="evidence">Evidence</h2>`;
  if (evidence.length === 0) {
    return joinLines([heading, `<p>No usable source links are recorded for ${esc(name)} yet.</p>`]);
  }
  const items = evidence
    .map(
      (item) =>
        `<li><a href="${esc(item.url)}">${prose(item.label)}</a><span class="where">${esc(urlHost(item.url))}</span></li>`,
    )
    .join('\n');
  return joinLines([
    heading,
    `<p>Every claim on this page traces to a primary source. Check them:</p>`,
    `<ul class="evidence">\n${items}\n</ul>`,
  ]);
}

function relatedSection(site: SiteContext, related: readonly PageRecord[], name: string): string {
  if (related.length === 0) return '';
  const items = related
    .map(
      (item) =>
        `<li><a href="${esc(href(site, item.path))}"><span class="name">${esc(item.record.from)}</span><span class="says">${esc(truncate(indexSummary(item.record), 90))}</span></a></li>`,
    )
    .join('\n');
  return joinLines([
    `<h2 id="related">Packages related to ${esc(name)}</h2>`,
    `<ul class="cards">\n${items}\n</ul>`,
    `<p>See the <a href="${esc(href(site, '#index'))}">full index of covered packages</a>, or read <a href="${esc(href(site, 'methodology/'))}">the methodology</a> for how a verdict is reached and why a quiet package is not a dead one.</p>`,
  ]);
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

function faqPage(
  site: SiteContext,
  page: PageRecord,
  question: string,
  evidence: ReadonlyArray<{ label: string; url: string }>,
): unknown {
  const record = page.record;
  const month = sinceMonth(record);
  const to = plain(record.to);
  const url = absolute(site, page.path);

  const answers: Array<[string, string]> = [
    [
      `Is ${record.from} still maintained?`,
      `${month === null ? `No. ${record.from} is no longer maintained.` : `No. ${record.from} stopped being maintained around ${month}.`} ${deticked(record.notes)}`,
    ],
    [question, `${successionSentence(record)} ${dropInSentence(record)}`],
  ];

  if (record.toKind === 'package' && to !== '') {
    answers.push([
      `Is ${to} a drop-in replacement for ${record.from}?`,
      record.dropIn
        ? `Mostly yes. ${dropInSentence(record)}`
        : `No. ${dropInSentence(record)}${deticked(record.migration) === '' ? '' : ` ${deticked(record.migration)}`}`,
    ]);
  }

  const migration = deticked(record.migration);
  if (migration !== '' && !(record.toKind === 'package' && to !== '' && !record.dropIn)) {
    answers.push([`How do I migrate off ${record.from}?`, migration]);
  }

  const alternatives = record.alternatives.map((item) => plain(item)).filter((item) => item !== '');
  if (alternatives.length > 0) {
    answers.push([
      `What are the alternatives to ${record.from}?`,
      `Besides ${to === '' ? 'the primary recommendation' : to}, credible options are ${listSentence(alternatives)}.`,
    ]);
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    name: pageTitle(record),
    url,
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: site.name, url: site.baseUrl },
    ...(evidence.length > 0
      ? { citation: evidence.map((item) => ({ '@type': 'CreativeWork', name: deticked(item.label), url: item.url })) }
      : {}),
    mainEntity: answers.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: deticked(a) },
    })),
  };
}

function breadcrumbData(site: SiteContext, page: PageRecord): unknown {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'dead-deps', item: site.baseUrl },
      { '@type': 'ListItem', position: 2, name: 'Packages', item: `${site.baseUrl}#index` },
      { '@type': 'ListItem', position: 3, name: page.record.from, item: absolute(site, page.path) },
    ],
  };
}

function listSentence(items: readonly string[]): string {
  if (items.length === 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  const tail = items[items.length - 1] ?? '';
  return `${head} and ${tail}`;
}
