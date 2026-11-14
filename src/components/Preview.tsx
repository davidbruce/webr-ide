// Preview tab: the last rendered Quarto / R Markdown document.

import { createEffect, createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import { attachDeck, audienceOpen, closeAudienceWindow } from '../lib/presenter';
import { audienceWindow, openPresenter } from './Presenter';
import { preview } from '../lib/render';
import { downloadBlob, editor, writeWorkspaceFile } from '../lib/ide';
import { kbd, toast } from '../lib/ui';
import { Icon } from './Icon';
import './Preview.css';

const htmlName = (name: string) => name.replace(/\.(qmd|rmd)$/i, '') + '.html';
const formatMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

async function saveHtml() {
  if (!preview.html) return;
  const path = preview.path ? preview.path.replace(/\.(qmd|rmd)$/i, '') + '.html' : htmlName(preview.name);
  try {
    await writeWorkspaceFile(path, preview.html);
    toast(`Saved ${path}`);
  } catch (e) {
    toast(`Save failed: ${e}`, 'error');
  }
}

let frame: HTMLIFrameElement | undefined;
let stage: HTMLDivElement | undefined;

/**
 * Presenting: 'full' is the browser's full screen, 'overlay' a full-window
 * stand-in where element full screen isn't available (iPhone).
 */
const [presenting, setPresenting] = createSignal<null | 'full' | 'overlay'>(null);
/**
 * Slide rotation while presenting. With the iPad's rotation lock on, the page
 * stays portrait even when the iPad is held sideways (and Safari can't lock
 * orientation), so the slides are turned to fill the screen that way round.
 */
const [rotation, setRotation] = createSignal<0 | 90 | -90>(0);
const portrait = window.matchMedia('(orientation: portrait)');
const touch = window.matchMedia('(pointer: coarse)');
const autoRotation = () => (portrait.matches && touch.matches ? 90 : 0);

type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

function present() {
  const el = stage as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | undefined;
  if (!el) return;
  setRotation(autoRotation());
  const go = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  if (go) {
    Promise.resolve(go())
      .then(() => setPresenting('full'))
      .catch(() => setPresenting('overlay'));
    // Older WebKit returns nothing; the fullscreenchange event confirms it.
    if (!el.requestFullscreen) setPresenting('full');
  } else setPresenting('overlay');
  // So the arrow keys move the slides straight away.
  setTimeout(() => frame?.contentWindow?.focus(), 150);
}

function stopPresenting() {
  if (fsElement()) {
    const d = document as FsDoc;
    (d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d))?.();
  }
  setPresenting(null);
  setRotation(0);
}

const onFullscreenChange = () => {
  if (!fsElement() && presenting() === 'full') {
    setPresenting(null);
    setRotation(0);
  }
};
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
// Rotation lock turned off and the screen turned: no need to rotate any more.
portrait.addEventListener('change', () => {
  if (!presenting()) return;
  if (!portrait.matches) setRotation(0);
  else if (rotation() === 0) setRotation(autoRotation());
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && presenting() === 'overlay') stopPresenting();
});

export function PreviewPane() {
  // The preview's slides follow (and can drive) the audience window.
  createEffect(() => {
    if (preview.format !== 'revealjs' || !preview.html) return;
    const detach = attachDeck(frame?.contentWindow, 'view');
    onCleanup(detach);
  });
  return (
    <>
      <div class="pane-toolbar">
        <button
          class="tb-btn labeled"
          title={`Render the current document again (${kbd('mod+shift+K')})`}
          disabled={preview.status === 'rendering'}
          onClick={() => editor()?.renderActive?.()}
        >
          <Icon name="refresh" />
          <span>Render</span>
        </button>
        <Show when={preview.format === 'revealjs' && preview.html}>
          <button class="tb-btn labeled" title="Show the slides full screen (Esc to leave)" onClick={present}>
            <Icon name="play" />
            <span>Present</span>
          </button>
          <button class="tb-btn labeled" title="Presenter view: current and next slide, notes and timer" onClick={openPresenter}>
            <Icon name="grid" />
            <span>Presenter</span>
          </button>
          <button
            class="tb-btn"
            classList={{ active: audienceOpen() }}
            title={audienceOpen() ? 'Close the audience window' : 'Open the slides in a separate window (for a projector or second display)'}
            onClick={() => (audienceOpen() ? closeAudienceWindow() : audienceWindow())}
          >
            <Icon name="expand" />
          </button>
        </Show>
        <span class="tb-sep" />
        <button class="tb-btn" title="Save as HTML next to the document" disabled={!preview.html} onClick={() => void saveHtml()}>
          <Icon name="save" />
        </button>
        <button
          class="tb-btn"
          title="Download HTML"
          disabled={!preview.html}
          onClick={() => downloadBlob(new Blob([preview.html], { type: 'text/html' }), htmlName(preview.name))}
        >
          <Icon name="download" />
        </button>
        <span class="tb-spacer" />
        <span class="preview-status">
          <Switch>
            <Match when={preview.status === 'rendering'}>
              <span class="spinner small" aria-hidden="true" /> Rendering {preview.name}…
            </Match>
            <Match when={preview.status === 'error'}>
              <span class="nb-bad">✕</span> {preview.name}
            </Match>
            <Match when={preview.status === 'done'}>
              {preview.name} · {formatMs(preview.ms)}
            </Match>
          </Switch>
        </span>
      </div>
      <div class="pane-body preview-body">
        <Show when={preview.status === 'error'}>
          <div class="preview-error">
            <strong>Render failed</strong>
            <pre>{preview.error}</pre>
          </div>
        </Show>
        <Show
          when={preview.html}
          fallback={
            <Show when={preview.status === 'idle'}>
              <div class="empty-state">
                <Icon name="book" size={32} />
                <p>Render a Quarto document to preview it here.</p>
                <p class="hint">{kbd('mod+shift+K')} or the Render button in the editor</p>
              </div>
            </Show>
          }
        >
          <div
            ref={stage}
            class="preview-stage"
            classList={{ presenting: !!presenting(), overlay: presenting() === 'overlay', rotated: rotation() !== 0 }}
            style={{ '--stage-rotate': `${rotation()}deg` }}
          >
            <div class="stage-screen">
              <iframe
                ref={frame}
                allow="fullscreen"
                class="preview-frame"
                classList={{ stale: preview.status === 'rendering' }}
                sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                srcdoc={preview.html}
                title={`Preview of ${preview.name}`}
              />
              <Show when={presenting()}>
                <div class="stage-tools">
                  <button title="Rotate the slides anticlockwise" aria-label="Rotate anticlockwise" onClick={() => setRotation((r) => (r === 90 ? 0 : -90))}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4v6h6" /><path d="M3.5 15a9 9 0 1 0 2.1-9.4L3 10" /></svg>
                  </button>
                  <button title="Rotate the slides clockwise" aria-label="Rotate clockwise" onClick={() => setRotation((r) => (r === -90 ? 0 : 90))}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 4v6h-6" /><path d="M20.5 15a9 9 0 1 1-2.1-9.4L21 10" /></svg>
                  </button>
                  <button title="Stop presenting (Esc)" aria-label="Stop presenting" onClick={stopPresenting}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}
