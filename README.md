# webR IDE

An RStudio-style IDE for [webR](https://github.com/r-wasm/webr) (R compiled to WebAssembly). It runs entirely in the browser and is designed for iPad Safari. It can be installed as a PWA.

- **Script:** [Monaco](https://microsoft.github.io/monaco-editor/) editor with tabs, R syntax highlighting, and completions from R itself
- **Console:** [wterm](https://wterm.dev/) terminal with line editing, history, Tab completion, and Ctrl+C to interrupt
- **Environment / History:** objects grouped as Data, Values, and Functions; expandable `str()` views; `View()` data viewer; command history with *To Console* and *To Source*
- **Plots / Packages / Help:** plot history, an **Expand** button that re-renders the plot full size in a closable window, PNG save and download, package install and attach, and R help pages
- **Files sidebar:** create, rename, delete, upload, download, and drag-and-drop; import CSV files; source scripts
- **Workspaces:** each workspace has its own files, history, open tabs, and saved environment (`.RData`)

## Quarto notebooks

Quarto (`.qmd`) and R Markdown (`.Rmd`) documents work like notebooks. **New → Quarto Document** starts one.

- **Run chunks.** Each ```` ```{r} ```` chunk has ▶ (run) and ⤒ (run all above) buttons at the right of its first line. The toolbar has **Run Chunk**, **Run All**, **Stop**, and ＋ to insert a chunk.
- **Output where you want it.** **Inline** shows output under each chunk; **Pane** shows it in the **Output** tab. Printed values, messages, warnings, errors and plots appear in the order they happened. Tap a plot to enlarge it.
- **Rich output.** Data frames and tibbles show as paged tables (first 1,000 rows). HTML widgets such as plotly, leaflet, DT and reactable, and gt tables, are interactive, with a button to open them full size.
- **Inline code.** ⌘↩ on a line with `` `r expr` `` shows its value after the expression. **Run All** evaluates inline code in document order with the chunks.
- **Saved output.** Output is saved per document in the workspace's hidden `.ide/outputs/` folder. It comes back when you reopen the document or reload, and moves with the file on rename. Clearing output (🧹) deletes it.
- **Shared session.** Chunks run in the same R session as the console, so objects appear in the Environment pane.

### Render to HTML

**Render** (⌘⇧K) knits the document and shows it in the **Preview** tab: an HTML page for `format: html` (the default), or slides for `format: revealjs`. Saving re-renders it while it's being previewed. The page can be saved next to the document as `.html`, or downloaded. It is self-contained: images, widgets and their libraries are inlined, and it works offline.

It uses knitr and litedown, both installed on first use, rather than Quarto/Pandoc, and adds Quarto's HTML features itself:

- Title block (`title`, `subtitle`, `author`, `date`, `abstract`), `toc`, `number-sections` and `code-fold` (under `format: html:` or at the top level), and `execute:` options
- Chunk options in `#|` form (`echo`, `eval`, `include`, `fig-cap`, `fig-width`, `code-fold`, …)
- Callouts (`::: {.callout-note}` and the other four types, with a heading or `title=`), tabsets (`::: {.panel-tabset}`)
- Figure and table cross-references (`#| label: fig-…` / `tbl-…` with `@fig-…`, `@tbl-…`, `@sec-…`)
- Maths (`$…$`, `$$…$$`), rendered as MathML with KaTeX, and highlighted code

### Presentations

`format: revealjs` renders [reveal.js](https://revealjs.com) slides into the Preview tab. **New → Quarto Presentation** starts one. They follow Quarto's conventions and look:

- **Themes.** Quarto's own reveal.js themes (`default`, `dark`, `beige`, `blood`, `dracula`, `league`, `moon`, `night`, `serif`, `simple`, `sky`, `solarized`; `white`/`black` are aliases). They're compiled from Quarto's Sass sources (`scripts/build-quarto-themes.py`), and their fonts (Source Sans, Lato, League Gothic, …) are bundled, so slides look the same offline.
- **Structure.** `##` headings start slides, `#` headings make section slides, `---` starts an untitled slide, and there's a title slide. With `navigation-mode: vertical`, each `#` section becomes a vertical stack.
- **Slide attributes.** `{.smaller}`, `{.scrollable}`, `{background-color="…"}`, `{background-image="…"}`, `{transition="…"}`, `{auto-animate=true}`.
- **Content.** `::: {.incremental}` / `{.nonincremental}`, `::: {.fragment}`, `:::: {.columns}` with `::: {.column width="40%"}`, `.absolute` with `top`/`left`/`right`/`bottom`/`width`/`height`, and `::: {.notes}`. Plots, widgets, maths, callouts and highlighted code work as in documents.
- **Options** under `format: revealjs:`: `theme`, `transition`, `slide-number`, `incremental`, `smaller`, `scrollable`, `footer`, `logo`, `controls`, `progress`, `center`, `width`, `height`, `margin`, `loop`, `navigation-mode`, `chalkboard`.

Presenting:

- **Present** shows the slides full screen. Safari can't lock the screen to landscape, so on a touch device held upright (for example an iPad with rotation lock on, held sideways) the slides turn 90° to fill the screen. The ⟲ ⟳ buttons change the direction or turn it off, and the rotation is dropped if the screen turns to landscape. On iPhone, which has no element full screen, a full-window view is used instead.
- **Presenter** opens the presenter view: the current slide, the next one, speaker notes (resizable), an elapsed timer you can pause, the time, and large previous/next buttons for touch.
- **Audience window** (⛶) opens the slides in a separate window to drag to a projector or second display, with its own **Full screen** button. On iPad it opens as a Safari tab, which Stage Manager can move to an external display. Every view stays on the same slide, whichever one you navigate from.
- **Pen.** Draw over slides with the pen button (when `chalkboard: true`), the presenter's **Pen**, `C`, or just an Apple Pencil. `B` opens a blank board and Delete clears. Drawings appear in every view.

The saved `.html` is a single self-contained file that works offline. Not supported: Quarto's multiplex, which needs a server to broadcast to viewers' browsers.

Not supported: PDF/Word output, citations from `.bib` files, Quarto projects, and non-R engines. The code runs in an environment that inherits from the global environment, rather than in a fresh R session as Quarto does, so it can see objects you've created in the console.

## Data grid

CSV, TSV, PSV and `.tab` files get a **Text | Grid** toggle in the script toolbar. Grid view is a read-only spreadsheet:

- **Virtualized rows and columns.** Only the visible cells are in the DOM. Very long tables use proportional scrolling, so millions of rows stay smooth.
- **Lazy loading.** A worker streams the file in 8 MB chunks and records each row's byte offset, handling quoted newlines. The first rows appear immediately, and rows are read from disk only when scrolled into view. A 1M-row, 37 MB file opens in about 0.1 s.
- **Sorting.** Click a header to cycle ascending, descending, off. Sorting is numeric-aware, and missing values go last.
- **Filters.** Each column has a filter: text means *contains*. You can also use `=x`, `!=x`, `>5`, `>=5`, `<5`, `<=5`, ranges like `1..10`, and `empty` / `!empty`. There's also a search box across all columns. Sorting a million rows takes about a second.
- **Editing.** Columns can be resized by dragging and navigated with the arrow keys. ⌘C copies a cell. **Import to R** reads the file into a data frame.
- **Size limits.** Files over 10 MB open in grid view only. Files over 500 MB are blocked, with a Download button and a suggestion to use a desktop viewer.

R's `View()` uses the same grid.

## Package browser

**Packages** in the top bar, or **Browse** in the Packages tab, opens a browser modelled on Visual Studio's NuGet manager:

- **Browse / Installed / Updates** tabs.
- **Search.** Package names match instantly against webR's repository index, which also works offline. Topic search (e.g. "read excel") uses [R-universe](https://r-universe.dev). Results are re-ranked by relevance and popularity, and anything webR can't install is filtered out.
- **Details.** Description, webR and CRAN versions, license, maintainer, monthly downloads, reverse dependencies, links, and dependencies (ticked if already installed), plus a note of what an install would also pull in.
- **Actions.** Install, update or remove. Installs run in the console, so you can see their output.

Only search text and package names are sent to R-universe.

**Only packages with a webR build are listed.** Every result is checked against webR's own repository index for the running R version (`repo.r-wasm.org/bin/emscripten/contrib/4.6`), and anything without a WebAssembly binary is dropped. Having a binary doesn't guarantee a package works in the browser, so packages verified *not* to work (RSQLite, googlesheets4, googledrive) show a ⚠ known-issue badge with an explanation.

### Install progress

Every install path is tracked: `webr::install()`, `install.packages()`, `library()` auto-installing a missing package (from the console or a script), and the package browser. The IDE wraps webR's installer, and the wrapper emits hidden progress markers that the console strips out. While a download runs:

- an overlay with a spinner covers the script editor, showing the current package and a running count, and the editor is read-only;
- Run, Run All and Source are disabled;
- the status pill reads *Installing &lt;pkg&gt;…*.

Downloads served from the browser cache finish in milliseconds. To avoid a flash, the overlay only appears for installs that take longer than 150 ms, and then stays up for at least 400 ms.

## Storage

**If files disappear on reload**, the browser isn't letting the IDE save. At startup the IDE saves a test file; if that fails, it shows a banner with the reason and keeps files in memory for that page only. **Workspace menu → Storage Details…** lists what the browser supports, with a Copy button. Common causes:
- **An `http://` address**, such as the dev server opened from a phone at `http://192.168.x.x:5173`. Browsers only allow storage on `https://` or `localhost`.
- **Private Browsing.**
- **Blocked website data.** On iPhone/iPad, turn off Settings → Apps → Safari → **Block All Cookies**.

Files live in the browser's **Origin Private File System (OPFS)**, which Safari has supported since 15.2, at `/workspaces/<name>/…`. On older Safari versions that lack `createWritable()`, writes go through a worker that uses `createSyncAccessHandle()`. If OPFS is unavailable (for example in some private-browsing modes), the IDE falls back to in-memory storage and shows a warning.

### How R sees your files

**R works on the workspace in browser storage directly.** Nothing is copied into R's memory. Each workspace is mounted at `~/<workspace>` using webR's built-in `DRIVEFS` mount. When R touches a file, webR's worker makes a synchronous request, and the app's service worker answers it from OPFS (`src/lib/drive/server.ts`).

The IDE replaces DriveFS's stock file handling inside webR's worker (`src/lib/drive/worker-patch.ts`, applied with `webr::eval_js()`):

| | Stock DriveFS | This IDE |
|---|---|---|
| Reading | Whole file, base64 | Files ≤ 4 MB whole; larger ones in 2 MB blocks on demand (HTTP `Range`), raw binary |
| Writing | Copies the whole file on every write (a 50 MB `write.csv` never finishes) | Buffer grows geometrically, uploaded once on close |
| `mmap` | Missing (readr returns an empty table; `fread` errors) | Supported |

For a 50 MB CSV in WebKit, `read.csv` takes about 1.9 s, `write.csv` about 1.4 s, and reading the first lines takes about 13 ms. Peak extra memory is the 2 MB blocks R is reading, not the workspace.

- **Live updates.** Files R creates, changes or deletes appear in the Files pane straight away, and open editor tabs reload.
- **Consistency.** Saves from the IDE are queued while R is part-way through reading that file. A file changed by anything else mid-read gives R an I/O error rather than mixed data.
- **Safety.** At startup the IDE self-tests the mount (write, read, append, rename, RDS, `mmap`). If that fails, for example after a webR upgrade changes its internals, or if there's no service worker, it falls back to **compatibility mode**. In compatibility mode the workspace is copied into R and changes are synced back after each command. Hover over the folder path in the Files pane to see which mode is active.
- **Limits.** Each file open costs a few milliseconds, so commands that touch thousands of files are slower than on a real disk. There are no symlinks or file locks, and permissions are cosmetic.

The global environment is autosaved to `<workspace>/.RData` when R goes idle and restored when you reopen the workspace. **Environments over 100 MB aren't autosaved**, to save storage space; a notice appears, and *Save Environment* still saves them on demand.

### Package library

Packages you install are kept between sessions. webR installs a package by mounting the archive `<pkg>_<version>.tgz` from the webR repository. The IDE saves a copy of each archive, including every dependency, in OPFS:

```
packages/<R major.minor>/<pkg>_<version>.tgz
packages/index.json      # name, version, R version, source URL, size, date
```

On startup, every saved package for the running R version is mounted into `/webr-ide/library`, which is first in `.libPaths()`, before the console accepts input. Nothing is downloaded and it works offline. Archives are stored per R version, so a webR upgrade to a new R release won't load incompatible binaries. Old archives show up in the Packages tab with a *Clear* link.

The Packages tab splits the list into the **User library** (saved packages) and the **System library** (bundled with webR). It shows each package's saved version and can **check for updates** against the repository. Updating installs the new version, which replaces the saved archive; if the package is already loaded, it asks to restart R first. The trash icon removes a package.

> **Tip for iPad:** use *Share → Add to Home Screen*. Installed web apps are exempt from Safari's 7-day storage eviction for sites you haven't visited. The app also asks the browser for persistent storage.

## Keyboard shortcuts

The same shortcuts work on all platforms: ⌘ on Mac and iPad keyboards is Ctrl on Windows and Linux, and ⌥ is Alt. Tooltips show the keys for your platform.

| Action | Mac / iPad | Windows / Linux |
|---|---|---|
| Run line / selection (**Run**) | ⌘↩ (or ⌃↩) | Ctrl+Enter |
| Run whole script, or every chunk (**Run All**) | ⌘⌥R | Ctrl+Alt+R |
| Source file with echo (in a Quarto document: run the current chunk) | ⌘⇧↩ | Ctrl+Shift+Enter |
| Quarto: run chunk / run all chunks above / insert chunk | ⌘⌥C / ⌘⌥P / ⌘⌥I | Ctrl+Alt+C / Ctrl+Alt+P / Ctrl+Alt+I |
| Quarto: render to the Preview tab | ⌘⇧K | Ctrl+Shift+K |
| Source file | ⌘⇧S | Ctrl+Shift+S |
| Save / new R script | ⌘S / ⌘⌥N | Ctrl+S / Ctrl+Alt+N |
| Insert `<-` / ` \|> ` | ⌥- / ⌘⇧M | Alt+- / Ctrl+Shift+M |
| Focus console | ⌃2 | Ctrl+2 ¹ |
| Console: complete / history / interrupt / clear | Tab / ↑↓ / ⌃C / ⌃L | Tab / ↑↓ / Ctrl+C / Ctrl+L |
| Restart R | ⌘⇧F10 | Ctrl+Shift+F10 |

¹ Most Windows/Linux browsers keep Ctrl+1–8 for switching tabs, so Ctrl+2 may switch tabs instead. Click the console to focus it.

Double-click (or double-tap) a pane header, or use its □ button, to zoom that pane. Drag the gutters to resize panes; double-click a gutter to reset it.

## Tidyverse support (webR 0.6.1, R 4.6)

**Examples ▾** in the top bar opens a runnable script for each package below. Every script was run in webR, in WebKit, each in a fresh R session.

| Status | Packages |
|---|---|
| ✅ Works | tidyverse, ggplot2, dplyr, tidyr, readr, purrr, tibble, stringr, forcats, lubridate, readxl, haven, jsonlite, xml2, hms, broom, modelr, magrittr, glue, dbplyr (with **duckdb**), dtplyr / data.table |
| 🟡 Partly | httr2, rvest, and reading URLs with `read_csv()` / `download.file()`: requests go through the browser, so they only reach servers that allow cross-origin requests (CORS). The GitHub API and raw GitHub files work; most web pages don't. |
| ❌ Not in the browser | **RSQLite**: its compiled code fails to load in webR 0.6.1, so use duckdb instead. A failed load like this can also stop *other* compiled packages from loading in the same session; restart R if that happens. **googlesheets4 / googledrive**: they need Google's OAuth sign-in, which can't run here. |

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (sends COOP/COEP headers)
npm run build      # production build → dist/
npm run preview -- --host   # serve dist/ on your LAN to test from an iPad
```

## Deployment

`dist/` is a static site (about 61 MB) that can be hosted anywhere. The build uses a relative base path, so it works at a domain root or under a subpath.

### GitHub Pages

`main` holds only source. The workflow in `.github/workflows/deploy.yml` runs on every push to `main`: it type-checks, builds, and publishes the contents of `dist/` to the **`gh-pages`** branch, which GitHub Pages serves. Each deploy replaces `gh-pages` with a single fresh commit (`Deploy <sha> from main`), so built files never pile up in the repository's history.

1. Push the repository to GitHub. Pages on a private repository needs a paid plan.
2. Wait for the first **Deploy to GitHub Pages** run in the **Actions** tab to finish; this creates the `gh-pages` branch.
3. Open **Settings → Pages → Build and deployment** and set **Source** to **Deploy from a branch**, branch **`gh-pages`**, folder **`/ (root)`**.
4. The site appears at `https://<user>.github.io/<repo>/` within a minute or two. Later pushes to `main` redeploy automatically, and you can also run the workflow by hand from **Actions**.

GitHub Pages can't send custom headers, so the service worker supplies the cross-origin isolation headers (see below). The build includes `.nojekyll` so GitHub serves the files as-is instead of running Jekyll over them.

### Other hosts

webR needs a **cross-origin isolated** page to use `SharedArrayBuffer`, which it relies on for interrupting R and for blocking input such as `readline()`. If your host can set headers, send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If it can't, the bundled service worker adds those headers itself. On the first visit the page reloads once when the worker takes control. Until then, webR runs in its PostMessage mode, which works except for interrupts.

**Works offline.** The webR runtime is bundled with the app instead of loaded from the webR CDN. That includes R.wasm, the worker, and R's base library (help pages, translations, the time zone database, `parallel`, fonts). It's served from `webr/<version>/` and is about 47 MB. webR's default *lazy* filesystem fetches base-library files on demand with synchronous requests, which service workers can't answer. So the IDE turns that off and, at startup, mounts every base-library image itself using normal fetches. The service worker caches those cache-first after the first run. Together with installed packages restored from OPFS, R starts with no network at all. The only things that still need a connection are installing *new* packages and checking for updates. The repository index is fetched network-first so those checks stay current.

## Project layout

```
src/
  lib/
    r-session.ts   webR wrapper: console input queue, output/plot/pager/view events
    r-helpers.ts   R helper functions (attached as "tools:ide")
    ide.ts         app state, workspaces, OPFS ⇄ webR file sync, history, autosave
    packages.ts    versioned package cache: capture installs, mount on start, updates
    pkg-index.ts   webR repo index + R-universe search/details (package browser)
    pkg-actions.ts install / update / remove shared by the UI
    grid/          CSV parsing, lazy indexing worker, grid data sources
    opfs.ts        OPFS storage (+ in-memory fallback, Safari worker writer)
    monaco.ts      Monaco setup, themes, R completion provider, statement detection
    ui.ts          dialogs, toasts, theme
  components/      TopBar, Workbench (layout/splitters), Sidebar, Editor,
                   Console, EnvPane, PlotsPane, DataGrid, PackageBrowser, Modals
  sw.ts            service worker (precache, COOP/COEP injection, webR runtime cache, workspace drive)
  sw-dev.ts        development service worker (workspace drive only; served as /dev-sw.js)
  lib/drive/       workspace drive: server (service worker), worker patch, page client
  lib/webr-runtime.ts  mounts the bundled base library at startup
vite.config.ts     also serves/copies node_modules/webr/dist → webr/<version>/
```
