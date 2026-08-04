/**
 * The entire stylesheet, inlined into every page.
 *
 * One block, no external requests, no webfonts, no JavaScript. Colours live in
 * custom properties so light and dark are the same rules with a different
 * palette.
 */

export const STYLESHEET = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  --bg: #fcfbf8;
  --surface: #f4f2ec;
  --fg: #1c1b18;
  --muted: #5f5c53;
  --rule: #e1ded4;
  --accent: #9c3d17;
  --accent-soft: #f0e2d9;
  --ok: #2f6f4f;
  --warn: #8a5a06;
  --shadow: 0 1px 2px rgba(28, 27, 24, .05);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a;
    --surface: #1e1e23;
    --fg: #e8e6e0;
    --muted: #a3a09a;
    --rule: #32323a;
    --accent: #e79a6a;
    --accent-soft: #2b2119;
    --ok: #7fbf9a;
    --warn: #d9b366;
    --shadow: none;
    color-scheme: dark;
  }
}

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 17px;
  line-height: 1.65;
  font-synthesis-weight: none;
  text-rendering: optimizeLegibility;
}

.wrap { width: 100%; max-width: 47rem; margin: 0 auto; padding: 0 1.25rem; }

a { color: var(--accent); text-decoration: underline; text-underline-offset: .16em; text-decoration-thickness: .06em; }
a:hover { text-decoration-thickness: .12em; }
a:focus-visible, .skip:focus { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

.skip {
  position: absolute; left: -9999px; top: 0;
  background: var(--surface); color: var(--fg);
  padding: .5rem .9rem; z-index: 10; border-radius: 0 0 6px 0;
}
.skip:focus { left: 0; }

/* ---- masthead ---- */

.masthead { border-bottom: 1px solid var(--rule); background: var(--bg); }
.masthead .wrap {
  display: flex; flex-wrap: wrap; gap: .5rem 1.25rem;
  align-items: baseline; justify-content: space-between;
  padding-top: 1rem; padding-bottom: 1rem;
}
.brand { font-family: var(--mono); font-size: 1rem; font-weight: 600; letter-spacing: -.01em; color: var(--fg); text-decoration: none; }
.brand:hover { color: var(--accent); }
.brand .dim { color: var(--muted); font-weight: 400; }
.nav { display: flex; flex-wrap: wrap; gap: 1rem; font-size: .9rem; }
.nav a { color: var(--muted); text-decoration: none; }
.nav a:hover, .nav a[aria-current="page"] { color: var(--accent); text-decoration: underline; text-underline-offset: .2em; }

/* ---- typography ---- */

main { padding: 2.75rem 0 3.5rem; }

h1 {
  font-family: var(--serif);
  font-size: clamp(1.85rem, 1.2rem + 2.4vw, 2.6rem);
  line-height: 1.15;
  letter-spacing: -.015em;
  margin: 0 0 .6rem;
  font-weight: 600;
}
h2 {
  font-size: 1.3rem; line-height: 1.3; letter-spacing: -.01em;
  margin: 2.75rem 0 .75rem; padding-top: 1.1rem; border-top: 1px solid var(--rule);
  font-weight: 650;
}
h3 { font-size: 1.02rem; margin: 1.75rem 0 .5rem; font-weight: 650; }
h2 + h3 { margin-top: 1rem; }

p, ul, ol, dl, table, pre, blockquote { margin: 0 0 1.1rem; }
li { margin: .3rem 0; }
strong { font-weight: 650; }

.lede { font-size: 1.12rem; color: var(--muted); margin-bottom: 1.75rem; }
.muted { color: var(--muted); }
.small { font-size: .875rem; }

code, kbd, samp { font-family: var(--mono); font-size: .875em; }
p code, li code, dd code, td code, h3 code {
  background: var(--surface); border: 1px solid var(--rule);
  border-radius: 4px; padding: .06em .32em;
}

pre {
  font-family: var(--mono); font-size: .87rem; line-height: 1.55;
  background: var(--surface); border: 1px solid var(--rule); border-radius: 8px;
  padding: .85rem 1rem; overflow-x: auto; box-shadow: var(--shadow);
}
pre code { background: none; border: 0; padding: 0; font-size: inherit; }
.cmd { position: relative; }
.cmd::before {
  content: "$"; color: var(--muted); position: absolute; left: 1rem; top: .85rem;
}
.cmd code { display: block; padding-left: 1.1rem; }

/* ---- verdict card ---- */

.verdict {
  background: var(--surface); border: 1px solid var(--rule); border-radius: 10px;
  padding: 1.1rem 1.25rem .35rem; margin: 0 0 1.75rem; box-shadow: var(--shadow);
}
.verdict dl { display: grid; grid-template-columns: 10.5rem 1fr; gap: .1rem 1rem; margin: 0; }
.verdict dt { color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .05em; padding-top: .3rem; }
.verdict dd { margin: 0; padding: .15rem 0; }
@media (max-width: 34rem) {
  .verdict dl { grid-template-columns: 1fr; gap: 0; }
  .verdict dt { padding-top: .7rem; }
  .verdict dd { padding-top: 0; }
}

.tags { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 1.4rem; padding: 0; list-style: none; }
.tag {
  font-family: var(--mono); font-size: .74rem; letter-spacing: .02em;
  border: 1px solid var(--rule); background: var(--surface); color: var(--muted);
  border-radius: 999px; padding: .12rem .6rem; margin: 0;
}
.tag-accent { background: var(--accent-soft); border-color: var(--accent-soft); color: var(--accent); }

/* ---- lists ---- */

ul.plain, ol.plain { list-style: none; padding: 0; }

.index-nav { display: flex; flex-wrap: wrap; gap: .35rem; padding: 0; list-style: none; margin-bottom: 1.5rem; }
.index-nav li { margin: 0; }
.index-nav a {
  display: inline-block; min-width: 1.9rem; text-align: center;
  font-family: var(--mono); font-size: .82rem; text-decoration: none;
  border: 1px solid var(--rule); border-radius: 6px; padding: .1rem .35rem; color: var(--muted);
}
.index-nav a:hover { color: var(--accent); border-color: var(--accent); }

.pkg-list { list-style: none; padding: 0; margin: 0 0 1.5rem; }
.pkg-list li { margin: 0; padding: .5rem 0; border-bottom: 1px solid var(--rule); }
.pkg-list li:last-child { border-bottom: 0; }
.pkg-list .name { font-family: var(--mono); font-size: .93rem; font-weight: 600; }
.pkg-list .says { display: block; color: var(--muted); font-size: .9rem; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr)); gap: .75rem; padding: 0; list-style: none; margin: 0 0 1.1rem; }
.cards li { margin: 0; }
.cards a {
  display: block; height: 100%; text-decoration: none; color: var(--fg);
  border: 1px solid var(--rule); border-radius: 8px; padding: .7rem .85rem;
  background: var(--surface); box-shadow: var(--shadow);
}
.cards a:hover { border-color: var(--accent); }
.cards .name { font-family: var(--mono); font-size: .88rem; font-weight: 600; color: var(--accent); display: block; }
.cards .says { display: block; color: var(--muted); font-size: .82rem; line-height: 1.45; margin-top: .15rem; }

.evidence { list-style: none; padding: 0; }
.evidence li { padding: .45rem 0; border-bottom: 1px solid var(--rule); }
.evidence li:last-child { border-bottom: 0; }
.evidence .where { display: block; font-family: var(--mono); font-size: .76rem; color: var(--muted); }

/* ---- tables ---- */

.scroll { overflow-x: auto; margin: 0 0 1.1rem; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; padding: .45rem .7rem .45rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }

/* ---- footer ---- */

footer { border-top: 1px solid var(--rule); padding: 1.5rem 0 2.5rem; color: var(--muted); font-size: .875rem; }
footer p { margin: 0 0 .35rem; }
footer a { color: var(--muted); }
footer a:hover { color: var(--accent); }
`.trim();
