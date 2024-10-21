#!/bin/bash

# Check if Node.js is installed
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed. Please install Node.js and try again."
    exit 1
fi

# Check if npm is installed
if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed. Please install npm and try again."
    exit 1
fi

# Function to clean up and exit
cleanup() {
  echo "Cleaning up and exiting..."
  # Kill all background processes
  pkill -P $$
  lsof -ti:8081 | xargs kill -9 2>/dev/null
  exit
}
trap cleanup SIGINT

# Install dependencies for cors-anywhere
if [ -d "cors-anywhere-master" ]; then
  echo "Installing dependencies for cors-anywhere..."
  (cd cors-anywhere-master/cors-anywhere-master && npm install)
else
  echo "Directory 'cors-anywhere-master' does not exist."
  exit 1
fi

# Install dependencies for potree
if [ -d "PotreeCopied" ]; then
  echo "Installing dependencies for potree..."
  (cd PotreeCopied && npm install)
else
  echo "Directory 'PotreeCopied' does not exist."
  exit 1
fi

# Run cors-anywhere
if [ -d "cors-anywhere-master" ]; then
  (cd cors-anywhere-master/cors-anywhere-master && node server.js) &
else
  echo "Directory 'cors-anywhere-master' does not exist."
fi

# Run Cesium
node server.js &

# Check if running in X11 or Wayland session
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    open http://localhost:8081/Apps/HelloWorld.html &
else
    echo "Not running in X11 or Wayland session. Please open http://localhost:8081/Apps/HelloWorld.html manually."
fi

# Wait for the Enter key to be pressed
read -p "Press Enter to exit..."

# Clean up and exit
#cleanup
