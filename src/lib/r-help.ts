// R side of the HTML Help pane. Help pages are rendered with tools::Rd2HTML
// (dynamic links: "../../<pkg>/help/<topic>"), and ?topic, help(package = ),
// vignette() and browseVignettes() are routed to the Help pane through the
// pager with a small header the IDE recognises:
//   "\x01ide-help\x01" / pkg / topic / title / html…
//   "\x01ide-file\x01" / path / title
export const R_HELP = String.raw`
local({
  e <- as.environment("tools:ide")
  esc <- function(x) {
    x <- gsub("&", "&amp;", x, fixed = TRUE)
    x <- gsub("<", "&lt;", x, fixed = TRUE)
    gsub(">", "&gt;", x, fixed = TRUE)
  }
  enc <- function(x) vapply(x, utils::URLencode, "", reserved = TRUE, USE.NAMES = FALSE)
  rd_db <- function(dir) tryCatch(readRDS(file.path(dir, "Meta", "Rd.rds")), error = function(err) NULL)

  # c(title, html, pkg, topic) for one help file (a path from help()).
  e$.ide_help_render <- function(path) {
    pkg <- basename(dirname(dirname(path)))
    topic <- basename(path)
    rd <- utils:::.getHelpFile(path)
    f <- tempfile(fileext = ".html")
    on.exit(unlink(f))
    tools::Rd2HTML(rd, out = f, package = pkg, dynamic = TRUE)
    html <- paste(readLines(f, encoding = "UTF-8", warn = FALSE), collapse = "\n")
    c(paste0(topic, " {", pkg, "}"), html, pkg, topic)
  }

  help_title <- function(path) {
    db <- rd_db(dirname(dirname(path)))
    if (is.null(db)) return("")
    t <- db$Title[tools::file_path_sans_ext(db$File) == basename(path)]
    if (length(t)) t[1] else ""
  }

  e$.ide_help_paths <- function(paths, topic, package = "", note = "") {
    if (length(paths) == 1L) return(e$.ide_help_render(paths))
    if (!length(paths)) {
      msg <- if (nzchar(package) && !nzchar(system.file(package = package)))
        sprintf("Package <code>%s</code> is not installed.", esc(package))
      else sprintf("No documentation for <code>%s</code>%s. Try <code>??%s</code> in the console to search all help.",
        esc(topic), if (nzchar(package)) sprintf(" in package <code>%s</code>", esc(package)) else "", esc(topic))
      return(c(paste("No help for", topic), paste0("<h2>No help found</h2><p>", msg, "</p>"), package, topic))
    }
    pkgs <- basename(dirname(dirname(paths)))
    titles <- vapply(paths, help_title, "", USE.NAMES = FALSE)
    items <- sprintf('<li><a href="../../%s/help/%s"><code>%s::%s</code></a> %s</li>',
      enc(pkgs), enc(topic), esc(pkgs), esc(topic), esc(titles))
    html <- paste0("<h2>Help on <code>", esc(topic), "</code></h2>",
      if (nzchar(note)) paste0("<p>", note, "</p>") else "<p>Found in more than one package:</p>",
      "<ul class='help-choices'>", paste(items, collapse = ""), "</ul>")
    c(paste("Help on", topic), html, "", topic)
  }

  e$.ide_help_html <- function(topic, package = "") {
    args <- list(topic, help_type = "text")
    if (nzchar(package)) args$package <- package
    paths <- tryCatch(as.character(do.call(utils::help, args)), error = function(err) character(0))
    if (!length(paths) && !nzchar(package)) {
      args$try.all.packages <- TRUE
      paths <- tryCatch(as.character(do.call(utils::help, args)), error = function(err) character(0))
      if (length(paths))
        return(e$.ide_help_paths(paths, topic, "", "Not in a loaded package, but found in:"))
    }
    e$.ide_help_paths(paths, topic, package)
  }

  # HTML and PDF documents in a package's doc folder, vignettes first.
  e$.ide_vignettes <- function(pkg) {
    dir <- system.file(package = pkg)
    out <- data.frame(title = character(0), file = character(0))
    info <- tryCatch(tools::getVignetteInfo(pkg), error = function(err) NULL)
    if (!is.null(info) && nrow(info)) {
      files <- file.path(dir, "doc", info[, "PDF"])
      ok <- nzchar(info[, "PDF"]) & file.exists(files)
      out <- data.frame(title = info[ok, "Title"], file = files[ok])
    }
    if (!nrow(out)) {
      fs <- list.files(file.path(dir, "doc"), pattern = "[.](html|pdf)$", full.names = TRUE)
      fs <- fs[basename(fs) != "index.html"]
      out <- data.frame(title = tools::file_path_sans_ext(basename(fs)), file = fs)
    }
    out
  }

  e$.ide_help_index <- function(pkg) {
    dir <- system.file(package = pkg)
    if (!nzchar(dir)) return(e$.ide_help_paths(character(0), "", pkg))
    d <- tryCatch(utils::packageDescription(pkg), error = function(err) list())
    html <- sprintf("<h2>%s: %s</h2><p class='help-meta'>Version %s</p>%s",
      esc(pkg), esc(d$Title %||% ""), esc(d$Version %||% ""),
      if (!is.null(d$Description)) paste0("<p>", esc(gsub("\\s+", " ", d$Description)), "</p>") else "")
    v <- e$.ide_vignettes(pkg)
    if (nrow(v)) {
      kind <- toupper(tools::file_ext(v$file))
      html <- paste0(html, "<h3>Vignettes and documents</h3><ul>",
        paste(sprintf('<li><a href="ide-file:%s">%s</a> <span class="help-meta">%s</span></li>',
          enc(v$file), esc(v$title), kind), collapse = ""), "</ul>")
    }
    db <- rd_db(dir)
    if (!is.null(db) && nrow(db)) {
      internal <- vapply(db$Keywords, function(k) "internal" %in% k, TRUE)
      db <- db[!internal, , drop = FALSE]
      db <- db[order(tolower(db$Name)), , drop = FALSE]
      link <- mapply(function(n, a) if (n %in% a || !length(a)) n else a[1], db$Name, db$Aliases, USE.NAMES = FALSE)
      html <- paste0(html, "<h3>Help pages</h3><table class='help-index'>",
        paste(sprintf('<tr><td><a href="../../%s/help/%s">%s</a></td><td>%s</td></tr>',
          enc(pkg), enc(link), esc(db$Name), esc(db$Title)), collapse = ""), "</table>")
    }
    c(paste("Package", pkg), html, pkg, "")
  }

  show <- function(lines, title) {
    f <- tempfile(fileext = ".txt")
    writeLines(enc2utf8(lines), f, useBytes = TRUE)
    file.show(f, title = title, delete.file = TRUE)
  }
  e$.ide_help_show <- function(res) {
    show(c("\001ide-help\001", res[3], res[4], res[1], res[2]), res[1])
    invisible(NULL)
  }

  original_print <- utils:::print.help_files_with_topic
  ns <- asNamespace("utils")
  suppressWarnings(suppressMessages({
    registerS3method("print", "help_files_with_topic", function(x, ...) {
      paths <- as.character(x)
      if (!length(paths)) return(original_print(x, ...))
      note <- if (isTRUE(attr(x, "tried_all_packages"))) "Not in a loaded package, but found in:" else ""
      e$.ide_help_show(e$.ide_help_paths(paths, attr(x, "topic"), "", note))
      invisible(x)
    }, envir = ns)
    registerS3method("print", "packageInfo", function(x, ...) {
      e$.ide_help_show(e$.ide_help_index(x$name))
      invisible(x)
    }, envir = ns)
    registerS3method("print", "vignette", function(x, ...) {
      f <- file.path(x$Dir, "doc", x$PDF)
      if (length(f) == 1L && nzchar(x$PDF) && file.exists(f)) show(c("\001ide-file\001", f, x$Title %||% x$Topic), x$Topic)
      else message("This vignette isn't available in this R.")
      invisible(x)
    }, envir = ns)
    registerS3method("print", "browseVignettes", function(x, ...) {
      for (p in utils::head(names(x), 1L)) e$.ide_help_show(e$.ide_help_index(p))
      invisible(x)
    }, envir = ns)
  }))
  invisible(NULL)
})
`;
