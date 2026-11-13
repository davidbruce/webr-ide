// R helper functions installed into an attached "tools:ide" environment so
// they never show up in the user's global environment.
export const R_HELPERS = String.raw`
local({
  e <- attach(NULL, name = "tools:ide")

  e$.ide_set_device <- function(w, h) {
    options(device = function(...) {
      webr::canvas(width = w, height = h, bg = "white")
      grDevices::dev.control("enable") # keep a display list so plots can be re-rendered
    })
    invisible(NULL)
  }

  e$.ide_record <- function() {
    if (grDevices::dev.cur() == 1L) return(FALSE)
    p <- tryCatch(grDevices::recordPlot(), error = function(err) NULL)
    if (is.null(p) || is.null(p[[1]])) return(FALSE)
    assign(".ide_rec", p, envir = e)
    TRUE
  }

  e$.ide_set_width <- function(n) {
    options(width = max(20L, min(as.integer(n), 250L)))
    invisible(NULL)
  }

  e$.ide_env <- function(env = globalenv()) {
    out <- character(0)
    for (n in ls(env)) {
      x <- tryCatch(get(n, envir = env), error = function(err) NULL)
      grp <- if (is.data.frame(x) || is.matrix(x)) "Data"
             else if (is.function(x)) "Functions" else "Values"
      cls <- paste(class(x), collapse = ", ")
      val <- tryCatch({
        if (is.data.frame(x)) {
          sprintf("%d obs. of %d variable%s", nrow(x), ncol(x), if (ncol(x) == 1) "" else "s")
        } else if (is.function(x)) {
          d <- deparse(args(x))
          trimws(paste(d[-length(d)], collapse = " "))
        } else if (is.matrix(x)) {
          sprintf("%s [%d x %d]", typeof(x), nrow(x), ncol(x))
        } else if (is.environment(x)) {
          "<environment>"
        } else {
          s <- utils::capture.output(utils::str(x, give.attr = FALSE, vec.len = 3, nchar.max = 60, max.level = 1))
          trimws(s[1])
        }
      }, error = function(err) "")
      if (is.na(val) || !length(val)) val <- ""
      sz <- tryCatch(format(utils::object.size(x), units = "auto"), error = function(err) "")
      out <- c(out, n, grp, cls, substr(val, 1, 300), sz)
    }
    out
  }

  # frame > 0: a frame of the paused call stack (see .ide_debug_stack).
  e$.ide_str <- function(name, frame = 0L) {
    env <- if (frame > 0L) e$.ide_debug_frame(frame) else globalenv()
    x <- get(name, envir = env)
    utils::capture.output(utils::str(x, give.attr = FALSE, vec.len = 3, list.len = 200))
  }

  e$.ide_snapshot <- function(root) {
    f <- list.files(root, recursive = TRUE, all.files = TRUE, include.dirs = TRUE, no.. = TRUE)
    f <- f[!(f == ".ide" | startsWith(f, ".ide/"))]
    if (!length(f)) return(character(0))
    i <- file.info(file.path(root, f), extra_cols = FALSE)
    kind <- ifelse(i$isdir, "d", "f")
    sig <- ifelse(i$isdir, "", paste(format(as.numeric(i$mtime), digits = 15), i$size))
    c(rbind(f, kind, sig))
  }

  e$.ide_mkdirs <- function(dirs) {
    for (d in dirs) dir.create(d, recursive = TRUE, showWarnings = FALSE)
    invisible(NULL)
  }

  e$.ide_complete <- function(line) {
    utils:::.assignLinebuffer(line)
    utils:::.assignEnd(nchar(line))
    token <- utils:::.guessTokenFromLine()
    utils:::.completeToken()
    comps <- utils:::.retrieveCompletions()
    # Mark functions (suffix "\x1f(") so the editor can add () after them.
    is_fn <- vapply(comps, function(x) {
      if (!grepl("^[A-Za-z.][A-Za-z0-9._]*(:::?[A-Za-z.][A-Za-z0-9._]*)?$", x)) return(FALSE)
      tryCatch(
        if (grepl("::", x, fixed = TRUE)) is.function(eval(str2lang(x))) else exists(x, envir = globalenv(), mode = "function"),
        error = function(err) FALSE
      )
    }, TRUE, USE.NAMES = FALSE)
    c(token, paste0(comps, ifelse(is_fn, "\x1f(", "")))
  }

  e$.ide_packages <- function() {
    ip <- utils::installed.packages(fields = character(0))
    pk <- unname(ip[, "Package"])
    ver <- unname(ip[, "Version"])
    att <- paste0("package:", pk) %in% search()
    user <- unname(ip[, "LibPath"]) == e$.ide_pkg_lib
    keep <- !duplicated(pk) # user library first in .libPaths()
    pk <- pk[keep]; ver <- ver[keep]; att <- att[keep]; user <- user[keep]
    o <- order(tolower(pk))
    c(rbind(pk[o], ver[o], ifelse(att[o], "1", "0"), ifelse(user[o], "1", "0")))
  }

  # ---- persistent package library -------------------------------------------
  # Packages are installed into a dedicated library. webR's installers are
  # wrapped so every install (dependencies included) is logged as
  # (package, version, url); the IDE then stores that .tgz in browser storage
  # and mounts it again on the next start.
  e$.ide_pkg_log <- character(0)
  e$.ide_pkg_lib <- ""

  # Cached package images are mounted under 'cache' as <pkg>_<version> (not on
  # .libPaths()); the library 'lib' holds links to the ones this workspace
  # uses, plus packages installed in this session.
  # 'tools' holds packages the IDE itself uses (codetools for problem checks,
  # styler for formatting). It's last on .libPaths(), so these never become
  # part of a workspace's library or its renv.lock.
  e$.ide_pkg_cache <- ""
  e$.ide_pkg_tools <- ""
  e$.ide_pkg_setup <- function(lib, cache, tools) {
    for (d in c(lib, cache, tools)) dir.create(d, recursive = TRUE, showWarnings = FALSE)
    .libPaths(c(lib, .libPaths(), tools))
    e$.ide_pkg_lib <- lib
    e$.ide_pkg_cache <- cache
    e$.ide_pkg_tools <- tools
    ns <- asNamespace("webr")
    where <- function(lib) if (identical(normalizePath(lib, mustWork = FALSE), normalizePath(tools, mustWork = FALSE))) "tools" else "lib"
    # The install log: (package, version, url or "" if linked from the cache, "lib" or "tools").
    record <- function(repo, lib, pkg, pkg_ver) {
      url <- file.path(sub("file:", "", repo, fixed = TRUE), paste0(pkg, "_", pkg_ver, ".tgz"))
      e$.ide_pkg_log <- c(e$.ide_pkg_log, pkg, as.character(pkg_ver), url, where(lib))
    }
    # Hidden markers on stderr let the IDE show install progress while R is
    # still busy downloading (the console strips them).
    signal <- function(what, pkg, ver) {
      cat("\037IDE\037", what, "\037", pkg, "\037", as.character(ver), "\n", sep = "", file = stderr())
    }
    orig_vfs <- get("install_vfs_image", envir = ns)
    orig_tgz <- get("install_tgz", envir = ns)
    hooked_vfs <- function(repo, lib, pkg, pkg_ver) {
      signal("install-start", pkg, pkg_ver)
      on.exit(signal("install-end", pkg, pkg_ver))
      # Already in the cache: link it instead of downloading (works offline).
      cached <- file.path(e$.ide_pkg_cache, paste0(pkg, "_", pkg_ver))
      if (nzchar(e$.ide_pkg_cache) && file.exists(file.path(cached, "DESCRIPTION"))) {
        e$.ide_pkg_unlink(pkg, lib)
        if (file.symlink(cached, file.path(lib, pkg))) {
          e$.ide_pkg_log <- c(e$.ide_pkg_log, pkg, as.character(pkg_ver), "", where(lib))
          return(invisible(TRUE))
        }
      }
      res <- orig_vfs(repo, lib, pkg, pkg_ver)
      record(repo, lib, pkg, pkg_ver)
      invisible(res)
    }
    hooked_tgz <- function(repo, lib, pkg, pkg_ver) {
      signal("install-start", pkg, pkg_ver)
      on.exit(signal("install-end", pkg, pkg_ver))
      res <- orig_tgz(repo, lib, pkg, pkg_ver)
      record(repo, lib, pkg, pkg_ver)
      invisible(res)
    }
    utils::assignInNamespace("install_vfs_image", hooked_vfs, ns = "webr")
    utils::assignInNamespace("install_tgz", hooked_tgz, ns = "webr")
    invisible(NULL)
  }

  e$.ide_pkg_take_log <- function() {
    out <- e$.ide_pkg_log
    e$.ide_pkg_log <- character(0)
    out
  }

  # Remove a library entry: a link to the cache, or an image mounted this session.
  e$.ide_pkg_unlink <- function(pkg, lib = e$.ide_pkg_lib) {
    mp <- file.path(lib, pkg)
    if (nzchar(Sys.readlink(mp))) {
      file.remove(mp)
    } else if (file.exists(mp)) {
      try(webr::unmount(mp), silent = TRUE)
      unlink(mp, recursive = TRUE)
    }
    invisible(NULL)
  }

  # Link cached packages into the library: dirs are <pkg>_<version> under the cache.
  e$.ide_pkg_link <- function(pkgs, dirs, lib = e$.ide_pkg_lib) {
    for (i in seq_along(pkgs)) {
      e$.ide_pkg_unlink(pkgs[[i]], lib)
      file.symlink(file.path(e$.ide_pkg_cache, dirs[[i]]), file.path(lib, pkgs[[i]]))
    }
    invisible(NULL)
  }

  # Tool packages and everything they need (recursively), with the installed
  # versions; base and recommended packages left out.
  e$.ide_tool_closure <- function(pkgs) {
    ip <- utils::installed.packages(fields = character(0))
    ip <- ip[!duplicated(ip[, "Package"]), , drop = FALSE]
    deps <- tools::package_dependencies(pkgs, db = ip, which = c("Depends", "Imports", "LinkingTo"), recursive = TRUE)
    all <- unique(c(pkgs, unlist(deps)))
    all <- all[all %in% rownames(ip) & is.na(ip[match(all, ip[, "Package"]), "Priority"])]
    c(rbind(all, unname(ip[match(all, ip[, "Package"]), "Version"])))
  }

  # Make an IDE tool package available, installing it into the tools library
  # if no library has it (never into the workspace's). FALSE if that fails.
  e$.ide_tool <- function(pkg, install = TRUE) {
    if (!nzchar(system.file(package = pkg))) {
      if (!install || !nzchar(e$.ide_pkg_tools)) return(FALSE)
      try(suppressMessages(webr::install(pkg, lib = e$.ide_pkg_tools, quiet = TRUE)), silent = TRUE)
    }
    requireNamespace(pkg, quietly = TRUE)
  }

  # Packages from the user library loaded in this session, with versions:
  # a starting point for a workspace's own library.
  e$.ide_pkg_snapshot <- function() {
    ip <- utils::installed.packages(lib.loc = e$.ide_pkg_lib, fields = character(0))
    keep <- ip[, "Package"] %in% loadedNamespaces()
    c(rbind(unname(ip[keep, "Package"]), unname(ip[keep, "Version"])))
  }

  # After the IDE mounts cached images: return (and clean up) any that look broken.
  e$.ide_pkg_verify <- function(pkgs) {
    failed <- character(0)
    for (p in pkgs) {
      mp <- file.path(e$.ide_pkg_lib, p)
      if (!file.exists(file.path(mp, "DESCRIPTION"))) {
        e$.ide_pkg_unlink(p)
        failed <- c(failed, p)
      }
    }
    failed
  }

  e$.ide_pkg_loaded <- function(pkgs) pkgs[pkgs %in% loadedNamespaces()]

  # Drop a package from the user library in this session (not if loaded).
  e$.ide_pkg_drop <- function(pkg) {
    if (pkg %in% loadedNamespaces()) return(FALSE)
    e$.ide_pkg_unlink(pkg)
    TRUE
  }

  # Repository versions newer than the installed ones: (pkg, installed, available) triples.
  e$.ide_pkg_updates <- function(pkgs, installed) {
    ver <- gsub("\\.[^.]+$", "", as.character(getRversion()))
    repo <- gsub("/$", "", getOption("webr_pkg_repos"))
    ap <- utils::available.packages(contriburl = sprintf("%s/bin/emscripten/contrib/%s", repo, ver))
    out <- character(0)
    for (i in seq_along(pkgs)) {
      p <- pkgs[[i]]
      if (!p %in% rownames(ap)) next
      if (package_version(ap[p, "Version"]) > package_version(installed[[i]]))
        out <- c(out, p, installed[[i]], ap[p, "Version"])
    }
    out
  }

  e$.ide_clear_ws <- function(root) {
    rm(list = ls(envir = globalenv(), all.names = TRUE), envir = globalenv())
    try(grDevices::graphics.off(), silent = TRUE)
    if (dir.exists(root)) unlink(root, recursive = TRUE, force = TRUE)
    invisible(NULL)
  }

  e$.ide_open_ws <- function(root) {
    dir.create(root, recursive = TRUE, showWarnings = FALSE)
    setwd(root)
    if (file.exists(".RData")) {
      ok <- try(load(".RData", envir = globalenv()), silent = TRUE)
      if (!inherits(ok, "try-error")) return("restored")
    }
    ""
  }

  # Save the global environment to <root>/.RData, unless it is larger than
  # max_bytes (autosave cap). Returns "saved", "empty" or "skipped:<bytes>".
  e$.ide_save_image <- function(root, max_bytes = Inf) {
    f <- file.path(root, ".RData")
    nms <- ls(globalenv(), all.names = TRUE)
    if (!length(nms)) {
      if (file.exists(f)) unlink(f)
      return("empty")
    }
    size <- sum(vapply(nms, function(n) {
      as.numeric(tryCatch(utils::object.size(get(n, envir = globalenv())), error = function(err) 0))
    }, 0))
    if (size > max_bytes) return(paste0("skipped:", format(size, scientific = FALSE)))
    save(list = nms, envir = globalenv(), file = f)
    "saved"
  }

  # Leave a workspace without touching its files (drive mode: the mounted
  # folder IS the user's files, so never unlink it).
  # ---- debugging ---------------------------------------------------------------
  # While R waits at a Browse[n]> prompt the IDE can still evaluate R; the
  # paused calls are then the first frames on the stack, followed by webR's
  # own evaluation frames.

  # Index of the last paused (user) frame, as seen from the caller's caller.
  e$.ide_debug_user_n <- function(n) {
    webr_ns <- tryCatch(asNamespace("webr"), error = function(err) NULL)
    for (i in seq_len(n)) {
      f <- sys.function(i)
      env <- environment(f)
      if (!is.null(env) && !is.null(webr_ns) && identical(topenv(env), webr_ns)) return(i - 1L)
    }
    n
  }
  e$.ide_debug_frame <- function(i) sys.frame(i)

  # The paused call stack: (frame index, call, file, line) per frame of code
  # you wrote, outermost first. R's own functions (eval, stop, …), the
  # breakpoint machinery (.doTrace), packages and the IDE's helpers are left out. The line is where the frame
  # called the next one; the innermost frame's current line comes from R's
  # "debug at" output instead.
  e$.ide_debug_stack <- function() {
    n <- e$.ide_debug_user_n(sys.nframe() - 1L)
    if (n < 1L) return(character(0))
    calls <- sys.calls()
    helpers <- environment(sys.function())
    keep <- Filter(function(i) {
      env <- environment(sys.function(i))
      # Yours: not a primitive, not from R or a package, not the IDE's helpers.
      !is.null(env) && !identical(env, helpers) && identical(topenv(env), globalenv())
    }, seq_len(n))
    out <- character(0)
    for (i in keep) {
      call <- gsub("\\s+", " ", paste(deparse(calls[[i]], width.cutoff = 80L, nlines = 2L), collapse = " "))
      if (nchar(call) > 80) call <- paste0(substr(call, 1, 77), "...")
      file <- ""
      line <- ""
      # The first later call with a source reference was made from this frame.
      for (j in seq.int(i + 1L, length.out = max(0L, n - i))) {
        ref <- attr(calls[[j]], "srcref")
        if (!is.null(ref)) {
          f <- utils::getSrcFilename(ref, full.names = TRUE)
          if (length(f) && nzchar(f[1])) {
            file <- f[1]
            line <- as.character(ref[1])
          }
          break
        }
      }
      out <- c(out, as.character(i), call, file, line)
    }
    out
  }

  # Variables of paused frame i, like .ide_env().
  e$.ide_debug_env <- function(i) e$.ide_env(sys.frame(i))

  # Lines (of code in 'text') that are inside a function, where R can stop.
  e$.ide_bp_valid <- function(text, lines) {
    pd <- tryCatch(utils::getParseData(parse(text = text, keep.source = TRUE)), error = function(err) NULL)
    if (is.null(pd) || !length(lines)) return(integer(0))
    fns <- pd[pd$token == "FUNCTION", "parent"]
    ranges <- pd[pd$id %in% fns, c("line1", "line2")]
    as.integer(Filter(function(l) any(l >= ranges$line1 & l <= ranges$line2), lines))
  }

  # Breakpoints set in the editor, by file (normalized path) -> lines.
  e$.ide_bps <- list()
  e$.ide_set_breakpoints <- function(file, lines) {
    e$.ide_bps[[normalizePath(file, mustWork = FALSE)]] <- as.integer(lines)
    invisible(NULL)
  }

  # Like source(), but sets the editor's breakpoints in each function as soon
  # as it's defined, so code later in the same file stops at them too.
  e$.ide_debug_source <- function(file, echo = FALSE) {
    lines <- e$.ide_bps[[normalizePath(file, mustWork = FALSE)]]
    if (!length(lines)) return(invisible(source(file, echo = echo, keep.source = TRUE)))
    exprs <- parse(file, keep.source = TRUE)
    refs <- attr(exprs, "srcref")
    for (i in seq_along(exprs)) {
      if (echo) cat(paste0(c("> ", rep("+ ", max(0, refs[[i]][3] - refs[[i]][1]))), as.character(refs[[i]]), collapse = "\n"), "\n", sep = "")
      res <- withVisible(eval(exprs[[i]], globalenv()))
      if (echo && res$visible) print(res$value)
      r <- refs[[i]]
      for (l in lines[lines >= r[1] & lines <= r[3]])
        try(suppressMessages(utils::setBreakpoint(file, l, envir = globalenv(), verbose = FALSE)), silent = TRUE)
    }
    invisible(NULL)
  }

  # Apply the editor's breakpoints for 'file' to functions already defined
  # from it (an earlier Source), so changes take effect straight away: earlier
  # breakpoints in those functions are removed, then 'lines' are set.
  e$.ide_apply_breakpoints <- function(file, lines) {
    e$.ide_set_breakpoints(file, lines)
    base <- basename(file)
    for (n in ls(globalenv(), all.names = TRUE)) {
      f <- get(n, envir = globalenv())
      if (!inherits(f, "functionWithTrace")) next
      ref <- attr(f@original, "srcref")
      if (!is.null(ref) && identical(basename(utils::getSrcFilename(ref)), base))
        try(suppressMessages(untrace(n, where = globalenv())), silent = TRUE)
    }
    for (l in lines) try(suppressMessages(utils::setBreakpoint(file, l, envir = globalenv(), verbose = FALSE)), silent = TRUE)
    invisible(NULL)
  }

  # A paused frame's function, for a read-only view when it has no file
  # (typed in the console, or from a package): name, source, first line of
  # its source reference ("" if none, i.e. deparsed).
  e$.ide_debug_fun_view <- function(i) {
    f <- sys.function(i)
    if (inherits(f, "functionWithTrace")) f <- f@original
    ref <- attr(f, "srcref")
    name <- paste(deparse(sys.call(i)[[1]], nlines = 1L), collapse = "")
    if (!is.null(ref)) return(c(name, paste(as.character(ref), collapse = "\n"), as.character(ref[1])))
    c(name, paste(deparse(f), collapse = "\n"), "")
  }

  # A variable's structure as seen from paused frame i (for hover), or nothing.
  e$.ide_debug_value <- function(name, i) {
    env <- sys.frame(i)
    if (!exists(name, envir = env)) return(character(0))
    x <- get(name, envir = env)
    if (is.function(x)) return(character(0))
    utils::head(utils::capture.output(utils::str(x, give.attr = FALSE, vec.len = 4, list.len = 20, max.level = 2)), 25)
  }

  # As in RStudio: source a file with the editor's breakpoints set.
  e$debugSource <- function(file, echo = FALSE) e$.ide_debug_source(file, echo)

  # "Debug on error": pause in the frame where the error happened.
  e$.ide_on_error <- function() {
    n <- sys.nframe() - 1L
    i <- n
    while (i > 1L && identical(topenv(environment(sys.function(i))), baseenv())) i <- i - 1L
    if (i < 1L) return(invisible(NULL))
    message("Paused where the error happened, in ", paste(deparse(sys.call(i), nlines = 1L), collapse = ""))
    eval(quote(browser()), sys.frame(i))
  }
  e$.ide_debug_on_error <- function(on) {
    options(error = if (isTRUE(on)) quote(.ide_on_error()) else NULL)
    invisible(NULL)
  }

  # The workspace's .Rprofile, then .First() if it defines one, as R's start-up
  # does. renv's activation (from a desktop renv project) is skipped: it would
  # try to bootstrap renv and replace the library; the IDE checks renv.lock
  # and manages the packages itself.
  e$.ide_run_rprofile <- function() {
    if (!file.exists(".Rprofile")) return(invisible(FALSE))
    exprs <- parse(".Rprofile", keep.source = FALSE)
    skipped <- FALSE
    for (x in exprs) {
      txt <- paste(deparse(x), collapse = " ")
      if (grepl("renv/activate.R", txt, fixed = TRUE) || grepl("renv::(activate|load|restore|init)\\(", txt)) {
        skipped <- TRUE
        next
      }
      eval(x, globalenv())
    }
    if (skipped) message("Skipped renv activation in .Rprofile: webR IDE manages this workspace's packages (Packages tab > renv.lock).")
    first <- get0(".First", envir = globalenv(), inherits = FALSE)
    if (is.function(first)) first()
    invisible(TRUE)
  }

  # Packages that come with webR (not from the user library): name, version pairs.
  e$.ide_builtin_pkgs <- function() {
    ip <- utils::installed.packages(lib.loc = setdiff(.libPaths(), e$.ide_pkg_lib), fields = character(0))
    ip <- ip[!duplicated(ip[, "Package"]), , drop = FALSE]
    c(rbind(unname(ip[, "Package"]), unname(ip[, "Version"])))
  }

  e$.ide_detach_ws <- function() {
    rm(list = ls(envir = globalenv(), all.names = TRUE), envir = globalenv())
    try(grDevices::graphics.off(), silent = TRUE)
    setwd("/home/web_user")
    invisible(NULL)
  }

  # Run one notebook chunk in the global environment, the way the console
  # would (auto-printing visible values), and return its output as a flat
  # character vector of (type, text) pairs in the order it happened:
  #   stdout / message / warning / error, and "plot" with the page number of
  #   the image captured for it (pages come back from captureR in order).
  e$.ide_chunk <- function(code, width = 80L) {
    out <- character()
    add <- function(type, text) out <<- c(out, type, text)
    # Output goes to ide_buf; closing the connection also flushes a final
    # line that has no newline yet.
    ide_buf <- character()
    con <- textConnection("ide_buf", "w", local = TRUE)
    open_con <- TRUE
    used <- 0L
    flush_out <- function() {
      lines <- if (open_con) textConnectionValue(con) else ide_buf
      if (length(lines) > used) {
        add("stdout", paste(lines[(used + 1L):length(lines)], collapse = "\n"))
        used <<- length(lines)
      }
    }
    page <- 0L
    newpage <- function() {
      flush_out()
      page <<- page + 1L
      add("plot", as.character(page))
    }
    top <- quote(eval(ex, globalenv()))
    where <- function(call) if (is.null(call) || identical(call, top)) "" else paste0(" in ", paste(deparse(call, nlines = 1L), collapse = ""))
    old_base <- getHook("before.plot.new")
    old_grid <- getHook("before.grid.newpage")
    setHook("before.plot.new", function(...) if (isTRUE(graphics::par("page"))) newpage(), "replace")
    setHook("before.grid.newpage", function(...) newpage(), "replace")
    op <- options(width = max(20L, min(as.integer(width), 250L)))
    sinks <- sink.number()
    sink(con)
    cleanup <- function() {
      while (sink.number() > sinks) sink()
      if (open_con) {
        close(con)
        open_con <<- FALSE
      }
      flush_out()
      options(op)
      setHook("before.plot.new", old_base, "replace")
      setHook("before.grid.newpage", old_grid, "replace")
    }
    on.exit(if (open_con) cleanup())
    exprs <- tryCatch(parse(text = code, keep.source = FALSE), error = function(err) err)
    if (inherits(exprs, "error")) {
      add("error", paste0("Error: ", conditionMessage(exprs)))
      return(out)
    }
    for (ex in exprs) {
      ok <- withCallingHandlers(
        tryCatch({
          v <- withVisible(eval(ex, globalenv()))
          if (v$visible) {
            # Data frames and HTML widgets get rich output; everything else prints.
            rich <- tryCatch(.ide_rich(v$value), error = function(err) NULL)
            if (!is.null(rich)) {
              flush_out()
              add(rich[[1]], rich[[2]])
            } else if (isS4(v$value)) methods::show(v$value) else print(v$value)
          }
          TRUE
        }, error = function(err) {
          flush_out()
          add("error", paste0("Error", where(conditionCall(err)), ": ", conditionMessage(err)))
          FALSE
        }, interrupt = function(i) {
          flush_out()
          add("error", "Interrupted")
          FALSE
        }),
        message = function(m) {
          flush_out()
          add("message", sub("\n$", "", conditionMessage(m)))
          invokeRestart("muffleMessage")
        },
        warning = function(w) {
          flush_out()
          add("warning", paste0("Warning", where(conditionCall(w)), ": ", conditionMessage(w)))
          invokeRestart("muffleWarning")
        })
      if (!ok) break
    }
    cleanup()
    out
  }
})

options(menu.graphics = FALSE, help_type = "text", max.print = 2000)
# Point C++ time zone libraries (e.g. lubridate's CCTZ) at R's bundled tz database.
if (!nzchar(Sys.getenv("TZDIR"))) Sys.setenv(TZDIR = file.path(R.home("share"), "zoneinfo"))
try(webr::shim_install(), silent = TRUE)
try(webr::pager_install(), silent = TRUE)
try(webr::viewer_install(), silent = TRUE)
invisible(NULL)
`;
