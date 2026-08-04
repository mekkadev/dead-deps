/**
 * GitHub Pages serves `404.html` for any unknown path under the project root.
 * It is excluded from the sitemap and marked noindex.
 */

import { esc, joinLines } from './html.js';
import { href, type SiteContext } from './layout.js';
import type { RenderedPage } from './package.js';

export function renderNotFoundPage(site: SiteContext): RenderedPage {
  const body = joinLines([
    '<h1>That page does not exist</h1>',
    '<p class="lede">The link may be old, or the package may not be in the succession dataset.</p>',
    `<p>Package pages live at <code>${esc(site.basePath)}p/&lt;package&gt;/</code>, with scoped names flattened — <code>@angular/http</code> becomes <code>${esc(
      site.basePath,
    )}p/angular-http/</code>.</p>`,
    `<ul>
<li><a href="${esc(href(site, '#index'))}">Browse every covered package</a></li>
<li><a href="${esc(href(site, 'methodology/'))}">Read the methodology</a></li>
<li><a href="${esc(site.repoUrl)}/issues">Propose a missing package on GitHub</a></li>
</ul>`,
  ]);

  return {
    meta: {
      title: 'Page not found — dead-deps',
      description: 'That page does not exist. Browse the index of npm packages with a documented successor.',
      path: '404.html',
      ogType: 'website',
      noindex: true,
    },
    body,
  };
}
