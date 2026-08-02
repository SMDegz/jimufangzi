/** Asset-local authoring for walk surfaces, doors, stairs and occlusion. */
import { ASSET_MANIFEST, CATEGORIES } from '../assets/assetManifest.js';
import { allAssets } from '../assets/assetLoader.js';
import { playUiClick } from './Audio.js';

const LABELS = { terrain: '地形', nature: '自然', props: '摆件', water: '水景', buildings: '建筑' };
const EDITABLE = CATEGORIES.filter(category => category !== 'terrain');
const DELTAS = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export class OcclusionEditor {
    constructor(game, root) {
        this.game = game; this.root = root;
        this.canvas = root.querySelector('#occlusion-canvas'); this.ctx = this.canvas.getContext('2d');
        this.tabs = root.querySelector('#occlusion-tabs'); this.grid = root.querySelector('#occlusion-grid');
        this.title = root.querySelector('#occlusion-title'); this.category = 'buildings'; this.assetId = null;
        this.mode = 'walk'; this.height = 0; this.edge = 'bottom'; this.points = []; this.profile = this._empty();
        this.imageRect = null; this.hover = null; this.lastCell = null;
        this._build();
    }
    _empty() { return { surfaces: {}, doors: [], masks: [] }; }
    _build() {
        for (const category of EDITABLE) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'occlusion-tab'; b.textContent = LABELS[category];
            b.addEventListener('click', () => { playUiClick(); this.category = category; this._renderPalette(); }); this.tabs.appendChild(b);
        }
        this.root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { this._finishMaskRegion(); this.mode = b.dataset.mode; this.points = []; this._syncMode(); this._paint(); }));
        this.root.querySelector('[data-action="height"]').addEventListener('change', e => { this.height = +e.target.value; });
        this.root.querySelector('[data-action="edge"]').addEventListener('change', e => { this.edge = e.target.value; });
        this.root.querySelector('[data-action="undo"]').addEventListener('click', () => this._undo());
        this.root.querySelector('[data-action="clear"]').addEventListener('click', () => this._clear());
        this.root.querySelector('[data-action="new-mask"]').addEventListener('click', () => this._beginNewMask());
        this.root.querySelector('[data-action="apply"]').addEventListener('click', () => this._apply());
        this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.close());
        this.canvas.addEventListener('pointerdown', e => this._add(e));
        this.canvas.addEventListener('pointermove', e => { this.hover = this._normalise(this._event(e)); this._paint(); });
        this.canvas.addEventListener('pointerleave', () => { this.hover = null; this._paint(); });
        window.addEventListener('resize', () => { if (this.isOpen()) this._resize(); });
    }
    isOpen() { return !this.root.classList.contains('hidden'); }
    open(assetId) { const def = ASSET_MANIFEST.find(a => a.id === assetId && a.kind === 'object') ?? ASSET_MANIFEST.find(a => a.id === 'villa') ?? ASSET_MANIFEST.find(a => a.kind === 'object'); if (!def) return; this.root.classList.remove('hidden'); this.selectAsset(def.id); this._resize(); }
    close() { this.root.classList.add('hidden'); this.hover = null; }
    selectAsset(id) {
        const def = ASSET_MANIFEST.find(a => a.id === id); if (!def) return;
        this.assetId = id; this.category = def.category; this.points = [];
        const old = this.game.navigationProfiles[id] ?? this._empty();
        this.profile = { surfaces: { ...(old.surfaces ?? {}) }, doors: [...(old.doors ?? [])], masks: (old.masks ?? []).map(r => r.map(p => ({ ...p }))) };
        this.title.textContent = `绘制建筑通行与遮罩：${def.name}`; this._syncMode(); this._renderPalette(); this._paint();
    }
    _syncMode() { this.root.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === this.mode)); }
    _renderPalette() {
        for (const tab of this.tabs.children) tab.classList.toggle('active', tab.textContent === LABELS[this.category]);
        this.grid.innerHTML = ''; const assets = allAssets();
        for (const def of ASSET_MANIFEST.filter(a => a.category === this.category && a.kind === 'object')) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'occlusion-swatch'; b.classList.toggle('selected', def.id === this.assetId);
            const a = assets[def.id]; if (a) { const c = document.createElement('canvas'); const s = Math.min(62 / a.width, 62 / a.height, 2); c.width = Math.max(1, Math.round(a.width * s)); c.height = Math.max(1, Math.round(a.height * s)); c.getContext('2d').drawImage(a.displayCanvas || a.canvas, 0, 0, c.width, c.height); b.appendChild(c); }
            const name = document.createElement('span'); name.textContent = def.name; b.appendChild(name); b.addEventListener('click', () => { playUiClick(); this.selectAsset(def.id); }); this.grid.appendChild(b);
        }
    }
    _resize() { const r = this.canvas.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); this.canvas.width = Math.max(1, Math.round(r.width * d)); this.canvas.height = Math.max(1, Math.round(r.height * d)); this.ctx.setTransform(d, 0, 0, d, 0, 0); this._paint(); }
    _event(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    _normalise(p) { const r = this.imageRect; if (!r || p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) return null; return { x: (p.x - r.x) / r.w, y: (p.y - r.y) / r.h }; }
    _cellAt(p) { const a = allAssets()[this.assetId], fp = a?.footprint; if (!p || !a || !fp) return null; let best = null, dBest = Infinity; for (let x = 0; x < fp.w; x++) for (let y = 0; y < fp.d; y++) { const q = this._cellCenter(x, y, a); const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < dBest) { dBest = d; best = [x, y]; } } return best; }
    _cellCenter(x, y, a) { return { x: (a.anchorX + (x - y) * 16) / a.width, y: (a.anchorY + (x + y) * 16 + 16) / a.height }; }
    _add(e) { const p = this._normalise(this._event(e)); if (!p) return; if (this.mode === 'mask') { this.points.push(p); this._paint(); return; } const cell = this._cellAt(p); if (!cell) return; const key = cell.join(','); this.lastCell = key; if (this.mode === 'walk' || this.mode === 'stairs') this.profile.surfaces[key] = this.mode === 'walk' ? 0 : this.height; else { const [dx, dy] = DELTAS[this.edge]; const outside = `${cell[0] + dx},${cell[1] + dy}`; this.profile.doors = this.profile.doors.filter(edge => !edge.includes(key)); this.profile.doors.push(`${outside}>${key}`, `${key}>${outside}`); } this._paint(); }
    _undo() { if (this.mode === 'mask') this.points.pop(); else if (this.lastCell) { delete this.profile.surfaces[this.lastCell]; this.profile.doors = this.profile.doors.filter(e => !e.includes(this.lastCell)); } this._paint(); }
    _clear() { if (this.mode === 'mask') this.points = []; else if (this.mode === 'door') this.profile.doors = []; else this.profile.surfaces = {}; this._paint(); }
    _finishMaskRegion() { if (this.mode === 'mask' && this.points.length >= 3) this.profile.masks.push(this.points.map(p => ({ ...p }))); this.points = []; }
    _beginNewMask() {
        if (this.mode === 'mask' && this.points.length > 0 && this.points.length < 3) {
            this.game.ui?.showToast('当前遮罩至少需要 3 个点；请补点或清空当前区域');
            return;
        }
        this._finishMaskRegion();
        this.mode = 'mask';
        this._syncMode();
        this._paint();
        this.game.ui?.showToast(`开始第 ${this.profile.masks.length + 1} 个遮罩区域`);
    }
    _apply() { this._finishMaskRegion(); this.game.setNavigationProfile(this.assetId, this.profile); this.close(); }
    _toCanvas(p) { return { x: this.imageRect.x + p.x * this.imageRect.w, y: this.imageRect.y + p.y * this.imageRect.h }; }
    _diamond(cell, a) { const c = this._cellCenter(cell[0], cell[1], a), sx = 16 / a.width * this.imageRect.w, sy = 16 / a.height * this.imageRect.h, q = this._toCanvas(c); return [[q.x, q.y - sy], [q.x + sx, q.y], [q.x, q.y + sy], [q.x - sx, q.y]]; }
    _paint() {
        const ctx = this.ctx, b = this.canvas.getBoundingClientRect(), w = b.width, h = b.height; ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#f5efe3'; ctx.fillRect(0, 0, w, h);
        const a = allAssets()[this.assetId]; if (!a) return; const s = Math.min((w - 64) / a.width, (h - 64) / a.height); this.imageRect = { x: (w - a.width * s) / 2, y: (h - a.height * s) / 2, w: a.width * s, h: a.height * s }; ctx.drawImage(a.displayCanvas || a.canvas, this.imageRect.x, this.imageRect.y, this.imageRect.w, this.imageRect.h);
        const diamond = (cell, fill, stroke) => { const pts = this._diamond(cell, a); ctx.beginPath(); ctx.moveTo(...pts[0]); for (let i = 1; i < 4; i++) ctx.lineTo(...pts[i]); ctx.closePath(); ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); };
        const fp = a.footprint ?? { w: 1, d: 1 }; for (let x = 0; x < fp.w; x++) for (let y = 0; y < fp.d; y++) diamond([x, y], 'rgba(255,255,255,.04)', 'rgba(27,91,168,.22)');
        for (const [key, z] of Object.entries(this.profile.surfaces)) { diamond(key.split(',').map(Number), z ? 'rgba(255,188,66,.32)' : 'rgba(47,201,166,.28)', z ? '#db8b00' : '#118f72'); }
        for (const edge of this.profile.doors) { const [, to] = edge.split('>'); if (!to || edge.indexOf('>') < 0) continue; const cell = to.split(',').map(Number); if (cell[0] < 0 || cell[1] < 0 || cell[0] >= fp.w || cell[1] >= fp.d) continue; const q = this._toCanvas(this._cellCenter(cell[0], cell[1], a)); ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.strokeStyle = '#1676d2'; ctx.lineWidth = 3; ctx.stroke(); }
        const drawMask = (points, color, fill) => { if (points.length < 2) return; const q = this._toCanvas(points[0]); ctx.beginPath(); ctx.moveTo(q.x, q.y); for (let i = 1; i < points.length; i++) { const p = this._toCanvas(points[i]); ctx.lineTo(p.x, p.y); } if (points.length >= 3) { ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke(); };
        for (const region of this.profile.masks) drawMask(region, '#7956d8', 'rgba(121,86,216,.20)');
        drawMask(this.points, '#f34d70', 'rgba(243,77,112,.22)');
    }
}
