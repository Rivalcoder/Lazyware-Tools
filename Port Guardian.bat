@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Port Guardian
color 0B

for /F %%a in ('echo prompt $E^|cmd') do set "ESC=%%a"
set "C_CYAN=%ESC%[96m"
set "C_WHITE=%ESC%[97m"
set "C_YELLOW=%ESC%[93m"
set "C_GREEN=%ESC%[92m"
set "C_MAGENTA=%ESC%[95m"
set "C_RED=%ESC%[91m"
set "C_BLUE=%ESC%[94m"
set "C_RESET=%ESC%[0m"

call :splash
goto :menu

:splash
cls
color 0A
echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║              ██████╗ ██████╗                 ║
echo   ║              ██╔══██╗██╔══██╗                ║
echo   ║              ██║  ██║██████╔╝                ║
echo   ║              ██║  ██║██╔═══╝                 ║
echo   ║              ██████╔╝██║                     ║
echo   ║              ╚═════╝ ╚═╝                     ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝
echo.
color 0B
call :typewriter "        PORT GUARDIAN  -  created by Dp"
echo.
echo.
set "BAR="
<nul set /p ".=   Loading "
for /l %%I in (1,1,20) do (
    set "BAR=!BAR!█"
    <nul set /p ".=█"
    ping -n 1 -w 40 127.0.0.1 >nul
)
echo   100%%
timeout /t 1 >nul
goto :eof

:typewriter
set "MSG=%~1"
:tw_loop
if "%MSG%"=="" goto :eof
set "CH=%MSG:~0,1%"
set "MSG=%MSG:~1%"
<nul set /p ".=%CH%"
goto tw_loop

:menu
cls
echo.
echo   %C_CYAN%╔══════════════════════════════════════════════╗
echo   ║           ◆ P O R T   G U A R D I A N  ◆     ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
echo    %C_CYAN%[1] ◆  Kill process by PORT%C_RESET%
echo    %C_YELLOW%[2] ■  List all LISTENING ports%C_RESET%
echo    %C_MAGENTA%[3] ▲  Kill process by PID%C_RESET%
echo    %C_GREEN%[4] ●  Find what's using a PORT (no kill)%C_RESET%
echo    %C_BLUE%[5] ★  Kill process by NAME%C_RESET%
echo    %C_WHITE%[6] ▣  Export listening ports to a file%C_RESET%
echo    %C_RED%[7] ✖  Exit%C_RESET%
echo.
set /p CHOICE=   %C_WHITE%Choose an option (1-7): %C_RESET%

if "%CHOICE%"=="1" goto killbyport
if "%CHOICE%"=="2" goto listports
if "%CHOICE%"=="3" goto killbypid
if "%CHOICE%"=="4" goto findport
if "%CHOICE%"=="5" goto killbyname
if "%CHOICE%"=="6" goto exportports
if "%CHOICE%"=="7" goto :bye
echo.
echo    %C_RED%!  Invalid option, try again.%C_RESET%
timeout /t 1 >nul
goto menu

:killbyport
cls
color 0B
echo.
echo   %C_CYAN%╔══════════════════════════════════════════════╗
echo   ║           ◆  KILL PROCESS BY PORT            ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
set /p PORT=   Enter the port number: 
call :checknum "%PORT%"
if errorlevel 1 (
    echo.
    echo    %C_RED%!  Invalid input - port must be numbers only ^(e.g. 3000^).%C_RESET%
    echo.
    pause
    goto :menu
)
echo.
echo   %C_CYAN%Searching for processes on port %PORT% ...%C_RESET%
echo.

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do (
    set "FOUND=1"
    call :killpid %%P
)

if "!FOUND!"=="0" (
    echo    %C_YELLOW%!  No process found listening on port %PORT%.%C_RESET%
)

echo.
pause
goto :menu

:killbypid
cls
color 0B
echo.
echo   %C_MAGENTA%╔══════════════════════════════════════════════╗
echo   ║           ▲  KILL PROCESS BY PID             ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
set /p KPID=   Enter the PID to kill: 
call :checknum "%KPID%"
if errorlevel 1 (
    echo.
    echo    %C_RED%!  Invalid input - PID must be numbers only.%C_RESET%
    echo.
    pause
    goto :menu
)
call :killpid %KPID%
echo.
pause
goto :menu

:findport
cls
color 0B
echo.
echo   %C_GREEN%╔══════════════════════════════════════════════╗
echo   ║        ●  FIND PROCESS USING A PORT          ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
set /p PORT=   Enter the port number: 
call :checknum "%PORT%"
if errorlevel 1 (
    echo.
    echo    %C_RED%!  Invalid input - port must be numbers only ^(e.g. 3000^).%C_RESET%
    echo.
    pause
    goto :menu
)
echo.

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do (
    set "FOUND=1"
    set "PNAME=unknown"
    for /f "usebackq tokens=1 delims=," %%N in (`tasklist /FI "PID eq %%P" /NH /FO CSV 2^>nul`) do (
        set "PNAME=%%~N"
    )
    echo    %C_GREEN%✓%C_RESET%  PID %C_YELLOW%%%P%C_RESET%  ^|  Process: %C_GREEN%!PNAME!%C_RESET%  ^|  Port: %C_CYAN%%PORT%%C_RESET%
)

if "!FOUND!"=="0" (
    echo    %C_YELLOW%!  No process found listening on port %PORT%.%C_RESET%
)

echo.
pause
goto :menu

:listports
cls
color 0B
echo.
echo   %C_YELLOW%╔══════════════════════════════════════════════╗
echo   ║           ■  ALL LISTENING PORTS             ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
call :padstr H_PROTO "PROTO" 7
call :padstr H_ADDR "LOCAL ADDRESS" 28
call :padstr H_PID "PID" 8
echo    %C_MAGENTA%!H_PROTO!!H_ADDR!!H_PID!PROCESS%C_RESET%
echo    %C_WHITE%─────  ────────────────────────  ──────  ───────────────%C_RESET%
for /f "tokens=1,2,5" %%A in ('netstat -ano ^| findstr "LISTENING"') do (
    set "PNAME=unknown"
    for /f "usebackq tokens=1 delims=," %%N in (`tasklist /FI "PID eq %%C" /NH /FO CSV 2^>nul`) do (
        set "PNAME=%%~N"
    )
    call :padstr ROW_PROTO "%%A" 7
    call :padstr ROW_ADDR "%%B" 28
    call :padstr ROW_PID "%%C" 8
    echo    %C_CYAN%!ROW_PROTO!%C_WHITE%!ROW_ADDR!%C_YELLOW%!ROW_PID!%C_GREEN%!PNAME!%C_RESET%
)
echo.
pause
goto :menu

:padstr
setlocal EnableDelayedExpansion
set "W=%~3"
set "str=%~2                                                            "
set "str=!str:~0,%W%!"
endlocal & set "%~1=%str%"
goto :eof

:checknum
setlocal
set "V=%~1"
echo(%V%| findstr /r "^[0-9][0-9]*$" >nul
set "RC=%errorlevel%"
endlocal & exit /b %RC%

:killbyname
cls
color 0B
echo.
echo   %C_BLUE%╔══════════════════════════════════════════════╗
echo   ║           ★  KILL PROCESS BY NAME            ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
set /p PNAME_QUERY=   Enter the process name (e.g. chrome.exe): 
echo.

set "FOUND=0"
for /f "usebackq tokens=2 delims=," %%P in (`tasklist /FI "IMAGENAME eq %PNAME_QUERY%" /NH /FO CSV 2^>nul`) do (
    set "FOUND=1"
    set "RAWPID=%%~P"
    call :killpid !RAWPID!
)

if "!FOUND!"=="0" (
    echo    %C_YELLOW%!  No running process matches "%PNAME_QUERY%".%C_RESET%
)

echo.
pause
goto :menu

:exportports
cls
color 0B
echo.
echo   %C_WHITE%╔══════════════════════════════════════════════╗
echo   ║        ▣  EXPORT LISTENING PORTS TO FILE         ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
for /f "tokens=2-4 delims=/ " %%A in ('date /t') do set "DSTAMP=%%C-%%A-%%B"
for /f "tokens=1-2 delims=: " %%A in ('time /t') do set "TSTAMP=%%A%%B"
set "OUTFILE=%~dp0PortReport_!DSTAMP!_!TSTAMP!.txt"
echo    Exporting active listening ports ...
(
    echo Port Guardian - Listening Ports Report
    echo Generated: %DATE% %TIME%
    echo.
    echo PROTO   LOCAL ADDRESS                  PID     PROCESS
    for /f "tokens=1,2,5" %%A in ('netstat -ano ^| findstr "LISTENING"') do (
        set "PNAME=unknown"
        for /f "usebackq tokens=1 delims=," %%N in (`tasklist /FI "PID eq %%C" /NH /FO CSV 2^>nul`) do (
            set "PNAME=%%~N"
        )
        echo %%A   %%B   %%C   !PNAME!
    )
) > "!OUTFILE!"
echo    %C_GREEN%✓  Report saved to: !OUTFILE!%C_RESET%
echo.
pause
goto :menu

:killpid
set "PID=%~1"
set "PNAME=unknown"
for /f "usebackq tokens=1 delims=," %%N in (`tasklist /FI "PID eq %PID%" /NH /FO CSV 2^>nul`) do (
    set "PNAME=%%~N"
)
if "%PID%"=="0" set "PNAME=System Idle Process"
if "%PID%"=="4" set "PNAME=System"
if "%PID%"=="0" goto skipkill_critical
if "%PID%"=="4" goto skipkill_critical
echo    %C_YELLOW%⚡  Found PID !PID! ^(!PNAME!^). Killing it...%C_RESET%
taskkill /PID !PID! /F >nul 2>&1
if errorlevel 1 (
    echo    %C_RED%✖  Failed to kill PID !PID!. Try running as Administrator.%C_RESET%
) else (
    echo    %C_GREEN%✓  Successfully killed PID !PID! ^(!PNAME!^).%C_RESET%
)
goto :eof

:skipkill_critical
echo    %C_RED%!  PID !PID! ^(!PNAME!^) is a critical system process - skipped.%C_RESET%
goto :eof

:bye
cls
color 0D
echo.
echo   %C_MAGENTA%╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║       ♥  Thanks for using Port Guardian!      ║
echo   ║                                              ║
echo   ║                   Made by Dp                 ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝%C_RESET%
echo.
for /l %%I in (1,1,3) do (
    <nul set /p ".=   Closing "
    ping -n 1 -w 200 127.0.0.1 >nul
    cls
    color 0D
    echo.
    echo   %C_MAGENTA%╔══════════════════════════════════════════════╗
    echo   ║                                              ║
    echo   ║       ♥  Thanks for using Port Guardian!      ║
    echo   ║                                              ║
    echo   ║                   Made by Dp                 ║
    echo   ║                                              ║
    echo   ╚══════════════════════════════════════════════╝%C_RESET%
    echo.
)
timeout /t 1 >nul
endlocal
exit
