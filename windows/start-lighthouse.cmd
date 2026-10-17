@echo off
rem Double-click to start Lighthouse. Runs start-lighthouse.ps1 without changing PowerShell's script policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-lighthouse.ps1" %*
