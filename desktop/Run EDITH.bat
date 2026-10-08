@echo off
rem E.D.I.T.H - PC edition launcher. Finds Python 3, starts edith.py, and keeps this window open on an error.
setlocal
cd /d "%~dp0"
set "PYEXE="
set "PYARGS="

if exist "%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe" (
    set "PYEXE=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
    goto run
)
py -3 --version >nul 2>nul
if not errorlevel 1 (
    set "PYEXE=py"
    set "PYARGS=-3"
    goto run
)
rem "python" can be the Microsoft Store placeholder, which only prints a message: check it really runs.
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
if not errorlevel 1 (
    set "PYEXE=python"
    goto run
)
echo.
echo  E.D.I.T.H needs Python 3.9 or newer, and none was found.
echo  Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),
echo  then double-click "Run EDITH.bat" again.
echo.
pause
exit /b 1

:run
echo Starting E.D.I.T.H ...
"%PYEXE%" %PYARGS% "%~dp0edith.py" %*
if errorlevel 1 (
    echo.
    echo  E.D.I.T.H stopped with an error ^(code %errorlevel%^). The messages above say why.
    echo.
    pause
)
endlocal
