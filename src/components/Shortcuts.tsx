// Keyboard shortcut reference (Alt+Shift+K, as in RStudio).
import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { kbd } from '../lib/ui';

const [open, setOpen] = createSignal(false);
export const openShortcuts = () => setOpen(true);

const GROUPS: [string, [string, string][]][] = [
  [
    'Run',
    [
      ['mod+enter', 'Run the current line or selection'],
      ['mod+alt+R', 'Run every chunk (Quarto) / source the script'],
      ['mod+shift+S', 'Source the file'],
      ['mod+shift+enter', 'Source with echo / run the chunk at the cursor'],
      ['mod+alt+P', 'Run chunks above (Quarto)'],
      ['mod+alt+I', 'Insert an R chunk (Quarto)'],
      ['mod+shift+K', 'Render the document'],
    ],
  ],
  [
    'Edit',
    [
      ['alt+-', 'Insert <-'],
      ['mod+shift+M', 'Insert |>'],
      ['mod+/', 'Comment / uncomment lines (also ' + kbd('mod+shift+C') + ')'],
      ['mod+I', 'Reindent lines'],
      ['mod+shift+A', 'Reformat code (styler)'],
      ['mod+F', 'Find / replace in the file'],
      ['mod+shift+F', 'Find in files'],
      ['mod+S', 'Save'],
    ],
  ],
  [
    'Navigate',
    [
      ['mod+shift+O', 'Document outline'],
      ['F2', 'Go to function definition (or ⌘/Ctrl-click)'],
      ['F1', 'Help for the name at the cursor'],
      ['mod+shift+P', 'Command palette'],
      ['mod+2', 'Move focus to the console'],
      ['mod+,', 'Settings'],
      ['alt+shift+K', 'This list'],
    ],
  ],
  [
    'Console',
    [
      ['Tab', 'Complete'],
      ['↑ / ↓', 'History'],
      ['ctrl+C', 'Interrupt R'],
      ['ctrl+L', 'Clear the console'],
    ],
  ],
];

export function Shortcuts() {
  return (
    <Show when={open()}>
      <Portal>
        <div class="modal-backdrop dialog-backdrop" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div class="dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts">
            <h3>Keyboard shortcuts</h3>
            <div class="shortcuts-groups">
              <For each={GROUPS}>
                {([title, rows]) => (
                  <section>
                    <h4>{title}</h4>
                    <table>
                      <tbody>
                        <For each={rows}>
                          {([keys, what]) => (
                            <tr>
                              <th>
                                <kbd>{kbd(keys)}</kbd>
                              </th>
                              <td>{what}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </section>
                )}
              </For>
            </div>
            <div class="dialog-actions">
              <button class="btn primary" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
