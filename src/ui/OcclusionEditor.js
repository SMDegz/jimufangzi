/** Dedicated asset-canvas editor for foreground occlusion profiles. */

import { ASSET_MANIFEST, CATEGORIES } from '../assets/assetManifest.js';
import { allAssets } from '../assets/assetLoader.js';
import { playUiClick } from './Audio.js';

const LABELS = { terrain: '地形', nature: '自然', props: '摆件', water: '水景', buildings: '建筑' };
const OCCLUDABLE_CATEGORIES = CATEGORIES.filter(category => category !== 'terrain');

export class OcclusionEditor {
    constructor(game, root) {
        this.game = game;
        this.root = root;
        this.canvas = root.querySelector('#occlusion-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.tabs = root.querySelector('#occlusion-tabs');
        this.grid = root.querySelector('#occlusion-grid');
        this.title = root.querySelector('#occlusion-title');
        this.category = 'props';
        this.assetId = null;
        this.points = [];
        this.hover = null;
        this.imageRect = null;
        this._build();
    }

    _build() {
        for (const category of OCCLUDABLE_CATEGORIES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'occlusion-tab';
            button.textContent = LABELS[category] ?? category;
            button.addEventListener('click', () => {
                playUiClick();
                this.category = category;
                this._renderPalette();
            });
            this.tabs.appendChild(button);
        }
        this.root.querySelector('[data-action="undo"]').addEventListener('click', () => { this.points.pop(); this._paint(); });
        this.root.querySelector('[data-action="clear"]').addEventListener('click', () => { this.points = []; this._paint(); });
        this.root.querySelector('[data-action="apply"]').addEventListener('click', () => {
            if (this.points.length === 0) {
                this.game.removeOcclusionProfile(this.assetId);
                return this.close();
            }
            if (this.points.length < 3) return this.game.ui?.showToast('请至少绘制三个轮廓点');
            this.game.setOcclusionProfile(this.assetId, this.points);
            this.close();
        });
        this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.close());
        this.canvas.addEventListener('pointerdown', e => this._addPoint(e));
        this.canvas.addEventListener('pointermove', e => this._movePointer(e));
        this.canvas.addEventListener('pointerleave', () => { this.hover = null; this._paint(); });
        window.addEventListener('resize', () => { if (this.isOpen()) this._resizeAndPaint(); });
    }

    isOpen() { return !this.root.classList.contains('hidden'); }

    open(assetId) {
        const def = ASSET_MANIFEST.find(a => a.id === assetId && a.kind === 'object')
            ?? ASSET_MANIFEST.find(a => a.kind === 'object');
        if (!def) return;
        this.root.classList.remove('hidden');
        this.selectAsset(def.id);
        this._resizeAndPaint();
    }

    close() { this.root.classList.add('hidden'); this.hover = null; }

    selectAsset(assetId) {
        const def = ASSET_MANIFEST.find(a => a.id === assetId);
        if (!def) return;
        this.assetId = assetId;
        this.category = def.category;
        this.points = (this.game.occlusionProfiles[assetId]?.points ?? []).map(p => ({ ...p }));
        this.title.textContent = `编辑前景遮挡：${def.name}`;
        this._renderPalette();
        this._paint();
    }

    _renderPalette() {
        for (const tab of this.tabs.children) tab.classList.toggle('active', tab.textContent === LABELS[this.category]);
        this.grid.innerHTML = '';
        const assets = allAssets();
        for (const def of ASSET_MANIFEST.filter(a => a.category === this.category && a.kind === 'object')) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'occlusion-swatch';
            button.classList.toggle('selected', def.id === this.assetId);
            const asset = assets[def.id];
            if (asset) {
                const thumb = document.createElement('canvas');
                const scale = Math.min(62 / asset.width, 62 / asset.height, 2);
                thumb.width = Math.max(1, Math.round(asset.width * scale));
                thumb.height = Math.max(1, Math.round(asset.height * scale));
                thumb.getContext('2d').drawImage(asset.displayCanvas || asset.canvas, 0, 0, thumb.width, thumb.height);
                button.appendChild(thumb);
            }
            const name = document.createElement('span');
            name.textContent = def.name;
            button.appendChild(name);
            button.addEventListener('click', () => { playUiClick(); this.selectAsset(def.id); });
            this.grid.appendChild(button);
        }
    }

    _resizeAndPaint() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._paint();
    }

    _eventPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    _normalise(point) {
        const r = this.imageRect;
        if (!r || point.x < r.x || point.x > r.x + r.w || point.y < r.y || point.y > r.y + r.h) return null;
        return { x: (point.x - r.x) / r.w, y: (point.y - r.y) / r.h };
    }

    _addPoint(event) {
        const point = this._normalise(this._eventPoint(event));
        if (!point) return;
        this.points.push(point);
        this._paint();
    }

    _movePointer(event) { this.hover = this._normalise(this._eventPoint(event)); this._paint(); }

    _paint() {
        const ctx = this.ctx;
        const bounds = this.canvas.getBoundingClientRect();
        const w = bounds.width, h = bounds.height;
        ctx.clearRect(0, 0, w, h);
        const tile = 18;
        for (let y = 0; y < h; y += tile) for (let x = 0; x < w; x += tile) {
            ctx.fillStyle = ((x / tile + y / tile) & 1) ? '#eee5d4' : '#fbf6ec';
            ctx.fillRect(x, y, tile, tile);
        }
        const asset = allAssets()[this.assetId];
        if (!asset) return;
        const scale = Math.min((w - 64) / asset.width, (h - 64) / asset.height);
        const imageW = asset.width * scale, imageH = asset.height * scale;
        this.imageRect = { x: (w - imageW) / 2, y: (h - imageH) / 2, w: imageW, h: imageH };
        ctx.drawImage(asset.displayCanvas || asset.canvas, this.imageRect.x, this.imageRect.y, imageW, imageH);
        const toCanvas = p => ({ x: this.imageRect.x + p.x * imageW, y: this.imageRect.y + p.y * imageH });
        if (!this.points.length) return;
        const first = toCanvas(this.points[0]);
        ctx.beginPath(); ctx.moveTo(first.x, first.y);
        for (let i = 1; i < this.points.length; i++) { const p = toCanvas(this.points[i]); ctx.lineTo(p.x, p.y); }
        if (this.hover) { const p = toCanvas(this.hover); ctx.lineTo(p.x, p.y); }
        if (this.points.length >= 3) { ctx.closePath(); ctx.fillStyle = 'rgba(229, 70, 70, 0.24)'; ctx.fill(); }
        ctx.strokeStyle = '#df3f3f'; ctx.lineWidth = 3; ctx.stroke();
        for (const point of this.points) {
            const p = toCanvas(point);
            ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#df3f3f'; ctx.fill(); ctx.strokeStyle = '#fff8e8'; ctx.lineWidth = 1.5; ctx.stroke();
        }
    }
}
