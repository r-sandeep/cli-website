# cli-website
Who needs a website when you have a terminal.

## Terminal version

Run `version` to print the human-readable build identity:

```
Root Ventures terminal v<version> (build <date>)
```

Run `version --json` to print the same values as one compact JSON object:

```
{"version":"<version>","buildDate":"<date>"}
```

The production asset build in `scripts/build-assets.js` injects both values into
the application bundle: `version` comes from `package.json`, and `buildDate` is
the build date in `YYYY-MM-DD` form. They are fixed for the deployed bundle and
are not read or recalculated by the command at runtime.

## Directory bookmarks

The terminal supports persistent named bookmarks for quick directory navigation:

- `bookmark add NAME` saves the current directory.
- `bookmark list` lists saved bookmarks as `NAME -> path`.
- `bookmark remove NAME` removes a saved bookmark.
- `go NAME` moves to the directory saved under `NAME`.

`NAME` must match `[A-Za-z0-9_-]+`. Bookmarks persist across page reloads in
browser storage, with a maximum of 25 saved bookmarks.

## Output pipelines

Pipe the output of any terminal command through one or more filters with
`COMMAND | FILTER [| FILTER ...]`. Filters run from left to right and do not
replace the existing standalone commands with the same names.

- `COMMAND | grep PATTERN` keeps lines containing the literal substring.
  Add `-i` for case-insensitive matching, `-v` to invert the match, or `-n` to
  prefix retained lines with their 1-based incoming line number. Flags may be
  combined, as in `grep -ivn PATTERN`.
- `COMMAND | head [N]` keeps the first N lines. N defaults to 10.
- `COMMAND | tail [N]` keeps the last N lines. N defaults to 10.
- `COMMAND | wc -l` prints the number of output lines.
- `COMMAND | sort [-rnu]` sorts lines by visible text. Add `-r` to reverse the
  order, `-n` to compare leading numeric values, or `-u` to remove exact
  duplicates after sorting. Flags may be combined, as in `sort -rn`.
- `COMMAND | uniq [-cd]` collapses adjacent lines with identical visible text.
  Add `-c` to prefix each surviving line with its run count and one space, or
  `-d` to keep only repeated runs. Flags may be combined, as in `uniq -cd`.

Sorting and duplicate detection ignore ANSI color and escape sequences while
preserving each selected line's original styling.

For example, `whois | grep -i root | head 3`, `whois | sort -r | head 3`, and
`tldr | uniq -c | sort -rn` chain filters from left to right. Run `man pipe`,
`man grep`, `man head`, `man tail`, `man wc`, `man sort`, or `man uniq` in the
terminal for the corresponding manual page.

## Terminal editing shortcuts

- **Tab** — complete commands, whois partners, tldr companies, and entries for cd, ls, cat, head, tail, less, or more; press twice to list ambiguous matches
- **Alt+Left** — move to the start of the previous word
- **Alt+Right** — move to the start of the next word
- **Ctrl+W** — delete back to the start of the previous word
- **Alt+D** — delete forward to the start of the next word
- **Ctrl+A** — move to the start of the line
- **Ctrl+E** — move to the end of the line
- **Ctrl+U** — clear the whole line

Run `man shortcuts` in the terminal to view the same reference.

[![Netlify Status](https://api.netlify.com/api/v1/badges/f3bfb854-9bc6-40a7-8d4c-2cccd3850764/deploy-status)](https://app.netlify.com/sites/rootvc-cli-website/deploys)

## Basic Commands
  - help: list all commands
  - version [--json]: show the terminal version and build date
  - alias [name[=value]]: define, list, or query command aliases
  - unalias name: remove a command alias
  - man alias: show alias usage
  - man unalias: show unalias usage
  - whois root: learn about us
  - whois [partner]: learn about a partner
  - tldr: list all portfolio companies
  - tldr: [company_name]": learn about a portfolio company
  - email: reach out to us
  - twitter: twitter accounts
  - instagram: instagram account
  - git: this repo
  - github: all repos
  - locate: physical address
  - www: plain-text version of this site
  - test: do not use
  - other: try your favorite linux commands

## Advanced Commands
 - alias
 - cat
 - cd
 - chmod
 - chown
 - clear
 - cowsay
 - cp
 - curl
 - date
 - df
 - echo
 - emacs
 - env: list stored environment variables
 - exit
 - export NAME=value: store an environment variable (or use `export` to list all)
 - fdisk
 - find
 - finger
 - free
 - ftp
 - grep
 - groups
 - gzip
 - head
 - history
 - kill
 - less
 - ls
 - man (alias: woman)
 - mkdir
 - more
 - mv
 - nano
 - open
 - passwd
 - pico
 - pine
 - ps
 - pwd
 - quit
 - rm
 - say
 - sftp
 - ssh
 - stop
 - su
 - sudo
 - tail
 - top
 - touch
 - uname
 - unset NAME: remove an environment variable
 - vi
 - vim
 - wget
 - zsh

Environment variables persist across page reloads. Command arguments can use
`$NAME` or `${NAME}`; an undefined variable expands to an empty string. Prefix
the dollar sign with a backslash, as in `\$NAME`, to pass the reference
literally without expansion.

Missing a favorite one? Make a PR!

## Portfolio CLIs
Future project: get the Hello Worlds working for every portfolio company with a CLI or npm/pypi/cargo package
 - esper
 - great_expectations (alias: ge)
 - meroxa
 - okteto
 - particle
 - privacy_dynamics (alias: privacy)
 - zed

## Build Notes
`npm run build` produces `dist/`, which is what Netlify publishes. It is wiped
and rebuilt from scratch each time, and it is gitignored — no build output is
ever committed.

That build:
 - copies the static assets (`images/`, `videos/`, `css/`, `welcome.htm`, and the
   `config/*.js` files `welcome.htm` loads directly)
 - copies and minifies the xterm vendor assets
 - bundles the app boot/runtime code into `dist/js/app.bundle.js`
 - emits a minified lazy-load asset for the RickRoll animation
 - generates the crawlable surface and `dist/index.html` (see below)

Anything not on the copy list in `scripts/build-assets.js` stays out of `dist/`,
so `scripts/`, `tests/`, `package.json`, and the unbundled `js/` sources are not
served.

`npm start` builds and then runs `netlify dev` against `dist/`.

## Crawlability
The terminal renders its content only when someone types a command, so search
engines and LLM crawlers see an empty page. `scripts/build-pages.js` closes that
gap from a single URL:

```
index.html     an offscreen block naming every company and person
_redirects     the old mirror URLs, 301'd into the terminal
llms.txt  llms-full.txt  robots.txt  sitemap.xml
```

Content is addressed by URL fragment: `/#tldr-chargelab` tells the terminal to
run `tldr chargelab` on load, and `js/terminal-ext.js` splits the command from
its argument on the **first** hyphen so a hyphenated slug still resolves.

There used to be a static mirror here — real HTML pages at `/about/`, `/team/`,
`/portfolio/<slug>/` and the rest. It worked well enough to cause the problem it
had: Google indexed all 70-odd pages and started showing sitelinks to About /
Team / Jobs under the root.vc result, advertising a conventional website sitting
behind the terminal. It was removed in #128 and those URLs now 301 to their
commands. Since Google strips fragments before indexing, this deliberately
trades per-company search results for having exactly one indexed URL.

The homepage block is a `.visually-hidden` div rather than `<noscript>`:
extraction pipelines routinely strip `<noscript>` as non-content, and Googlebot
indexes the rendered DOM, which drops it once JS runs.

**`config/*.js` is the only source of truth.** Changing a portfolio description
regenerates the homepage block, the llms files, and the redirects.

There is nothing to keep in sync. None of it is ever committed — it exists only
in `dist/`, and every deploy runs `npm run build` and regenerates it from the
current `config/*.js`. No cron, no CI drift check, no "rebuild and commit" step:
a config edit reaches the generated files the moment it is deployed, because
that is the only way they come into existence.

`index.html` in the repo root is a **template**. The regions between its
`<!-- BEGIN generated-* -->` sentinels are empty; the build injects the JSON-LD
and crawlable-index blocks when it writes `dist/index.html`. Do not paste
generated content back into the template.

Use `npm run build:pages` to regenerate just those files while iterating —
`netlify dev` does not watch `config/*.js`.

Firm-level facts (blurb, thesis, fund size, office address, email) live in
`config/firm.js` so the terminal and the static pages cannot disagree. It has no
dependencies and must load before `config/commands.js` in both
`scripts/build-assets.js` and `welcome.htm`.

`config/firm.js`, `portfolio.js`, `team.js`, and `jobs.js` end with a guarded
`module.exports` so they work unchanged as classic browser scripts *and* as
CommonJS modules for `scripts/build-pages.js`. Keep the `typeof module` guard —
an unguarded `module` reference is a ReferenceError in the browser — and do not
convert them to ESM, which would break the bundle and `welcome.htm`.

## Performance Notes
The terminal now initializes on `DOMContentLoaded` instead of waiting for `window.onload`, and optional work such as ASCII art preloading happens after the terminal is already usable.

In local repeated Chromium benchmarks against the previous `HEAD`, median startup timings improved roughly:
 - homepage prompt visible: `1941.7ms` -> `70.1ms`
 - homepage first command rendered: `2076.5ms` -> `223.5ms`
 - `#whois-lee` deep link rendered: `1159.9ms` -> `151.9ms`

## Hosting
root.vc is served by **Netlify**, which publishes `dist/` — `server: Netlify` on
the live response, the apex `A` record points at Netlify's load balancer, and
`www` 301s to the apex.

The repo is also connected to a **Vercel** project. That project belongs to the
`ai-incarnations` branch (the parked AI-reinvention experiment, #110), which
carries its own `vercel.json` and builds there successfully. `main` has no
Vercel deployment, so Vercel had nothing to build on this line: every attempt
failed and posted a red check on PRs that had nothing to do with Vercel.

`vercel.json` here sets [`git.deploymentEnabled: false`][1], which turns off
automatic Vercel deployments for branches carrying this file.

Do not "fix" this by making it match the `ai-incarnations` copy — that branch
deliberately omits the key so it keeps deploying. If it is ever merged down,
expect a conflict on `vercel.json` and resolve it toward whichever host is
actually serving the domain at that point.

[1]: https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled

Live at: [https://root.vc](https://root.vc).

Special thanks to [Jerry Neumann](https://www.linkedin.com/in/jerryneumann/) at [Neu Venture Capital](https://neuvc.com/) for the inspiration for this website concept.

Thanks to the team at [divshot](https://www.divshot.com) for the awesome and hilarious [Geocities Bootstrap Theme](https://github.com/divshot/geo-bootstrap).

_aut viam inveniam aut faciam_
