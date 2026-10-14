# Agent instructions for cli-website

This is root.vc: a VC firm website that is a terminal. There are no real pages —
all content renders inside an xterm.js terminal when a visitor types a command.
Read the README for build, crawlability, and hosting details before changing
anything under `scripts/` or the root `index.html`.

## Source of truth

**`config/*.js` is the only source of truth for content.** The homepage
crawlable block, JSON-LD, `llms.txt`, `llms-full.txt`, `sitemap.xml`,
`.well-known/security.txt`, and `_redirects` are all generated from it at build
time, exist only in `dist/`, and are never committed. Edit the config, never the
generated output.

- `config/firm.js` — firm-level facts (blurb, thesis, fund size, address, email)
- `config/portfolio.js` — portfolio companies
- `config/team.js` — partners
- `config/jobs.js` — portfolio job listings

## Repo conventions

- `config/firm.js`, `portfolio.js`, `team.js`, and `jobs.js` are dual-mode:
  classic browser scripts *and* CommonJS modules. Keep the
  `if (typeof module !== "undefined") module.exports = …` guard exactly as-is
  and do not convert these files to ESM.
- The root `index.html` is a template. The regions between its
  `<!-- BEGIN generated-* -->` sentinels must stay empty in the repo; the build
  fills them when writing `dist/index.html`. Never paste generated content back.
- Deep links (`/#tldr-chargelab`) split command from argument on the **first**
  hyphen, so multi-word slugs use underscores (`privacy_dynamics`), not hyphens.
- Companies that shut down are not deleted; set `url: "(inactive)"` (a sentinel
  recognized by `js/geo.js` and the page generator).

## Adding a portfolio company

1. Add one entry to `config/portfolio.js`. The key is the slug used everywhere
   (`tldr <slug>`, `/#tldr-<slug>`, `images/<slug>.jpg`):

   ```js
   acme: {
     name: "Acme Robotics",
     url: "https://acme.dev",
     description: "Acme Robotics builds …", // one sentence, starts with the name
     memo: "https://github.com/rootvc/investment-memos/blob/main/acme.md", // optional
     demo: "https://docs.acme.dev/quickstart", // optional
   },
   ```

   Only `name`, `url`, and `description` are required. If `demo` is set,
   `config/commands.js` auto-registers a terminal command named after the slug
   that opens it — no extra wiring.

2. Add `images/<slug>.jpg` (the company logo). Required: `tldr <slug>` renders
   it as ASCII art, and a test fails if it is missing. Prefer a simple,
   high-contrast logo — it gets dithered down to ASCII characters.

3. Run `npm test`. It checks the image exists, the entry survives HTML
   escaping, and every generated link resolves.

4. Nothing else to update. The `tldr` listing, crawlable homepage block,
   JSON-LD, llms files, sitemap, and `/portfolio/<slug>/` redirect all
   regenerate from the config on the next deploy.

Adding a team member is the same shape: entry in `config/team.js` plus
`images/<slug>.png`.

## Verifying changes

- `npm test` — Vitest suite covering commands, the page generator, and assets.
- `npm run build:pages` — regenerate just the crawlable surface while iterating
  (`netlify dev` does not watch `config/*.js`).
- `npm run build` then `npm start` — full build served locally; try
  `tldr <slug>` or open `/#tldr-<slug>`.
