// R side of Quarto notebooks: rich chunk output (tables, HTML widgets),
// inline `r` values, and rendering a document to HTML with knitr + litedown.
// Added to the "tools:ide" environment after R_HELPERS.
//
// Values travel back as flat strings: fields separated by \x1f, records by \x1e.
// (No backticks in here: this is a JS template literal.)
export const R_NOTEBOOK = String.raw`
local({
  e <- as.environment("tools:ide")
  fence <- strrep(intToUtf8(96L), 3L)
  esc <- function(x) {
    x <- gsub("&", "&amp;", x, fixed = TRUE)
    x <- gsub("<", "&lt;", x, fixed = TRUE)
    x <- gsub(">", "&gt;", x, fixed = TRUE)
    gsub("\"", "&quot;", x, fixed = TRUE)
  }
  clean <- function(x) gsub("[\x1e\x1f]", " ", x)

  # ------------------------------------------------------------ rich values

  e$.ide_rich <- function(x) {
    if (inherits(x, c("htmlwidget", "shiny.tag", "shiny.tag.list", "html")) || .ide_has_tags(x)) {
      if (!requireNamespace("htmltools", quietly = TRUE)) return(NULL)
      return(list("widget", .ide_widget(x)))
    }
    if (is.data.frame(x) && ncol(x) > 0L) return(list("table", .ide_table(x)))
    NULL
  }

  # Objects (e.g. gt tables) that know how to turn themselves into HTML.
  e$.ide_has_tags <- function(x) {
    if (!is.object(x) || is.data.frame(x) || !isNamespaceLoaded("htmltools")) return(FALSE)
    any(vapply(class(x), function(cl) !is.null(utils::getS3method("as.tags", cl, optional = TRUE)), TRUE))
  }

  e$.ide_table <- function(x, max_rows = 1000L) {
    n <- nrow(x)
    shown <- as.data.frame(utils::head(x, max_rows))
    type_of <- function(col) {
      if (requireNamespace("pillar", quietly = TRUE)) return(tryCatch(pillar::type_sum(col), error = function(err) class(col)[1]))
      switch(class(col)[1], numeric = "dbl", integer = "int", character = "chr", factor = "fct",
        logical = "lgl", Date = "date", POSIXct = "dttm", class(col)[1])
    }
    cell <- function(col) {
      v <- tryCatch(format(col, trim = TRUE, justify = "none"), error = function(err) as.character(col))
      if (!is.null(dim(v))) v <- apply(v, 1L, paste, collapse = ", ")
      na <- tryCatch(is.na(col), error = function(err) rep(FALSE, length(v)))
      if (is.logical(na) && length(na) == length(v)) v[na] <- "NA"
      clean(as.character(v))
    }
    rn <- if (.row_names_info(x) > 0L) clean(rownames(shown)) else character()
    paste(c(
      paste(n, ncol(x), sep = "\x1f"),
      paste(clean(names(x)), collapse = "\x1f"),
      paste(clean(vapply(x, type_of, "")), collapse = "\x1f"),
      paste(rn, collapse = "\x1f"),
      vapply(shown, function(col) paste(cell(col), collapse = "\x1f"), "")
    ), collapse = "\x1e")
  }

  # A widget as body/head HTML plus the files of its dependencies; the IDE
  # inlines those into a self-contained page.
  e$.ide_widget <- function(x) {
    tags <- x
    if (inherits(x, "htmlwidget")) {
      tags <- tryCatch(htmlwidgets:::toHTML(x, standalone = TRUE), error = function(err) htmltools::as.tags(x))
    }
    r <- htmltools::renderTags(tags)
    h <- if (inherits(x, "htmlwidget") && is.numeric(x$height)) x$height else NA
    paste0(.ide_manifest(r$html, r$head, r$dependencies), "\x1eheight\x1f", h)
  }

  e$.ide_manifest <- function(body, head, deps) {
    deps <- htmltools::resolveDependencies(deps)
    parts <- c(paste0("body\x1f", body), paste0("head\x1f", head))
    for (d in deps) {
      dir <- ""
      if (!is.null(d$src$file)) dir <- if (!is.null(d$package)) system.file(d$src$file, package = d$package) else d$src$file
      href <- d$src$href
      loc <- function(f) {
        if (nzchar(dir)) return(c("", file.path(dir, f)))
        c("url", paste0(sub("/$", "", href %||% ""), "/", f))
      }
      items <- function(v, key) {
        if (is.list(v) && !is.null(names(v)) && key %in% names(v)) v <- list(v)
        vapply(v, function(s) if (is.list(s)) s[[key]] else s, "")
      }
      for (s in items(d$stylesheet, "href")) { l <- loc(s); parts <- c(parts, paste0("css", l[1], "\x1f", l[2])) }
      for (s in items(d$script, "src")) { l <- loc(s); parts <- c(parts, paste0("js", l[1], "\x1f", l[2])) }
      if (length(d$head)) parts <- c(parts, paste0("head\x1f", paste(d$head, collapse = "\n")))
    }
    paste(parts, collapse = "\x1e")
  }

  # ------------------------------------------------------------ inline code

  e$.ide_inline <- function(code) {
    tryCatch({
      v <- eval(parse(text = code, keep.source = FALSE), globalenv())
      if (is.numeric(v) && !is.object(v)) v <- format(v, digits = getOption("digits"))
      paste0("ok\x1f", clean(paste(as.character(v), collapse = ", ")))
    }, error = function(err) paste0("error\x1f", clean(conditionMessage(err))))
  }

  # ------------------------------------------------------------ rendering

  # Scalar options (e.g. revealjs settings) as key\x1fvalue records.
  e$.ide_scalars <- function(x) {
    keep <- vapply(x, function(v) is.atomic(v) && length(v) == 1L, TRUE)
    if (!length(x) || !any(keep)) return("")
    vals <- vapply(x[keep], function(v) if (is.logical(v)) tolower(as.character(v)) else clean(as.character(v)), "")
    paste(paste0(names(x)[keep], "\x1f", vals), collapse = "\x1e")
  }

  e$.ide_render <- function(text, dir) {
    for (p in c("knitr", "litedown")) if (!requireNamespace(p, quietly = TRUE)) webr::install(p, quiet = TRUE)
    lines <- strsplit(text, "\n", fixed = TRUE)[[1]]
    meta <- list()
    body <- lines
    if (length(lines) > 1L && grepl("^---\\s*$", lines[1])) {
      end <- which(grepl("^(---|\\.\\.\\.)\\s*$", lines[-1]))[1]
      if (!is.na(end)) {
        meta <- tryCatch(yaml::yaml.load(paste(lines[2:end], collapse = "\n")), error = function(err) list())
        body <- lines[-seq_len(end + 1L)]
      }
    }
    if (!is.list(meta)) meta <- list()
    # format: html | revealjs, as a string or as a list of per-format options
    to <- "html"
    fmt <- list()
    if (is.character(meta$format) && length(meta$format)) to <- meta$format[1]
    if (is.list(meta$format) && length(meta$format)) {
      to <- names(meta$format)[1]
      if (is.list(meta$format[[1]])) fmt <- meta$format[[1]]
    }
    if (!to %in% c("html", "revealjs")) to <- "html"
    opt <- function(name, default = NULL) fmt[[name]] %||% meta[[name]] %||% default

    fig_dir <- file.path(tempdir(), "ide-render")
    unlink(fig_dir, recursive = TRUE)
    dir.create(fig_dir, showWarnings = FALSE)
    old_wd <- setwd(dir)
    restore <- function() {
      knitr::opts_knit$restore()
      knitr::opts_chunk$restore()
      knitr::knit_hooks$restore()
    }
    restore()
    on.exit({ restore(); setwd(old_wd) }, add = TRUE)
    knitr::render_markdown()
    knitr::opts_knit$set(rmarkdown.pandoc.to = "html", out.format = "markdown")
    knitr::opts_chunk$set(dev = "png", dpi = 96, fig.retina = 2, fig.width = if (to == "revealjs") 10 else 7, fig.height = 5,
      fig.path = paste0(fig_dir, "/"), comment = NA)
    ex <- meta$execute
    if (is.list(ex) && length(ex)) {
      names(ex) <- gsub("-", ".", names(ex))
      do.call(knitr::opts_chunk$set, ex)
    }
    raw <- function(html) paste0("\n\n", fence, "{=html}\n", html, "\n", fence, "\n\n")

    knitr::knit_hooks$set(plot = function(x, options) {
      last <- is.null(options$fig.num) || is.null(options$fig.cur) || options$fig.cur >= options$fig.num
      lab <- options$label %||% ""
      id <- if (last && grepl("^fig-", lab)) sprintf(" id=\"%s\"", esc(lab)) else ""
      cap <- if (last && length(options$fig.cap)) sprintf("<figcaption>%s</figcaption>", esc(options$fig.cap[1])) else ""
      alt <- esc((options$fig.alt %||% options$fig.cap %||% "")[1])
      raw(sprintf("<figure class=\"quarto-figure\"%s><img src=\"%s\" alt=\"%s\" style=\"width:%dpx\">%s</figure>",
        id, knitr::image_uri(x), alt, round(options$fig.width * 96), cap))
    })
    fold <- opt("code-fold", FALSE)
    src0 <- knitr::knit_hooks$get("source")
    knitr::knit_hooks$set(source = function(x, options) {
      out <- src0(x, options)
      f <- options[["code-fold"]] %||% options$code.fold %||% fold
      if (isTRUE(f) || identical(f, "true") || identical(f, "show")) {
        out <- paste0("\n\n<details class=\"code-fold\"", if (identical(f, "show")) " open" else "",
          "><summary>Code</summary>\n\n", out, "\n\n</details>\n\n")
      }
      out
    })
    knitr::knit_hooks$set(chunk = function(x, options) {
      lab <- options$label %||% ""
      if (!grepl("^tbl-", lab)) return(x)
      tcap <- options[["tbl-cap"]] %||% options$tbl.cap %||% options$tab.cap
      cap <- if (length(tcap)) sprintf("<div class=\"table-caption\">%s</div>", esc(tcap[1])) else ""
      paste0(raw(sprintf("<div class=\"quarto-table\" id=\"%s\">%s", esc(lab), cap)), x, raw("</div>"))
    })

    md <- knitr::knit(text = body, quiet = TRUE, envir = new.env(parent = globalenv()))
    md <- gsub("(?s)<!--html_preserve-->(.*?)<!--/html_preserve-->", raw("\\1"), md, perl = TRUE)
    deps <- knitr::knit_meta(class = "html_dependency", clean = TRUE)
    lite <- "-js_highlight-js_math-embed_resources"
    if (isTRUE(opt("number-sections"))) lite <- paste0(lite, "+number_sections")
    html <- paste(litedown::mark(text = md, options = lite), collapse = "\n")
    manifest <- if (length(deps) && requireNamespace("htmltools", quietly = TRUE)) .ide_manifest("", "", deps) else ""

    who <- meta$author
    if (is.list(who)) who <- vapply(who, function(a) if (is.list(a)) as.character(a$name %||% "") else as.character(a), "")
    date <- as.character(meta$date %||% "")
    if (date %in% c("today", "now", "last-modified")) date <- format(Sys.Date(), "%B %d, %Y")
    one <- function(x) clean(paste(as.character(x %||% ""), collapse = " "))
    c(one(meta$title), one(meta$subtitle), paste(clean(as.character(who %||% character())), collapse = "\x1f"), clean(date),
      if (isTRUE(opt("toc"))) "true" else "", one(opt("toc-title", "Contents")), html, manifest, one(meta$abstract),
      to, .ide_scalars(fmt))
  }
})
invisible(NULL)
`;
