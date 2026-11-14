// Whether to edit "desktop style" (suggestion details open, no separate
// argument-hint popup): with a mouse or trackpad, or on a touch device that
// has a hardware keyboard attached (an iPad with a Magic Keyboard).
//
// Browsers don't report a hardware keyboard directly. Typing on one sends key
// events while the on-screen keyboard is down (the visual viewport stays
// full height); typing on the on-screen keyboard shrinks the viewport first.
import { createSignal } from 'solid-js';

const finePointer = window.matchMedia('(pointer: fine)');
const anyFine = window.matchMedia('(any-pointer: fine)');
const LS_KEY = 'webr-ide:hardware-keyboard';

const read = () => {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
};
const [hardwareKeyboard, setHardwareKeyboardRaw] = createSignal(read());
const [pointerFine, setPointerFine] = createSignal(finePointer.matches || anyFine.matches);
const update = () => setPointerFine(finePointer.matches || anyFine.matches);
finePointer.addEventListener('change', update);
anyFine.addEventListener('change', update);

function setHardwareKeyboard(on: boolean) {
  if (hardwareKeyboard() === on) return;
  setHardwareKeyboardRaw(on);
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0');
  } catch {
    /* private mode */
  }
}

const softKeyboardUp = () => {
  const vv = window.visualViewport;
  return !!vv && window.innerHeight - vv.height > 150;
};

if (!finePointer.matches) {
  window.addEventListener(
    'keydown',
    (e) => {
      // Modifier shortcuts and arrows only come from a real keyboard; plain
      // keys count when the on-screen keyboard isn't showing.
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.('.monaco-editor, .cm-editor, .console-term, input, textarea')) return;
      if (e.key === 'Unidentified' || e.key === 'Process') return;
      if (!softKeyboardUp() || e.metaKey || e.ctrlKey) setHardwareKeyboard(true);
    },
    true,
  );
  // The on-screen keyboard appeared: the hardware keyboard was detached.
  window.visualViewport?.addEventListener('resize', () => {
    if (softKeyboardUp()) setHardwareKeyboard(false);
  });
}

/** Edit with desktop conventions: a mouse/trackpad, or a hardware keyboard. */
export const desktopEditing = () => pointerFine() || hardwareKeyboard();
