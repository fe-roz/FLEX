@echo test
chdir /d C:\FLEX\cors-anywhere-master\cors-anywhere-master
START "" node server.js
chdir /d C:\FLEX\Cesium-1.109
START "" npm run start
START chrome http://localhost:8081/Apps/HelloWorld.html
pause
TASKKILL /F /IM cmd.exe /T 
@echo done
pause