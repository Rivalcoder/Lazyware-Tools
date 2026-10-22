/**
 * OmniStorage Pro - Interactive Treemap & Heatmap Engine
 * Features: Squarified Treemap layout, High-DPI Canvas, Hover Tooltips,
 * Breadcrumb Drilldown, Color Mode Switcher, and Sunburst Radial mode.
 */

class TreemapEngine {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) throw new Error(`Canvas #${canvasId} not found`);
    this.ctx = this.canvas.getContext('2d');
    
    this.rootData = null;
    this.currentNode = null;
    this.historyStack = [];
    this.renderedRects = []; // Array of { node, x, y, w, h }
    this.hoveredRect = null;
    this.selectedRect = null;

    // View options
    this.colorMode = 'category'; // 'category' | 'safety'
    this.viewMode = 'treemap';   // 'treemap' | 'sunburst'
    this.hideSystem = false;

    // Callbacks
    this.onSelectNode = options.onSelectNode || null;
    this.onBreadcrumbChange = options.onBreadcrumbChange || null;
    this.tooltipEl = document.getElementById('treemapTooltip');

    this.initEvents();
    this.resizeCanvas();
  }

  initEvents() {
    window.addEventListener('resize', () => {
      this.resizeCanvas();
      this.render();
    });

    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    this.canvas.addEventListener('click', (e) => this.handleClick(e));
  }

  resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);
  }

  setData(data) {
    this.rootData = data;
    this.currentNode = data;
    this.historyStack = [data];
    if (this.onBreadcrumbChange) {
      this.onBreadcrumbChange(this.historyStack);
    }
    this.render();
  }

  drillToNode(node) {
    if (!node || !node.children || node.children.length === 0) return;
    this.currentNode = node;
    this.historyStack.push(node);
    if (this.onBreadcrumbChange) {
      this.onBreadcrumbChange(this.historyStack);
    }
    this.render();
  }

  stepBack() {
    if (this.historyStack.length > 1) {
      this.historyStack.pop();
      this.currentNode = this.historyStack[this.historyStack.length - 1];
      if (this.onBreadcrumbChange) {
        this.onBreadcrumbChange(this.historyStack);
      }
      this.render();
    }
  }

  jumpToHistory(index) {
    if (index >= 0 && index < this.historyStack.length) {
      this.historyStack = this.historyStack.slice(0, index + 1);
      this.currentNode = this.historyStack[this.historyStack.length - 1];
      if (this.onBreadcrumbChange) {
        this.onBreadcrumbChange(this.historyStack);
      }
      this.render();
    }
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.render();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.render();
  }

  setHideSystem(hide) {
    this.hideSystem = hide;
    this.render();
  }

  // Helper: Format bytes
  formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Get color for node based on mode
  getNodeColor(node) {
    if (this.colorMode === 'safety') {
      if (node.safety === 'protected') return '#f43f5e'; // Red
      if (node.safety === 'safe') return '#10b981';      // Emerald
      if (node.safety === 'review') return '#f59e0b';    // Amber
      return '#38bdf8';                                  // Cyan (User data)
    }

    // Category based
    const cat = node.category || 'other';
    const colors = {
      system: '#f43f5e',
      media: '#f59e0b',
      dev: '#06b6d4',
      apps: '#a855f7',
      cache: '#10b981',
      documents: '#3b82f6',
      archives: '#ec4899',
      other: '#64748b'
    };
    return colors[cat] || '#64748b';
  }

  render() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.renderedRects = [];

    if (!this.currentNode) return;

    if (this.viewMode === 'sunburst') {
      this.renderSunburst();
    } else {
      this.renderTreemap();
    }
  }

  // ================= Squarified Treemap Algorithm =================
  renderTreemap() {
    if (!this.currentNode) return;

    let children = this.currentNode.children || [];
    if (this.hideSystem) {
      children = children.filter(c => c.safety !== 'protected');
    }

    if (children.length === 0) {
      // Draw single block representing current node
      this.drawBlock({
        node: this.currentNode,
        x: 0,
        y: 0,
        w: this.width,
        h: this.height
      });
      return;
    }

    // Filter valid positive size children
    const totalSize = children.reduce((sum, c) => sum + (c.size || 1), 0);
    const sorted = [...children].sort((a, b) => (b.size || 0) - (a.size || 0));

    // Normalize sizes to canvas area
    const totalArea = this.width * this.height;
    const items = sorted.map(node => ({
      node,
      value: ((node.size || 1) / totalSize) * totalArea
    }));

    this.squarify(items, [], { x: 0, y: 0, w: this.width, h: this.height });

    // Highlight hovered or selected
    if (this.hoveredRect) {
      this.drawHoverOutline(this.hoveredRect);
    }
  }

  squarify(children, row, rect) {
    if (children.length === 0) {
      this.layoutRow(row, rect);
      return;
    }

    const c = children[0];
    const newRow = [...row, c];

    if (row.length === 0 || this.worstAspectRatio(row, rect) >= this.worstAspectRatio(newRow, rect)) {
      this.squarify(children.slice(1), newRow, rect);
    } else {
      const remainingRect = this.layoutRow(row, rect);
      this.squarify(children, [], remainingRect);
    }
  }

  worstAspectRatio(row, rect) {
    if (row.length === 0) return Infinity;
    const rowArea = row.reduce((sum, item) => sum + item.value, 0);
    const side = Math.min(rect.w, rect.h);
    if (side === 0 || rowArea === 0) return Infinity;

    let maxAspect = 0;
    const rowLength = rowArea / side;

    for (const item of row) {
      const itemLen = item.value / rowLength;
      const aspect = Math.max(itemLen / rowLength, rowLength / itemLen);
      if (aspect > maxAspect) maxAspect = aspect;
    }
    return maxAspect;
  }

  layoutRow(row, rect) {
    if (row.length === 0) return rect;
    const rowArea = row.reduce((sum, item) => sum + item.value, 0);
    const isHorizontal = rect.w >= rect.h;
    const side = isHorizontal ? rect.h : rect.w;
    const rowThickness = side > 0 ? rowArea / side : 0;

    let offset = 0;
    for (const item of row) {
      const itemLen = rowThickness > 0 ? item.value / rowThickness : 0;
      let x, y, w, h;

      if (isHorizontal) {
        x = rect.x;
        y = rect.y + offset;
        w = rowThickness;
        h = itemLen;
        offset += itemLen;
      } else {
        x = rect.x + offset;
        y = rect.y;
        w = itemLen;
        h = rowThickness;
        offset += itemLen;
      }

      this.drawBlock({ node: item.node, x, y, w, h });
    }

    if (isHorizontal) {
      return {
        x: rect.x + rowThickness,
        y: rect.y,
        w: Math.max(0, rect.w - rowThickness),
        h: rect.h
      };
    } else {
      return {
        x: rect.x,
        y: rect.y + rowThickness,
        w: rect.w,
        h: Math.max(0, rect.h - rowThickness)
      };
    }
  }

  drawBlock(rect) {
    const { node, x, y, w, h } = rect;
    if (w < 1 || h < 1) return;

    this.renderedRects.push(rect);

    const baseColor = this.getNodeColor(node);
    
    // Fill block
    this.ctx.fillStyle = baseColor;
    this.ctx.fillRect(x, y, w, h);

    // Subtle 3D Glass / Shading
    const grad = this.ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.25)');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(x, y, w, h);

    // Dark sleek border
    this.ctx.strokeStyle = 'rgba(8, 12, 22, 0.7)';
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeRect(x, y, w, h);

    // Render Text Labels if there's enough space
    if (w > 50 && h > 28) {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(x + 4, y + 4, w - 8, h - 8);
      this.ctx.clip();

      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '600 11px Outfit, sans-serif';
      this.ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      this.ctx.shadowBlur = 4;
      this.ctx.fillText(node.name, x + 6, y + 16);

      if (h > 46 && w > 60) {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        this.ctx.font = '500 10px JetBrains Mono, monospace';
        const sizeStr = this.formatBytes(node.size);
        this.ctx.fillText(sizeStr, x + 6, y + 32);
      }

      this.ctx.restore();
    }
  }

  drawHoverOutline(rect) {
    const { x, y, w, h } = rect;
    this.ctx.save();
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2.5;
    this.ctx.shadowColor = '#38bdf8';
    this.ctx.shadowBlur = 12;
    this.ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    this.ctx.restore();
  }

  // ================= Sunburst Radial Mode =================
  renderSunburst() {
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    const maxRadius = Math.min(centerX, centerY) - 20;

    let children = this.currentNode.children || [];
    if (this.hideSystem) {
      children = children.filter(c => c.safety !== 'protected');
    }

    if (children.length === 0) return;

    const totalSize = children.reduce((acc, c) => acc + (c.size || 1), 0);
    const innerRadius = maxRadius * 0.3;
    const outerRadius = maxRadius * 0.85;

    // Draw central node circle
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, innerRadius - 8, 0, Math.PI * 2);
    this.ctx.fillStyle = '#1e293b';
    this.ctx.fill();
    this.ctx.strokeStyle = '#38bdf8';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    this.ctx.fillStyle = '#f8fafc';
    this.ctx.font = '700 13px Outfit';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(this.currentNode.name, centerX, centerY - 8);
    this.ctx.fillStyle = '#94a3b8';
    this.ctx.font = '500 11px JetBrains Mono';
    this.ctx.fillText(this.formatBytes(this.currentNode.size), centerX, centerY + 12);

    let currentAngle = 0;
    for (const child of children) {
      const sliceAngle = ((child.size || 1) / totalSize) * (Math.PI * 2);
      const endAngle = currentAngle + sliceAngle;

      this.ctx.beginPath();
      this.ctx.arc(centerX, centerY, outerRadius, currentAngle, endAngle);
      this.ctx.arc(centerX, centerY, innerRadius, endAngle, currentAngle, true);
      this.ctx.closePath();

      const color = this.getNodeColor(child);
      this.ctx.fillStyle = color;
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(8, 12, 22, 0.8)';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();

      currentAngle = endAngle;
    }
  }

  // ================= Interaction Handlers =================
  handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Find block
    let found = null;
    for (let i = this.renderedRects.length - 1; i >= 0; i--) {
      const r = this.renderedRects[i];
      if (mouseX >= r.x && mouseX <= r.x + r.w && mouseY >= r.y && mouseY <= r.y + r.h) {
        found = r;
        break;
      }
    }

    if (found !== this.hoveredRect) {
      this.hoveredRect = found;
      this.render();
    }

    if (found) {
      this.showTooltip(found, e.clientX, e.clientY);
      this.canvas.style.cursor = found.node.type === 'directory' ? 'pointer' : 'default';
    } else {
      this.hideTooltip();
      this.canvas.style.cursor = 'default';
    }
  }

  handleMouseLeave() {
    this.hoveredRect = null;
    this.hideTooltip();
    this.render();
  }

  handleClick(e) {
    if (this.hoveredRect) {
      const node = this.hoveredRect.node;
      this.selectedRect = this.hoveredRect;
      if (this.onSelectNode) {
        this.onSelectNode(node);
      }
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        this.drillToNode(node);
      }
    }
  }

  showTooltip(rectItem, clientX, clientY) {
    if (!this.tooltipEl) return;
    const node = rectItem.node;
    const parentSize = this.currentNode.size || 1;
    const pctOfParent = ((node.size / parentSize) * 100).toFixed(1);

    const titleEl = this.tooltipEl.querySelector('.tooltip-title');
    const catEl = this.tooltipEl.querySelector('.tooltip-category-pill');
    const sizeEl = this.tooltipEl.querySelector('.tooltip-size');
    const pctEl = this.tooltipEl.querySelector('.tooltip-pct');
    const pathEl = this.tooltipEl.querySelector('.tooltip-path');
    const hintEl = this.tooltipEl.querySelector('.tooltip-hint');

    if (titleEl) titleEl.textContent = node.name;
    if (sizeEl) sizeEl.textContent = this.formatBytes(node.size);
    if (pctEl) pctEl.textContent = `(${pctOfParent}% of current folder)`;
    if (pathEl) pathEl.textContent = node.path || node.name;

    if (catEl) {
      const catText = node.category || 'other';
      catEl.textContent = catText;
      catEl.style.backgroundColor = `${this.getNodeColor(node)}33`;
      catEl.style.color = this.getNodeColor(node);
    }

    if (hintEl) {
      if (node.safety === 'protected') {
        hintEl.innerHTML = `<span style="color:#f43f5e">🛡️ Protected Windows System File</span>`;
      } else if (node.name && node.name.toLowerCase() === 'node_modules') {
        hintEl.innerHTML = `<span style="color:#06b6d4">📦 node_modules • ${(node.fileCount || 0).toLocaleString()} files • Restorable via npm i</span>`;
      } else if (node.isArtifact) {
        hintEl.innerHTML = `<span style="color:#38bdf8">⚡ Build Output Cache • ${(node.fileCount || 0).toLocaleString()} files • Restorable via build</span>`;
      } else if (node.type === 'directory') {
        hintEl.innerHTML = `<span>👆 Click to explore folder contents</span>`;
      } else {
        hintEl.innerHTML = `<span style="color:#94a3b8">📄 File</span>`;
      }
    }

    // Position tooltip relative to container
    const containerRect = this.canvas.parentElement.getBoundingClientRect();
    const relX = clientX - containerRect.left;
    const relY = clientY - containerRect.top;

    this.tooltipEl.style.left = `${relX}px`;
    this.tooltipEl.style.top = `${relY}px`;
    this.tooltipEl.classList.add('visible');
  }

  hideTooltip() {
    if (this.tooltipEl) {
      this.tooltipEl.classList.remove('visible');
    }
  }
}

// Export for app.js
window.TreemapEngine = TreemapEngine;
