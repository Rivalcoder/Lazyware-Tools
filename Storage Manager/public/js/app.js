/**
 * OmniStorage Pro - Main Application Orchestrator
 */

document.addEventListener('DOMContentLoaded', () => {
  // Global App State
  const state = {
    overview: null,
    activeDrive: null,
    scanData: null,
    currentPath: null,
    activeTab: 'heatmap',
    theme: 'dark',
    includeSystemInScan: true,
    fileFilter: 'all',
    searchQuery: '',
    devData: null,
    selectedDevPaths: new Set(),
    devFilter: 'all',
    devSearch: ''
  };

  // Instantiate Sub-Systems
  const treemap = new TreemapEngine('treemapCanvas', {
    onSelectNode: (node) => handleNodeSelect(node),
    onBreadcrumbChange: (stack) => renderBreadcrumbs(stack)
  });

  const cleaner = new CleanerManager({
    onRefreshRequired: () => refreshAllData()
  });

  // ================= Initialize App =================
  initTheme();
  initTabs();
  initToolbarControls();
  initLeaderboardFilters();
  initDevHunterEvents();
  refreshAllData();

  // ================= Data Loading =================
  async function refreshAllData() {
    // 1. Instant load system overview & drives (<100ms)
    await loadSystemOverview();

    // 2. Default to CodeStuffs workspace or user directory
    const defaultPath = state.currentPath || state.overview?.userFolders?.codeStuffs || 'C:\\CodeStuffs';
    
    // Set scope selector value
    const scopeSelect = document.getElementById('scopeSelector');
    if (scopeSelect) scopeSelect.value = defaultPath;

    // 3. Parallel non-blocking execution
    loadCleanupAudit();
    loadDevArtifacts();
    triggerScan(defaultPath);
  }

  // 1. Fetch System Overview & Drives
  async function loadSystemOverview() {
    try {
      const res = await fetch('/api/system-overview');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      state.overview = data;

      // Update Laptop Specs Pill
      const sysPill = document.getElementById('systemPillText');
      if (sysPill) {
        sysPill.textContent = `${data.hostname} • ${data.platform} • ${data.totalRam} RAM`;
      }

      // Update Total Storage Summary
      const totalStorageNum = document.getElementById('totalStorageNum');
      const totalStorageSub = document.getElementById('totalStorageSub');
      if (totalStorageNum && data.totalStorage) {
        totalStorageNum.textContent = data.totalStorage.usedFormatted;
        totalStorageSub.textContent = `Used of ${data.totalStorage.totalFormatted} (${data.totalStorage.usedPct}% Total Capacity Across All Drives)`;
      }

      // Render Drive Cards Deck
      renderDriveCards(data.drives);

      // Populate Scope Selector Dropdown
      populateScopeDropdown(data);
    } catch (err) {
      showToast(`Error fetching system info: ${err.message}`, 'error');
    }
  }

  // 2. Fetch Cleanup Audit
  async function loadCleanupAudit() {
    try {
      const res = await fetch('/api/cleanup-audit');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      cleaner.setAuditData(data.audit);
    } catch (err) {
      console.error('Error auditing junk files:', err);
    }
  }

  // 3. Trigger Drive / Folder Scan with Live Elapsed Stopwatch
  async function triggerScan(targetPath) {
    state.currentPath = targetPath;
    const loader = document.getElementById('treemapLoader');
    const scanPathLabel = document.getElementById('loaderPath');
    
    let startTime = Date.now();
    let scanInterval = null;

    if (loader) {
      loader.classList.add('active');
      if (scanPathLabel) scanPathLabel.textContent = `Scanning: ${targetPath} (0.0s elapsed)`;
      scanInterval = setInterval(() => {
        const sec = ((Date.now() - startTime) / 1000).toFixed(1);
        if (scanPathLabel) scanPathLabel.textContent = `Scanning: ${targetPath} (${sec}s elapsed)...`;
      }, 100);
    }

    try {
      const url = `/api/scan?path=${encodeURIComponent(targetPath)}&depth=2&includeSystem=${state.includeSystemInScan}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      state.scanData = data;
      treemap.setData(data.tree);

      // Render Largest Files Leaderboard
      renderLargestFilesTable(data.largestFiles || []);

      // Update inspector with root node
      handleNodeSelect(data.tree);
    } catch (err) {
      showToast(`Scan error: ${err.message}`, 'error');
    } finally {
      if (scanInterval) clearInterval(scanInterval);
      if (loader) loader.classList.remove('active');
    }
  }

  // ================= UI Component Renderers =================

  // Render Drive Cards
  function renderDriveCards(drives) {
    const deck = document.getElementById('drivesDeck');
    if (!deck || !drives) return;
    deck.innerHTML = '';

    drives.forEach((drive, idx) => {
      if (idx === 0 && !state.activeDrive) state.activeDrive = drive;

      const card = document.createElement('div');
      card.className = `drive-card ${state.activeDrive?.id === drive.id ? 'active' : ''}`;
      card.id = `drive-card-${drive.id.replace(':', '')}`;

      const pct = drive.usedPercentage;
      const progressClass = pct > 85 ? 'danger' : (pct > 70 ? 'warning' : '');

      card.innerHTML = `
        <div class="drive-card-header">
          <div class="drive-badge-group">
            <div class="drive-icon-wrap">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                <line x1="6" y1="6" x2="6.01" y2="6"></line>
                <line x1="6" y1="18" x2="6.01" y2="18"></line>
              </svg>
            </div>
            <div class="drive-info">
              <h3>${drive.id} (${drive.name}) ${drive.isSystem ? '<span class="pro-badge">SYSTEM OS</span>' : ''}</h3>
              <span class="drive-type-tag">${drive.fileSystem} File System</span>
            </div>
          </div>
          <div class="stat-value" style="font-size: 1.25rem;">${pct}%</div>
        </div>

        <div class="drive-stats-grid">
          <div class="drive-stat-box">
            <div class="stat-label">Used Space</div>
            <div class="stat-value">${drive.usedFormatted}</div>
          </div>
          <div class="drive-stat-box">
            <div class="stat-label">Free Space</div>
            <div class="stat-value" style="color: var(--accent-emerald);">${drive.freeFormatted}</div>
          </div>
        </div>

        <div class="drive-progress-wrap">
          <div class="progress-header">
            <span>Total: ${drive.totalFormatted}</span>
            <span>${drive.freeFormatted} Available</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill ${progressClass}" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.drive-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        state.activeDrive = drive;

        // Switch scope selector to this drive & trigger scan
        const scopeSelect = document.getElementById('scopeSelector');
        if (scopeSelect) scopeSelect.value = drive.path;
        triggerScan(drive.path);
      });

      deck.appendChild(card);
    });
  }

  // Populate Scope Selector Dropdown
  function populateScopeDropdown(overview) {
    const select = document.getElementById('scopeSelector');
    if (!select || !overview) return;
    select.innerHTML = '';

    // Add Drives
    const drivesGroup = document.createElement('optgroup');
    drivesGroup.label = 'Physical / Logical Drives';
    overview.drives.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.path;
      opt.textContent = `Drive ${d.id} (${d.name}) - ${d.totalFormatted}`;
      if (d.isSystem) opt.selected = true;
      drivesGroup.appendChild(opt);
    });
    select.appendChild(drivesGroup);

    // Add User Key Folders & CodeStuffs
    const userGroup = document.createElement('optgroup');
    userGroup.label = 'Workspaces, Media & User Folders';

    const uf = overview.userFolders;
    const folderPairs = [
      { name: '💻 CodeStuffs Workspace', path: uf.codeStuffs || 'C:\\CodeStuffs' },
      { name: '📱 Mobile Builds Folder', path: uf.mobileBuilds || 'C:\\CodeStuffs\\Mobile Builds' },
      { name: 'User Profile Home', path: uf.home },
      { name: 'Downloads Folder', path: uf.downloads },
      { name: 'Documents Folder', path: uf.documents },
      { name: 'Videos Folder', path: uf.videos },
      { name: 'Pictures Folder', path: uf.pictures },
      { name: 'Desktop Folder', path: uf.desktop }
    ];

    folderPairs.forEach(f => {
      if (f.path) {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = `${f.name} (${f.path})`;
        userGroup.appendChild(opt);
      }
    });
    select.appendChild(userGroup);

    select.addEventListener('change', (e) => {
      triggerScan(e.target.value);
    });
  }

  // Breadcrumbs Trail
  function renderBreadcrumbs(stack) {
    const trailEl = document.getElementById('breadcrumbTrail');
    if (!trailEl) return;
    trailEl.innerHTML = '';

    if (stack.length > 1) {
      const backBtn = document.createElement('button');
      backBtn.className = 'btn-breadcrumb-back';
      backBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        Back
      `;
      backBtn.addEventListener('click', () => treemap.stepBack());
      trailEl.appendChild(backBtn);
    }

    stack.forEach((node, index) => {
      const isLast = index === stack.length - 1;

      const item = document.createElement('span');
      item.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
      item.textContent = node.name || 'Root';

      if (!isLast) {
        item.addEventListener('click', () => treemap.jumpToHistory(index));
      }

      trailEl.appendChild(item);

      if (!isLast) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator';
        sep.textContent = '/';
        trailEl.appendChild(sep);
      }
    });
  }

  // Inspector Drawer Handler
  function handleNodeSelect(node) {
    if (!node) return;
    const nameEl = document.getElementById('inspectorName');
    const pathEl = document.getElementById('inspectorPath');
    const sizeEl = document.getElementById('inspectorSize');
    const catEl = document.getElementById('inspectorCategory');
    const drillBtn = document.getElementById('btnInspectorDrill');
    const openBtn = document.getElementById('btnInspectorOpen');

    if (nameEl) nameEl.textContent = node.name;
    if (pathEl) pathEl.textContent = node.path || node.name;
    if (sizeEl) sizeEl.textContent = treemap.formatBytes(node.size);
    if (catEl) {
      catEl.textContent = (node.category || 'Folder').toUpperCase();
      catEl.style.color = treemap.getNodeColor(node);
    }

    if (drillBtn) {
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        drillBtn.style.display = 'flex';
        drillBtn.onclick = () => treemap.drillToNode(node);
      } else {
        drillBtn.style.display = 'none';
      }
    }

    if (openBtn) {
      openBtn.onclick = () => openInExplorer(node.path || state.currentPath);
    }
  }

  // Render Largest Files Table
  function renderLargestFilesTable(files) {
    const tbody = document.getElementById('largestFilesTbody');
    const countBadge = document.getElementById('largestFilesCount');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Apply Filter & Search
    let filtered = files;
    if (state.fileFilter !== 'all') {
      filtered = filtered.filter(f => f.category === state.fileFilter);
    }
    if (state.searchQuery.trim() !== '') {
      const q = state.searchQuery.toLowerCase();
      filtered = filtered.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
    }

    if (countBadge) countBadge.textContent = `${filtered.length} items`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 2rem; color: var(--text-muted);">No large files matching filters found in current scan scope.</td></tr>`;
      return;
    }

    filtered.forEach((file, index) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border-color)';
      
      const isProtected = file.safety === 'protected';

      tr.innerHTML = `
        <td style="padding: 0.85rem 1rem; font-family: var(--font-mono); color: var(--text-muted);">${index + 1}</td>
        <td style="padding: 0.85rem 1rem;">
          <div style="display: flex; align-items: center; gap: 0.65rem;">
            <span style="font-family: var(--font-mono); font-size: 0.72rem; padding: 0.15rem 0.45rem; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--accent-cyan);">
              ${file.ext}
            </span>
            <div style="font-weight: 600; color: var(--text-primary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${file.name}
            </div>
            ${isProtected ? '<span class="zone-badge badge-protected">PROTECTED</span>' : ''}
          </div>
          <div style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); margin-top: 0.2rem; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${file.path}
          </div>
        </td>
        <td style="padding: 0.85rem 1rem; font-family: var(--font-mono); font-size: 1rem; font-weight: 700; color: var(--accent-cyan);">
          ${file.sizeFormatted}
        </td>
        <td style="padding: 0.85rem 1rem; text-transform: uppercase; font-size: 0.75rem; font-family: var(--font-mono); color: ${treemap.getNodeColor(file)};">
          ${file.category}
        </td>
        <td style="padding: 0.85rem 1rem; text-align: right;">
          <button class="btn-action-outline" data-path="${encodeURIComponent(file.path)}" style="padding: 0.35rem 0.7rem; font-size: 0.78rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            Locate
          </button>
        </td>
      `;

      const btn = tr.querySelector('.btn-action-outline');
      if (btn) {
        btn.addEventListener('click', () => openInExplorer(file.path));
      }

      tbody.appendChild(tr);
    });
  }

  // ================= Event Listeners & Actions =================

  // Open Windows Explorer via API
  async function openInExplorer(targetPath) {
    if (!targetPath) return;
    try {
      const res = await fetch('/api/open-explorer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Revealed in Explorer: ${targetPath}`, 'success');
      } else {
        showToast(data.error, 'error');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Open Windows Storage Sense
  const btnStorageSense = document.getElementById('btnOpenStorageSense');
  if (btnStorageSense) {
    btnStorageSense.addEventListener('click', async () => {
      try {
        await fetch('/api/open-storage-sense', { method: 'POST' });
        showToast('Opened Windows Storage Sense Settings', 'success');
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  }

  // Refresh All Button
  const btnRefresh = document.getElementById('btnRefreshAll');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      showToast('Refreshing system drives & space audit...', 'info');
      refreshAllData();
    });
  }

  // Tab Switcher
  function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));

        tab.classList.add('active');
        const targetView = tab.getAttribute('data-tab');
        const viewEl = document.getElementById(targetView);
        if (viewEl) {
          viewEl.classList.add('active');
          state.activeTab = targetView;
        }

        // If heatmap activated, resize canvas
        if (targetView === 'viewHeatmap') {
          treemap.resizeCanvas();
          treemap.render();
        } else if (targetView === 'viewDevHunter') {
          if (!state.devData) loadDevArtifacts();
          else renderDevArtifactsTable();
        }
      });
    });
  }

  // Toolbar Controls (Color Mode, View Mode, Hide System)
  function initToolbarControls() {
    // Hide System Files Toggle
    const hideSysToggle = document.getElementById('toggleHideSystem');
    if (hideSysToggle) {
      hideSysToggle.addEventListener('click', () => {
        state.includeSystemInScan = !state.includeSystemInScan;
        hideSysToggle.classList.toggle('active', !state.includeSystemInScan);
        hideSysToggle.innerHTML = !state.includeSystemInScan 
          ? `<span>🛡️ System Files Hidden</span>` 
          : `<span>🛡️ System Files Visible</span>`;
        treemap.setHideSystem(!state.includeSystemInScan);
      });
    }

    // Color Mode Switcher
    const colorModeSelect = document.getElementById('colorModeSelect');
    if (colorModeSelect) {
      colorModeSelect.addEventListener('change', (e) => {
        treemap.setColorMode(e.target.value);
      });
    }

    // View Mode Switcher (Treemap vs Sunburst)
    const viewTreemapBtn = document.getElementById('btnModeTreemap');
    const viewSunburstBtn = document.getElementById('btnModeSunburst');

    if (viewTreemapBtn && viewSunburstBtn) {
      viewTreemapBtn.addEventListener('click', () => {
        viewTreemapBtn.classList.add('active');
        viewSunburstBtn.classList.remove('active');
        treemap.setViewMode('treemap');
      });

      viewSunburstBtn.addEventListener('click', () => {
        viewSunburstBtn.classList.add('active');
        viewTreemapBtn.classList.remove('active');
        treemap.setViewMode('sunburst');
      });
    }
  }

  // Leaderboard Filters & Search
  function initLeaderboardFilters() {
    const filterPills = document.querySelectorAll('.leaderboard-filter-pill');
    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.fileFilter = pill.getAttribute('data-filter');
        if (state.scanData) {
          renderLargestFilesTable(state.scanData.largestFiles || []);
        }
      });
    });

    const searchInput = document.getElementById('largestFileSearch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        if (state.scanData) {
          renderLargestFilesTable(state.scanData.largestFiles || []);
        }
      });
    }
  }

  // ================= Dev & Build Hunter Manager =================

  // Fetch Dev Artifacts
  async function loadDevArtifacts() {
    try {
      const res = await fetch('/api/dev-artifacts');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      state.devData = data;

      // Update Header Tab Pill
      const badgePill = document.getElementById('badgeDevHunterCount');
      if (badgePill) badgePill.textContent = data.totalFormatted;

      // Update Hero Banner Total
      const heroTotal = document.getElementById('heroDevTotalSize');
      if (heroTotal) heroTotal.textContent = data.totalFormatted;

      // Update 4 Stat Cards
      const sm = data.summary;
      if (sm) {
        const elNodeSize = document.getElementById('statNodeModulesSize');
        const elNodeCount = document.getElementById('statNodeModulesCount');
        if (elNodeSize) elNodeSize.textContent = sm.nodeModules.formatted;
        if (elNodeCount) elNodeCount.textContent = sm.nodeModules.count;

        const elWebSize = document.getElementById('statWebBuildsSize');
        const elWebCount = document.getElementById('statWebBuildsCount');
        if (elWebSize) elWebSize.textContent = sm.webBuilds.formatted;
        if (elWebCount) elWebCount.textContent = sm.webBuilds.count;

        const elMobSize = document.getElementById('statMobileBuildsSize');
        const elMobCount = document.getElementById('statMobileBuildsCount');
        if (elMobSize) elMobSize.textContent = sm.mobileBuilds.formatted;
        if (elMobCount) elMobCount.textContent = sm.mobileBuilds.count;

        const elVenvSize = document.getElementById('statPythonVenvsSize');
        const elVenvCount = document.getElementById('statPythonVenvsCount');
        if (elVenvSize) elVenvSize.textContent = sm.pythonVenvs.formatted;
        if (elVenvCount) elVenvCount.textContent = sm.pythonVenvs.count;
      }

      // Update Filter Button Counters
      const btnAll = document.getElementById('devFilterAll');
      if (btnAll) btnAll.textContent = `All Artifacts (${data.totalArtifacts})`;

      const btnMod = document.getElementById('devFilterModules');
      if (btnMod && sm) btnMod.textContent = `📦 node_modules (${sm.nodeModules.count})`;

      const btnWeb = document.getElementById('devFilterWeb');
      if (btnWeb && sm) btnWeb.textContent = `🌐 Web Builds (${sm.webBuilds.count})`;

      const btnMob = document.getElementById('devFilterMobile');
      if (btnMob && sm) btnMob.textContent = `📱 Mobile Builds (${sm.mobileBuilds.count})`;

      const btnVenv = document.getElementById('devFilterVenv');
      if (btnVenv && sm) btnVenv.textContent = `🐍 Python venvs (${sm.pythonVenvs.count})`;

      renderDevArtifactsTable();
    } catch (err) {
      console.error('Error fetching dev artifacts:', err);
    }
  }

  // Render Dev Artifacts Table
  function renderDevArtifactsTable() {
    const tbody = document.getElementById('devArtifactsTbody');
    if (!tbody || !state.devData) return;
    tbody.innerHTML = '';

    let items = state.devData.artifacts || [];

    // Filter by Category
    if (state.devFilter !== 'all') {
      items = items.filter(a => a.category === state.devFilter);
    }

    // Filter by Search
    if (state.devSearch.trim() !== '') {
      const q = state.devSearch.toLowerCase();
      items = items.filter(a => a.projectName.toLowerCase().includes(q) || a.path.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
    }

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 2.5rem; color: var(--text-muted);">No developer build artifacts matching current filters found.</td></tr>`;
      return;
    }

    items.forEach((item, idx) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border-color)';
      const isChecked = state.selectedDevPaths.has(item.path);

      let badgeClass = 'type-node_modules';
      if (item.category === 'mobile_build') badgeClass = 'type-mobile_build';
      else if (item.category === 'web_build') badgeClass = 'type-web_build';
      else if (item.category === 'python_venv') badgeClass = 'type-python_venv';

      tr.innerHTML = `
        <td style="padding: 0.85rem 1rem;">
          <input type="checkbox" class="custom-checkbox dev-row-chk" data-path="${encodeURIComponent(item.path)}" ${isChecked ? 'checked' : ''}>
        </td>
        <td style="padding: 0.85rem 1rem;">
          <div style="font-weight: 700; color: var(--text-primary); font-size: 0.95rem;">
            ${item.projectName} / <span style="color: var(--accent-cyan);">${item.name}</span>
          </div>
          <div style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); margin-top: 0.2rem; max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${item.path}
          </div>
        </td>
        <td style="padding: 0.85rem 1rem;">
          <span class="badge-dev-type ${badgeClass}">
            ${item.typeLabel}
          </span>
        </td>
        <td style="padding: 0.85rem 1rem; font-family: var(--font-mono); font-size: 1.05rem; font-weight: 700; color: var(--accent-cyan);">
          ${item.sizeFormatted}
        </td>
        <td style="padding: 0.85rem 1rem; font-family: var(--font-mono); font-size: 0.82rem; color: var(--text-secondary);">
          ${(item.fileCount || 0).toLocaleString()}
        </td>
        <td style="padding: 0.85rem 1rem; text-align: right;">
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
            <button class="btn-action-outline btn-locate-artifact" data-path="${encodeURIComponent(item.path)}" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" title="Reveal in Windows Explorer">
              Locate
            </button>
            <button class="btn-clean-single btn-purge-single" data-path="${encodeURIComponent(item.path)}" style="padding: 0.35rem 0.65rem; font-size: 0.75rem; color: var(--accent-rose); border-color: rgba(244, 63, 94, 0.3);" title="Purge this folder to reclaim space">
              Purge
            </button>
          </div>
        </td>
      `;

      // Checkbox listener
      const chk = tr.querySelector('.dev-row-chk');
      if (chk) {
        chk.addEventListener('change', (e) => {
          if (e.target.checked) state.selectedDevPaths.add(item.path);
          else state.selectedDevPaths.delete(item.path);
          updateDevPurgeSummary();
        });
      }

      // Locate in explorer
      const locateBtn = tr.querySelector('.btn-locate-artifact');
      if (locateBtn) {
        locateBtn.addEventListener('click', () => openInExplorer(item.path));
      }

      // Purge single
      const purgeBtn = tr.querySelector('.btn-purge-single');
      if (purgeBtn) {
        purgeBtn.addEventListener('click', () => purgeSelectedArtifacts([item.path]));
      }

      tbody.appendChild(tr);
    });

    updateDevPurgeSummary();
  }

  // Update Purge Button State & Size
  function updateDevPurgeSummary() {
    const purgeBtn = document.getElementById('btnPurgeSelectedArtifacts');
    if (!purgeBtn) return;

    let selectedBytes = 0;
    if (state.devData && state.devData.artifacts) {
      for (const a of state.devData.artifacts) {
        if (state.selectedDevPaths.has(a.path)) {
          selectedBytes += (a.sizeBytes || 0);
        }
      }
    }

    const count = state.selectedDevPaths.size;
    purgeBtn.disabled = count === 0;
    if (count > 0) {
      purgeBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Purge ${count} Selected (${treemap.formatBytes(selectedBytes)})
      `;
    } else {
      purgeBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Purge Selected Build Caches
      `;
    }
  }

  // Purge Artifacts API Call
  async function purgeSelectedArtifacts(pathsToPurge) {
    if (!pathsToPurge || pathsToPurge.length === 0) return;

    const count = pathsToPurge.length;
    if (!confirm(`Are you sure you want to permanently delete ${count} build/module folder(s)? You can restore them anytime using your project build tools (npm install / flutter build).`)) {
      return;
    }

    showToast(`Purging ${count} build artifacts...`, 'info');

    try {
      const res = await fetch('/api/clean-artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: pathsToPurge })
      });

      const data = await res.json();
      if (data.success) {
        showToast(`Successfully reclaimed ${data.totalFreedFormatted} across ${data.freedCount} build folders!`, 'success');

        // Clear selection
        pathsToPurge.forEach(p => state.selectedDevPaths.delete(p));

        // Reload data
        await loadDevArtifacts();
        await loadSystemOverview();
      } else {
        showToast(`Purge error: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
    }
  }

  // Init Dev Hunter Event Handlers
  function initDevHunterEvents() {
    // Category Filter Pills
    const filterBtns = document.querySelectorAll('.dev-filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.devFilter = btn.getAttribute('data-dev-filter');
        renderDevArtifactsTable();
      });
    });

    // Search Input
    const searchInput = document.getElementById('devArtifactSearch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.devSearch = e.target.value;
        renderDevArtifactsTable();
      });
    }

    // Select All Web & Mobile Builds Button
    const btnSelectBuilds = document.getElementById('btnSelectAllBuilds');
    if (btnSelectBuilds) {
      btnSelectBuilds.addEventListener('click', () => {
        if (!state.devData || !state.devData.artifacts) return;
        state.devData.artifacts.forEach(a => {
          if (a.category === 'web_build' || a.category === 'mobile_build') {
            state.selectedDevPaths.add(a.path);
          }
        });
        renderDevArtifactsTable();
        showToast('Selected all web & mobile build caches', 'info');
      });
    }

    // Select All node_modules Button
    const btnSelectModules = document.getElementById('btnSelectAllNodeModules');
    if (btnSelectModules) {
      btnSelectModules.addEventListener('click', () => {
        if (!state.devData || !state.devData.artifacts) return;
        state.devData.artifacts.forEach(a => {
          if (a.category === 'node_modules') {
            state.selectedDevPaths.add(a.path);
          }
        });
        renderDevArtifactsTable();
        showToast('Selected all node_modules folders', 'info');
      });
    }

    // Clear Selection Button
    const btnClear = document.getElementById('btnDeselectAllArtifacts');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        state.selectedDevPaths.clear();
        renderDevArtifactsTable();
      });
    }

    // Master Checkbox
    const masterChk = document.getElementById('chkDevSelectAllMaster');
    if (masterChk) {
      masterChk.addEventListener('change', (e) => {
        const rowCheckboxes = document.querySelectorAll('.dev-row-chk');
        rowCheckboxes.forEach(chk => {
          chk.checked = e.target.checked;
          const p = decodeURIComponent(chk.getAttribute('data-path'));
          if (e.target.checked) state.selectedDevPaths.add(p);
          else state.selectedDevPaths.delete(p);
        });
        updateDevPurgeSummary();
      });
    }

    // Primary Purge Action Button
    const purgeBtn = document.getElementById('btnPurgeSelectedArtifacts');
    if (purgeBtn) {
      purgeBtn.addEventListener('click', () => {
        purgeSelectedArtifacts(Array.from(state.selectedDevPaths));
      });
    }
  }

  // Theme Toggle
  function initTheme() {
    const themeBtn = document.getElementById('btnThemeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', state.theme);
        themeBtn.innerHTML = state.theme === 'dark' 
          ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`
          : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
        treemap.render();
      });
    }
  }

  // Toast System
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) {
      console.log(`[Toast ${type}]`, msg);
      return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary);">${msg}</div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
  window.showToast = showToast;
});
