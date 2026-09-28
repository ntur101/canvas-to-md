# canvas-to-md

Scrapes University of Auckland **Canvas** module content and converts it to
Markdown **verbatim** — no summarising, no LLM in the pipeline. Every page,
file, and slide deck is preserved word-for-word, with the original file kept
alongside whenever conversion can't be perfectly lossless (PDFs, slides,
spreadsheets). The point is a clean, faithful corpus to give an assistant (or
Obsidian search) full context on a course.

Deliberately a separate project from my Panopto lecture-notes tool: Canvas
ingestion shares none of that project's video or LLM machinery. The two only
share a convention — both can write per-course into the same Obsidian vault.

## Quick start

```bash
npm install
npm run setup              # install Playwright's Edge channel (one-time)
npm run setup-auth         # sign in to Canvas once (Microsoft SSO); saves session
npm run probe              # go/no-go: prints your courses if session auth works
npm run setup-auth-sharepoint   # sign in to SharePoint once (only if you have SharePoint links)
npm run dev                # download + convert everything into ./Output
```

Requires Node 20+ (developed on Node 22 via nvm) and Microsoft Edge installed.

Out of the box everything is written to a local `Output/` folder and nothing is
ever deleted. To file straight into an Obsidian vault, and to let the run clean
up files that no longer exist on Canvas, create a `settings.json` in the project
root (gitignored):

```json
{
  "paths.output": "C:/Users/you/notes",
  "scrape.pruneOrphans": true
}
```

Overridable keys are listed in `src/settings.ts`; anything else is ignored with a
warning. Read `## Orphan cleanup` before turning pruning on — it deletes files.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup-auth` | Headed Microsoft SSO login for Canvas; saves the session. |
| `npm run probe` | Confirms session-based API access works; lists all active courses. |
| `npm run courses` | Lists courses with your role + term, flags the scrape set (student + current term, plus `scrape.extraCourseIds`). |
| `npm run survey` | Read-only inventory of every module item across the scrape set, by type/extension/host. |
| `npm run setup-auth-sharepoint` | Headed SSO login for `uoa-my.sharepoint.com`; needed to download SharePoint files. |
| `npm run dev` | The main run: walk modules, fetch every item, convert to Markdown, write to `paths.output`. Incremental by default — see below. |
| `npm run dev:force` | Same, but ignores the incremental cache and re-fetches/re-converts everything. |
| `npm run dev:no-prune` | Same, but only lists orphaned files instead of deleting them. |
| `npm run typecheck` | `tsc --noEmit`. |

## How auth works

UoA has personal access tokens **disabled**, so this uses your **SSO session
cookie** instead. Canvas's own front-end calls `/api/v1/` with nothing but the
session cookie, and so do we (read-only, so no CSRF header is ever needed).

`setup-auth` opens Edge, you complete Microsoft SSO by hand once, and the
resulting `canvas.auckland.ac.nz` session is saved to
`browser-data/storage-state.json` (gitignored). Everything after that is plain
HTTP against the saved session — no browser window.

**SharePoint** (`uoa-my.sharepoint.com`) is a different domain with its own
cookies, so it needs its own login: `setup-auth-sharepoint` (seeded from the
Canvas session to cut clicks, but still a manual sign-in). Saved separately to
`browser-data/storage-state-sharepoint.json`. If that session expires, downloads
degrade gracefully to link-only notes until you re-run it.

> Gotcha baked into the code: under session-cookie auth (but not token auth),
> Canvas prefixes JSON responses with `while(1);` to prevent JSON hijacking.
> `src/canvasApi.ts` strips it before parsing.

Every network call retries transient failures (429 rate limits, 5xx, dropped
sockets) with exponential backoff, honouring `Retry-After` when the server sends
one. Failures that won't improve on a second try — 401/403/404, or an SSO login
page where JSON should be — are raised immediately so a dead session still fails
fast with a useful message rather than after three slow retries.

## Incremental runs

`npm run dev` skips anything unchanged since the last run, using a small
cache at `state/manifest.json` (gitignored, lives in the repo not the vault):

- **Page / Assignment / Quiz / File** — compared against Canvas's own
  `updated_at` for that item. Unchanged + output still on disk → skipped
  entirely (for files, that means the download itself is skipped, not just
  the write).
- **SharePoint** — Canvas exposes no `updated_at` for external links, so this
  is existence-based: once a deck is downloaded, it's left alone unless its
  local copy is deleted. A useful side effect: already-downloaded decks never
  need a live SharePoint session again, softening the session-expiry issue.

A side benefit: unchanged files keep their original `scraped` frontmatter
date instead of it churning on every run.

Force a full re-scrape (ignore the cache) with `npm run dev:force`, or
delete `state/manifest.json` / specific output files to selectively refresh.

## Orphan cleanup

When an item is renamed, reordered, or removed on Canvas, its old file would
otherwise sit in the vault forever as a stale duplicate. Each run tracks every
file it vouches for and treats the rest of the module folder as orphaned.

**Off by default — orphans are only listed.** Set `"scrape.pruneOrphans": true`
in `settings.json` to have them deleted, which is worth doing once everything
under your output root is generated: a file the run didn't produce is then by
definition stale. Module folders that no longer exist on Canvas are swept the
same way, and a folder emptied by pruning is removed.

Don't enable it if you hand-write notes inside `Modules/` — those look exactly
like orphans. `npm run dev:no-prune` always wins for a single run, and
`npm run dev -- --prune` forces pruning on for one run without changing config.

Two safeguards, because this deletes files:

- **Cleanup is skipped for any module where an item failed** (or a course, for
  folder-level cleanup). A network blip must never be mistaken for "removed
  from Canvas".
- **An existing download is never downgraded to a link note.** If a SharePoint
  session has expired but the deck was fetched on an earlier run, the local
  copy is kept rather than replaced.
- **Only the top level of a module folder is swept**, so `assets/` is never
  touched, and `Course Info/` sits outside the sweep entirely.

## What it handles

Each module item is dispatched by its Canvas type:

| Canvas type | Handling | Fidelity |
| --- | --- | --- |
| Page / Assignment / Quiz | HTML → Markdown (Turndown + GFM tables) | Lossless |
| Discussion | Topic prompt → Markdown | Prompt verbatim; replies not scraped |
| File — PDF | Download original + extracted-text `.md` | Text verbatim; figures in the original |
| File — other (zip, images, …) | Download original | Original preserved |
| ExternalUrl — SharePoint | Download + convert (pptx / xlsx / docx / pdf) + keep original | Text verbatim; layout/images in the original |
| ExternalUrl — other (forms, Panopto) | Recorded as a link note | Link preserved |
| ExternalTool (LTI) | Recorded as a link note | Content lives outside Canvas |
| SubHeader | Skipped (a divider, no content) | — |

### Beyond the modules

The module walk misses real course material, so each course also gets a
`Course Info/` folder (a sibling of `Modules/`, never inside it — orphan pruning
would treat an unrecognised folder under the modules root as removed):

| Content | Where | Default |
| --- | --- | --- |
| Syllabus | `Course Info/Syllabus.md` | on |
| Announcements | `Course Info/Announcements/` | on |
| Pages not linked from any module | `Course Info/Unfiled Pages/` | on |
| Files not attached to any module | `Course Info/Unfiled Files/` | **off** — can be a large download of never-assigned material |

Each section is failure-isolated: a course with announcements disabled, or a
syllabus you can't read, won't stop the rest.

### Assignments and quizzes

Assignment **rubrics** are rendered in full — one subsection per criterion with
its rating bands as a table — since the rubric is usually the actual grading
criteria. Quiz **questions** are captured where Canvas exposes them; it often
refuses this endpoint for students (questions can be hidden until an attempt),
which is treated as normal and leaves the quiz note with just its description.

### Internal links

Links between scraped items are rewritten to Obsidian links, so the vault is
navigable and the graph reflects the course. Normally that's a wikilink
(`[[13 - Agile|Agile]]`); when the link text contains an image — Canvas's
card-style page links do this — it becomes a relative Markdown link instead,
since a wikilink alias would render the image markup as literal text.

Links to anything *not* scraped stay as plain URLs: a dead wikilink is worse
than a working external link. That includes links to files, whose note filename
isn't known until the file is fetched.

Because a link can point forward to a page in a later module (or another
course), the run plans every course's structure before writing the first note.

**Pages found only by their links.** A course with its Pages tab disabled 404s
the pages listing, so material linked from a module page — but not in any module
— is otherwise invisible. Any internal page link that doesn't resolve is fetched
and written to `Course Info/Linked Pages/`, then linked to. This runs in rounds
(`scrape.linkedPageRounds`), since a recovered page can link to more. On the
first live run it recovered 10 pages, including three "card" pages holding ~25KB
of SOFTENG 761 content that no previous version could reach.

Discovery reads the notes already on disk, not just freshly-written ones —
otherwise an incremental run, where the note holding the link is skipped, would
never find anything.

> Gotcha: Turndown emits `[text](url "Title")` whenever the source `<a>` has a
> `title` attribute, and Canvas sets it often. A link pattern that doesn't allow
> the title silently skips those — fixing it took one run from 8 rewritten links
> to 37.

### Inline images

Canvas HTML embeds images as authenticated Canvas URLs, so a converted note
would show broken images in Obsidian. Each one is downloaded into an `assets/`
subfolder of its module and the link rewritten to a relative path, leaving notes
self-contained offline. Assets are named by Canvas file id, so an image used by
several notes in a module is stored once. They live in a subfolder deliberately:
orphan pruning only sweeps the top level of a module folder, so an image can
never be mistaken for a stale note and deleted.

### Extracted-text cleanup

Every converter's output passes through a shared cleaner. Some PDFs — Powerpoint
exports especially — come back from `pdf-parse` with NUL bytes woven through the
text (one deck was 77% NUL bytes), which makes the note unsearchable and flags it
as binary to tooling. The readable text underneath is intact, so the control
characters are stripped and nothing legible is lost.

Canvas's newer "Design Block" pages hide config as JSON in
`<span class="cdbData" style="display:none">`; the HTML converter strips those
so only real content survives.

**Converters** (`src/convert/`): `html` (Turndown), `pdf` (pdf-parse), `pptx`
(unzip → `<a:t>` slide text + speaker notes), `xlsx` (SheetJS → Markdown
tables), `docx` (unzip → `<w:t>` runs, with Word heading styles preserved), and
`text` (the shared cleanup below). All deterministic — nothing is ever
summarised or reworded.

## Output layout

Written under `<paths.output>/<COURSE>/Modules/<NN - module>/`, one file per
item, in module and item order. A course code is folded to its folder name by
replacing spaces with hyphens (`SOFTENG 761` → `SOFTENG-761`); add an entry to
`scrape.courseFolders` only for a course that needs a different name:

```
_notes/SOFTENG-761/Modules/
  01 - General Information/
    01 - 00 Course Overview Slides.pptx        (original)
    01 - 00 Course Overview Slides.pptx.md     (40 slides, verbatim)
    02 - Home Page.md                          (Canvas page)
  03 - Module 3 Project/
    05 - Scrum Primer.pdf                       (original)
    05 - Scrum Primer.pdf.md                    (extracted text)
    03 - GitHub Repository Information Sheet.xlsx
    03 - GitHub Repository Information Sheet.xlsx.md
```

Each `.md` carries YAML frontmatter (title, course, module, type, `canvas_url`,
scrape date, and for downloads the `source_url`/`source_file` + page/slide/sheet
counts).

## Which courses get scraped

`npm run courses` picks the target set automatically: courses you're an active
**student** in whose **term is current** (today falls inside the term's dates).
Observer enrolments, past-semester papers, and undated inductions are excluded.
The date-driven check keeps working across semesters with no edits.

## Configuration

Defaults live in `config.ts`. Machine-specific values — your output path, and
whether pruning may delete — belong in a gitignored `settings.json` merged over
the top at load (`CONFIG = applyUserSettings(DEFAULTS)`), so `git diff config.ts`
stays meaningful and "reset to defaults" is deleting one file. `src/settings.ts`
lists which keys may be overridden and validates each one, so a bad hand-edit
warns and falls back rather than failing mid-run.

| Setting | Purpose |
| --- | --- |
| `paths.output` | Where content is written. Defaults to a local `Output/` folder; set `"paths.output"` in `settings.json` to write into a vault instead. |
| `paths.manifest` | Incremental-scrape cache (`state/manifest.json`). Delete to force a full re-scrape. |
| `scrape.subfolder` | Subfolder per course (default `Modules`), sits next to UniNotes' `LectureNotes`. |
| `scrape.incremental` | Skip unchanged items on repeat runs (default `true`). |
| `scrape.pruneOrphans` | Delete orphaned files rather than just listing them (default `false`). |
| `scrape.linkInternally` | Rewrite links between scraped items into Obsidian links (default `true`). |
| `scrape.includeRubrics` | Render assignment rubrics (default `true`). |
| `scrape.includeQuizQuestions` | Fetch quiz questions where permitted (default `true`). |
| `extras.folder` | Folder for content outside the modules (default `Course Info`). |
| `extras.syllabus` / `.announcements` / `.unfiledPages` / `.unfiledFiles` | Which outside-the-modules sections to scrape. Files default to off. |
| `retry.*` | Attempts and backoff for transient failures (rate limits, 5xx, dropped sockets). |
| `scrape.courseFolders` | Maps Canvas course code (`COMPSYS 726`) → vault folder (`COMPSYS-726`). |
| `scrape.extraCourseIds` | Canvas course ids to scrape outside the default set, e.g. `[143801]` for a full-year paper filed under a past term. Ids come from `npm run courses`. |
| `scrape.keepOriginalPdf` | Keep the original PDF beside its extracted `.md`. |

## Limitations / notes

- **Image-only content** (scanned PDFs, picture-heavy slides) has no text to
  extract — the original file is always kept as the fallback.
- **Types without a converter** (zip, images, …) keep just the original file;
  pdf/pptx/xlsx/docx are converted whether they come from Canvas or SharePoint.
- **Discussion replies aren't scraped** — only the topic prompt. Replies are a
  separate paginated endpoint, are mostly student conversation rather than
  material, and would churn the incremental check on every run.
- **Assets are never pruned.** An image whose note was deleted lingers in
  `assets/`; they're small, and losing a figure is worse than keeping one.
- **Smart quotes/dashes** in some spreadsheets can come through mojibaked
  (e.g. `‚Äô` for `'`) — cosmetic; the text is otherwise verbatim.
- **SharePoint incremental check is existence-only** (no `updated_at` from
  Canvas for external links) — if a deck changes upstream at the same
  sharing link, delete the local copy to pick up the new version.

## Roadmap

- Warn before overwriting a note you've hand-edited (content hash in the
  manifest) — the output root is your vault, so edits are currently clobbered
  silently when Canvas reports a change.
- `--dry-run`, now that `--prune` deletes files.
- Optional additive summary/keyword frontmatter for retrieval (bodies stay
  verbatim — no destructive rewriting).
- Concurrency across independent items (currently fully sequential).
- A scheduler, now that repeat runs are cheap — though new SharePoint decks
  would still need a periodic manual re-auth.
