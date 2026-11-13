// "A new version is ready" (from the service worker), shown by UpdateBanner.
import { createSignal } from 'solid-js';

const [updateReady, setUpdate] = createSignal<null | (() => Promise<void>)>(null);
export { updateReady };
export const setUpdateReady = (apply: () => Promise<void>) => setUpdate(() => apply);
