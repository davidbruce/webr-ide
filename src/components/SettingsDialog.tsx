// Settings: appearance, editor and code checks in one dialog.
import { For, JSX, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { settings, setSetting, resetSettings, settingsOpen, setSettingsOpen, type Settings } from '../lib/settings';
import { setThemePref, themePref, type ThemePref } from '../lib/ui';
import { rKeyboardEnabled, setRKeyboardEnabled } from '../lib/rkeyboard';

const touchScreen = window.matchMedia('(pointer: coarse)').matches;

function Row(p: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="settings-row">
      <div class="settings-text">
        <div class="settings-label">{p.label}</div>
        <Show when={p.hint}>
          <div class="settings-hint">{p.hint}</div>
        </Show>
      </div>
      <div class="settings-control">{p.children}</div>
    </div>
  );
}

function OnOff(p: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <button class="switch" classList={{ on: p.on }} role="switch" aria-checked={p.on} aria-label={p.label} onClick={() => p.set(!p.on)}>
      <span class="switch-knob" />
    </button>
  );
}

function Segmented<T extends string | number>(p: { value: T; options: [T, string][]; set: (v: T) => void; label: string }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={p.label}>
      <For each={p.options}>
        {([v, text]) => (
          <button role="radio" aria-checked={p.value === v} classList={{ on: p.value === v }} onClick={() => p.set(v)}>
            {text}
          </button>
        )}
      </For>
    </div>
  );
}

function Stepper(p: { value: number; min: number; max: number; set: (v: number) => void; label: string }) {
  return (
    <div class="stepper" aria-label={p.label}>
      <button aria-label={`Smaller ${p.label}`} disabled={p.value <= p.min} onClick={() => p.set(p.value - 1)}>
        −
      </button>
      <span class="stepper-value">{p.value}px</span>
      <button aria-label={`Larger ${p.label}`} disabled={p.value >= p.max} onClick={() => p.set(p.value + 1)}>
        +
      </button>
    </div>
  );
}

const flag = (key: keyof Settings) => (v: boolean) => setSetting(key, v as never);

export function SettingsDialog() {
  return (
    <Show when={settingsOpen()}>
      <Portal>
        <div class="modal-backdrop dialog-backdrop" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <div class="dialog settings" role="dialog" aria-label="Settings">
            <h3>Settings</h3>
            <div class="settings-body">
              <h4>Appearance</h4>
              <Row label="Theme">
                <Segmented
                  label="Theme"
                  value={themePref()}
                  options={[
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                    ['system', 'System'],
                  ]}
                  set={(v) => setThemePref(v as ThemePref)}
                />
              </Row>
              <Row label="Editor font size" hint="Phones use 1px less.">
                <Stepper label="editor font size" value={settings.editorFontSize} min={10} max={24} set={(v) => setSetting('editorFontSize', v)} />
              </Row>
              <Row label="Console font size">
                <Stepper label="console font size" value={settings.consoleFontSize} min={10} max={24} set={(v) => setSetting('consoleFontSize', v)} />
              </Row>

              <h4>Editor</h4>
              <Row label="Tab width">
                <Segmented
                  label="Tab width"
                  value={settings.tabSize}
                  options={[
                    [2, '2 spaces'],
                    [4, '4 spaces'],
                  ]}
                  set={(v) => setSetting('tabSize', v as 2 | 4)}
                />
              </Row>
              <Row label="Wrap long lines">
                <OnOff label="Wrap long lines" on={settings.wordWrap} set={flag('wordWrap')} />
              </Row>
              <Row label="Help on hover" hint="Usage and a summary when the pointer rests on a function.">
                <OnOff label="Help on hover" on={settings.hoverHelp} set={flag('hoverHelp')} />
              </Row>

              <h4>Code checks</h4>
              <Row label="Syntax errors" hint="Underline code R can't parse, as you type.">
                <OnOff label="Syntax errors" on={settings.syntaxCheck} set={flag('syntaxCheck')} />
              </Row>
              <Row label="Problems" hint="Warn about unknown functions, wrong arguments and unused variables (R's codetools).">
                <OnOff label="Problems" on={settings.lint} set={flag('lint')} />
              </Row>

              <Show when={touchScreen}>
                <h4>Touch</h4>
                <Row label="R keyboard (experimental)" hint="An on-screen keyboard for R on phones.">
                  <OnOff label="R keyboard" on={rKeyboardEnabled()} set={setRKeyboardEnabled} />
                </Row>
              </Show>
            </div>
            <div class="dialog-actions">
              <button class="btn" onClick={resetSettings}>
                Reset
              </button>
              <span class="tb-spacer" />
              <button class="btn primary" onClick={() => setSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
