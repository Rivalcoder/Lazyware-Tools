@echo off
title OmniStorage Pro - Native High-Speed C# Engine
echo ========================================================
echo   OmniStorage Pro - Native High-Speed C# Backend Engine
echo ========================================================
if not exist "OmniStorageEngine.exe" (
    echo Compiling native 64-bit C# engine...
    C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /platform:x64 /r:System.Web.Extensions.dll /out:OmniStorageEngine.exe OmniStorageEngine.cs
)
echo Starting native device engine on http://localhost:4455...
start http://localhost:4455
OmniStorageEngine.exe
pause
