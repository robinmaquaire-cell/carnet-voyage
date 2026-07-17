@echo off
chcp 65001 >nul
title Publier TraceMap sur GitHub
cd /d "%~dp0"
echo ============================================
echo   Envoi de TraceMap vers GitHub
echo ============================================
echo.
echo Si une fenetre de connexion GitHub s'ouvre,
echo connecte-toi puis clique sur "Authorize".
echo (C'est demande une seule fois.)
echo.
git push -u origin main
echo.
echo ----------------------------------------
echo Termine. Tu peux fermer cette fenetre.
pause
