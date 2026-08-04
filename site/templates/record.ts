/**
 * The view model for one dataset row, plus the prose derived from it.
 *
 * Titles, descriptions and verdict sentences are all generated here so that a
 * package page, the landing index and the JSON-LD never disagree about what the
 * dataset says.
 */

import type { SuccessionType, SuccessorRecord } from '../../src/types.js';
import { formatMonth, plain, truncate } from './html.js';

export interface PageRecord {
  record: SuccessorRecord;
  slug: string;
  /** Site-relative path, e.g. `p/request/`. */
  path: string;
}

const TYPE_LABEL: Record<SuccessionType, string> = {
  fork: 'maintained fork',
  rename: 'renamed package',
  replacement: 'replacement project',
  absorbed: 'absorbed elsewhere',
  'self-declared': 'successor named by the maintainers',
  reimplementation: 'reimplementation',
};

export function typeLabel(type: SuccessionType): string {
  return TYPE_LABEL[type] ?? type;
}

/** What the successor is, in a noun phrase. Never returns an empty string. */
export function successorName(record: SuccessorRecord): string {
  const to = plain(record.to);
  if (record.toKind === 'none' || to === '') return 'no direct successor';
  return to;
}

/** `February 2020`, or null when the dataset does not pin a month. */
export function sinceMonth(record: SuccessorRecord): string | null {
  return formatMonth(record.since);
}

/** One sentence describing how the successor relates to the dead package. */
export function successionSentence(record: SuccessorRecord): string {
  const from = record.from;
  const to = plain(record.to);

  if (record.toKind === 'none' || to === '') {
    return `No single package succeeded ${from}; the fix depends on what you were using it for.`;
  }
  if (record.toKind === 'platform') {
    return `${to} covers this in the language or runtime now, so the right move is to delete the dependency rather than replace it.`;
  }

  switch (record.type) {
    case 'fork':
      return `${to} is a community fork that picked ${from} up and carried it on.`;
    case 'rename':
      return `The same project continues under the name ${to}.`;
    case 'replacement':
      return `The ecosystem moved to ${to}, a separate project that took over the same job.`;
    case 'absorbed':
      return `${from}'s functionality was absorbed into ${to}.`;
    case 'self-declared':
      return `${from}'s own maintainers named ${to} as the successor.`;
    case 'reimplementation':
      return `${to} is the same idea rebuilt from scratch.`;
    default:
      return `${to} is the recommended successor to ${from}.`;
  }
}

/** The short answer, used in titles and index rows. */
export function shortAnswer(record: SuccessorRecord): string {
  const to = plain(record.to);
  if (record.toKind === 'none' || to === '') return 'no, and nothing directly replaced it';
  if (record.toKind === 'platform') return `no, ${to} replaced it`;
  if (record.type === 'rename') return `no, it is now ${to}`;
  if (record.type === 'fork') return `no, the maintained fork is ${to}`;
  return `no, use ${to} instead`;
}

/** How the index line reads under a package name. */
export function indexSummary(record: SuccessorRecord): string {
  const month = sinceMonth(record);
  const tail = month ? ` · unmaintained since ${month}` : '';
  const to = plain(record.to);
  if (record.toKind === 'none' || to === '') return `No direct successor${tail}`;
  if (record.toKind === 'platform') return `Replaced by ${to} in the platform${tail}`;
  return `${capitalise(typeLabel(record.type))}: ${to}${tail}`;
}

export function dropInSentence(record: SuccessorRecord): string {
  const to = plain(record.to);
  if (record.toKind === 'none' || to === '') {
    return 'There is nothing to swap in, so plan the change rather than the upgrade.';
  }
  if (record.toKind === 'platform') {
    return 'There is no package to install; the dependency comes out and platform code goes in.';
  }
  return record.dropIn
    ? `${to} is close enough to a drop-in replacement that most projects only change the dependency and the import.`
    : `${to} is not a drop-in replacement, so expect to change call sites.`;
}

export function dropInLabel(record: SuccessorRecord): string {
  if (record.toKind !== 'package' || plain(record.to) === '') return 'not applicable';
  return record.dropIn ? 'yes — swap the import' : 'no — expect code changes';
}

export function confidenceSentence(record: SuccessorRecord): string {
  switch (record.confidence) {
    case 'high':
      return 'The succession is settled: primary sources agree and the ecosystem has already moved.';
    case 'medium':
      return 'The succession is well supported, but it is not the only defensible choice.';
    default:
      return 'Reasonable engineers still disagree about the replacement — read the alternatives before committing.';
  }
}

/** `<title>` for the package page, phrased as the query someone types. */
export function pageTitle(record: SuccessorRecord): string {
  return `Is ${record.from} still maintained? ${capitalise(shortAnswer(record))}`;
}

/** `<h1>`. Kept as the bare question so it matches the search intent exactly. */
export function pageHeading(record: SuccessorRecord): string {
  return `Is ${record.from} still maintained?`;
}

export function metaDescription(record: SuccessorRecord): string {
  const month = sinceMonth(record);
  const opening = month
    ? `${record.from} stopped being maintained around ${month}.`
    : `${record.from} is no longer maintained.`;
  const core = `${opening} ${successionSentence(record)}`;
  const tail = 'Evidence, migration notes and alternatives.';
  // Only append the boilerplate when it fits whole; a truncated tail is noise.
  return core.length + tail.length + 1 <= 158 ? `${core} ${tail}` : truncate(core, 158);
}

/** The question a package page answers second, after "is it maintained". */
export function successorQuestion(record: SuccessorRecord): string {
  if (record.toKind === 'package' && record.type === 'fork') {
    return `Is there a maintained fork of ${record.from}?`;
  }
  if (record.toKind === 'platform' || record.toKind === 'none') {
    return `What replaced ${record.from}?`;
  }
  return `What should I use instead of ${record.from}?`;
}

export function capitalise(text: string): string {
  if (text === '') return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
