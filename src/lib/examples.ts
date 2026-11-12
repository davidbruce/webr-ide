// Example scripts for tidyverse packages, opened from the "Examples" menu.
// `status` records what was verified by running each script in webR
// (see README → Tidyverse support).

export type ExampleStatus = 'works' | 'partial' | 'unsupported';

export interface Example {
  pkg: string;
  group: 'Core tidyverse' | 'Import & data' | 'Modelling & programming' | 'Databases' | 'Not available in the browser';
  summary: string;
  status: ExampleStatus;
  note?: string;
  code: string;
}

const header = (pkg: string, what: string) =>
  `# ${pkg} — ${what}\n# Packages install on first use and are saved in this browser for next time.\n`;

export const EXAMPLES: Example[] = [
  // ------------------------------------------------------------------ core
  {
    pkg: 'tidyverse',
    group: 'Core tidyverse',
    summary: 'Load all core packages at once',
    status: 'works',
    note: 'Large first install (~80 packages).',
    code: `${header('tidyverse', 'load the core packages together')}
webr::install("tidyverse")
library(tidyverse)

# A full pipeline: tibble → dplyr → tidyr → ggplot2
mpg |>
  filter(year == 2008) |>
  group_by(manufacturer) |>
  summarise(hwy = mean(hwy), n = n()) |>
  arrange(desc(hwy)) |>
  slice_head(n = 10) |>
  ggplot(aes(x = hwy, y = fct_reorder(manufacturer, hwy))) +
  geom_col(fill = "steelblue") +
  labs(x = "Mean highway MPG", y = NULL, title = "Most efficient makes, 2008")

tidyverse_packages()
`,
  },
  {
    pkg: 'ggplot2',
    group: 'Core tidyverse',
    summary: 'Grammar of graphics plotting',
    status: 'works',
    code: `${header('ggplot2', 'create plots with the grammar of graphics')}
webr::install("ggplot2")
library(ggplot2)

# Scatter plot with a smoother, coloured by class
ggplot(mpg, aes(displ, hwy)) +
  geom_point(aes(colour = class), size = 2) +
  geom_smooth(method = "loess", formula = y ~ x, colour = "black") +
  labs(title = "Fuel economy by engine size",
       x = "Displacement (L)", y = "Highway MPG", colour = "Class") +
  theme_minimal()

# Facets
ggplot(mpg, aes(cty, hwy)) +
  geom_point(alpha = 0.6) +
  facet_wrap(~ drv) +
  theme_bw()

# Proportional bar chart
ggplot(diamonds, aes(cut, fill = clarity)) +
  geom_bar(position = "fill") +
  scale_y_continuous(labels = scales::percent) +
  coord_flip() +
  labs(x = NULL, y = "Share of diamonds")

# Distributions
ggplot(diamonds, aes(price, fill = cut)) +
  geom_density(alpha = 0.4) +
  scale_x_log10()
`,
  },
  {
    pkg: 'dplyr',
    group: 'Core tidyverse',
    summary: 'Filter, mutate, summarise and join data',
    status: 'works',
    code: `${header('dplyr', 'a grammar of data manipulation')}
webr::install("dplyr")
library(dplyr)

starwars |>
  filter(!is.na(height), species %in% c("Human", "Droid")) |>
  select(name, height, mass, species) |>
  mutate(bmi = mass / (height / 100)^2) |>
  arrange(desc(height))

# Grouped summaries
starwars |>
  group_by(species) |>
  summarise(n = n(), mean_height = mean(height, na.rm = TRUE), .groups = "drop") |>
  filter(n > 1) |>
  arrange(desc(n))

# Joins
band_members
band_instruments
band_members |> left_join(band_instruments, by = "name")
band_members |> anti_join(band_instruments, by = "name")

# Window functions and across()
mtcars |>
  group_by(cyl) |>
  mutate(rank_mpg = min_rank(desc(mpg))) |>
  summarise(across(c(mpg, hp, wt), mean))
`,
  },
  {
    pkg: 'tidyr',
    group: 'Core tidyverse',
    summary: 'Reshape and tidy data',
    status: 'works',
    code: `${header('tidyr', 'reshape data into tidy form')}
webr::install("tidyr")
library(tidyr)
library(dplyr)

# Wide → long
relig_income
long <- relig_income |>
  pivot_longer(-religion, names_to = "income", values_to = "count")
long

# Long → wide
long |> pivot_wider(names_from = income, values_from = count)

# Split one column into several
df <- tibble(id = 1:3, name = c("Ada Lovelace", "Alan Turing", "Grace Hopper"))
df |> separate_wider_delim(name, delim = " ", names = c("first", "last"))

# Missing values
tibble(x = c(1, NA, 3), y = c("a", NA, "c")) |>
  fill(x) |>
  replace_na(list(y = "unknown"))

# Nesting
mtcars |> nest(data = -cyl)
`,
  },
  {
    pkg: 'readr',
    group: 'Core tidyverse',
    summary: 'Read and write CSV and other flat files',
    status: 'works',
    code: `${header('readr', 'fast reading and writing of rectangular files')}
webr::install("readr")
library(readr)

# Write a CSV into this workspace (it appears in the Files sidebar)
write_csv(mtcars, "mtcars.csv")

# Read it back with explicit column types
cars <- read_csv("mtcars.csv", col_types = cols(.default = col_double()))
cars

# Read inline data
read_csv(I("name,score,passed
Ada,93.5,TRUE
Alan,88,TRUE
Grace,71.25,FALSE"))

# Read straight from a URL (works for servers that allow CORS, e.g. GitHub raw files)
read_csv("https://raw.githubusercontent.com/tidyverse/readr/main/inst/extdata/mtcars.csv",
         show_col_types = FALSE)

# Parse vectors
parse_number(c("$1,234.50", "45%", "about 12 apples"))
parse_date("2024-02-29")
`,
  },
  {
    pkg: 'purrr',
    group: 'Core tidyverse',
    summary: 'Functional programming with map()',
    status: 'works',
    code: `${header('purrr', 'functional programming tools')}
webr::install("purrr")
library(purrr)

map(1:3, \\(x) x^2)
map_dbl(mtcars, mean)
map_chr(c(a = 1, b = 2), \\(x) paste("value", x))

# Fit one model per group and extract a coefficient
mtcars |>
  split(mtcars$cyl) |>
  map(\\(df) lm(mpg ~ wt, data = df)) |>
  map(coef) |>
  map_dbl("wt")

# Iterate over two inputs
map2_dbl(1:3, 4:6, \\(x, y) x * y)

# Handle failures safely
safe_log <- safely(log)
safe_log(10)
safe_log("a")

# Reduce and accumulate
reduce(1:5, \`+\`)
accumulate(1:5, \`*\`)
`,
  },
  {
    pkg: 'tibble',
    group: 'Core tidyverse',
    summary: 'Modern data frames',
    status: 'works',
    code: `${header('tibble', 'modern data frames')}
webr::install("tibble")
library(tibble)

tb <- tibble(
  x = 1:5,
  y = x^2,
  label = letters[1:5]
)
tb

# Row-wise construction
tribble(
  ~city,       ~country,  ~pop_m,
  "Tokyo",     "Japan",   37.4,
  "Delhi",     "India",   31.0,
  "Shanghai",  "China",   27.1
)

glimpse(mtcars)
as_tibble(iris)
rownames_to_column(head(mtcars), "model")
`,
  },
  {
    pkg: 'stringr',
    group: 'Core tidyverse',
    summary: 'Work with strings and regular expressions',
    status: 'works',
    code: `${header('stringr', 'consistent string functions')}
webr::install("stringr")
library(stringr)

x <- c("apple pie", "banana split", "cherry tart", "date loaf")
str_length(x)
str_to_title(x)
str_detect(x, "an")
str_replace(x, "\\\\s.*", "")
str_split(x, " ", simplify = TRUE)

# Regular expressions on built-in data
head(sentences)
str_extract(head(sentences), "\\\\b[A-Z][a-z]+\\\\b")
fruit[str_detect(fruit, "^b")]

str_pad(c("7", "42", "512"), width = 5, pad = "0")
str_glue("There are {length(fruit)} fruits in the list.")
`,
  },
  {
    pkg: 'forcats',
    group: 'Core tidyverse',
    summary: 'Tools for factors',
    status: 'works',
    code: `${header('forcats', 'tools for working with factors')}
webr::install("forcats")
library(forcats)
library(dplyr)

gss_cat

# Order levels by frequency
gss_cat |> count(relig, sort = TRUE)
fct_infreq(gss_cat$relig) |> levels() |> head()

# Lump rare levels into "Other"
gss_cat |> mutate(relig = fct_lump_n(relig, n = 4)) |> count(relig)

# Recode levels
gss_cat |>
  mutate(partyid = fct_collapse(partyid,
    other = c("No answer", "Don't know", "Other party"),
    rep = c("Strong republican", "Not str republican"),
    ind = c("Ind,near rep", "Independent", "Ind,near dem"),
    dem = c("Not str democrat", "Strong democrat"))) |>
  count(partyid)
`,
  },
  {
    pkg: 'lubridate',
    group: 'Core tidyverse',
    summary: 'Dates and times',
    status: 'works',
    code: `${header('lubridate', 'make dates and times easier')}
webr::install("lubridate")
library(lubridate)

d <- ymd(c("2024-01-15", "2024-02-29", "2024-12-31"))
d
wday(d, label = TRUE)
month(d, label = TRUE)
d + months(1)
floor_date(d, "month")

# Date-times and time zones
t <- ymd_hms("2024-07-04 18:30:00", tz = "America/New_York")
t
with_tz(t, "Europe/London")

# Durations, periods and intervals
int <- interval(ymd("2024-01-01"), ymd("2024-12-25"))
as.period(int)
time_length(int, "weeks")

# Parse messy formats
parse_date_time(c("3/14/2024", "14.03.2024", "March 14 2024"),
                orders = c("mdy", "dmy", "Bdy"))
`,
  },

  // ------------------------------------------------------------------ import
  {
    pkg: 'readxl',
    group: 'Import & data',
    summary: 'Read Excel files',
    status: 'works',
    code: `${header('readxl', 'read .xls and .xlsx files')}
webr::install("readxl")
library(readxl)

path <- readxl_example("datasets.xlsx")
excel_sheets(path)
read_excel(path, sheet = "mtcars")
read_excel(path, sheet = "chickwts", range = "A1:B6")

# Upload your own .xlsx with the Files sidebar, then:
# read_excel("my-data.xlsx")
`,
  },
  {
    pkg: 'haven',
    group: 'Import & data',
    summary: 'SPSS, Stata and SAS files',
    status: 'works',
    code: `${header('haven', 'import and export SPSS, Stata and SAS files')}
webr::install("haven")
library(haven)

survey <- data.frame(
  id = 1:4,
  gender = labelled(c(1, 2, 2, 1), c(Male = 1, Female = 2)),
  score = c(12.5, 17, 9.75, 20)
)

write_sav(survey, "survey.sav")   # SPSS
write_dta(survey, "survey.dta")   # Stata

back <- read_sav("survey.sav")
back
as_factor(back$gender)
read_dta("survey.dta")
`,
  },
  {
    pkg: 'jsonlite',
    group: 'Import & data',
    summary: 'Convert between JSON and R',
    status: 'works',
    code: `${header('jsonlite', 'JSON for R')}
webr::install("jsonlite")
library(jsonlite)

json <- toJSON(head(mtcars, 3), pretty = TRUE)
json

fromJSON('{"name": "webR", "tags": ["wasm", "browser"], "stars": 900}')

df <- fromJSON('[{"x": 1, "y": "a"}, {"x": 2, "y": "b"}]')
df
str(df)
`,
  },
  {
    pkg: 'rvest',
    group: 'Import & data',
    summary: 'Parse HTML (local content)',
    status: 'partial',
    note: 'Parses HTML strings and files; most live web pages block cross-origin requests.',
    code: `${header('rvest', 'extract data from HTML')}
# R's requests go through the browser, so read_html("https://...") only works
# for sites that allow cross-origin requests (CORS) — most web pages don't.
# Parsing HTML you already have works fine.
webr::install("rvest")
library(rvest)

page <- read_html('
<html><body>
  <h1>Planets</h1>
  <p class="intro">The four inner planets.</p>
  <table>
    <tr><th>Planet</th><th>Moons</th><th>Radius (km)</th></tr>
    <tr><td>Mercury</td><td>0</td><td>2440</td></tr>
    <tr><td>Venus</td><td>0</td><td>6052</td></tr>
    <tr><td>Earth</td><td>1</td><td>6371</td></tr>
    <tr><td>Mars</td><td>2</td><td>3390</td></tr>
  </table>
  <a href="/mercury">Mercury</a> <a href="/mars">Mars</a>
</body></html>')

page |> html_element("h1") |> html_text2()
page |> html_element(".intro") |> html_text2()
page |> html_element("table") |> html_table()
page |> html_elements("a") |> html_attr("href")
`,
  },
  {
    pkg: 'httr2',
    group: 'Import & data',
    summary: 'HTTP requests and web APIs',
    status: 'partial',
    note: 'Works with servers that allow cross-origin requests (CORS), like the GitHub API.',
    code: `${header('httr2', 'HTTP requests and web APIs')}
# Requests go through the browser, so they only succeed for servers that send
# CORS headers (most public JSON APIs do; most ordinary web pages don't).
webr::install(c("httr2", "jsonlite")) # jsonlite is needed for resp_body_json()
library(httr2)

req <- request("https://api.github.com") |>
  req_url_path_append("repos", "r-wasm", "webr") |>
  req_headers(Accept = "application/vnd.github+json")
req

resp <- req_perform(req)
resp_status(resp)
repo <- resp_body_json(resp)
repo[c("full_name", "description", "stargazers_count", "license")]
`,
  },
  {
    pkg: 'xml2',
    group: 'Import & data',
    summary: 'Parse and query XML',
    status: 'works',
    code: `${header('xml2', 'work with XML')}
webr::install("xml2")
library(xml2)

doc <- read_xml("<library>
  <book year='1965'><title>Dune</title><author>Herbert</author></book>
  <book year='1969'><title>The Left Hand of Darkness</title><author>Le Guin</author></book>
</library>")

books <- xml_find_all(doc, ".//book")
data.frame(
  title  = xml_text(xml_find_first(books, "title")),
  author = xml_text(xml_find_first(books, "author")),
  year   = as.integer(xml_attr(books, "year"))
)
`,
  },
  {
    pkg: 'hms',
    group: 'Import & data',
    summary: 'Time-of-day values',
    status: 'works',
    code: `${header('hms', 'times of day')}
webr::install("hms")
library(hms)

t <- hms(seconds = 30, minutes = 15, hours = 9)
t
as_hms("13:45:10")
as_hms(c("08:00:00", "17:30:00")) - t
round_hms(as_hms("10:17:44"), secs = 60 * 15)
`,
  },

  // ------------------------------------------------------------------ modelling / programming
  {
    pkg: 'broom',
    group: 'Modelling & programming',
    summary: 'Tidy model output',
    status: 'works',
    code: `${header('broom', 'turn models into tidy tibbles')}
webr::install(c("broom", "dplyr", "ggplot2"))
library(broom)
library(dplyr)
library(ggplot2)

fit <- lm(mpg ~ wt + hp, data = mtcars)
tidy(fit, conf.int = TRUE)
glance(fit)

augment(fit) |>
  ggplot(aes(.fitted, .resid)) +
  geom_point() +
  geom_hline(yintercept = 0, linetype = 2) +
  labs(title = "Residuals vs fitted")

# One model per group
mtcars |>
  group_by(cyl) |>
  group_modify(\\(df, key) tidy(lm(mpg ~ wt, data = df)))
`,
  },
  {
    pkg: 'modelr',
    group: 'Modelling & programming',
    summary: 'Modelling helpers for pipelines',
    status: 'works',
    code: `${header('modelr', 'modelling functions that work with the pipe')}
webr::install(c("modelr", "dplyr", "ggplot2"))
library(modelr)
library(dplyr)
library(ggplot2)

fit <- lm(hwy ~ displ, data = mpg)

grid <- mpg |> data_grid(displ = seq_range(displ, 20)) |> add_predictions(fit)
ggplot(mpg, aes(displ, hwy)) +
  geom_point(alpha = 0.4) +
  geom_line(data = grid, aes(y = pred), colour = "red", linewidth = 1)

mpg |> add_residuals(fit) |> select(displ, hwy, resid) |> head()
rmse(fit, mpg)
rsquare(fit, mpg)
`,
  },
  {
    pkg: 'magrittr & glue',
    group: 'Modelling & programming',
    summary: 'Pipes and string interpolation',
    status: 'works',
    code: `${header('magrittr & glue', 'pipes and string interpolation')}
webr::install(c("magrittr", "glue"))
library(magrittr)
library(glue)

mtcars %>% subset(cyl == 4) %>% nrow()
mtcars %$% cor(mpg, wt)           # exposition pipe
x <- c(4, 9, 16); x %<>% sqrt; x  # assignment pipe

name <- "webR"; n <- 3
glue("{name} has run {n} example{ifelse(n == 1, '', 's')} today.")
glue_data(head(mtcars, 3), "{rownames(head(mtcars, 3))}: {mpg} mpg")
`,
  },

  // ------------------------------------------------------------------ databases
  {
    pkg: 'dbplyr',
    group: 'Databases',
    summary: 'dplyr on SQL databases (DuckDB)',
    status: 'works',
    note: 'Uses DuckDB — RSQLite does not load in webR 0.6.1.',
    code: `${header('dbplyr', 'use dplyr verbs on database tables')}
# Uses an in-memory DuckDB database (RSQLite's compiled code doesn't load in
# webR 0.6.1, but DuckDB works).
webr::install(c("dbplyr", "dplyr", "duckdb"))
library(dplyr)
library(dbplyr)

con <- DBI::dbConnect(duckdb::duckdb())
copy_to(con, mtcars, "mtcars")

cars_db <- tbl(con, "mtcars")
query <- cars_db |>
  filter(hp > 100) |>
  group_by(cyl) |>
  summarise(n = n(), mpg = mean(mpg, na.rm = TRUE))

show_query(query)   # the SQL dbplyr generates
collect(query)      # run it and bring results into R

# Plain SQL works too
DBI::dbGetQuery(con, "SELECT cyl, COUNT(*) AS n FROM mtcars GROUP BY cyl ORDER BY cyl")

DBI::dbDisconnect(con, shutdown = TRUE)
`,
  },
  {
    pkg: 'dtplyr',
    group: 'Databases',
    summary: 'dplyr syntax backed by data.table',
    status: 'works',
    code: `${header('dtplyr', 'dplyr syntax with a data.table backend')}
webr::install(c("dtplyr", "dplyr"))
library(dplyr)
library(dtplyr)

dt <- lazy_dt(mtcars)
q <- dt |>
  filter(wt < 5) |>
  mutate(kpl = mpg * 0.425) |>
  group_by(cyl) |>
  summarise(kpl = mean(kpl))

show_query(q)   # the data.table code
as_tibble(q)
`,
  },

  // ------------------------------------------------------------------ not in the browser
  {
    pkg: 'RSQLite',
    group: 'Not available in the browser',
    summary: 'SQLite databases',
    status: 'unsupported',
    note: "Its compiled code doesn't load in webR 0.6.1 — use duckdb instead.",
    code: `# RSQLite
# RSQLite installs, but its compiled code fails to load in webR 0.6.1
# ("could not load dynamic lib"). A failed load can also break loading of
# other packages later in the same session — restart R if that happens.
#
# DuckDB works and speaks SQL through the same DBI interface:
webr::install("duckdb")
con <- DBI::dbConnect(duckdb::duckdb())
DBI::dbWriteTable(con, "iris", iris)
DBI::dbGetQuery(con, 'SELECT "Species", AVG("Petal.Length") AS mean_petal FROM iris GROUP BY 1')
DBI::dbDisconnect(con, shutdown = TRUE)
`,
  },
  {
    pkg: 'googlesheets4 / googledrive',
    group: 'Not available in the browser',
    summary: 'Google Sheets and Drive',
    status: 'unsupported',
    note: "Needs Google's OAuth sign-in flow, which can't run inside webR.",
    code: `# googlesheets4 / googledrive
# These packages install, but they need Google's OAuth sign-in flow, which
# can't complete from R running inside the browser.
#
# Workaround: in Google Sheets use File → Download → CSV (or .xlsx), upload
# the file with the Files sidebar, then read it:
webr::install("readr")
library(readr)
# my_sheet <- read_csv("my-sheet.csv")
`,
  },
];

export const EXAMPLE_GROUPS = [...new Set(EXAMPLES.map((e) => e.group))];
