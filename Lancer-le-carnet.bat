@echo off
chcp 65001 >nul
title Carnet de voyage
echo ============================================
echo   Carnet de voyage - demarrage du serveur
echo ============================================
echo.
echo Le carnet va s'ouvrir dans ton navigateur.
echo Garde cette fenetre noire OUVERTE pendant que tu utilises l'app.
echo Pour arreter : ferme cette fenetre.
echo.

REM On se place dans le dossier de l'application (la ou est ce fichier .bat)
cd /d "%~dp0"

REM On ouvre le navigateur sur la bonne adresse
start "" "http://localhost:8754"

REM On lance le mini-serveur qui sert le dossier (la 1re fois, il telecharge "serve", patiente quelques secondes)
npx --yes serve --no-clipboard -l 8754 .
pause
