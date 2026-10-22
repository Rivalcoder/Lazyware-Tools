const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4455;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache storage for scans
const scanCache = new Map();
const devArtifactsMap = new Map(); // normalized lower path -> { size, fileCount, category }
let devArtifactsCache = null;
let devArtifactsCacheTime = 0;
let cleanupAuditCache = null;
let cleanupAuditCacheTime = 0;
let isScanningArtifacts = false;

// Helper: Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Fast Windows robocopy folder size measurement
function getFolderSizeFast(folderPath) {
    if (!fs.existsSync(folderPath)) return { size: 0, fileCount: 0 };
    try {
        const cmd = `robocopy "${folderPath}" "NULL" /L /S /BYTES /NJH /NFL /NDL /NC /NS /XD "$RECYCLE.BIN"`;
        const out = execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'ignore'] });
        const match = out.match(/Bytes\s*:\s*(\d+)/);
        const fileMatch = out.match(/Files\s*:\s*(\d+)/);
        return {
            size: match ? parseInt(match[1], 10) : 0,
            fileCount: fileMatch ? parseInt(fileMatch[1], 10) : 0
        };
    } catch (err) {
        if (err.stdout) {
            const match = err.stdout.toString().match(/Bytes\s*:\s*(\d+)/);
            const fileMatch = err.stdout.toString().match(/Files\s*:\s*(\d+)/);
            return {
                size: match ? parseInt(match[1], 10) : 0,
                fileCount: fileMatch ? parseInt(fileMatch[1], 10) : 0
            };
        }
        return { size: 0, fileCount: 0 };
    }
}

// Helper: Categorize file by extension or path
function categorizeItem(itemPath, isDirectory = false) {
    const ext = path.extname(itemPath).toLowerCase();
    const lowerPath = itemPath.toLowerCase();

    // Check System Protected
    if (
        lowerPath.includes('\\windows') ||
        lowerPath.includes('\\system32') ||
        lowerPath.includes('\\winsxs') ||
        lowerPath.includes('\\system volume information') ||
        lowerPath.endsWith('pagefile.sys') ||
        lowerPath.endsWith('hiberfil.sys') ||
        lowerPath.endsWith('swapfile.sys') ||
        lowerPath.includes('\\$recycle.bin') ||
        lowerPath.includes('\\recovery')
    ) {
        return { category: 'system', safety: 'protected', color: '#f43f5e' };
    }

    // Build artifacts & node_modules
    if (lowerPath.includes('\\node_modules')) {
        return { category: 'dev', safety: 'review', color: '#06b6d4' };
    }
    if (lowerPath.includes('\\.next') || lowerPath.includes('\\dist') || lowerPath.includes('\\build') || lowerPath.includes('\\.gradle') || lowerPath.includes('\\.dart_tool') || lowerPath.includes('\\pods')) {
        return { category: 'dev', safety: 'review', color: '#38bdf8' };
    }

    // Check Junk / Caches
    if (
        lowerPath.includes('\\temp') ||
        lowerPath.includes('\\tmp') ||
        lowerPath.includes('\\cache') ||
        lowerPath.includes('\\code cache') ||
        lowerPath.includes('\\shadercache') ||
        lowerPath.includes('\\npm-cache') ||
        lowerPath.includes('\\pip\\cache') ||
        lowerPath.includes('\\crashdumps') ||
        lowerPath.includes('\\wer')
    ) {
        return { category: 'cache', safety: 'safe', color: '#10b981' };
    }

    // Media
    const mediaExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.raw', '.psd'];
    if (mediaExts.includes(ext) || lowerPath.includes('\\videos') || lowerPath.includes('\\pictures') || lowerPath.includes('\\music')) {
        return { category: 'media', safety: 'user', color: '#f59e0b' };
    }

    // Developer / Code
    const devExts = ['.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.py', '.cpp', '.c', '.h', '.java', '.go', '.rs', '.php', '.sql', '.md', '.sh', '.bat', '.ps1', '.dart'];
    if (devExts.includes(ext) || lowerPath.includes('\\codestuffs') || lowerPath.includes('\\venv') || lowerPath.includes('\\.venv')) {
        return { category: 'dev', safety: 'review', color: '#06b6d4' };
    }

    // Apps & Executables
    const appExts = ['.exe', '.msi', '.dll', '.sys', '.iso', '.dmg', '.pkg', '.apk', '.aab'];
    if (appExts.includes(ext) || lowerPath.includes('\\program files')) {
        return { category: 'apps', safety: 'protected', color: '#8b5cf6' };
    }

    // Archives
    const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'];
    if (archiveExts.includes(ext)) {
        return { category: 'archives', safety: 'review', color: '#ec4899' };
    }

    // Documents
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf'];
    if (docExts.includes(ext) || lowerPath.includes('\\documents')) {
        return { category: 'documents', safety: 'user', color: '#3b82f6' };
    }

    return { category: 'other', safety: 'user', color: '#64748b' };
}

// Get User Shell Folders from Registry
function getUserFolders() {
    const home = os.homedir();
    const defaults = {
        home,
        codeStuffs: 'C:\\CodeStuffs',
        mobileBuilds: 'C:\\CodeStuffs\\Mobile Builds',
        documents: path.join(home, 'Documents'),
        downloads: path.join(home, 'Downloads'),
        desktop: path.join(home, 'Desktop'),
        videos: path.join(home, 'Videos'),
        pictures: path.join(home, 'Pictures'),
        music: path.join(home, 'Music')
    };

    try {
        const psCmd = `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' | Select-Object 'Personal', 'Desktop', '{374DE290-123F-4565-9164-39C4925E467B}', 'My Video', 'My Pictures', 'My Music' | ConvertTo-Json -Compress`;
        const res = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8', timeout: 3000 });
        const reg = JSON.parse(res.trim());

        if (reg['Personal'] && fs.existsSync(reg['Personal'])) defaults.documents = reg['Personal'];
        if (reg['Desktop'] && fs.existsSync(reg['Desktop'])) defaults.desktop = reg['Desktop'];
        if (reg['{374DE290-123F-4565-9164-39C4925E467B}'] && fs.existsSync(reg['{374DE290-123F-4565-9164-39C4925E467B}'])) {
            defaults.downloads = reg['{374DE290-123F-4565-9164-39C4925E467B}'];
        }
        if (reg['My Video'] && fs.existsSync(reg['My Video'])) defaults.videos = reg['My Video'];
        if (reg['My Pictures'] && fs.existsSync(reg['My Pictures'])) defaults.pictures = reg['My Pictures'];
        if (reg['My Music'] && fs.existsSync(reg['My Music'])) defaults.music = reg['My Music'];
    } catch (e) {}
    return defaults;
}

// Query Windows logical drives
function getSystemDrives() {
    try {
        const psCmd = `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace | ConvertTo-Json -Compress`;
        const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8', timeout: 5000 });
        const parsed = JSON.parse(output.trim());
        const drives = Array.isArray(parsed) ? parsed : [parsed];

        return drives.map(d => {
            const size = Number(d.Size) || 0;
            const free = Number(d.FreeSpace) || 0;
            const used = size > free ? size - free : 0;
            const usedPct = size > 0 ? Math.round((used / size) * 100) : 0;
            return {
                id: d.DeviceID,
                path: d.DeviceID + '\\',
                name: d.VolumeName || (d.DeviceID === 'C:' ? 'System OS' : 'Local Disk'),
                fileSystem: d.FileSystem || 'NTFS',
                totalBytes: size,
                freeBytes: free,
                usedBytes: used,
                totalFormatted: formatBytes(size),
                freeFormatted: formatBytes(free),
                usedFormatted: formatBytes(used),
                usedPercentage: usedPct,
                isSystem: d.DeviceID.toUpperCase() === 'C:'
            };
        });
    } catch (e) {
        return [];
    }
}

// Deep Dev & Build Artifacts Scanner
function scanAllDevArtifacts(roots = ['C:\\CodeStuffs']) {
    const list = [];
    devArtifactsMap.clear();

    function walk(dir, depth = 0, maxDepth = 4) {
        if (depth > maxDepth || !fs.existsSync(dir)) return;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
                if (!ent.isDirectory()) continue;
                if (ent.name === '.git' || ent.name === '$RECYCLE.BIN' || ent.name === 'AppData') continue;

                const full = path.join(dir, ent.name);
                const nameLower = ent.name.toLowerCase();

                const isNodeModules = nameLower === 'node_modules';
                const isMobile = ['build', '.gradle', '.dart_tool', 'pods', '.cxx'].includes(nameLower) || full.toLowerCase().includes('mobile builds');
                const isWeb = ['dist', '.next', 'out'].includes(nameLower) || (nameLower === 'build' && !full.toLowerCase().includes('android'));
                const isVenv = ['.venv', 'venv', 'env', '__pycache__'].includes(nameLower);

                if (isNodeModules || isMobile || isWeb || isVenv) {
                    let cat = 'web_build';
                    let typeLabel = 'Web Build (.next / dist)';
                    if (isNodeModules) {
                        cat = 'node_modules';
                        typeLabel = 'node_modules';
                    } else if (isVenv) {
                        cat = 'python_venv';
                        typeLabel = 'Python Virtualenv';
                    } else if (full.toLowerCase().includes('mobile') || ['.gradle', '.dart_tool', 'pods'].includes(nameLower)) {
                        cat = 'mobile_build';
                        typeLabel = 'Mobile / Android Build';
                    }

                    const stats = getFolderSizeFast(full);
                    let mtime = null;
                    try {
                        mtime = fs.statSync(full).mtime;
                    } catch (e) {}

                    const artifactRecord = {
                        name: ent.name,
                        path: full,
                        projectName: path.basename(path.dirname(full)),
                        category: cat,
                        typeLabel,
                        sizeBytes: stats.size,
                        sizeFormatted: formatBytes(stats.size),
                        fileCount: stats.fileCount,
                        modified: mtime ? mtime.toISOString() : null
                    };

                    list.push(artifactRecord);
                    devArtifactsMap.set(path.resolve(full).toLowerCase(), artifactRecord);
                    continue; // Skip scanning sub-files inside this artifact
                }

                walk(full, depth + 1, maxDepth);
            }
        } catch (e) {}
    }

    for (const root of roots) {
        walk(root, 0, 4);
    }

    list.sort((a, b) => b.sizeBytes - a.sizeBytes);

    let sumModules = 0;
    let countModules = 0;
    let sumMobile = 0;
    let countMobile = 0;
    let sumWeb = 0;
    let countWeb = 0;
    let sumVenv = 0;
    let countVenv = 0;

    for (const item of list) {
        if (item.category === 'node_modules') {
            sumModules += item.sizeBytes;
            countModules++;
        } else if (item.category === 'mobile_build') {
            sumMobile += item.sizeBytes;
            countMobile++;
        } else if (item.category === 'web_build') {
            sumWeb += item.sizeBytes;
            countWeb++;
        } else if (item.category === 'python_venv') {
            sumVenv += item.sizeBytes;
            countVenv++;
        }
    }

    const grandTotal = sumModules + sumMobile + sumWeb + sumVenv;

    return {
        totalBytes: grandTotal,
        totalFormatted: formatBytes(grandTotal),
        totalArtifacts: list.length,
        summary: {
            nodeModules: { bytes: sumModules, formatted: formatBytes(sumModules), count: countModules },
            mobileBuilds: { bytes: sumMobile, formatted: formatBytes(sumMobile), count: countMobile },
            webBuilds: { bytes: sumWeb, formatted: formatBytes(sumWeb), count: countWeb },
            pythonVenvs: { bytes: sumVenv, formatted: formatBytes(sumVenv), count: countVenv }
        },
        artifacts: list
    };
}

// Pre-warm dev artifacts cache in background
function warmDevArtifacts() {
    if (isScanningArtifacts) return;
    isScanningArtifacts = true;
    setTimeout(() => {
        try {
            cleanupAuditCache = auditCleanupTargets();
            cleanupAuditCacheTime = Date.now();
            console.log(`[Audit] Cleanup targets primed: ${cleanupAuditCache.totalSafeFormatted} safe to clear.`);

            devArtifactsCache = scanAllDevArtifacts(['C:\\CodeStuffs']);
            devArtifactsCacheTime = Date.now();
            console.log(`[Dev Hunter] Cache primed: ${devArtifactsCache.totalFormatted} across ${devArtifactsCache.totalArtifacts} artifacts.`);
        } catch (e) {
            console.error('[Warmer] Warm cache error:', e.message);
        } finally {
            isScanningArtifacts = false;
        }
    }, 50);
}

// Fast Recursive Treemap Scanner utilizing devArtifactsMap for instant atomic sizing
function scanDirectoryTree(dirPath, maxDepth = 2, currentDepth = 0, largestFiles = [], includeSystem = true) {
    if (!fs.existsSync(dirPath)) {
        return { name: path.basename(dirPath) || dirPath, path: dirPath, size: 0, children: [], type: 'directory' };
    }

    const { category, safety, color } = categorizeItem(dirPath, true);
    if (!includeSystem && safety === 'protected' && currentDepth > 0) {
        return null;
    }

    let totalSize = 0;
    let fileCount = 0;
    const children = [];

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === '$Recycle.Bin' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') {
                continue;
            }
            if (entry.name.startsWith('.') && entry.name !== '.vscode' && entry.name !== '.git' && entry.name !== '.next' && entry.name !== '.gradle' && entry.name !== '.dart_tool' && entry.name !== '.venv') {
                continue;
            }

            const fullPath = path.join(dirPath, entry.name);
            const lowerPath = path.resolve(fullPath).toLowerCase();
            const nameLower = entry.name.toLowerCase();

            try {
                if (entry.isFile()) {
                    const stat = fs.statSync(fullPath);
                    const itemCat = categorizeItem(fullPath, false);

                    if (!includeSystem && itemCat.safety === 'protected') continue;

                    totalSize += stat.size;
                    fileCount++;

                    if (stat.size > 20 * 1024 * 1024) {
                        largestFiles.push({
                            name: entry.name,
                            path: fullPath,
                            size: stat.size,
                            sizeFormatted: formatBytes(stat.size),
                            ext: path.extname(entry.name).toLowerCase() || 'file',
                            modified: stat.mtime,
                            category: itemCat.category,
                            safety: itemCat.safety
                        });
                    }

                    if (currentDepth <= maxDepth) {
                        children.push({
                            name: entry.name,
                            path: fullPath,
                            size: stat.size,
                            sizeFormatted: formatBytes(stat.size),
                            type: 'file',
                            category: itemCat.category,
                            safety: itemCat.safety,
                            color: itemCat.color,
                            modified: stat.mtime
                        });
                    }
                } else if (entry.isDirectory()) {
                    const itemCat = categorizeItem(fullPath, true);
                    if (!includeSystem && itemCat.safety === 'protected') continue;

                    // Check if this directory is in the pre-warmed dev artifacts map
                    if (devArtifactsMap.has(lowerPath)) {
                        const cached = devArtifactsMap.get(lowerPath);
                        totalSize += cached.sizeBytes;
                        fileCount += cached.fileCount;

                        children.push({
                            name: entry.name,
                            path: fullPath,
                            size: cached.sizeBytes,
                            sizeFormatted: formatBytes(cached.sizeBytes),
                            type: 'directory',
                            isArtifact: true,
                            category: 'dev',
                            safety: 'review',
                            color: nameLower === 'node_modules' ? '#06b6d4' : '#38bdf8',
                            children: [],
                            fileCount: cached.fileCount
                        });
                        continue;
                    }

                    // Check if it's node_modules or a build folder not in map
                    const isNodeModules = nameLower === 'node_modules';
                    const isBuildFolder = ['.next', 'dist', 'build', '.gradle', '.dart_tool', 'pods', '.venv', 'venv', '__pycache__'].includes(nameLower);

                    if (isNodeModules || isBuildFolder) {
                        const artifactStats = getFolderSizeFast(fullPath);
                        totalSize += artifactStats.size;
                        fileCount += artifactStats.fileCount;

                        children.push({
                            name: entry.name,
                            path: fullPath,
                            size: artifactStats.size,
                            sizeFormatted: formatBytes(artifactStats.size),
                            type: 'directory',
                            isArtifact: true,
                            category: 'dev',
                            safety: 'review',
                            color: isNodeModules ? '#06b6d4' : '#38bdf8',
                            children: [],
                            fileCount: artifactStats.fileCount
                        });
                        continue;
                    }

                    // For regular directories within maxDepth
                    if (currentDepth < maxDepth) {
                        const sub = scanDirectoryTree(fullPath, maxDepth, currentDepth + 1, largestFiles, includeSystem);
                        if (sub) {
                            totalSize += sub.size;
                            fileCount += (sub.fileCount || 0);
                            children.push(sub);
                        }
                    } else {
                        // Beyond maxDepth: check children against devArtifactsMap to sum accurately without spawning robocopy!
                        let subSize = 0;
                        let subFiles = 0;
                        try {
                            const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                            for (const se of subEntries) {
                                const subP = path.join(fullPath, se.name);
                                const subLower = path.resolve(subP).toLowerCase();
                                if (se.isFile()) {
                                    const s = fs.statSync(subP).size;
                                    subSize += s;
                                    subFiles++;
                                } else if (devArtifactsMap.has(subLower)) {
                                    const c = devArtifactsMap.get(subLower);
                                    subSize += c.sizeBytes;
                                    subFiles += c.fileCount;
                                }
                            }
                        } catch (e) {}

                        totalSize += subSize;
                        fileCount += subFiles;

                        children.push({
                            name: entry.name,
                            path: fullPath,
                            size: subSize,
                            sizeFormatted: formatBytes(subSize),
                            type: 'directory',
                            category: itemCat.category,
                            safety: itemCat.safety,
                            color: itemCat.color,
                            children: [],
                            fileCount: subFiles,
                            hasMore: true
                        });
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}

    // Sort children by size descending
    children.sort((a, b) => b.size - a.size);

    return {
        name: path.basename(dirPath) || dirPath,
        path: dirPath,
        size: totalSize,
        sizeFormatted: formatBytes(totalSize),
        type: 'directory',
        fileCount,
        category,
        safety,
        color,
        children
    };
}

// Audit Cleanable Targets
function auditCleanupTargets() {
    const home = os.homedir();
    const userFolders = getUserFolders();

    const safeTargets = [
        {
            key: 'userTemp',
            name: 'User Temporary Files (%TEMP%)',
            description: 'Temporary files created by apps and Windows that are no longer needed.',
            path: os.tmpdir(),
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'trash-2'
        },
        {
            key: 'systemTemp',
            name: 'Windows System Temp',
            description: 'OS-level temporary scratch files created during updates and background tasks.',
            path: 'C:\\Windows\\Temp',
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'hard-drive'
        },
        {
            key: 'edgeCache',
            name: 'Microsoft Edge Web Cache',
            description: 'Cached images, scripts, and web pages from Edge browser.',
            path: path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'globe'
        },
        {
            key: 'chromeCache',
            name: 'Google Chrome Web Cache',
            description: 'Cached browsing data from Google Chrome.',
            path: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'chrome'
        },
        {
            key: 'crashDumps',
            name: 'Crash Dumps & Error Reports',
            description: 'Memory dumps and logs generated when applications unexpectedly close.',
            path: path.join(home, 'AppData', 'Local', 'CrashDumps'),
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'alert-triangle'
        },
        {
            key: 'werReports',
            name: 'Windows Error Reporting (WER)',
            description: 'Queued diagnostic reports for Microsoft error telemetry.',
            path: 'C:\\ProgramData\\Microsoft\\Windows\\WER',
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'file-text'
        },
        {
            key: 'winUpdateDownload',
            name: 'Windows Update Cache',
            description: 'Installer payload files downloaded by Windows Update after successful installs.',
            path: 'C:\\Windows\\SoftwareDistribution\\Download',
            badge: 'Safe to Delete',
            risk: 'none',
            icon: 'refresh-cw'
        }
    ];

    const auditedSafe = safeTargets.map(t => {
        const stats = getFolderSizeFast(t.path);
        return {
            ...t,
            sizeBytes: stats.size,
            sizeFormatted: formatBytes(stats.size),
            fileCount: stats.fileCount,
            exists: fs.existsSync(t.path),
            checked: stats.size > 0
        };
    });

    let recycleBinSize = 0;
    let recycleBinCount = 0;
    try {
        const cmd = `(New-Object -ComObject Shell.Application).Namespace(0xa).Items() | Measure-Object -Property Size -Sum | Select-Object Count, Sum | ConvertTo-Json -Compress`;
        const res = execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8', timeout: 3000 });
        const parsed = JSON.parse(res.trim());
        recycleBinSize = Number(parsed.Sum) || 0;
        recycleBinCount = Number(parsed.Count) || 0;
    } catch (e) {
        const cRecycle = getFolderSizeFast('C:\\$Recycle.Bin');
        const zRecycle = getFolderSizeFast('Z:\\$RECYCLE.BIN');
        recycleBinSize = cRecycle.size + zRecycle.size;
        recycleBinCount = cRecycle.fileCount + zRecycle.fileCount;
    }

    auditedSafe.unshift({
        key: 'recycleBin',
        name: 'Windows Recycle Bin',
        description: 'Deleted files waiting in the trash across all logical drives.',
        path: 'Shell:RecycleBinFolder',
        badge: 'Safe to Delete',
        risk: 'none',
        icon: 'trash',
        sizeBytes: recycleBinSize,
        sizeFormatted: formatBytes(recycleBinSize),
        fileCount: recycleBinCount,
        exists: true,
        checked: recycleBinSize > 0
    });

    const reviewTargets = [
        {
            key: 'npmCache',
            name: 'Node.js (npm) Package Cache',
            description: 'Downloaded npm tarballs and packages cached locally.',
            path: path.join(home, 'AppData', 'Local', 'npm-cache'),
            badge: 'Developer Cache',
            risk: 'low',
            icon: 'package'
        },
        {
            key: 'pipCache',
            name: 'Python (pip) Wheel Cache',
            description: 'Cached Python packages and wheels from pip installs.',
            path: path.join(home, 'AppData', 'Local', 'pip', 'cache'),
            badge: 'Developer Cache',
            risk: 'low',
            icon: 'terminal'
        },
        {
            key: 'oldDownloads',
            name: 'Downloads Folder (> 30 Days Old)',
            description: 'Downloaded setup files, zips, and documents left in Downloads.',
            path: userFolders.downloads,
            badge: 'User Review',
            risk: 'medium',
            icon: 'download'
        }
    ];

    const auditedReview = reviewTargets.map(t => {
        const stats = getFolderSizeFast(t.path);
        return {
            ...t,
            sizeBytes: stats.size,
            sizeFormatted: formatBytes(stats.size),
            fileCount: stats.fileCount,
            exists: fs.existsSync(t.path),
            checked: false
        };
    });

    const systemProtected = [
        {
            key: 'winCore',
            name: 'Windows System Files & Drivers',
            description: 'Critical operating system binaries, DLLs, and kernel drivers essential for booting Windows.',
            path: 'C:\\Windows\\System32',
            badge: 'PROTECTED - DO NOT DELETE',
            risk: 'critical',
            isProtected: true,
            icon: 'shield-alert',
            reason: 'Deleting or modifying these files will corrupt Windows and cause blue screens (BSOD).'
        },
        {
            key: 'winSxS',
            name: 'Windows Component Store (WinSxS)',
            description: 'Servicing components and previous versions for rollbacks, updates, and system integrity.',
            path: 'C:\\Windows\\WinSxS',
            badge: 'PROTECTED - SYSTEM STORE',
            risk: 'critical',
            isProtected: true,
            icon: 'lock',
            reason: 'Hard-linked system files managed exclusively by DISM and Windows Update.'
        },
        {
            key: 'pagefile',
            name: 'Paging File (pagefile.sys)',
            description: 'Virtual memory backup file used by Windows when RAM is heavily committed.',
            path: 'C:\\pagefile.sys',
            badge: 'PROTECTED - VIRTUAL RAM',
            risk: 'high',
            isProtected: true,
            icon: 'cpu',
            reason: 'Windows locks this file at boot for memory paging. Can only be adjusted via System Properties.'
        },
        {
            key: 'hiberfil',
            name: 'Hibernation File (hiberfil.sys)',
            description: 'Saves current RAM state to disk for Fast Startup and Hibernation mode.',
            path: 'C:\\hiberfil.sys',
            badge: 'PROTECTED - FAST STARTUP',
            risk: 'high',
            isProtected: true,
            icon: 'zap',
            reason: 'Can be safely reduced or disabled using "powercfg /hibernate off" in administrator cmd.'
        },
        {
            key: 'progFiles',
            name: 'Program Files & Installed Applications',
            description: 'Installed desktop software, Microsoft Office, browsers, and game runtimes.',
            path: 'C:\\Program Files',
            badge: 'MANAGED VIA UNINSTALLER',
            risk: 'high',
            isProtected: true,
            icon: 'layers',
            reason: 'Uninstall through Windows Settings > Apps to cleanly remove registry keys and files.'
        }
    ];

    const auditedProtected = systemProtected.map(t => {
        let size = 0;
        try {
            if (fs.existsSync(t.path)) {
                const st = fs.statSync(t.path);
                if (st.isFile()) size = st.size;
                else size = t.key === 'winCore' ? 18 * 1024 * 1024 * 1024 : 12 * 1024 * 1024 * 1024;
            }
        } catch (e) {}
        return {
            ...t,
            sizeBytes: size,
            sizeFormatted: size > 0 ? formatBytes(size) : 'System Managed',
            fileCount: 0
        };
    });

    const totalSafeBytes = auditedSafe.reduce((acc, cur) => acc + (cur.sizeBytes || 0), 0);
    const totalReviewBytes = auditedReview.reduce((acc, cur) => acc + (cur.sizeBytes || 0), 0);

    return {
        totalSafeBytes,
        totalSafeFormatted: formatBytes(totalSafeBytes),
        totalReviewBytes,
        totalReviewFormatted: formatBytes(totalReviewBytes),
        safe: auditedSafe,
        review: auditedReview,
        protected: auditedProtected
    };
}

// Safely clean folder
function safelyCleanFolder(dirPath) {
    if (!fs.existsSync(dirPath)) return { freedBytes: 0, freedFiles: 0, errors: [] };
    let freedBytes = 0;
    let freedFiles = 0;
    const errors = [];

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const ent of entries) {
            const fullPath = path.join(dirPath, ent.name);
            try {
                if (ent.isFile()) {
                    const st = fs.statSync(fullPath);
                    fs.unlinkSync(fullPath);
                    freedBytes += st.size;
                    freedFiles++;
                } else if (ent.isDirectory()) {
                    const sub = safelyCleanFolder(fullPath);
                    freedBytes += sub.freedBytes;
                    freedFiles += sub.freedFiles;
                    try {
                        fs.rmdirSync(fullPath);
                    } catch (e) {}
                }
            } catch (err) {}
        }
    } catch (err) {
        errors.push(err.message);
    }

    return { freedBytes, freedFiles, errors };
}

// ======================= API ENDPOINTS =======================

// 1. System Overview
app.get('/api/system-overview', (req, res) => {
    try {
        const drives = getSystemDrives();
        const userFolders = getUserFolders();
        const totalDriveBytes = drives.reduce((a, b) => a + b.totalBytes, 0);
        const freeDriveBytes = drives.reduce((a, b) => a + b.freeBytes, 0);
        const usedDriveBytes = totalDriveBytes - freeDriveBytes;

        res.json({
            success: true,
            hostname: os.hostname(),
            platform: `${os.type()} ${os.release()} (${os.arch()})`,
            uptimeHours: (os.uptime() / 3600).toFixed(1),
            totalRam: formatBytes(os.totalmem()),
            freeRam: formatBytes(os.freemem()),
            drives,
            userFolders,
            totalStorage: {
                totalBytes: totalDriveBytes,
                freeBytes: freeDriveBytes,
                usedBytes: usedDriveBytes,
                totalFormatted: formatBytes(totalDriveBytes),
                freeFormatted: formatBytes(freeDriveBytes),
                usedFormatted: formatBytes(usedDriveBytes),
                usedPct: Math.round((usedDriveBytes / totalDriveBytes) * 100)
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Drives List
app.get('/api/drives', (req, res) => {
    try {
        const drives = getSystemDrives();
        res.json({ success: true, drives });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Cleanup Audit
app.get('/api/cleanup-audit', (req, res) => {
    try {
        if (cleanupAuditCache && (Date.now() - cleanupAuditCacheTime < 180000)) {
            return res.json({ success: true, audit: cleanupAuditCache });
        }
        const audit = auditCleanupTargets();
        cleanupAuditCache = audit;
        cleanupAuditCacheTime = Date.now();
        res.json({ success: true, audit });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Dedicated Developer & Build Artifacts Scanner Endpoint
app.get('/api/dev-artifacts', (req, res) => {
    try {
        if (devArtifactsCache && (Date.now() - devArtifactsCacheTime < 180000)) {
            return res.json({ success: true, ...devArtifactsCache });
        }

        const data = scanAllDevArtifacts(['C:\\CodeStuffs']);
        devArtifactsCache = data;
        devArtifactsCacheTime = Date.now();

        res.json({ success: true, ...data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Purge / Clean Developer Build Artifacts
app.post('/api/clean-artifacts', (req, res) => {
    try {
        const { paths } = req.body;
        if (!paths || !Array.isArray(paths)) {
            return res.status(400).json({ success: false, error: 'paths array required' });
        }

        let totalFreed = 0;
        let freedCount = 0;
        const results = [];

        for (const itemPath of paths) {
            const norm = path.resolve(itemPath);
            const lower = norm.toLowerCase();
            const isSafeToDelete = (
                lower.includes('node_modules') ||
                lower.includes('\\.next') ||
                lower.includes('\\dist') ||
                lower.includes('\\build') ||
                lower.includes('\\.gradle') ||
                lower.includes('\\.dart_tool') ||
                lower.includes('\\pods') ||
                lower.includes('\\venv') ||
                lower.includes('\\.venv')
            ) && lower.startsWith('c:\\codestuffs');

            if (!isSafeToDelete) {
                results.push({ path: norm, success: false, error: 'Path not authorized for artifact purge' });
                continue;
            }

            if (fs.existsSync(norm)) {
                try {
                    const stats = getFolderSizeFast(norm);
                    fs.rmSync(norm, { recursive: true, force: true });
                    totalFreed += stats.size;
                    freedCount++;
                    results.push({ path: norm, success: true, freedBytes: stats.size, freedFormatted: formatBytes(stats.size) });
                } catch (e) {
                    results.push({ path: norm, success: false, error: e.message });
                }
            } else {
                results.push({ path: norm, success: false, error: 'Folder does not exist' });
            }
        }

        devArtifactsCache = null;
        scanCache.clear();
        warmDevArtifacts();

        res.json({
            success: true,
            totalFreedBytes: totalFreed,
            totalFreedFormatted: formatBytes(totalFreed),
            freedCount,
            results
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Execute Regular Cleanup
app.post('/api/clean', (req, res) => {
    try {
        const { targetKeys } = req.body;
        if (!targetKeys || !Array.isArray(targetKeys)) {
            return res.status(400).json({ success: false, error: 'targetKeys array required' });
        }

        const home = os.homedir();
        const results = [];
        let grandTotalFreedBytes = 0;
        let grandTotalFreedFiles = 0;

        for (const key of targetKeys) {
            let targetPath = null;
            let actionType = 'folder';

            if (key === 'userTemp') targetPath = os.tmpdir();
            else if (key === 'systemTemp') targetPath = 'C:\\Windows\\Temp';
            else if (key === 'edgeCache') targetPath = path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache');
            else if (key === 'chromeCache') targetPath = path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache');
            else if (key === 'crashDumps') targetPath = path.join(home, 'AppData', 'Local', 'CrashDumps');
            else if (key === 'npmCache') targetPath = path.join(home, 'AppData', 'Local', 'npm-cache');
            else if (key === 'pipCache') targetPath = path.join(home, 'AppData', 'Local', 'pip', 'cache');
            else if (key === 'recycleBin') actionType = 'recycleBin';

            if (actionType === 'recycleBin') {
                try {
                    execSync(`powershell -NoProfile -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"`, { timeout: 10000 });
                    results.push({ key, success: true, message: 'Recycle Bin emptied successfully' });
                } catch (e) {
                    results.push({ key, success: false, error: e.message });
                }
            } else if (targetPath) {
                const cleanRes = safelyCleanFolder(targetPath);
                grandTotalFreedBytes += cleanRes.freedBytes;
                grandTotalFreedFiles += cleanRes.freedFiles;
                results.push({
                    key,
                    targetPath,
                    success: true,
                    freedBytes: cleanRes.freedBytes,
                    freedFormatted: formatBytes(cleanRes.freedBytes),
                    freedFiles: cleanRes.freedFiles
                });
            }
        }

        res.json({
            success: true,
            totalFreedBytes: grandTotalFreedBytes,
            totalFreedFormatted: formatBytes(grandTotalFreedBytes),
            totalFreedFiles: grandTotalFreedFiles,
            results
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Scan Treemap Hierarchy
app.get('/api/scan', (req, res) => {
    try {
        const userFolders = getUserFolders();
        let targetPath = req.query.path;
        const depth = parseInt(req.query.depth, 10) || 2;
        const includeSystem = req.query.includeSystem === 'true';

        if (!targetPath) targetPath = userFolders.home;
        targetPath = path.resolve(targetPath);

        const cacheKey = `${targetPath}_d${depth}_s${includeSystem}`;
        if (scanCache.has(cacheKey) && (Date.now() - scanCache.get(cacheKey).time < 60000)) {
            return res.json(scanCache.get(cacheKey).data);
        }

        const largestFiles = [];
        const tree = scanDirectoryTree(targetPath, depth, 0, largestFiles, includeSystem);

        largestFiles.sort((a, b) => b.size - a.size);
        const top50 = largestFiles.slice(0, 50);

        const responseData = {
            success: true,
            scanPath: targetPath,
            tree,
            largestFiles: top50,
            scannedAt: new Date().toISOString()
        };

        scanCache.set(cacheKey, { data: responseData, time: Date.now() });
        res.json(responseData);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. Reveal in Windows Explorer
app.post('/api/open-explorer', (req, res) => {
    try {
        const { targetPath } = req.body;
        if (!targetPath) return res.status(400).json({ success: false, error: 'Path required' });

        if (fs.existsSync(targetPath)) {
            const isDir = fs.statSync(targetPath).isDirectory();
            if (isDir) {
                exec(`explorer.exe "${targetPath}"`);
            } else {
                exec(`explorer.exe /select,"${targetPath}"`);
            }
            res.json({ success: true, message: `Opened ${targetPath}` });
        } else {
            res.status(404).json({ success: false, error: 'Path does not exist' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. Open Windows Storage Sense
app.post('/api/open-storage-sense', (req, res) => {
    try {
        exec('start ms-settings:storagesense', (err) => {
            if (err) exec('cleanmgr.exe');
        });
        res.json({ success: true, message: 'Launched Windows Storage Settings' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start Server & warm cache in background
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Storage Manager & Heatmap Analyzer running at:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`====================================================`);
    warmDevArtifacts();
});
