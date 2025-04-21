@echo test
chdir /d C:\FLEX
START "" node server.js
START chrome http://localhost:8081/index.html
pause
TASKKILL /F /IM cmd.exe /T 
@echo done
pause
