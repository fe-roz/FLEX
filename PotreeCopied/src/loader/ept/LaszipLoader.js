import * as THREE from "../../../libs/three.js/build/three.module.js";

export class EptLaszipLoader {
	async load(node) {
		if (node.loaded) return;

		const { Key } = window.Copc

		const url = `${node.owner.base}/ept-data/${Key.toString(node.key)}.laz`
		// FLEX: a failed fetch must release the node (see
		// PointCloudEptGeometryNode.loadFailed), or it stays loading for good
		// and holds one of the global concurrency slots. Stock 1.8.2 had no
		// check at all here. The timeout (60 s) matches EptBinaryLoader.
		let buffer;
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
			if (!response.ok) {
				node.loadFailed('HTTP ' + response.status + ' ' + url);
				return;
			}
			buffer = await response.arrayBuffer();
		} catch (e) {
			node.loadFailed('network ' + url + ': ' + e);
			return;
		}
		this.parse(node, buffer);
	}

	async parse(node, compressed){
		let handler = new EptLazBatcher(node);

		try {
			const { Bounds, Las } = Copc

			const get = (begin, end) => new Uint8Array(compressed, begin, end - begin)

			const header = Las.Header.parse(new Uint8Array(compressed))
			const vlrs = await Las.Vlr.walk(get, header)
			let eb = []
			const ebVlr = Las.Vlr.find(vlrs, 'LASF_Spec', 4)
			if (ebVlr) eb = Las.ExtraBytes.parse(await Las.Vlr.fetch(get, ebVlr))

			const message = {
				isFullFile: true,
				compressed,
				header,
				eb,
				pointCount: header.pointCount,
				nodemin: Bounds.min(node.bounds),
			}
			handler.push(message)
		} catch (e) {
			console.log('Failed:', e)
			node.loadFailed('laz parse: ' + e) // FLEX
		}
	}
};

export class CopcLaszipLoader {
	async load(node) {
		if (node.loaded) return;

		// There are utilities to do all of this in one async call via copc.js,
		// however we must split things out a bit to accommodate the expensive
		// calls to go in the worker.  So in this non-worker context, we just
		// isolate the compressed data buffer, which is passed to the worker.
		// The time-consuming decompression and extracting the data into 
		// GPU-compatible buffers happens in the worker.
		const { pointCount, pointDataOffset, pointDataLength } = node.nodeinfo

		// Note that COPC explicitly allows nodes to exist with no data.  They
		// may have children, but there is no point cloud data.  Make sure we
		// don't try to fetch a slice of point data in this case.
		if (!pointCount) return this.parse(node, new ArrayBuffer())
		// FLEX: release the node when the range request fails (see EptLaszipLoader.load).
		let compressed;
		try {
			compressed = await node.owner.getter(
				pointDataOffset,
				pointDataOffset + pointDataLength)
		} catch (e) {
			node.loadFailed('copc range request: ' + e)
			return
		}
		this.parse(node, compressed.buffer);
	}

	async parse(node, compressed) {
		let handler = new EptLazBatcher(node);

		try {
			handler.push({
				isFullFile: false,
				compressed,
				header: node.owner.copc.header,
				eb: node.owner.copc.eb,
				pointCount: node.nodeinfo.pointCount,
				nodemin: node.bounds.slice(0, 3),
			})
		} catch (e) {
			console.log('Failed:', e)
			node.loadFailed('copc parse: ' + e) // FLEX
		}
	}
};

export class EptLazBatcher {
	constructor(node) { this.node = node; }

	push(las) {
		const { isFullFile, compressed, header, eb, pointCount, nodemin } = las

		let workerPath = Potree.scriptPath +
			'/workers/EptLaszipDecoderWorker.js';
		let worker = Potree.workerPool.getWorker(workerPath);
		const pointAttributes = this.node.owner.pointAttributes;

		// FLEX: a worker that throws (corrupt chunk) or a malformed message would
		// otherwise never reach doneLoading and strand the node, exactly like a
		// failed request. See PointCloudEptGeometryNode.loadFailed.
		worker.onerror = (err) => {
			this.node.loadFailed('decode worker: ' + (err && err.message ? err.message : err));
			Potree.workerPool.returnWorker(workerPath, worker);
		};

		worker.onmessage = (e) => {
			try {
			let g = new THREE.BufferGeometry();

			let positions = new Float32Array(e.data.position);
			let colors = new Uint8Array(e.data.color);
			
			let intensities = new Float32Array(e.data.intensity);
			let classifications = new Uint8Array(e.data.classification);
			let returnNumbers = new Uint8Array(e.data.returnNumber);
			let numberOfReturns = new Uint8Array(e.data.numberOfReturns);
			let pointSourceIds = new Uint16Array(e.data.pointSourceId);
			let scanAngles = new Float32Array(e.data.scanAngle); // FLEX
			let indices = new Uint8Array(e.data.indices);
			let gpsTime = new Float32Array(e.data.gpsTime);

			g.setAttribute('position',
					new THREE.BufferAttribute(positions, 3));
			g.setAttribute('rgba',
					new THREE.BufferAttribute(colors, 4, true));
			g.setAttribute('intensity',
					new THREE.BufferAttribute(intensities, 1));
			g.setAttribute('classification',
					new THREE.BufferAttribute(classifications, 1));
			g.setAttribute('return number',
					new THREE.BufferAttribute(returnNumbers, 1));
			g.setAttribute('number of returns',
					new THREE.BufferAttribute(numberOfReturns, 1));
			g.setAttribute('source id',
					new THREE.BufferAttribute(pointSourceIds, 1));
			// FLEX: scan angle for angle of incidence visualization
			g.setAttribute('scan angle',
					new THREE.BufferAttribute(scanAngles, 1));
			g.setAttribute('indices',
					new THREE.BufferAttribute(indices, 4));
			g.setAttribute('gps-time',
					new THREE.BufferAttribute(gpsTime, 1));
			this.node.gpsTime = e.data.gpsMeta;

			g.attributes.indices.normalized = true;

			for (const key in e.data.ranges) {
				const range = e.data.ranges[key];
				const attribute = pointAttributes.attributes.find(a => a.name === key);
				if (attribute) {
					attribute.range[0] = Math.min(attribute.range[0], range[0]);
					attribute.range[1] = Math.max(attribute.range[1], range[1]);

					// May not be right, but we need something here or we crash.
					if (!attribute.initialRange) {
						attribute.initialRange = attribute.range
					}
				}
			}

			let tightBoundingBox = new THREE.Box3(
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.min),
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.max)
			);

			this.node.doneLoading(
				g,
				tightBoundingBox,
				pointCount,
				new THREE.Vector3(...e.data.mean));

			Potree.workerPool.returnWorker(workerPath, worker);
			} catch (err) {
				this.node.loadFailed('decode: ' + err);
				Potree.workerPool.returnWorker(workerPath, worker);
			}
		};

		let message = { isFullFile, compressed, header, eb, pointCount, nodemin };

		worker.postMessage(message, [message.compressed]);
	};
};
