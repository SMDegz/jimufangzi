/**
 * Player walk-cycle frames.
 *
 * The character art lives outside the normal placement asset manifest: it
 * is an animated actor rather than a placeable world object. Keep its URLs
 * ASCII-encoded so the paths work consistently on static hosts.
 */

const ROOT = 'assets/people/%E4%BA%BA%E7%89%A9';

const WALK_CYCLES = Object.freeze({
    front: Array.from({ length: 8 }, (_, i) => `${ROOT}/%E5%89%8D%E8%BF%9B/frame_${String(i).padStart(3, '0')}.png`),
    right: Array.from({ length: 8 }, (_, i) => `${ROOT}/%E5%90%91%E5%8F%B3/frame_${String(i + 8).padStart(3, '0')}.png`),
    back:  Array.from({ length: 8 }, (_, i) => `${ROOT}/%E5%90%91%E5%90%8E/frame_${String(i + 16).padStart(3, '0')}.png`),
    left:  [24, 25, 26, 27, 29, 30, 31].map(i => `${ROOT}/%E5%90%91%E5%B7%A6/frame_${String(i).padStart(3, '0')}.png`),
});

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not load player frame: ${src}`));
        image.src = src;
    });
}

/** Load all four directional walk cycles for the controllable player. */
export async function loadPlayerSprites() {
    const entries = await Promise.all(Object.entries(WALK_CYCLES).map(async ([direction, urls]) => {
        const frames = await Promise.all(urls.map(loadImage));
        return [direction, frames];
    }));
    return Object.fromEntries(entries);
}
