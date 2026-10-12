@echo off
setlocal EnableDelayedExpansion

:: ==============================================================
:: Windows Folder & File Unlocker / Force Deletion Launcher
:: Supports Drag-and-Drop, Right-Click, and Interactive CLI
:: ==============================================================

title Windows Folder and File Unlocker (Enhanced)

set "TARGET=%~1"
set "ACTION_FLAG=%~2"
set "EXTRA_FLAG=%~3"
set "PS_ACTION="
set "PS_EXTRA="

if /i "%ACTION_FLAG%"=="--force-delete" set "PS_ACTION=-Action Delete"
if /i "%ACTION_FLAG%"=="--scan"         set "PS_ACTION=-Action Scan"
if /i "%ACTION_FLAG%"=="--deep-scan"    set "PS_ACTION=-Action DeepScan"
if /i "%ACTION_FLAG%"=="--unlock"       set "PS_ACTION=-Action Unlock"
if /i "%ACTION_FLAG%"=="--install"      set "PS_ACTION=-Action InstallMenu"
if /i "%ACTION_FLAG%"=="--uninstall"    set "PS_ACTION=-Action UninstallMenu"

if /i "%ACTION_FLAG%"=="--non-interactive" set "PS_EXTRA=-NonInteractive"
if /i "%EXTRA_FLAG%"=="--non-interactive"  set "PS_EXTRA=-NonInteractive"

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%UnlockFolder.ps1"

:: Check if PowerShell is available
where powershell.exe >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] powershell.exe was not found on your system!
    pause
    exit /b 1
)

:: If a target was provided (drag-and-drop or argument)
if defined TARGET (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -TargetPath "%TARGET%" %PS_ACTION% %PS_EXTRA%
    exit /b %ERRORLEVEL%
)

:: If no target was provided, launch interactive menu
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
exit /b %ERRORLEVEL%
