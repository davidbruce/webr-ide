// Code snippets, in RStudio's r.snippets format: type a snippet's name and
// press Tab (or pick it from the completion list) to insert it.
//
//   snippet fun
//   	${1:name} <- function(${2:variables}) {
//   		${0}
//   	}
//
// Body lines start with a tab. `r expr` in a body is replaced by the result of
// running expr in R when the snippet is inserted (as in RStudio). Snippets
// are shared by all workspaces: kept in the app's storage (snippets/r.snippets),
// outside any workspace. Without that file the defaults apply.
import { monaco, inRChunk } from './monaco';
import * as fs from './opfs';
import { session, editor } from './ide-state';

export const SNIPPETS_FILE = 'snippets/r.snippets';

export const DEFAULT_SNIPPETS = `# R snippets. Type a snippet's name and press Tab to insert it.
# Body lines start with a tab. \${1:name} is a placeholder (Tab moves to the
# next one), \${0} is where the cursor ends up, and \`r expr\` is replaced by
# the result of running expr in R.

snippet lib
	library(\${1:package})

snippet req
	require(\${1:package})

snippet src
	source("\${1:file.R}")

snippet ret
	return(\${1:code})

snippet mat
	matrix(\${1:data}, nrow = \${2:rows}, ncol = \${3:cols})

snippet sg
	setGeneric("\${1:generic}", function(\${2:x, ...}) {
		standardGeneric("\${1:generic}")
	})

snippet sm
	setMethod("\${1:generic}", \${2:class}, function(\${2:x, ...}) {
		\${0}
	})

snippet sc
	setClass("\${1:Class}", slots = c(\${2:name = "type"}))

snippet if
	if (\${1:condition}) {
		\${0}
	}

snippet el
	else {
		\${0}
	}

snippet ei
	else if (\${1:condition}) {
		\${0}
	}

snippet fun
	\${1:name} <- function(\${2:variables}) {
		\${0}
	}

snippet for
	for (\${1:variable} in \${2:vector}) {
		\${0}
	}

snippet while
	while (\${1:condition}) {
		\${0}
	}

snippet switch
	switch (\${1:object},
		\${2:case} = \${3:action}
	)

snippet tryc
	tryCatch({
		\${1:code}
	}, error = function(e) {
		\${0}
	})

snippet apply
	apply(\${1:array}, \${2:margin}, \${3:...})

snippet lapply
	lapply(\${1:list}, \${2:function})

snippet sapply
	sapply(\${1:list}, \${2:function})

snippet mapply
	mapply(\${1:function}, \${2:...})

snippet tapply
	tapply(\${1:vector}, \${2:index}, \${3:function})

snippet vapply
	vapply(\${1:list}, \${2:function}, FUN.VALUE = \${3:type}, \${4:...})

snippet rapply
	rapply(\${1:list}, \${2:function})

snippet df
	\${1:df} <- data.frame(
		\${2:x} = \${3:1:3}
	)

snippet ts
	\`r paste("#", date(), "------------------------------")\`

snippet sec
	# \${1:Section} ----
`;

/** name → body (one tab of indentation removed). */
export function parseSnippets(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let name: string | null = null;
  let body: string[] = [];
  let indent = '';
  const flush = () => {
    if (name) {
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (body.length) out.set(name, body.join('\n'));
    }
    name = null;
    body = [];
    indent = '';
  };
  for (const line of lines) {
    const m = line.match(/^snippet\s+(\S+)\s*$/);
    if (m) {
      flush();
      name = m[1];
    } else if (name && (line.startsWith('\t') || !line.trim())) {
      body.push(line.startsWith('\t') ? line.slice(1) : '');
    } else if (name && /^ +\S/.test(line)) {
      // Spaces instead of a tab (an editor that converts tabs): the first
      // body line's indentation is the snippet's.
      if (!indent) indent = line.match(/^ +/)![0];
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line.trimStart());
    } else {
      flush();
    }
  }
  flush();
  return out;
}

let current = parseSnippets(DEFAULT_SNIPPETS);
let loaded = false;
let loading: Promise<void> | null = null;

/** The snippets (loaded from storage in the background the first time). */
export function snippets(): Map<string, string> {
  if (!loaded) void loadSnippets();
  return current;
}

/** The text of the snippets file, or the defaults. */
export async function snippetsText(): Promise<string> {
  try {
    return await (await fs.readAppFile(SNIPPETS_FILE)).text();
  } catch {
    return DEFAULT_SNIPPETS;
  }
}

export function loadSnippets(): Promise<void> {
  if (loaded) return loading ?? Promise.resolve();
  loaded = true;
  loading = snippetsText()
    .then((text) => void (current = parseSnippets(text)))
    .finally(() => (loading = null));
  return loading;
}

/** Save the snippets file (from the editor) and use it straight away. */
export async function saveSnippets(text: string): Promise<void> {
  await fs.writeAppFile(SNIPPETS_FILE, text);
  current = parseSnippets(text);
  loaded = true;
}

/** Open the snippets file in an editor tab. */
export async function editSnippets() {
  await editor()?.openAppFile(SNIPPETS_FILE, 'r.snippets', await snippetsText());
}

/** Run each `r expr` in R and put its result (escaped for a snippet) in its place. */
export async function resolveR(body: string): Promise<string> {
  if (!body.includes('`r ')) return body;
  const parts = body.split(/(`r [^`]+`)/);
  for (let i = 1; i < parts.length; i += 2) {
    const expr = parts[i].slice(3, -1);
    let value = '';
    if (session.status === 'ready' && session.idle) {
      try {
        const code = `paste(as.character(eval(parse(text = ${JSON.stringify(expr)}), new.env(parent = globalenv()))), collapse = "")`;
        value = (await session.strings(code))[0] ?? '';
      } catch {
        value = '';
      }
    }
    parts[i] = value.replace(/[\\$}]/g, '\\$&');
  }
  return parts.join('');
}

/** The snippet name at the end of `before` (text before the cursor), if any. */
export function snippetNameIn(before: string): string | null {
  const m = before.match(/(?:^|[^\w.$@])([A-Za-z_.][\w.]*)$/);
  return m && snippets().has(m[1]) ? m[1] : null;
}

/** The snippet name just before the cursor, if any. */
function nameBefore(model: monaco.editor.ITextModel, pos: monaco.Position): string | null {
  if (model.getLanguageId() === 'quarto' && !inRChunk(model, pos.lineNumber)) return null;
  if (model.getLanguageId() !== 'r' && model.getLanguageId() !== 'quarto') return null;
  const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
  const m = before.match(/(?:^|[^\w.$@])([A-Za-z_.][\w.]*)$/);
  return m && snippets().has(m[1]) ? m[1] : null;
}

/** Tab: expand the snippet named before the cursor. Returns false if there isn't one. */
export function expandSnippet(ed: monaco.editor.ICodeEditor): boolean {
  const model = ed.getModel();
  const sel = ed.getSelection();
  if (!model || !sel || !sel.isEmpty()) return false;
  const pos = sel.getPosition();
  const name = nameBefore(model, pos);
  if (!name) return false;
  const body = snippets().get(name)!;
  const version = model.getVersionId();
  void resolveR(body).then((text) => {
    if (model.getVersionId() !== version || ed.getModel() !== model) return;
    const ctrl = ed.getContribution('snippetController2') as unknown as { insert(t: string, o: { overwriteBefore: number }): void } | null;
    ctrl?.insert(text, { overwriteBefore: name.length });
    ed.focus();
  });
  return true;
}

/** Whether Tab would expand a snippet at the cursor (for the editor's context key). */
export function snippetAtCursor(ed: monaco.editor.ICodeEditor): boolean {
  const model = ed.getModel();
  const sel = ed.getSelection();
  return !!model && !!sel && sel.isEmpty() && !!nameBefore(model, sel.getPosition());
}

export const snippetCompletions: monaco.languages.CompletionItemProvider = {
  async provideCompletionItems(model, position) {
    if (model.getLanguageId() === 'quarto' && !inRChunk(model, position.lineNumber)) return { suggestions: [] };
    const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const m = before.match(/(?:^|[^\w.$@])([A-Za-z_.][\w.]*)$/);
    if (!m) return { suggestions: [] };
    const typed = m[1];
    const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
    const suggestions: monaco.languages.CompletionItem[] = [];
    for (const [name, body] of snippets()) {
      if (!name.startsWith(typed[0])) continue;
      suggestions.push({
        label: { label: name, description: 'snippet' },
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: body,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        documentation: { value: '```r\n' + body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '') + '\n```' },
        range,
        sortText: `~${name}`,
      });
    }
    // `r expr` bodies: resolve only those that could be picked.
    await Promise.all(
      suggestions.map(async (s) => {
        const name = (s.label as { label: string }).label;
        if (name.startsWith(typed) && (s.insertText as string).includes('`r ')) s.insertText = await resolveR(s.insertText as string);
      }),
    );
    return { suggestions };
  },
};

const g = globalThis as { __rSnippetSubs?: { dispose(): void }[] };
g.__rSnippetSubs?.forEach((d) => d.dispose());
g.__rSnippetSubs = ['r', 'quarto'].map((lang) => monaco.languages.registerCompletionItemProvider(lang, snippetCompletions));
