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

  # styler: NA if it isn't installed, "\x01<message>" on error.
  e$.ide_style <- function(text, scope = "tokens") {
    if (!requireNamespace("styler", quietly = TRUE)) return(NA_character_)
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
