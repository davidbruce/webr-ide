import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { dialog, setDialog, DialogRequest, toasts, imageView, setImageView } from '../lib/ui';
import { view, setView } from '../lib/ide';
import { Icon } from './Icon';
import { DataGrid } from './DataGrid';
import { ArraySource } from '../lib/grid/source';

function DialogBox(props: { req: DialogRequest }) {
  const [value, setValue] = createSignal(props.req.input?.value ?? '');
  let input: HTMLInputElement | undefined;
  let okBtn!: HTMLButtonElement;

  const req = props.req; // captured: the <Show> accessor goes stale once we close
  const close = (v: string | null) => {
    setDialog(null);
    req.resolve(v);
  };

  onMount(() => {
    if (input) {
      input.focus();
      const v = input.value;
      const slash = v.lastIndexOf('/') + 1;
      const dot = v.lastIndexOf('.');
      if (props.req.input?.selectStem && dot > slash) input.setSelectionRange(slash, dot);
      else input.select();
    } else okBtn.focus();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close(null);
  };
  window.addEventListener('keydown', onKey, true);
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  return (
    <div class="modal-backdrop dialog-backdrop prompt-backdrop" onClick={(e) => e.target === e.currentTarget && close(null)}>
      <form
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.req.title}
        onSubmit={(e) => {
          e.preventDefault();
          if (props.req.input) {
            const v = value().trim();
            if (v) close(v);
          } else close('ok');
        }}
      >
        <h2>{props.req.title}</h2>
        <Show when={props.req.message}>
          <p>{props.req.message}</p>
        </Show>
        <Show when={props.req.input}>
          <input
            ref={input}
            type="text"
            value={value()}
            placeholder={props.req.input!.placeholder}
            onInput={(e) => setValue(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        </Show>
        <div class="dialog-actions">
          <Show when={props.req.extra}>
            <button type="button" class="btn" onClick={() => close(props.req.extra!.value)}>
              {props.req.extra!.label}
            </button>
            <span class="tb-spacer" />
          </Show>
          <Show when={props.req.cancelLabel !== null}>
            <button type="button" class="btn" onClick={() => close(null)}>
              {props.req.cancelLabel ?? 'Cancel'}
            </button>
          </Show>
          <button ref={okBtn} type="submit" class="btn" classList={{ primary: !props.req.danger, danger: !!props.req.danger }}>
            {props.req.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DataViewer(props: { title: string; data: Record<string, unknown[]> }) {
  const source = new ArraySource(props.data);
  let box!: HTMLDivElement;
  onMount(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    box.focus();
  });
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setView(null)}>
      <div class="data-viewer" role="dialog" aria-label={props.title} tabIndex={-1} ref={box}>
        <div class="plot-modal-header">
          <Icon name="table" />
          <strong>{props.title}</strong>
          <span class="muted">
            {source.totalRows().toLocaleString()} obs. of {source.columns().length} variables
          </span>
          <span class="tb-spacer" />
          <button class="tb-btn close-btn" onClick={() => setView(null)} title="Close (Esc)">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div class="data-viewer-body">
          <DataGrid source={source} />
        </div>
      </div>
    </div>
  );
}

export function Modals() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (view()) setView(null);
    const iv = imageView();
    if (iv) {
      URL.revokeObjectURL(iv.url);
      setImageView(null);
    }
  };
  window.addEventListener('keydown', onKey, true);
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  const closeImage = () => {
    const iv = imageView();
    if (iv) URL.revokeObjectURL(iv.url);
    setImageView(null);
  };

  return (
    <Portal>
      <Show when={dialog()}>{(d) => <DialogBox req={d()} />}</Show>
      <Show when={view()}>{(v) => <DataViewer title={v().title} data={v().data} />}</Show>
      <Show when={imageView()}>
        {(iv) => (
          <div class="modal-backdrop plot-modal-backdrop" onClick={(e) => e.target === e.currentTarget && closeImage()}>
            <div class="plot-modal" role="dialog" aria-label={iv().title} tabIndex={-1} ref={(el) => queueMicrotask(() => el.focus())}>
              <div class="plot-modal-header">
                <Icon name="image" />
                <strong>{iv().title}</strong>
                <span class="tb-spacer" />
                <button class="tb-btn close-btn" onClick={closeImage} title="Close">
                  <Icon name="close" size={18} />
                </button>
              </div>
              <div class="plot-modal-body">
                <img src={iv().url} alt={iv().title} class="plot-image" />
              </div>
            </div>
          </div>
        )}
      </Show>
      <div class="toasts" aria-live="polite">
        <For each={toasts()}>{(t) => <div class={`toast ${t.kind}`}>{t.text}</div>}</For>
      </div>
    </Portal>
  );
}
