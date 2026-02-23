@echo off
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0Deploy-BakerStreet.ps1" %*
