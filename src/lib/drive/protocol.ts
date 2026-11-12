// Constants shared by the drive server (service worker), the in-worker patch
// and the page.

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const DIR_MODE = 16895; // 0o40777
export const FILE_MODE = 33206; // 0o100666

/** Files up to this size are read whole on open (consistent, fewest requests). */
export const SMALL_FILE_MAX = 4 * 1024 * 1024;
/** Lazy-read block size; 1–8 MB measured the same, 2 MB keeps memory low. */
export const BLOCK_SIZE = 2 * 1024 * 1024;

/** Header marking who wrote a file through the drive API. */
export const WRITER_HEADER = 'X-IDE-Writer';
