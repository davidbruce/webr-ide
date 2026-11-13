// R helpers behind the editor's language features: syntax checks, function
// hints, help summaries and code formatting. Installed into "tools:ide".
export const R_INTEL = String.raw`
local({
  e <- as.environment("tools:ide")

  # "" if the code parses, else R's parse error message.
  e$.ide_parse_check <- function(text) {
    tryCatch({
      parse(text = text, keep.source = FALSE)
      ""
    }, error = function(err) conditionMessage(err))
  }

  e$.ide_fun <- function(name) {
    tryCatch({
      if (grepl("::", name, fixed = TRUE)) f <- eval(str2lang(name), globalenv())
      else f <- get(name, envir = globalenv(), mode = "function")
      if (is.function(f)) f else NULL
    }, error = function(err) NULL)
  }

  # Argument names and deparsed defaults ("" when there is none), interleaved.
  e$.ide_signature <- function(name) {
    f <- e$.ide_fun(name)
    if (is.null(f)) return(character(0))
    a <- formals(if (is.primitive(f)) args(f) else f)
    if (!length(a)) return("\x02") # a function without arguments
    def <- vapply(seq_along(a), function(i) {
      d <- paste(deparse(a[[i]], width.cutoff = 500L), collapse = " ")
      if (nchar(d) > 40) paste0(substr(d, 1, 37), "...") else d
    }, "")
    c(rbind(names(a), def))
  }

  # The parsed help page for a name (optionally pkg::name), or NULL.
  e$.ide_rd <- function(name) {
    parts <- strsplit(name, ":::?")[[1]]
    args <- list(parts[length(parts)])
    if (length(parts) > 1) args$package <- parts[1]
    h <- tryCatch(do.call(utils::help, args), error = function(err) character(0))
    if (!length(h)) return(NULL)
    rd <- tryCatch(utils:::.getHelpFile(h[1]), error = function(err) NULL)
    if (is.null(rd)) return(NULL)
    attr(rd, "ide_pkg") <- basename(dirname(dirname(h[1])))
    rd
  }

  # Rd fragment -> Markdown-ish text: \code{} becomes backticks.
  e$.ide_rd_text <- function(x, max = 600) {
    flat <- function(x) {
      tag <- attr(x, "Rd_tag")
      if (is.list(x)) {
        inner <- paste(vapply(x, flat, ""), collapse = "")
        if (identical(tag, "\\code") || identical(tag, "\\env") || identical(tag, "\\option")) paste0("\x60", inner, "\x60")
        else if (identical(tag, "\\dots") || identical(tag, "\\ldots")) "..."
        else inner
      } else if (identical(tag, "COMMENT")) "" else paste(as.character(x), collapse = "")
    }
    txt <- gsub("[ \t\r\n]+", " ", trimws(flat(x)))
    if (nchar(txt) > max) paste0(substr(txt, 1, max - 3), "...") else txt
  }

  e$.ide_rd_section <- function(rd, t) {
    s <- rd[vapply(rd, function(x) identical(attr(x, "Rd_tag"), t), TRUE)]
    if (length(s)) s[[1]] else NULL
  }

  # Help summary: c(package, title, description) or character(0).
  e$.ide_help_summary <- function(name) {
    rd <- e$.ide_rd(name)
    if (is.null(rd)) return(character(0))
    sec <- function(t) { s <- e$.ide_rd_section(rd, t); if (is.null(s)) "" else e$.ide_rd_text(s) }
    c(attr(rd, "ide_pkg"), sec("\\title"), sec("\\description"))
  }

  # Argument descriptions from the help page: names and texts, interleaved.
  e$.ide_help_args <- function(name) {
    rd <- e$.ide_rd(name)
    if (is.null(rd)) return(character(0))
    a <- e$.ide_rd_section(rd, "\\arguments")
    if (is.null(a)) return(character(0))
    out <- character(0)
    for (it in a) {
      if (!identical(attr(it, "Rd_tag"), "\\item") || length(it) < 2) next
      nms <- tryCatch(trimws(strsplit(e$.ide_rd_text(it[[1]]), ",")[[1]]), error = function(err) character(0))
      nms <- gsub("\x60", "", nms)
      d <- tryCatch(e$.ide_rd_text(it[[2]], 400), error = function(err) "")
      for (n in nms[nzchar(nms)]) out <- c(out, n, d)
    }
    out
  }

  # Problems codetools can see without running anything: unknown functions,
  # calls with arguments a function doesn't take, and (inside functions)
  # variables assigned but never used.
  #
  # Each top-level statement is checked on its own and the raw result cached
  # by its source text, so editing one statement only re-checks that one.
  # At most "budget" seconds are spent per call: the result starts with "1"
  # when every statement was checked, "0" when the caller should call again.
  # Then (line, message) pairs follow.
  e$.ide_lint_cache <- new.env(hash = TRUE)
  e$.ide_lint_one <- function(expr, ref) {
    raw <- character(0)
    rec <- function(m) raw <<- c(raw, m)
    is_fn_def <- is.call(expr) && as.character(expr[[1]])[1] %in% c("<-", "=") && length(expr) == 3 &&
      is.call(expr[[3]]) && identical(expr[[3]][[1]], as.name("function"))
    fn <- if (is_fn_def) tryCatch(eval(expr[[3]], globalenv()), error = function(err) NULL)
    if (is.function(fn)) {
      # A function definition: one check covers its body, including unused locals.
      try(codetools::checkUsage(fn, name = "f", report = rec, all = TRUE, suppressParamUnused = TRUE), silent = TRUE)
    } else {
      # Other code: wrapped as a function body so codetools can walk it.
      body <- as.call(list(as.name("{"), expr))
      attr(body, "srcref") <- list(NULL, ref)
      attr(body, "srcfile") <- attr(ref, "srcfile")
      f <- eval(call("function", NULL, body))
      environment(f) <- globalenv()
      try(codetools::checkUsage(f, name = "script", report = rec, all = TRUE,
        suppressLocalUnused = TRUE, suppressParamUnused = TRUE), silent = TRUE)
    }
    # Store lines relative to the statement's first line.
    start <- ref[1]
    vapply(raw, function(m) {
      loc <- regmatches(m, regexec("\\(<text>:([0-9]+)(-[0-9]+)?\\)\\s*$", m))[[1]]
      rel <- if (length(loc)) as.integer(loc[2]) - start else 0L
      paste0(rel, "\x1f", sub("^[^ :]*: ", "", sub("\\s*\\(<text>:[0-9-]+\\)\\s*$", "", m)))
    }, "", USE.NAMES = FALSE)
  }
  # 'known': names defined elsewhere (other chunks, other files) that aren't unknown.
  e$.ide_lint <- function(text, budget = 0.1, known = character(0)) {
    if (!e$.ide_tool("codetools")) return("1")
    exprs <- tryCatch(parse(text = text, keep.source = TRUE), error = function(err) NULL)
    if (is.null(exprs) || !length(exprs)) return("1")
    refs <- attr(exprs, "srcref")
    lines <- strsplit(text, "\n", fixed = TRUE)[[1]]
    cache <- e$.ide_lint_cache
    if (length(cache) > 5000) { rm(list = ls(cache), envir = cache) }
    # Names this file assigns at the top level, and whether its functions
    # can't be known yet (packages it loads that aren't attached, or other
    # files it sources).
    assigned <- unlist(lapply(exprs, function(x) {
      if (is.call(x) && as.character(x[[1]])[1] %in% c("<-", "=", "<<-") && length(x) == 3 && is.symbol(x[[2]])) as.character(x[[2]])
    }))
    pkgs <- unlist(lapply(exprs, function(x) {
      if (is.call(x) && as.character(x[[1]])[1] %in% c("library", "require") && length(x) > 1) as.character(x[[2]])
    }))
    calls <- all.names(exprs)
    unknown_ok <- any(c("source", "sys.source") %in% calls) ||
      (length(pkgs) > 0 && any(!paste0("package:", pkgs) %in% search()))
    out <- character(0)
    t0 <- proc.time()[[3]]
    done <- TRUE
    for (i in seq_along(exprs)) {
      ref <- refs[[i]]
      key <- paste(c(ref[2], ref[4], lines[ref[1]:ref[3]]), collapse = "\n")
      raw <- cache[[key]]
      if (is.null(raw)) {
        if (proc.time()[[3]] - t0 > budget) { done <- FALSE; break }
        raw <- e$.ide_lint_one(exprs[[i]], ref)
        assign(key, raw, envir = cache)
      }
      for (r in raw) {
        parts <- strsplit(r, "\x1f", fixed = TRUE)[[1]]
        m <- parts[2]
        # Column names in dplyr/ggplot-style code look like undefined variables.
        if (grepl("no visible binding for global variable", m, fixed = TRUE)) next
        if (grepl("no visible global function definition", m, fixed = TRUE)) {
          name <- sub("^.*definition for \\W*([A-Za-z0-9._]+)\\W*$", "\\1", m, perl = TRUE)
          if (unknown_ok || name %in% assigned || name %in% known || exists(name, envir = globalenv())) next
        }
        out <- c(out, as.character(ref[1] + as.integer(parts[1])), m)
      }
    }
    c(if (done) "1" else "0", out)
  }

  # styler: "\x02" if it isn't installed, "\x01<message>" on error.
  e$.ide_style <- function(text, scope = "tokens") {
    # Installed on request (the IDE asks first): only check here.
    if (!e$.ide_tool("styler", install = FALSE)) return("\x02")
    tryCatch({
      try(styler::cache_deactivate(verbose = FALSE), silent = TRUE)
      out <- suppressMessages(styler::style_text(text, scope = scope))
      paste(as.character(out), collapse = "\n")
    }, error = function(err) paste0("\x01", conditionMessage(err)))
  }
})
# Keep source references so errors in source()d files can say where they happened.
options(keep.source = TRUE, show.error.locations = TRUE)
invisible(NULL)
`;
