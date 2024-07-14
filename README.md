## FLEX

This is the first draft of the LIDAR visualizer tool based on CesiumJS and Potree with many different data sources. It is not very polihed, has many bugs and lacks many features. 

This whole repository needs to be organized and credits and licenses need to be updated. 

---
2024 National Speleological Society Convention presentation about the project:
https://docs.google.com/presentation/d/1ijDiJJ1g6IRt8oCFVmPTKpNqkT0I9oWBMN1QG8OYKQc/edit?usp=sharing

---
https://feroz.us/FLEX-demo.mp4

---

## Installation

Install Node: https://radixweb.com/blog/installing-npm-and-nodejs-on-windows-and-mac#npm
For Mac: `brew install node`


Here is a rough procedure to get it working. I do not have a lot of experience publishing software so you will probably need to figure out a couple of things on your own, but this is a good list of tasks to do in order to get the software running:

Navigate to the main Cesium-1.109 folder and run 
```sh
npm install cesium --save
```

You might need to navigate into the PotreeCopied folder inside of that and run npm install there as well to get Potree working. 
```sh
npm install
```

You'll also have to install npm http-proxy to bypass the CORS restrictions:
```sh
npm install http-proxy
```

The cors-anywhere-master folder is a tool to run a local server and bypass some CORS restrictions on Chrome and facilitate the use of some types of map data. This might need some installing as well. This is certainly not the best way to do this but it works for now. 

You also need to change the Cesium access token to one of your own - navigate to FLEX\Cesium-1.109\Tokens.JS and add a Cesium.Ion.defaultAccessToken that you can get from https://cesium.com/. I'd like to untie this from Cesium ION at some point but for now this is the only way I have to get the terrain data. I have removed mine from the code I uploaded because I believe it is only meant for personal use. Also Add your Google Maps API key if you want the Google Maps Model to work.

--- 
## Starting the tool

To quickly start it on my computer, I created a simple bash file on the desktop "FLEX.bat" that initializes the servers and opens up a localhost on the browser to display the tool. If you want to use it too, you probably need to change the paths after "chdir" on this file to point to wherever the files end up on your computer. 

For mac or linux systems, you can start up the webapp using `./FLEX.sh`.

---
## Using the tool

Use the mouse to navigate around the globe. Zoom/Tilt/Pan work as usual. 

Press F to switch to flying mode. In this mode, use the mouse to change the camera orintation and W,A,S,D,Q,E to fly around. Speed can be controlled using the mouse scrollwheel. I set it so that the flying speed also changes with altitude relative to the ellipsoid to make navigating long distances easier.

Use the sliders and drop-down menus on the top left to add and change the transparency of the different map layers. 

Press L to display/hide the outlines of all available LIDAR datasets. 

Click on a LIDAR dataset to view info about it a new window should pop up. On this window, click on the smaller camera button to display the 3D point cloud on the screen. This part requires decent internet and a decent GPU. 

Press R to remove all Point Clouds. 

Find the browser's developer tools (F12 usually) and navigate to the console if you want to get the coordinates for the camera position and for some useful debugging info.

Tip: fly underground and look up to find points of interest. Sinks and pits show up very clearly from below.

---
## Future functionalities

- Waypoints/Features: CesiumJS can handle KMl/Json natively. It is easy to add waypoints and tracks to the map. I'd like to add something similar to Gaia/CalTopo integrated here that shows known locations, tracks and areas on the map. 

- Point Cloud tools: Potree has some tools to measure distances in between point cloud points. It is really useful to find minimum depths of karst features. I'd like to bring that over to the tool. Currently, all navigation is done in Cesium and Potree just displays on top of the Cesium window, so we might need to give Potree access to the cursor location to get that working.

- Cave Survey Data: It would be awesome to display cave survey data here. A simple way to get this would be to export a 3D file from Compass and add it to Cesium, but it could also be interesting to start from the raw survey data and do the processing here. 

- Other map sources: Google maps has high detail satellite imagery, as well as historic imagery available in Google Earth Pro. It would be pretty useful to add those there. 

- Point cloud distance limit: It would be good to reduce the hardware requirements by limiting the distance at which points are displayed. 

- Point cloud Coloring by classification: Should not be too hard, Potree has some functions like that. 

- Fix the point cloud to the ground properly. Currently it floats a little bit (gets worse for higher latitudes).

---

As you can see, there is a lot of organizing and cleaning up to do here. This is my first real software project and I am learning a lot as I go. If you have any suggestions on how to organize things or any guidelines to follow while using GitHub, please let me know. If you are interested in joining the project and helping, feel free to reach out to me and we can figure out something that works!

