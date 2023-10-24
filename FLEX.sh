#!/bin/sh
echo "test"

# Function to clean up and exit
cleanup() {
  echo "Cleaning up and exiting..."
  # Kill all background processes
  pkill -P $$
  npx kill-port 8081
  exit
}
trap cleanup SIGINT

if [ -d "cors-anywhere-master" ]; then
  (cd cors-anywhere-master/cors-anywhere-master && node server.js) &
else
  echo "Directory 'cors-anywhere-master' does not exist."
fi

if [ -d "Cesium-1.109" ]; then
  (cd Cesium-1.109 && npm run start) &
else
  echo "Directory 'Cesium-1.109' does not exist."
fi

# Open Google Chrome with the specified URL
open -a "Google Chrome" http://localhost:8081/Apps/HelloWorld.html &

# Wait for the Enter key to be pressed
read -p "Press Enter to exit..."

# Clean up and exit
cleanup
