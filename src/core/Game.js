/**
 * Game.js
 *
 * Top-level game controller. Owns the world (TileMap), camera, renderer,
 * input manager, placement system, and UI. Exposes a small intent API
 * (setTool, selectAsset, save, reset, …) consumed by the UI.
 */

// Keep map-expansion settings in sync with this module after static deploys.
import { CONFIG } from '../config.js?v=expand-1';
import { Camera } from './Camera.js';
import { Renderer } from './Renderer.js';
import { InputManager } from './InputManager.js';
// Versioned import prevents a browser from combining a newly deployed Game
// module with an older cached TileMap module after a static-site deploy.
import { TileMap } from '../grid/TileMap.js?v=expand-1';
import { PlacementSystem } from '../building/PlacementSystem.js';
import { ASSET_INDEX, ASSET_MANIFEST } from '../assets/assetManifest.js';
import { SaveSystem } from '../storage/SaveSystem.js';
import { cellToScreen } from '../grid/IsoGrid.js';
import { playPlacementFor } from '../ui/Audio.js';
import { loadPlayerSprites } from '../assets/playerSprites.js';

// Local walk surfaces for the main-villa artwork. Coordinates are relative
// to its 4×4 footprint: the front courtyard leads to the left exterior
// stair, then across the upper roof and the pergola-side lower terrace.
const VILLA_SURFACES = Object.freeze({
    // Ground-floor terrace and the rooms directly behind the large blue
    // front door. These are intentionally at ground height: walking through
    // the door should not make the character jump onto a terrace.
    '0,3': 0, '1,3': 0, '2,3': 0, '3,3': 0,
    '1,2': 0, '2,2': 0,
    // The exterior flight seen on the left of the villa.
    '0,2': 2, '0,1': 4,
    // Upstairs roof terrace, reached directly from the stair landing.
    '0,0': 6, '1,0': 6, '1,1': 6,
    // The upper-right pergola terrace. The former 2,2 / 3,2 cells project
    // to the lower right façade in the artwork, not to this terrace.
    '2,0': 6, '3,0': 6, '2,1': 6, '3,1': 6,
});

// Only these footprint-boundary edges are doors. Surface cells along the
// courtyard are walkable after entering, but must not turn every adjacent
// wall segment into an entrance. Coordinates are local to the villa.
const VILLA_ENTRY_EDGES = new Set([
    '0,4>0,3', '0,3>0,4', // small blue courtyard gate
    '3,4>3,3', '3,3>3,4', // large ground-floor blue front door
]);

// A character can climb one short flight at a time. Besides making stairs
// feel like stairs, this prevents entering an elevated terrace directly from
// an adjacent ground cell that has no connecting steps.
const MAX_PLAYER_STEP_HEIGHT = 2;

export class Game {
    constructor(canvas, ui = null) {
        this.canvas = canvas;
        this.tileMap = new TileMap();
        this.camera = new Camera();
        this.renderer = new Renderer(canvas, this.camera, this.tileMap);
        this.placement = new PlacementSystem(this.tileMap);
        this.input = new InputManager(canvas, this.camera, this);
        this.occlusionProfiles = {};
        this.occlusionEdit = null;
        this.renderer.setOcclusionProfiles(this.occlusionProfiles);

        // A deliberately simple controllable stand-in for a future character.
        // `x/y` are rendered positions while `targetX/targetY` keep movement
        // locked to grid cells.
        this.player = {
            x: 6,
            y: 6,
            targetX: 6,
            targetY: 6,
            z: 0,
            targetZ: 0,
            moving: false,
            speed: 5, // cells per second
            direction: 'front',
            animationTime: 0,
            frames: null,
        };
        this.renderer.setPlayer(this.player);
        loadPlayerSprites().then(frames => {
            this.player.frames = frames;
            this.renderer.markDirty();
        }).catch(err => console.warn('Player sprites unavailable; using cube fallback.', err));
        this._lastFrameTime = performance.now();

        // Any camera mutation (pan/zoom/recenter) needs the next frame
        // re-rendered. The renderer itself is otherwise idle.
        this.camera.onChange(() => this.renderer.markDirty());

        // Default selection
        this.tool = 'place';                  // 'place' | 'erase' | 'pan'
        this.category = 'terrain';
        this.selectedAssetId = ASSET_MANIFEST.find(a => a.category === 'terrain').id;
        this.ui = ui;

        // Preview-only flip state for the current selection. Toggled by the
        // user (H / V) before commit; the values are baked into the
        // PlacedObject when the asset is placed.
        this.flipH = false;
        this.flipV = false;

        // Center camera over grid
        this._centerCamera();

        // Animation loop
        this._loop = this._loop.bind(this);
        requestAnimationFrame(this._loop);
    }

    _centerCamera() {
        const c = cellToScreen(this.tileMap.width / 2, this.tileMap.height / 2);
        const { innerWidth: w, innerHeight: h } = window;
        this.camera.centerOn(c.x, c.y, w, h);
    }

    /* ── Intents from UI / input ──────────────────────────────── */

    setTool(t) {
        this.tool = t;
        this.renderer.eraseMode = (t === 'erase');
        this.canvas.style.cursor = t === 'pan' ? 'grab'
                                  : t === 'erase' ? 'crosshair'
                                  : 'crosshair';
        this.renderer.markDirty();
        this.ui?.update();
    }

    setCategory(cat) {
        if (this.category === cat) return;
        this.category = cat;
        // Auto-select first asset of that category.
        const first = ASSET_MANIFEST.find(a => a.category === cat);
        if (first) this.selectedAssetId = first.id;
        this._resetFlip();
        this.renderer.markDirty();
        this.ui?.update();
    }

    selectAsset(id) {
        const a = ASSET_INDEX[id];
        if (!a) return;
        const changed = this.selectedAssetId !== id;
        this.selectedAssetId = id;
        this.category = a.category;
        if (changed) this._resetFlip();
        // Picking an asset implies "place" mode.
        if (this.tool === 'erase') this.setTool('place');
        this.renderer.markDirty();
        this.ui?.update();
    }

    toggleFlipH() {
        this.flipH = !this.flipH;
        this._syncPreviewFlip();
        this.renderer.markDirty();
        this.ui?.showToast(`水平翻转：${this.flipH ? '开启' : '关闭'}`);
        this.ui?.update();
    }

    toggleFlipV() {
        this.flipV = !this.flipV;
        this._syncPreviewFlip();
        this.renderer.markDirty();
        this.ui?.showToast(`垂直翻转：${this.flipV ? '开启' : '关闭'}`);
        this.ui?.update();
    }

    _resetFlip() {
        this.flipH = false;
        this.flipV = false;
        this._syncPreviewFlip();
    }

    _syncPreviewFlip() {
        this.renderer.previewFlipH = this.flipH;
        this.renderer.previewFlipV = this.flipV;
    }

    toggleGrid() {
        this.renderer.showGrid = !this.renderer.showGrid;
        this.renderer.markDirty();
        this.ui?.hud?.syncToggles();
        this.ui?.update();
    }

    save() {
        const ok = SaveSystem.save(this.tileMap, this.camera, this.occlusionProfiles);
        this.ui?.showToast(ok ? '岛屿已保存' : '保存失败');
    }

    load() {
        const ok = SaveSystem.load(this.tileMap, this.camera, profiles => {
            this.occlusionProfiles = profiles;
            this.renderer.setOcclusionProfiles(profiles);
        });
        if (ok) this.renderer.markDirty();
        return ok;
    }

    reset() {
        this.tileMap.clearAll();
        SaveSystem.clear();
        this._centerCamera();
        this.renderer.markDirty();
        this.ui?.showToast('世界已重置');
    }

    /** Add an even border around the island without moving it on screen. */
    expandMap() {
        // Defaults keep an already-open page safe if its config module was
        // retained in cache from before map expansion existed.
        const step = Number.isInteger(CONFIG.grid.expandStep) ? CONFIG.grid.expandStep : 4;
        const padding = step / 2;
        const nextWidth = this.tileMap.width + step;
        const nextHeight = this.tileMap.height + step;
        const maxSize = Number.isInteger(CONFIG.grid.maxSize) ? CONFIG.grid.maxSize : 64;
        if (nextWidth > maxSize || nextHeight > maxSize) {
            this.ui?.showToast(`地图最大可扩展到 ${maxSize} × ${maxSize}`);
            return;
        }
        // The fallback supports an already-open page that retained an older
        // TileMap module during a deploy. Fresh loads use TileMap.expand().
        const shift = typeof this.tileMap.expand === 'function'
            ? this.tileMap.expand(padding)
            : this._expandTileMapCompat(padding);
        this.player.x += shift.x;
        this.player.y += shift.y;
        this.player.targetX += shift.x;
        this.player.targetY += shift.y;
        // Shifting existing grid coordinates moves their world position down
        // by `padding * tile.h`; counter it in screen pixels to keep the
        // built island visually stationary while its border grows.
        this.camera.pan(0, -shift.y * CONFIG.tile.h * this.camera.zoom);
        this.renderer.markDirty();
        this.save();
        this.ui?.showToast(`地图已扩展至 ${this.tileMap.width} × ${this.tileMap.height}`);
    }

    _expandTileMapCompat(padding) {
        const map = this.tileMap;
        const oldWidth = map.width, oldHeight = map.height;
        const width = oldWidth + padding * 2, height = oldHeight + padding * 2;
        const terrain = new Array(width * height).fill(null);
        for (let y = 0; y < oldHeight; y++) {
            for (let x = 0; x < oldWidth; x++) {
                terrain[(y + padding) * width + x + padding] = map.terrain[y * oldWidth + x];
            }
        }
        for (const obj of map.objects) { obj.gx += padding; obj.gy += padding; }
        map.width = width;
        map.height = height;
        map.terrain = terrain;
        map._occupancy = new Array(width * height).fill(null);
        for (const obj of map.objects) map._stampOccupancy(obj, obj);
        map.terrainVersion++;
        map.objectsVersion++;
        return { x: padding, y: padding };
    }

    /**
     * Carpet the entire grid with grass in one click. Empty cells get a
     * fresh grass tile; cells whose terrain is already something else
     * (path, sand, water) are left alone so the user doesn't lose any
     * intentional terrain work. Each tile is queued through the same
     * staggered animation pipeline as the starter scene so the fill
     * ripples diagonally across the island instead of snapping in flat.
     *
     * Returns the number of cells that were actually filled.
     */
    fillGrass() {
        const W = this.tileMap.width;
        const H = this.tileMap.height;
        // Same wave timing as the starter scene reveal so the two feel
        // like one consistent visual language.
        const STEP_MS = 32;
        let filled = 0;
        for (let gy = 0; gy < H; gy++)
        for (let gx = 0; gx < W; gx++) {
            if (this.tileMap.getTerrain(gx, gy)) continue;
            if (this.placeAndAnimate('grass', gx, gy, { delay: (gx + gy) * STEP_MS })) {
                filled++;
            }
        }
        if (filled > 0) {
            // One sound at the start; the per-tile placement audio path
            // would fire ~196 times in a fraction of a second otherwise.
            playPlacementFor('grass');
            this.ui?.showToast(`已铺设 ${filled} 格草地`);
        } else {
            this.ui?.showToast('网格已经铺满地形');
        }
        return filled;
    }

    /* ── Mouse callbacks (called by InputManager) ─────────────── */

    onHover(cell) {
        const prev = this.renderer.hoverCell;
        const sameCell = prev && prev.gx === cell.gx && prev.gy === cell.gy;
        this.renderer.hoverCell = cell;
        if (this.isOcclusionEditing()) {
            this.renderer.previewAssetId = null;
            this.renderer.previewValid = true;
        } else if (this.tool === 'erase') {
            this.renderer.previewAssetId = null;
            this.renderer.previewValid = !!this.tileMap.objectAt(cell.gx, cell.gy)
                || !!this.tileMap.getTerrain(cell.gx, cell.gy);
        } else if (this.tool === 'place') {
            this.renderer.previewAssetId = this.selectedAssetId;
            this.renderer.previewValid = this.placement.canPlace(this.selectedAssetId, cell.gx, cell.gy);
        } else {
            this.renderer.previewAssetId = null;
            this.renderer.previewValid = true;
        }
        // Only invalidate the next frame when the highlighted cell or its
        // validity actually changed. Hover events fire on every mousemove
        // pixel, so this matters.
        if (!sameCell) this.renderer.markDirty();
    }

    onPrimaryClick(gx, gy) {
        if (this.isOcclusionEditing()) return;
        if (!this.tileMap.inBounds(gx, gy)) return;
        if (this.tool === 'erase') {
            // Capture what's about to be removed so we can pick the right
            // SFX (water erase splashes, everything else thuds).
            const objHere = this.tileMap.objectAt(gx, gy);
            const terrainHere = this.tileMap.getTerrain(gx, gy);
            const targetId = objHere ? objHere.assetId : terrainHere;
            if (this.placement.erase(gx, gy)) {
                this.renderer.markDirty();
                playPlacementFor(targetId);
            }
        } else if (this.tool === 'place') {
            const result = this.placement.place(this.selectedAssetId, gx, gy, {
                flipH: this.flipH,
                flipV: this.flipV,
            });
            if (result?.kind === 'object') {
                const o = result.object;
                this.renderer.spawnAnim(`obj-${o.id}`, {
                    gx: o.gx,
                    gy: o.gy,
                    w: o.footprint?.w ?? 1,
                    d: o.footprint?.d ?? 1,
                });
                playPlacementFor(o.assetId);
            } else if (result?.kind === 'terrain') {
                this.renderer.spawnAnim(`t-${result.gx},${result.gy}`, {
                    gx: result.gx,
                    gy: result.gy,
                    w: 1,
                    d: 1,
                });
                playPlacementFor(result.assetId);
            }
        }
    }

    onSecondaryClick(gx, gy) {
        if (this.isOcclusionEditing()) return;
        // Right click always erases.
        if (!this.tileMap.inBounds(gx, gy)) return;
        const objHere = this.tileMap.objectAt(gx, gy);
        const terrainHere = this.tileMap.getTerrain(gx, gy);
        const targetId = objHere ? objHere.assetId : terrainHere;
        if (this.placement.erase(gx, gy)) {
            this.renderer.markDirty();
            playPlacementFor(targetId);
        }
    }

    /** Move the test character one grid cell, unless an object occupies it. */
    movePlayer(dx, dy) {
        const p = this.player;
        // One command per step keeps the collision test and the visual
        // movement easy to read while testing with held keys.
        if (p.moving) return;
        const gx = p.targetX + dx;
        const gy = p.targetY + dy;
        if (!this.tileMap.inBounds(gx, gy) || this._isPlayerBlocked(gx, gy)) return;
        if (!this._canCrossVillaBoundary(p.targetX, p.targetY, gx, gy)) return;
        const targetZ = this._tileHeight(gx, gy);
        if (Math.abs(targetZ - p.targetZ) > MAX_PLAYER_STEP_HEIGHT) return;
        if (dx < 0) p.direction = 'left';
        if (dx > 0) p.direction = 'right';
        if (dy < 0) p.direction = 'back';
        if (dy > 0) p.direction = 'front';
        p.targetX = gx;
        p.targetY = gy;
        p.targetZ = targetZ;
        p.moving = true;
        this.renderer.markDirty();
    }

    /**
     * Large structures and walls visually extend across their left and upper
     * grid edges. Only those two outside strips are reserved; the front,
     * right, and diagonal cells remain walkable.
     */
    _isPlayerBlocked(gx, gy) {
        const occupant = this.tileMap.objectAt(gx, gy);
        // Gates and arches are explicit entrances: their sprite remains in
        // the world, but the player may pass through its cell.
        if (occupant
            && !['gate_fence', 'archway'].includes(occupant.assetId)
            && this._structureHeightAt(gx, gy) == null) return true;
        for (const obj of this.tileMap.objects) {
            const def = ASSET_INDEX[obj.assetId];
            const isWall = ['low_wall', 'corner_wall', 'blue_railing']
                .includes(obj.assetId);
            if (def?.category !== 'buildings' && !isWall) continue;
            const fp = obj.footprint ?? { w: 1, d: 1 };
            const inLeftBuffer = gx === obj.gx - 1
                && gy >= obj.gy && gy < obj.gy + fp.d;
            const inTopBuffer = gy === obj.gy - 1
                && gx >= obj.gx && gx < obj.gx + fp.w;
            if (inLeftBuffer || inTopBuffer) return true;
        }
        return false;
    }

    _tileHeight(gx, gy) {
        const structureHeight = this._structureHeightAt(gx, gy);
        if (structureHeight != null) return structureHeight;
        // The existing stair terrain rises by two voxel steps. This small
        // height layer gives the character a visible climb without changing
        // the builder's terrain format.
        return this.tileMap.getTerrain(gx, gy) === 'stairs' ? 2 : 0;
    }

    _canCrossVillaBoundary(fromX, fromY, toX, toY) {
        const villa = [
            this.tileMap.objectAt(fromX, fromY),
            this.tileMap.objectAt(toX, toY),
        ].find(obj => obj?.assetId === 'villa');
        if (!villa) return true;

        const toLocal = `${toX - villa.gx},${toY - villa.gy}`;
        const fromLocal = `${fromX - villa.gx},${fromY - villa.gy}`;
        const fromIsSurface = Object.hasOwn(VILLA_SURFACES, fromLocal);
        const toIsSurface = Object.hasOwn(VILLA_SURFACES, toLocal);
        // Both cells are part of the villa route, so this is movement inside
        // the building. A crossing between a route cell and the exterior is
        // legal only through one of the explicitly painted blue doors.
        if (fromIsSurface === toIsSurface) return true;
        return VILLA_ENTRY_EDGES.has(`${fromLocal}>${toLocal}`);
    }

    _structureHeightAt(gx, gy) {
        const obj = this.tileMap.objectAt(gx, gy);
        if (!obj || obj.assetId !== 'villa') return null;
        const localX = gx - obj.gx;
        const localY = gy - obj.gy;
        const key = `${localX},${localY}`;
        return Object.hasOwn(VILLA_SURFACES, key) ? VILLA_SURFACES[key] : null;
    }

    /* ── Foreground-occlusion profile editor ─────────────────── */

    isOcclusionEditing() { return !!this.occlusionEdit; }

    toggleOcclusionEditor() {
        if (this.occlusionEdit) {
            this.cancelOcclusionEdit();
            return;
        }
        this.occlusionEdit = { selected: null, points: [] };
        this.renderer.setOcclusionEdit(this.occlusionEdit);
        this.canvas.style.cursor = 'crosshair';
        this.ui?.showToast('遮挡绘制：先点击围墙，再沿前景墙面逐点勾边');
    }

    /** Open the standalone asset editor instead of asking for map clicks. */
    openOcclusionEditor() {
        if (this.isOcclusionEditing()) this.cancelOcclusionEdit();
        this.ui?.occlusionEditor.open(this.selectedAssetId);
    }

    setOcclusionProfile(assetId, points) {
        this.occlusionProfiles[assetId] = { points: points.map(p => ({ x: p.x, y: p.y })) };
        this.renderer.setOcclusionProfiles(this.occlusionProfiles);
        this.save();
        this.ui?.showToast('前景遮挡轮廓已保存并应用到同类物品');
    }

    removeOcclusionProfile(assetId) {
        delete this.occlusionProfiles[assetId];
        this.renderer.setOcclusionProfiles(this.occlusionProfiles);
        this.save();
        this.ui?.showToast('已移除该物品的前景遮挡轮廓');
    }

    cancelOcclusionEdit() {
        if (!this.occlusionEdit) return;
        this.occlusionEdit = null;
        this.renderer.setOcclusionEdit(null);
        this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
        this.ui?.showToast('已取消遮挡绘制');
    }

    finishOcclusionEdit() {
        const edit = this.occlusionEdit;
        if (!edit?.selected || edit.points.length < 3) {
            this.ui?.showToast('至少需要三个轮廓点');
            return;
        }
        // Profiles belong to an asset type, so one outline fixes every
        // placed copy of that wall or building, including future copies.
        this.occlusionProfiles[edit.selected.assetId] = {
            points: edit.points.map(p => ({ x: p.x, y: p.y })),
        };
        this.renderer.setOcclusionProfiles(this.occlusionProfiles);
        const name = ASSET_INDEX[edit.selected.assetId]?.name ?? edit.selected.assetId;
        this.occlusionEdit = null;
        this.renderer.setOcclusionEdit(null);
        this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
        this.save();
        this.ui?.showToast(`${name} 的前景遮挡轮廓已保存`);
    }

    onOcclusionClick(gx, gy, worldX, worldY, finish = false) {
        const edit = this.occlusionEdit;
        if (!edit) return;
        if (!edit.selected) {
            const obj = this.tileMap.objectAt(gx, gy);
            if (!obj) {
                this.ui?.showToast('请点击一个已放置的围墙或建筑');
                return;
            }
            edit.selected = obj;
            edit.points = [];
            this.renderer.setOcclusionEdit(edit);
            this.ui?.showToast('沿需要盖住人物的前景墙面点击；双击或 Enter 保存');
            return;
        }
        const point = this.renderer.worldToObjectLocal(edit.selected, worldX, worldY);
        if (!point) {
            this.ui?.showToast('请在所选物体图片范围内绘制');
            return;
        }
        edit.points.push(point);
        this.renderer.markDirty();
        if (finish) this.finishOcclusionEdit();
    }

    /**
     * Place an asset and queue its elastic placement animation, optionally
     * delayed by `opts.delay` milliseconds. Used by the starter-scene
     * reveal to ripple the seeded village in back-to-front so first-run
     * players see the world build itself instead of just appearing.
     *
     * Returns the placement result (or null if the placement was rejected).
     */
    placeAndAnimate(assetId, gx, gy, opts = {}) {
        const result = this.placement.place(assetId, gx, gy, {
            flipH: !!opts.flipH,
            flipV: !!opts.flipV,
        });
        if (!result) return null;
        const startAt = performance.now() + (opts.delay ?? 0);
        const duration = opts.duration ?? 460;
        if (result.kind === 'object') {
            const o = result.object;
            this.renderer.spawnAnim(`obj-${o.id}`, {
                gx: o.gx,
                gy: o.gy,
                w: o.footprint?.w ?? 1,
                d: o.footprint?.d ?? 1,
            }, duration, startAt);
        } else if (result.kind === 'terrain') {
            this.renderer.spawnAnim(`t-${result.gx},${result.gy}`, {
                gx: result.gx,
                gy: result.gy,
                w: 1,
                d: 1,
            }, duration, startAt);
        }
        return result;
    }

    /* ── Frame loop ───────────────────────────────────────────── */

    _loop(now) {
        const dt = Math.min(0.05, (now - this._lastFrameTime) / 1000);
        this._lastFrameTime = now;
        const p = this.player;
        if (p.moving) {
            p.animationTime += dt;
            const distance = Math.hypot(p.targetX - p.x, p.targetY - p.y);
            const step = p.speed * dt;
            if (distance <= step) {
                p.x = p.targetX;
                p.y = p.targetY;
                p.z = p.targetZ;
                p.moving = false;
            } else {
                p.x += (p.targetX - p.x) / distance * step;
                p.y += (p.targetY - p.y) / distance * step;
                p.z += (p.targetZ - p.z) * (step / distance);
            }
            this.renderer.markDirty();
        }
        // The renderer skips its own work when nothing has changed and
        // there are no animations running, so this loop is effectively
        // free at idle. We still keep `requestAnimationFrame` ticking so
        // we resume instantly when input or animations resume.
        this.renderer.draw();
        requestAnimationFrame(this._loop);
    }
}
