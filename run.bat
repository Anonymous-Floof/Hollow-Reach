@echo off
title Voxel Sandbox
echo Starting the Voxel Sandbox server...
echo.

rem Prefer the Windows Python launcher, fall back to python on PATH.
where py >nul 2>nul
if %errorlevel%==0 (
    py "%~dp0server.py"
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    python "%~dp0server.py"
    goto :end
)

echo.
echo ============================================================
echo  Python 3 was not found on your system.
echo  Install it from https://www.python.org/downloads/
echo  (tick "Add Python to PATH" during install), then run again.
echo ============================================================
echo.
pause

:end
