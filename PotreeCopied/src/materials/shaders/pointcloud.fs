
#if defined paraboloid_point_shape || defined splat_enabled   // FLEX: splat mode writes its own depth
	#extension GL_EXT_frag_depth : enable
#endif

precision highp float;
precision highp int;

uniform mat4 viewMatrix;
uniform mat4 uViewInv;
uniform mat4 uProjInv;
uniform vec3 cameraPosition;


uniform mat4 projectionMatrix;
uniform float uOpacity;

uniform float blendHardness;
uniform float blendDepthSupplement;
uniform float fov;
uniform float uSpacing;
uniform float near;
uniform float far;
uniform float uPCIndex;
uniform float uScreenWidth;
uniform float uScreenHeight;

varying vec3	vColor;
varying float	vLogDepth;
varying vec3	vViewPosition;
varying float	vRadius;
varying float 	vPointSize;
varying vec3 	vPosition;

// FLEX: Splat mode [beta], see pointcloud.vs (doSplat) and client/src/modules/splat-mode.js
#if defined(splat_enabled)
uniform vec4      uSplatP;         // fill, max px, band, opacity
uniform vec4      uSplatCx;        // imagery atlas: pixel x (relative to the window origin) = dot(uSplatCx, (1, dx, dy, dx*dy))
uniform vec4      uSplatCy;        //   same for pixel y; dx, dy = metres from the window centre, ground-grid frame
uniform vec2      uSplatCtr;       // the window centre in the ground-grid frame
uniform vec4      uSplatWin;       // (atlas offset x, y of the window origin in pixels, window size in pixels, atlas size)
uniform float     uSplatColOn;     // 1 = an atlas is bound
uniform sampler2D uSplatColTex;
varying float vSplatKind;
varying float vSplatR;
varying vec3  vSplatN;
varying vec3  vSplatG;
varying vec3  vSplatMA;
varying vec3  vSplatMB;
varying vec3  vSplatMC;
varying vec3  vSplatRgb;
varying float vSplatLit;
varying float vSplatBias;    // metres
#endif


float specularStrength = 1.0;

void main() {

	// gl_FragColor = vec4(vColor, 1.0);

	vec3 color = vColor;
	float depth = gl_FragCoord.z;
	#if defined(splat_enabled) && !defined(paraboloid_point_shape)
		gl_FragDepthEXT = gl_FragCoord.z;   // FLEX: a shader that writes depth must write it on every path
	#endif

	#if defined(circle_point_shape) || defined(paraboloid_point_shape) 
		float u = 2.0 * gl_PointCoord.x - 1.0;
		float v = 2.0 * gl_PointCoord.y - 1.0;
	#endif
	
	#if defined(circle_point_shape) 
		float cc = u*u + v*v;
		if(cc > 1.0){
			discard;
		}
	#endif
		
	#if defined color_type_indices
		gl_FragColor = vec4(color, uPCIndex / 255.0);
	#else
		gl_FragColor = vec4(color, uOpacity);
	#endif

	#if defined paraboloid_point_shape
		float wi = 0.0 - ( u*u + v*v);
		vec4 pos = vec4(vViewPosition, 1.0);
		pos.z += wi * vRadius;
		float linearDepth = -pos.z;
		pos = projectionMatrix * pos;
		pos = pos / pos.w;
		float expDepth = pos.z;
		depth = (pos.z + 1.0) / 2.0;
		gl_FragDepthEXT = depth;
		
		#if defined(color_type_depth)
			color.r = linearDepth;
			color.g = expDepth;
		#endif
		
		#if defined(use_edl)
			gl_FragColor.a = log2(linearDepth);
		#endif
		
	#else
		#if defined(use_edl)
			gl_FragColor.a = vLogDepth;
		#endif
	#endif

	#if defined(weighted_splats)
		float distance = 2.0 * length(gl_PointCoord.xy - 0.5);
		float weight = max(0.0, 1.0 - distance);
		weight = pow(weight, 1.5);

		gl_FragColor.a = weight;
		gl_FragColor.xyz = gl_FragColor.xyz * weight;
	#endif


	#if defined(splat_enabled)
	if (vSplatKind > 0.5) { // FLEX: Splat mode [beta]
		// Ray through this pixel (view space, perspective), intersected with the disc's plane.
		vec2 ndc = gl_FragCoord.xy / vec2(uScreenWidth, uScreenHeight) * 2.0 - 1.0;
		vec3 rd = vec3(ndc.x / projectionMatrix[0][0], ndc.y / projectionMatrix[1][1], -1.0);
		float nd = dot(vSplatN, rd);
		if (abs(nd) < 1e-3) { discard; }
		float tt = dot(vSplatN, vViewPosition) / nd;
		if (tt <= 0.0) { discard; }
		// Coarse nodes' discs are pushed back by a fraction of their spacing, so where finer discs exist they win the
		// depth test (a big flat disc leaves the curved ground at its edge and would show as a ring).
		tt += vSplatBias / length(rd);
		vec3 P = rd * tt;
		vec3 off = P - vViewPosition;
		float r2 = dot(off, off) / (vSplatR * vSplatR);
		if (r2 > 1.0) { discard; }
		// Soft edge, drawn as stochastic discard: the pass is opaque, depth-tested and depth-writing, so overlapping
		// discs of one surface merge without sorted blending. The noise includes the disc's position, so where discs
		// overlap the pixel is kept if ANY of them keeps it: the edges soften and the gaps close.
		// (Opacity is not done here: see the layer opacity in the EDL pass / below.)
		float a = 1.0 - smoothstep(0.35, 1.0, r2);
		float noise = fract(sin(dot(gl_FragCoord.xy * 0.37 + vSplatG.xy * 7.13, vec2(12.9898, 78.233))) * 43758.5453);
		if (a < noise) { discard; }
		vec3 base = vSplatRgb;
		if (uSplatColOn > 0.5) {
			vec2 gxy = vSplatG.xy + vSplatMA.xy * off.x + vSplatMB.xy * off.y + vSplatMC.xy * off.z;
			vec2 d = gxy - uSplatCtr;
			vec4 m = vec4(1.0, d.x, d.y, d.x * d.y);
			vec2 pr = vec2(dot(uSplatCx, m), dot(uSplatCy, m));
			if (pr.x > 0.0 && pr.y > 0.0 && pr.x < uSplatWin.z && pr.y < uSplatWin.z) {
				vec4 tc = texture2D(uSplatColTex, (pr + uSplatWin.xy) / uSplatWin.w);
				base = mix(base, clamp(tc.rgb / max(tc.a, 0.001), 0.0, 1.0), tc.a);
			}
		}
		gl_FragColor.rgb = base * vSplatLit;
		vec4 pc = projectionMatrix * vec4(P, 1.0);
		gl_FragDepthEXT = (pc.z / pc.w) * 0.5 + 0.5;
		#if defined(use_edl)
			// the log depth EDL reads, with the sign flipped to mark "ground splat" (no offset: the target may be half
			// float, where a large offset would quantise the depth into visible bands): edl.fs flips it back, applies
			// the layer opacity and the edge shading to ground-on-ground pairs
			gl_FragColor.a = -max(log2(-P.z), 0.001);
		#else
			// premultiplied: the canvas is composited over the globe with this alpha (layer opacity)
			gl_FragColor = vec4(gl_FragColor.rgb * uSplatP.w, uSplatP.w);
		#endif
	}
	#endif

	//gl_FragColor = vec4(0.0, 0.7, 0.0, 1.0);
	
}


