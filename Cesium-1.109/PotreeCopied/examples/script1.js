import * as THREE from "../../libs/three.js/build/three.module.js";
	
		window.viewer = new Potree.Viewer(document.getElementById("potree_render_area"));
		
		viewer.setEDLEnabled(true);
		viewer.setFOV(80);
		viewer.setPointBudget(6_000_000);
		viewer.loadSettingsFromURL();
		viewer.setControls(viewer.fpControls);
		
		viewer.setDescription('Point cloud courtesy of USGS/Entwine');
		
		viewer.loadGUI(() => {
			viewer.setLanguage('en');
			$("#menu_tools").next().show();
			//viewer.toggleSidebar();
		});
		
		// Load and add point cloud to scene
		Potree.loadPointCloud("https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SantaCruzCounty_2020/ept.json", "CA_SantaCruzCounty_2020", function(e){
			let scene = viewer.scene;
			let pointcloud = e.pointcloud;
			
			let material = pointcloud.material;
			material.size = 0.5;
			material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
			material.shape = Potree.PointShape.CIRCLE;
			material.activeAttributeName = "elevation";

			scene.addPointCloud(pointcloud);

			let pointcloudProjection = e.pointcloud.projection;
			let mapProjection = proj4.defs("WGS84");

			window.toMap = proj4(pointcloudProjection, mapProjection);
			window.toScene = proj4(mapProjection, pointcloudProjection);

			scene.view.setView(
			[-13586486.800,	4439140.320,	229.360],
			[696072.86, 3916730.04, 82.04],
		);
		});
		