<#
.SYNOPSIS
    Folder and File Unlocker & Force Deletion Utility for Windows.
.DESCRIPTION
    Fixes "Folder In Use" / "File In Use" errors caused by:
    1. Processes holding open file handles (via Windows Restart Manager API).
    2. Processes holding working directory locks (via Process PEB inspection).
    3. Windows Explorer shell lockouts.
    4. Read-only and system file attributes.
    5. Kernel-level locks: Windows Search (WSearch), antivirus, OneDrive sync.
    6. Stubborn empty directories held by kernel drivers.
    Supports: Unlock-only, Force Delete, Deep Kernel Scan, Reboot-scheduled deletion.
#>

[CmdletBinding()]
param (
    [Parameter(Position = 0)]
    [string]$TargetPath,

    [Parameter()]
    [ValidateSet("Scan", "DeepScan", "Unlock", "Delete", "InstallMenu", "UninstallMenu", "RestartExplorer")]
    [string]$Action,

    [Parameter()]
    [switch]$NonInteractive
)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1: Admin check & Self-Elevation
# ─────────────────────────────────────────────────────────────────────────────
function Test-IsAdmin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    if ($Action -in @("Delete", "Unlock", "InstallMenu", "UninstallMenu") -or (-not $Action)) {
        if (-not $NonInteractive -and [Environment]::UserInteractive) {
            $rawArgs = @()
            if ($TargetPath) { $rawArgs += "-TargetPath `"$TargetPath`"" }
            if ($Action)     { $rawArgs += "-Action $Action" }

            $argString = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" " + ($rawArgs -join " ")
            try {
                $elevatedProc = Start-Process powershell.exe -ArgumentList $argString -Verb RunAs -PassThru
                $elevatedProc.WaitForExit()
                exit $elevatedProc.ExitCode
            } catch {
                Write-Host "Admin prompt declined or canceled. Continuing as standard user..." -ForegroundColor Yellow
            }
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2: C# type definitions (compiled once in memory)
# ─────────────────────────────────────────────────────────────────────────────
function Ensure-TypesLoaded {
    # ── 2A: Restart-Manager lock detector ──────────────────────────────────
    if (-not ([System.Management.Automation.PSTypeName]'Win32LockDetector').Type) {
        $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { Get-Location }
        $dllPath = Join-Path $scriptDir "LockDetector.dll"
        $loaded  = $false
        if (Test-Path -LiteralPath $dllPath) {
            try { Add-Type -Path $dllPath -ErrorAction Stop; $loaded = $true } catch {}
        }

        if (-not $loaded) {
            Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class Win32LockDetector {
    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    public enum RM_APP_TYPE {
        RmUnknownApp = 0,
        RmMainWindow = 1,
        RmOtherWindow = 2,
        RmService = 3,
        RmExplorer = 4,
        RmConsole = 5,
        RmCritical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(uint pSessionHandle, out uint pnProcInfoNeeded,
        ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<int> GetFileLockPids(string[] paths) {
        List<int> pids = new List<int>();
        if (paths == null || paths.Length == 0) return pids;

        uint handle;
        string key = Guid.NewGuid().ToString();
        int res = RmStartSession(out handle, 0, key);
        if (res != 0) return pids;

        try {
            res = RmRegisterResources(handle, (uint)paths.Length, paths, 0, null, 0, null);
            if (res != 0) return pids;

            uint pnProcInfoNeeded = 0;
            uint pnProcInfo = 0;
            uint lpdwRebootReasons = 0;

            res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, null, ref lpdwRebootReasons);
            if (res == 234) {
                RM_PROCESS_INFO[] processInfo = new RM_PROCESS_INFO[pnProcInfoNeeded];
                pnProcInfo = pnProcInfoNeeded;
                res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, processInfo, ref lpdwRebootReasons);
                if (res == 0) {
                    for (int i = 0; i < pnProcInfo; i++) {
                        pids.Add(processInfo[i].Process.dwProcessId);
                    }
                }
            }
        } catch {}
        finally {
            RmEndSession(handle);
        }
        return pids;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, [Out] byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_VM_READ = 0x0010;

    public static string GetProcessCwd(int pid) {
        IntPtr hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (hProcess == IntPtr.Zero) return null;

        try {
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(hProcess, 0, ref pbi, Marshal.SizeOf(pbi), out returnLength);
            if (status != 0 || pbi.PebBaseAddress == IntPtr.Zero) return null;

            byte[] pebBuffer = new byte[IntPtr.Size];
            IntPtr bytesRead;
            IntPtr procParamsPtrAddress = new IntPtr(pbi.PebBaseAddress.ToInt64() + 0x20);
            if (!ReadProcessMemory(hProcess, procParamsPtrAddress, pebBuffer, pebBuffer.Length, out bytesRead))
                return null;

            IntPtr procParamsAddress = new IntPtr(BitConverter.ToInt64(pebBuffer, 0));
            if (procParamsAddress == IntPtr.Zero) return null;

            byte[] unicodeStringHeader = new byte[16];
            IntPtr curDirAddress = new IntPtr(procParamsAddress.ToInt64() + 0x38);
            if (!ReadProcessMemory(hProcess, curDirAddress, unicodeStringHeader, unicodeStringHeader.Length, out bytesRead))
                return null;

            ushort length = BitConverter.ToUInt16(unicodeStringHeader, 0);
            IntPtr bufferPtr = new IntPtr(BitConverter.ToInt64(unicodeStringHeader, 8));

            if (length == 0 || bufferPtr == IntPtr.Zero) return null;

            byte[] pathBuffer = new byte[length];
            if (!ReadProcessMemory(hProcess, bufferPtr, pathBuffer, length, out bytesRead))
                return null;

            return Encoding.Unicode.GetString(pathBuffer);
        } catch {
            return null;
        } finally {
            CloseHandle(hProcess);
        }
    }
}
"@ -ErrorAction Stop
        }
    }

    # ── 2B: Kernel handle scanner (NtQuerySystemInformation + ForceClose) ──
    if (-not ([System.Management.Automation.PSTypeName]'KernelHandleScanner').Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class KernelHandleScanner {
    [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls,IntPtr buf,int sz,out int ret);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int acc,bool inh,int pid);
    [DllImport("kernel32.dll")] public static extern bool DuplicateHandle(IntPtr srcProc,IntPtr srcHandle,IntPtr dstProc,out IntPtr dstHandle,int access,bool inherit,int opts);
    [DllImport("kernel32.dll")] public static extern uint GetFinalPathNameByHandle(IntPtr h,[Out] StringBuilder sb,uint len,uint flags);
    [DllImport("kernel32.dll")] public static extern uint GetFileType(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();

    const int SystemExtendedHandleInformation = 64;
    const int PROCESS_DUP_HANDLE    = 0x0040;
    const int DUPLICATE_SAME_ACCESS = 0x0002;
    const int DUPLICATE_CLOSE_SOURCE= 0x0001;
    const int FILE_TYPE_DISK        = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_HANDLE_EX {
        public IntPtr Object, UniqueProcessId, HandleValue;
        public uint GrantedAccess; public ushort CreatorBackTrace, ObjTypeIndex, Attribs, Reserved;
    }

    static List<string> ScanHandles(string matchPath, bool closeMode) {
        var results = new List<string>();
        int len = 0x100000;
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
            while (true) {
                int ret;
                int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, len, out ret);
                if (status == 0) break;
                if (status == -1073741820) { Marshal.FreeHGlobal(buf); len=Math.Max(len*2,ret+0x10000); buf=Marshal.AllocHGlobal(len); }
                else { return results; }
            }
            long count = Marshal.ReadInt64(buf);
            IntPtr cur = new IntPtr(buf.ToInt64()+16);
            int eSz = Marshal.SizeOf(typeof(SYSTEM_HANDLE_EX));
            IntPtr self = GetCurrentProcess();
            var procHandles = new Dictionary<int,IntPtr>();
            for (long i=0;i<count;i++,cur=new IntPtr(cur.ToInt64()+eSz)) {
                var e = (SYSTEM_HANDLE_EX)Marshal.PtrToStructure(cur,typeof(SYSTEM_HANDLE_EX));
                int pid = e.UniqueProcessId.ToInt32();
                if (pid<=4) continue;
                IntPtr ph;
                if (!procHandles.TryGetValue(pid,out ph)) { ph=OpenProcess(PROCESS_DUP_HANDLE,false,pid); procHandles[pid]=ph; }
                if (ph==IntPtr.Zero) continue;
                IntPtr dup;
                if (!DuplicateHandle(ph,e.HandleValue,self,out dup,0,false,DUPLICATE_SAME_ACCESS)) continue;
                bool isMatch=false;
                try {
                    if (GetFileType(dup)==FILE_TYPE_DISK) {
                        var sb=new StringBuilder(1024);
                        if (GetFinalPathNameByHandle(dup,sb,(uint)sb.Capacity,0)>0) {
                            string path=sb.ToString();
                            if (path.StartsWith(@"""\\?\""")) path=path.Substring(4);
                            if (path.IndexOf(matchPath,StringComparison.OrdinalIgnoreCase)>=0) {
                                isMatch=true;
                                if (!closeMode) {
                                    string pname="Unknown";
                                    try { pname=Process.GetProcessById(pid).ProcessName; } catch {}
                                    results.Add("PID="+pid+"|Process="+pname+"|Handle=0x"+e.HandleValue.ToInt64().ToString("X")+"|Path="+path);
                                }
                            }
                        }
                    }
                } catch {} finally { CloseHandle(dup); }
                if (isMatch && closeMode) {
                    IntPtr dummy;
                    if (DuplicateHandle(ph,e.HandleValue,self,out dummy,0,false,DUPLICATE_CLOSE_SOURCE)) { CloseHandle(dummy); results.Add("closed:"+pid); }
                }
            }
            foreach(var kv in procHandles) if(kv.Value!=IntPtr.Zero) CloseHandle(kv.Value);
        } finally { Marshal.FreeHGlobal(buf); }
        return results;
    }

    public static List<string> FindLockers(string matchPath)   { return ScanHandles(matchPath, false); }
    public static int ForceCloseHandles(string matchPath)      { return ScanHandles(matchPath, true).Count; }
}
"@ -ErrorAction Stop
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3: Lock detection
# ─────────────────────────────────────────────────────────────────────────────
function Get-LockingProcessesDetailed {
    param ([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    Ensure-TypesLoaded
    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
    $isDir    = (Get-Item -LiteralPath $resolved) -is [System.IO.DirectoryInfo]

    $fileItems = @($resolved)
    if ($isDir) {
        $subs = Get-ChildItem -LiteralPath $resolved -Recurse -File -ErrorAction SilentlyContinue |
                Select-Object -First 300 -ExpandProperty FullName
        if ($subs) { $fileItems += $subs }
    }

    $rmPids = New-Object System.Collections.Generic.HashSet[int]
    for ($i = 0; $i -lt $fileItems.Count; $i += 200) {
        $batch = $fileItems[$i..([Math]::Min($i+199,$fileItems.Count-1))]
        foreach ($p in [Win32LockDetector]::GetFileLockPids($batch)) { [void]$rmPids.Add($p) }
    }

    $cwdPids  = @{}
    $normTgt  = $resolved.TrimEnd('\') + '\'
    Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $cwd = [Win32LockDetector]::GetProcessCwd($_.Id)
            if ($cwd) {
                $nc = $cwd.TrimEnd('\') + '\'
                if ($nc.StartsWith($normTgt,[StringComparison]::OrdinalIgnoreCase) -or
                    $nc.Equals($normTgt,[StringComparison]::OrdinalIgnoreCase)) {
                    $cwdPids[$_.Id] = $cwd
                }
            }
        } catch {}
    }

    $kernelPids = @{}
    try {
        if (Test-IsAdmin) {
            $kl = Get-KernelLockInfo -Path $resolved
            foreach ($k in $kl) {
                if ($k.PID -match '^\d+$') {
                    $kpid = [int]$k.PID
                    if ($kpid -gt 4) {
                        $kernelPids[$kpid] = $k.LockedPath
                        [void]$allPids.Add($kpid)
                    }
                }
            }
        }
    } catch {}

    $allPids = New-Object System.Collections.Generic.HashSet[int]
    foreach ($p in $rmPids)          { [void]$allPids.Add($p) }
    foreach ($p in $cwdPids.Keys)    { [void]$allPids.Add($p) }
    foreach ($p in $kernelPids.Keys) { [void]$allPids.Add($p) }

    $myPid   = [Diagnostics.Process]::GetCurrentProcess().Id
    $results = @()
    foreach ($pid in $allPids) {
        if ($pid -eq $myPid) { continue }
        try {
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($proc) {
                $reasons = @()
                if ($rmPids.Contains($pid))         { $reasons += "File Handle" }
                if ($cwdPids.ContainsKey($pid))     { $reasons += "Working Dir ($($cwdPids[$pid]))" }
                if ($kernelPids.ContainsKey($pid))  { $reasons += "Kernel Handle" }
                $results += [PSCustomObject]@{
                    Id          = $proc.Id
                    ProcessName = $proc.ProcessName
                    WindowTitle = $proc.MainWindowTitle
                    Path        = $proc.Path
                    LockReason  = ($reasons -join "; ")
                }
            }
        } catch {}
    }
    return $results
}

function Get-KernelLockInfo {
    param ([string]$Path)
    Ensure-TypesLoaded
    $raw = [KernelHandleScanner]::FindLockers($Path.TrimEnd('\'))
    $parsed = @()
    foreach ($line in $raw) {
        $parts = @{}
        foreach ($seg in $line -split '\|') {
            $kv = $seg -split '=',2
            if ($kv.Count -eq 2) { $parts[$kv[0]] = $kv[1] }
        }
        $parsed += [PSCustomObject]@{
            PID         = $parts['PID']
            ProcessName = $parts['Process']
            Handle      = $parts['Handle']
            LockedPath  = $parts['Path']
        }
    }
    return $parsed
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4: Attribute clearing
# ─────────────────────────────────────────────────────────────────────────────
function Clear-Attributes {
    param ([string]$Path)
    try {
        if (Test-Path -LiteralPath $Path) {
            Write-Host "  -> Clearing Read-Only / System / Hidden attributes..." -ForegroundColor Gray
            attrib.exe -r -s -h "$Path" /s /d 2>$null | Out-Null
        }
    } catch {}
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5: Service management (WSearch / OneDrive pause)
# ─────────────────────────────────────────────────────────────────────────────
$script:StoppedServices = @()

function Stop-LockingServices {
    Write-Host "  -> Checking system services that may hold locks..." -ForegroundColor Gray
    $candidates = @("WSearch","OneDrive","MsMpEng")
    foreach ($svc in $candidates) {
        try {
            $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
            if ($s -and $s.Status -eq 'Running') {
                Stop-Service -Name $svc -Force -ErrorAction Stop
                $script:StoppedServices += $svc
                Write-Host "    [OK] Stopped service: $svc" -ForegroundColor Green
            }
        } catch {
            Write-Host "    [SKIP] Could not stop '$svc': $($_.Exception.Message)" -ForegroundColor Gray
        }
    }
}

function Restore-Services {
    foreach ($svc in $script:StoppedServices) {
        try { Start-Service -Name $svc -ErrorAction SilentlyContinue; Write-Host "  -> Restarted: $svc" -ForegroundColor Gray } catch {}
    }
    $script:StoppedServices = @()
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6: Reboot-scheduled deletion
# ─────────────────────────────────────────────────────────────────────────────
function Schedule-DeleteOnReboot {
    param ([string]$Path)
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
    try {
        $existing = (Get-ItemProperty -Path $regPath -Name "PendingFileRenameOperations" -ErrorAction SilentlyContinue).PendingFileRenameOperations
        $entriesToAdd = @()
        if (Test-Path -LiteralPath $Path) {
            $children = Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
            foreach ($child in $children) { $entriesToAdd += "\??\$($child.FullName)"; $entriesToAdd += "" }
        }
        $entriesToAdd += "\??\$Path"; $entriesToAdd += ""
        $newValue = if ($existing) { $existing + $entriesToAdd } else { $entriesToAdd }
        Set-ItemProperty -Path $regPath -Name "PendingFileRenameOperations" -Value $newValue -Type MultiString -ErrorAction Stop
        Write-Host "  [SCHEDULED] Will be deleted on next reboot." -ForegroundColor Cyan
        return $true
    } catch {
        Write-Host "  [WARN] Could not schedule reboot deletion: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7: Robocopy wipe helper
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-RobocopyWipe {
    param ([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $emptyDir = Join-Path $env:TEMP "unlock_empty_$(Get-Random)"
    try {
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
        Write-Host "  -> Robocopy mirror wipe..." -ForegroundColor Gray
        robocopy $emptyDir $Path /MIR /NJH /NJS /NFL /NDL /R:1 /W:0 2>&1 | Out-Null
    } finally { Remove-Item -Path $emptyDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8: Explorer restart
# ─────────────────────────────────────────────────────────────────────────────
function Restart-ExplorerProcess {
    param ([switch]$Silent)
    if (-not $Silent) { Write-Host "Restarting Windows Explorer..." -ForegroundColor Yellow }
    Stop-Process -Name "explorer" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (-not (Get-Process -Name "explorer" -ErrorAction SilentlyContinue)) { Start-Process "explorer.exe" }
    if (-not $Silent) { Write-Host "Windows Explorer restarted." -ForegroundColor Green }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 9: User-mode unlock
# ─────────────────────────────────────────────────────────────────────────────
function Unlock-Target {
    param ([string]$Path, [switch]$ForceKill)
    Write-Host "`nScanning locks for: $Path" -ForegroundColor Cyan
    $lockers = Get-LockingProcessesDetailed -Path $Path
    $criticalProcesses = @("system", "smss", "csrss", "wininit", "services", "lsass", "lsm", "winlogon", "sihost", "explorer")
    if ($lockers.Count -eq 0) {
        Write-Host "No direct locking processes found." -ForegroundColor Green
    } else {
        Write-Host "Found $($lockers.Count) locking process(es):" -ForegroundColor Yellow
        $lockers | Format-Table -AutoSize Id, ProcessName, LockReason, WindowTitle | Out-String | Write-Host
        if ($ForceKill) {
            foreach ($locker in $lockers) {
                if ($criticalProcesses -contains $locker.ProcessName.ToLower()) {
                    Write-Host "  [SKIP] Critical Windows OS process: $($locker.ProcessName) (PID $($locker.Id))" -ForegroundColor Gray
                    continue
                }
                Write-Host "Terminating: $($locker.ProcessName) (PID $($locker.Id))..." -ForegroundColor Yellow
                try {
                    Stop-Process -Id $locker.Id -Force -ErrorAction Stop
                    Write-Host "  [OK] Killed $($locker.ProcessName)" -ForegroundColor Green
                } catch {
                    Write-Host "  [FAIL] $($locker.ProcessName): $($_.Exception.Message)" -ForegroundColor Red
                }
            }
            Start-Sleep -Milliseconds 600
        }
    }

    # Force close kernel handles (e.g. system, sihost, background daemons)
    $null = Close-KernelHandles -Path $Path

    # Clear attributes (Read-only, System, Hidden)
    $null = Clear-Attributes -Path $Path
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 10: Kernel handle force-close
# ─────────────────────────────────────────────────────────────────────────────
function Close-KernelHandles {
    param ([string]$Path)
    if (-not (Test-IsAdmin)) {
        Write-Host "  [SKIP] Kernel handle close requires Administrator rights." -ForegroundColor Yellow
        return 0
    }
    Ensure-TypesLoaded
    Write-Host "  -> Force-closing kernel handles for: $Path" -ForegroundColor Gray
    try {
        $count = [KernelHandleScanner]::ForceCloseHandles($Path.TrimEnd('\'))
        if ($count -gt 0) { Write-Host "  [OK] Force-closed $count kernel handle(s)." -ForegroundColor Green }
        else               { Write-Host "  [INFO] No additional kernel handles found." -ForegroundColor Gray }
        return $count
    } catch {
        Write-Host "  [WARN] Kernel handle close failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return 0
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 11: Try-Delete helper
# ─────────────────────────────────────────────────────────────────────────────
function Try-Delete {
    param ([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        if ((Get-Item -LiteralPath $Path -Force) -is [System.IO.DirectoryInfo]) {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        } else {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        }
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
    } catch {}
    cmd.exe /c "rd /s /q `"$Path`"" 2>$null | Out-Null
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    return $false
}

function Show-Result {
    param ([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { Write-Host "`n>>> SUCCESS: '$Path' deleted! <<<`n" -ForegroundColor Green }
    else { Write-Host "`n>>> FAILED: '$Path' still exists. <<<`n" -ForegroundColor Red }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 12: Main 8-phase removal orchestrator
# ─────────────────────────────────────────────────────────────────────────────
function Remove-TargetItem {
    param ([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { Write-Host "Item does not exist: $Path" -ForegroundColor Yellow; return }

    Write-Host "`n===============================================" -ForegroundColor Cyan
    Write-Host "    FORCE UNLOCK & DELETE PROCESS STARTED      " -ForegroundColor Cyan
    Write-Host "==============================================="  -ForegroundColor Cyan
    Write-Host "Target: $Path" -ForegroundColor White

    Write-Host "`n[Phase 1] Terminating user-mode locking processes..." -ForegroundColor Magenta
    Unlock-Target -Path $Path -ForceKill

    Write-Host "`n[Phase 2] Restarting Explorer (shell lock release)..." -ForegroundColor Magenta
    Restart-ExplorerProcess -Silent; Start-Sleep -Milliseconds 500

    Write-Host "`n[Phase 3] Clearing file attributes..." -ForegroundColor Magenta
    Clear-Attributes -Path $Path

    Write-Host "`n[Phase 4] Standard deletion attempt..." -ForegroundColor Magenta
    if (Try-Delete -Path $Path) { Show-Result $Path; return }

    Write-Host "`n[Phase 5] Force-closing kernel handles..." -ForegroundColor Magenta
    $closed = Close-KernelHandles -Path $Path
    if ($closed -gt 0) { Start-Sleep -Milliseconds 500 }
    if (Try-Delete -Path $Path) { Show-Result $Path; return }

    Write-Host "`n[Phase 6] Stopping system services (WSearch, OneDrive)..." -ForegroundColor Magenta
    if (Test-IsAdmin) {
        Stop-LockingServices
        Start-Sleep -Seconds 2
        $deleted = Try-Delete -Path $Path
        Restore-Services
        if ($deleted) { Show-Result $Path; return }
    } else {
        Write-Host "  [SKIP] Not Administrator - service stop skipped." -ForegroundColor Yellow
        Write-Host "  TIP: Run as Administrator for full unlock power." -ForegroundColor Cyan
    }

    Write-Host "`n[Phase 7] Robocopy mirror wipe + retry..." -ForegroundColor Magenta
    Invoke-RobocopyWipe -Path $Path
    if (Try-Delete -Path $Path) { Show-Result $Path; return }

    Write-Host "`n[Phase 8] Scheduling deletion on next reboot..." -ForegroundColor Magenta
    if (Test-IsAdmin) {
        Schedule-DeleteOnReboot -Path $Path
        Write-Host "`n>>> REBOOT REQUIRED: Folder scheduled for deletion on next restart. <<<" -ForegroundColor Yellow
    } else {
        Write-Host "`n>>> FAILED: Run as Administrator and retry, or reboot. <<<" -ForegroundColor Red
        Write-Host "  1. Right-click UnlockFolder.bat -> Run as administrator" -ForegroundColor Gray
        Write-Host "  2. Disable antivirus real-time protection temporarily" -ForegroundColor Gray
        Write-Host "  3. Reboot and retry" -ForegroundColor Gray
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 13: Context menu
# ─────────────────────────────────────────────────────────────────────────────
function Install-ContextMenu {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { Get-Location }
    $batPath   = Join-Path $scriptDir "UnlockFolder.bat"

    $targets = @(
        "Software\Classes\Directory\shell",
        "Software\Classes\*\shell",
        "Software\Classes\Directory\Background\shell",
        "Software\Classes\Drive\shell"
    )

    foreach ($t in $targets) {
        $argPlaceholder = if ($t -like "*Background*") { "%V" } else { "%1" }

        # Unlock Only
        $uk = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$t\UnlockOnly")
        $uk.SetValue("", "Unlock (Release Locks)")
        $uk.SetValue("Icon", "shell32.dll,47")
        $ukc = $uk.CreateSubKey("command")
        $ukc.SetValue("", "`"$batPath`" `"$argPlaceholder`" --unlock")
        $ukc.Close(); $uk.Close()

        # Unlock & Force Delete
        $dk = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$t\UnlockAndDelete")
        $dk.SetValue("", "Unlock & Force Delete")
        $dk.SetValue("Icon", "shell32.dll,131")
        $dkc = $dk.CreateSubKey("command")
        $dkc.SetValue("", "`"$batPath`" `"$argPlaceholder`" --force-delete")
        $dkc.Close(); $dk.Close()

        # Check Locking Programs
        $sk = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$t\ScanLocks")
        $sk.SetValue("", "Check Locking Programs")
        $sk.SetValue("Icon", "shell32.dll,23")
        $skc = $sk.CreateSubKey("command")
        $skc.SetValue("", "`"$batPath`" `"$argPlaceholder`" --scan")
        $skc.Close(); $sk.Close()
    }

    Write-Host "`nContext Menu Installed Successfully!" -ForegroundColor Green
    Write-Host "Right-click any file, folder, or folder background in Windows Explorer to see:" -ForegroundColor Cyan
    Write-Host "  * Unlock (Release Locks)"  -ForegroundColor Yellow
    Write-Host "  * Unlock & Force Delete"   -ForegroundColor Red
    Write-Host "  * Check Locking Programs"  -ForegroundColor Cyan
}

function Uninstall-ContextMenu {
    $subKeys = @(
        "Software\Classes\Directory\shell\UnlockOnly",
        "Software\Classes\*\shell\UnlockOnly",
        "Software\Classes\Directory\Background\shell\UnlockOnly",
        "Software\Classes\Drive\shell\UnlockOnly",
        "Software\Classes\Directory\shell\UnlockAndDelete",
        "Software\Classes\*\shell\UnlockAndDelete",
        "Software\Classes\Directory\Background\shell\UnlockAndDelete",
        "Software\Classes\Drive\shell\UnlockAndDelete",
        "Software\Classes\Directory\shell\ScanLocks",
        "Software\Classes\*\shell\ScanLocks",
        "Software\Classes\Directory\Background\shell\ScanLocks",
        "Software\Classes\Drive\shell\ScanLocks"
    )
    foreach ($sk in $subKeys) {
        try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($sk, $false) } catch {}
    }
    Write-Host "`nContext menu entries removed successfully." -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 14: Main entry
# ─────────────────────────────────────────────────────────────────────────────
try {
    if (-not $NonInteractive -and [System.Environment]::UserInteractive) { [System.Console]::Clear() }
} catch {}
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "       WINDOWS FOLDER & FILE UNLOCKER / FORCE DELETE     " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

function Pause-IfInteractive {
    if (-not $NonInteractive) { Write-Host "`nPress Enter to exit..." -ForegroundColor Gray; try { Read-Host | Out-Null } catch {} }
}

if ($Action -eq "InstallMenu")     { Install-ContextMenu;     Pause-IfInteractive; exit }
if ($Action -eq "UninstallMenu")   { Uninstall-ContextMenu;   Pause-IfInteractive; exit }
if ($Action -eq "RestartExplorer") { Restart-ExplorerProcess; Pause-IfInteractive; exit }

if ([string]::IsNullOrWhiteSpace($TargetPath)) {
    Write-Host "`nEnter or drag-and-drop the path of the locked folder/file:" -ForegroundColor Yellow
    $TargetPath = Read-Host "Path"
}
$TargetPath = $TargetPath.Trim('"').Trim("'").Trim()

if ([string]::IsNullOrWhiteSpace($TargetPath) -or (-not (Test-Path -LiteralPath $TargetPath))) {
    Write-Host "`nError: Path does not exist: '$TargetPath'" -ForegroundColor Red
    Pause-IfInteractive; exit
}
$resolved = (Resolve-Path -LiteralPath $TargetPath).ProviderPath

if ($Action -eq "Delete")   { Remove-TargetItem -Path $resolved; Pause-IfInteractive; exit }
if ($Action -eq "Unlock")   { Unlock-Target -Path $resolved -ForceKill; Write-Host "`nLocks released!" -ForegroundColor Green; Pause-IfInteractive; exit }
if ($Action -eq "Scan") {
    $lk = Get-LockingProcessesDetailed -Path $resolved
    if ($lk.Count -eq 0) { Write-Host "`nNo user-mode locks detected." -ForegroundColor Green }
    else { $lk | Format-Table -AutoSize Id, ProcessName, LockReason, WindowTitle | Out-String | Write-Host }
    Pause-IfInteractive; exit
}
if ($Action -eq "DeepScan") {
    Write-Host "`n[Deep Scan] Enumerating kernel handles for: $resolved" -ForegroundColor Cyan
    $kl = Get-KernelLockInfo -Path $resolved
    if ($kl.Count -eq 0) { Write-Host "No kernel handles found." -ForegroundColor Green }
    else { $kl | Format-Table -AutoSize PID, ProcessName, Handle, LockedPath | Out-String | Write-Host }
    Pause-IfInteractive; exit
}

# ── Interactive Menu ─────────────────────────────────────────────────────────
while ($true) {
    Write-Host "`nSelected: $resolved" -ForegroundColor White
    Write-Host "Choose an action:" -ForegroundColor Cyan
    Write-Host " [1] Scan - Show user-mode locking processes"              -ForegroundColor Yellow
    Write-Host " [2] Deep Scan - Enumerate ALL kernel handles (Admin)"     -ForegroundColor Yellow
    Write-Host " [3] Unlock Only - Kill locking processes, no delete"      -ForegroundColor Yellow
    Write-Host " [4] Unlock & Force Delete (full 8-phase)"                -ForegroundColor Red
    Write-Host " [5] Restart Windows Explorer"                             -ForegroundColor Magenta
    Write-Host " [6] Add to Windows Right-Click Context Menu"             -ForegroundColor Cyan
    Write-Host " [7] Remove from Windows Right-Click Context Menu"        -ForegroundColor Gray
    Write-Host " [Q] Quit"                                                 -ForegroundColor Gray

    $choice = Read-Host "`nEnter option [1-7 or Q]"
    switch ($choice.ToUpper()) {
        "1" {
            $lk = Get-LockingProcessesDetailed -Path $resolved
            if ($lk.Count -eq 0) { Write-Host "No user-mode locks." -ForegroundColor Green }
            else { $lk | Format-Table -AutoSize Id, ProcessName, LockReason, WindowTitle | Out-String | Write-Host }
        }
        "2" {
            Write-Host "`n[Deep Scan] Kernel handle enumeration..." -ForegroundColor Cyan
            $kl = Get-KernelLockInfo -Path $resolved
            if ($kl.Count -eq 0) { Write-Host "No kernel handles found." -ForegroundColor Green }
            else { $kl | Format-Table -AutoSize PID, ProcessName, Handle, LockedPath | Out-String | Write-Host }
        }
        "3" {
            Unlock-Target -Path $resolved -ForceKill
            Write-Host "`nLocks released. You can now rename/move/delete the item." -ForegroundColor Green
        }
        "4" {
            Remove-TargetItem -Path $resolved
            if (-not (Test-Path -LiteralPath $resolved)) { break }
        }
        "5" { Restart-ExplorerProcess }
        "6" { Install-ContextMenu }
        "7" { Uninstall-ContextMenu }
        "Q" { break }
        default { Write-Host "Invalid option." -ForegroundColor Yellow }
    }
    if ($choice.ToUpper() -eq "Q") { break }
    if ($choice -eq "4" -and -not (Test-Path -LiteralPath $resolved)) { break }
}
