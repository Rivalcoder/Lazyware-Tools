@echo off
setlocal

set "CONFIG_DIR=%LOCALAPPDATA%\PBIX-Model-Studio"
set "CONFIG_FILE=%CONFIG_DIR%\project-path.txt"
set "OLD_LOCAL_CONFIG_FILE=%~dp0PBIX-Model-Studio.path"

if exist "%OLD_LOCAL_CONFIG_FILE%" del /q "%OLD_LOCAL_CONFIG_FILE%"

if defined PBIX_MODEL_STUDIO_HOME (
	set "PROJECT_DIR=%PBIX_MODEL_STUDIO_HOME%"
	call :normalize_project_dir
	if exist "%PROJECT_DIR%\scripts\start_pbix_studio.bat" goto :project_found
)

if exist "%CONFIG_FILE%" (
	set /p "PROJECT_DIR="<"%CONFIG_FILE%"
	call :normalize_project_dir
	if exist "%PROJECT_DIR%\scripts\start_pbix_studio.bat" goto :project_found
)

set "PROJECT_DIR=%~dp0"
if exist "%PROJECT_DIR%scripts\start_pbix_studio.bat" goto :project_found

for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI\"
if exist "%PROJECT_DIR%scripts\start_pbix_studio.bat" goto :project_found

:request_project_folder
echo.
echo PBIX Model Studio files were not found automatically.
echo Enter the project folder, or drag that folder here.
set "PROJECT_DIR="
set /p "PROJECT_DIR=Project folder: "
if not defined PROJECT_DIR goto :request_project_folder

call :normalize_project_dir
if not exist "%PROJECT_DIR%\scripts\start_pbix_studio.bat" (
	echo [ERROR] scripts\start_pbix_studio.bat was not found in that folder.
	goto :request_project_folder
)

:project_found
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
>"%CONFIG_FILE%" echo %PROJECT_DIR%
setx PBIX_MODEL_STUDIO_HOME "%PROJECT_DIR%" >nul
call "%PROJECT_DIR%\scripts\start_pbix_studio.bat"
exit /b

:normalize_project_dir
set "PROJECT_DIR=%PROJECT_DIR:"=%"
for %%I in ("%PROJECT_DIR%") do set "PROJECT_DIR=%%~fI"
exit /b