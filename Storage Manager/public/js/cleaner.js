/**
 * OmniStorage Pro - Cleaner & Reclaim Center Manager
 * Handles audit presentation, item selection, safe execution, terminal logs,
 * and clear separation of Protected Windows System Files.
 */

class CleanerManager {
  constructor(options = {}) {
    this.auditData = null;
    this.selectedKeys = new Set();
    this.onRefreshRequired = options.onRefreshRequired || null;
    this.terminalEl = document.getElementById('terminalLogs');

    this.initEvents();
  }

  initEvents() {
    // 1-Click Clean Button
    const heroCleanBtn = document.getElementById('btnPrimaryClean');
    if (heroCleanBtn) {
      heroCleanBtn.addEventListener('click', () => this.executeCleanup());
    }

    // Select all safe button
    const selectAllSafeBtn = document.getElementById('btnSelectAllSafe');
    if (selectAllSafeBtn) {
      selectAllSafeBtn.addEventListener('click', () => this.toggleAllSafe(true));
    }

    const deselectAllSafeBtn = document.getElementById('btnDeselectAllSafe');
    if (deselectAllSafeBtn) {
      deselectAllSafeBtn.addEventListener('click', () => this.toggleAllSafe(false));
    }
  }

  setAuditData(audit) {
    this.auditData = audit;
    this.selectedKeys.clear();

    // Pre-select safe items with positive size
    if (audit.safe) {
      for (const item of audit.safe) {
        if (item.checked && item.sizeBytes > 0) {
          this.selectedKeys.add(item.key);
        }
      }
    }

    this.render();
    this.updateReclaimSummary();
  }

  render() {
    if (!this.auditData) return;

    this.renderSafeZone();
    this.renderReviewZone();
    this.renderProtectedZone();
    this.updateReclaimSummary();
  }

  // Render Safe Zone (Green)
  renderSafeZone() {
    const listEl = document.getElementById('safeTargetsList');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const item of (this.auditData.safe || [])) {
      const card = document.createElement('div');
      card.className = `target-card ${this.selectedKeys.has(item.key) ? 'selected' : ''}`;
      card.id = `target-${item.key}`;

      card.innerHTML = `
        <div class="target-card-top">
          <div class="custom-checkbox-wrap">
            <input type="checkbox" id="chk-${item.key}" class="custom-checkbox" 
                   ${this.selectedKeys.has(item.key) ? 'checked' : ''} 
                   ${item.sizeBytes === 0 ? 'disabled' : ''}>
          </div>
          <div class="target-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
            </svg>
          </div>
          <div class="target-details">
            <h4>${item.name}</h4>
            <p>${item.description}</p>
            <div class="target-path-pill">${item.path}</div>
          </div>
        </div>
        <div class="target-card-bottom">
          <div>
            <div class="target-size" style="color: var(--accent-emerald)">${item.sizeFormatted}</div>
            <div class="target-files-count">${item.fileCount || 0} items identified</div>
          </div>
          <button class="btn-clean-single" data-key="${item.key}" ${item.sizeBytes === 0 ? 'disabled' : ''}>
            Clean
          </button>
        </div>
      `;

      // Checkbox listener
      const chk = card.querySelector(`#chk-${item.key}`);
      if (chk) {
        chk.addEventListener('change', (e) => {
          if (e.target.checked) {
            this.selectedKeys.add(item.key);
            card.classList.add('selected');
          } else {
            this.selectedKeys.delete(item.key);
            card.classList.remove('selected');
          }
          this.updateReclaimSummary();
        });
      }

      // Single clean button
      const cleanBtn = card.querySelector('.btn-clean-single');
      if (cleanBtn) {
        cleanBtn.addEventListener('click', () => this.executeCleanup([item.key]));
      }

      listEl.appendChild(card);
    }
  }

  // Render Review Zone (Amber)
  renderReviewZone() {
    const listEl = document.getElementById('reviewTargetsList');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const item of (this.auditData.review || [])) {
      const card = document.createElement('div');
      card.className = `target-card ${this.selectedKeys.has(item.key) ? 'selected' : ''}`;
      card.id = `target-${item.key}`;

      card.innerHTML = `
        <div class="target-card-top">
          <div class="custom-checkbox-wrap">
            <input type="checkbox" id="chk-${item.key}" class="custom-checkbox" 
                   ${this.selectedKeys.has(item.key) ? 'checked' : ''} 
                   ${item.sizeBytes === 0 ? 'disabled' : ''}>
          </div>
          <div class="target-icon" style="color: var(--accent-amber); border-color: rgba(245, 158, 11, 0.3);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
          </div>
          <div class="target-details">
            <h4>${item.name}</h4>
            <p>${item.description}</p>
            <div class="target-path-pill">${item.path}</div>
          </div>
        </div>
        <div class="target-card-bottom">
          <div>
            <div class="target-size" style="color: var(--accent-amber)">${item.sizeFormatted}</div>
            <div class="target-files-count">${item.fileCount || 0} candidate items</div>
          </div>
          <button class="btn-clean-single" data-key="${item.key}" ${item.sizeBytes === 0 ? 'disabled' : ''}>
            Clean
          </button>
        </div>
      `;

      const chk = card.querySelector(`#chk-${item.key}`);
      if (chk) {
        chk.addEventListener('change', (e) => {
          if (e.target.checked) {
            this.selectedKeys.add(item.key);
            card.classList.add('selected');
          } else {
            this.selectedKeys.delete(item.key);
            card.classList.remove('selected');
          }
          this.updateReclaimSummary();
        });
      }

      const cleanBtn = card.querySelector('.btn-clean-single');
      if (cleanBtn) {
        cleanBtn.addEventListener('click', () => this.executeCleanup([item.key]));
      }

      listEl.appendChild(card);
    }
  }

  // Render Protected Zone (Red / Locked)
  renderProtectedZone() {
    const listEl = document.getElementById('protectedTargetsList');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const item of (this.auditData.protected || [])) {
      const card = document.createElement('div');
      card.className = 'target-card protected-card';
      card.id = `protected-${item.key}`;

      card.innerHTML = `
        <div class="target-card-top">
          <div class="target-icon" style="color: var(--accent-rose); border-color: rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.1);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
              <rect x="9" y="8" width="6" height="6" rx="1"></rect>
            </svg>
          </div>
          <div class="target-details">
            <h4 style="color: #fca5a5;">${item.name}</h4>
            <p>${item.description}</p>
            <div style="font-size: 0.75rem; color: #fda4af; margin-top: 0.35rem; display: flex; align-items: center; gap: 0.35rem;">
              <strong>Why Protected:</strong> ${item.reason}
            </div>
            <div class="target-path-pill">${item.path}</div>
          </div>
        </div>
        <div class="target-card-bottom">
          <div>
            <div class="target-size" style="color: var(--accent-rose)">${item.sizeFormatted}</div>
            <div class="target-files-count">Windows System Core</div>
          </div>
          <div class="protected-lock-indicator">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            LOCKED & SAFEGUARDED
          </div>
        </div>
      `;

      listEl.appendChild(card);
    }
  }

  toggleAllSafe(enable) {
    if (!this.auditData || !this.auditData.safe) return;
    for (const item of this.auditData.safe) {
      if (item.sizeBytes > 0) {
        if (enable) this.selectedKeys.add(item.key);
        else this.selectedKeys.delete(item.key);
      }
    }
    this.render();
  }

  updateReclaimSummary() {
    let totalBytes = 0;
    const allItems = [...(this.auditData?.safe || []), ...(this.auditData?.review || [])];
    
    for (const item of allItems) {
      if (this.selectedKeys.has(item.key)) {
        totalBytes += (item.sizeBytes || 0);
      }
    }

    const formatted = this.formatBytes(totalBytes);

    // Update banner badge
    const bannerHighlight = document.getElementById('heroReclaimSize');
    if (bannerHighlight) {
      bannerHighlight.textContent = formatted;
    }

    // Update top header reclaim pill
    const topPill = document.getElementById('headerReclaimSize');
    if (topPill) {
      topPill.textContent = formatted;
    }

    // Update Primary clean button
    const btn = document.getElementById('btnPrimaryClean');
    if (btn) {
      btn.disabled = this.selectedKeys.size === 0;
      btn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Reclaim ${formatted} Now
      `;
    }
  }

  async executeCleanup(customKeys = null) {
    const keysToClean = customKeys || Array.from(this.selectedKeys);
    if (keysToClean.length === 0) return;

    this.log(`Initiating safe cleanup for [${keysToClean.join(', ')}]...`, 'info');

    const heroBtn = document.getElementById('btnPrimaryClean');
    if (heroBtn) {
      heroBtn.disabled = true;
      heroBtn.textContent = 'Purging safe files...';
    }

    try {
      const resp = await fetch('/api/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKeys: keysToClean })
      });

      const res = await resp.json();
      if (res.success) {
        this.log(`Cleanup completed! Successfully freed ${res.totalFreedFormatted} (${res.totalFreedFiles} files removed).`, 'success');

        if (window.showToast) {
          window.showToast(`Cleaned ${res.totalFreedFormatted} of junk!`, 'success');
        }

        // Trigger parent refresh to reload drives and audit
        if (this.onRefreshRequired) {
          this.onRefreshRequired();
        }
      } else {
        this.log(`Cleanup error: ${res.error}`, 'error');
        if (window.showToast) {
          window.showToast(`Cleanup error: ${res.error}`, 'error');
        }
      }
    } catch (err) {
      this.log(`Network/Execution error: ${err.message}`, 'error');
    } finally {
      if (heroBtn) {
        heroBtn.disabled = false;
        this.updateReclaimSummary();
      }
    }
  }

  log(msg, type = 'info') {
    if (!this.terminalEl) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <span class="log-time">[${time}]</span>
      <span class="log-${type}">${msg}</span>
    `;
    this.terminalEl.appendChild(entry);
    this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
  }

  formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

window.CleanerManager = CleanerManager;
