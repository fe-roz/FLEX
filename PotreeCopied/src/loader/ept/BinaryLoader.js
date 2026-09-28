
import * as THREE from "../../../libs/three.js/build/three.module.js";
import {XHRFactory} from "../../XHRFactory.js";

export class EptBinaryLoader {
	extension() {
		return '.bin';
	}

	workerPath() {
		return Potree.scriptPath + '/workers/EptBinaryDecoderWorker.js';
	}

	load(node) {
		if (node.loaded) return;

		let url = node.url() + this.extension();

		let xhr = XHRFactory.createXMLHttpRequest();
		xhr.open('GET', url, true);
		xhr.responseType = 'arraybuffer';
		xhr.overrideMimeType('text/plain; charset=x-user-defined');
		// Every exit that is not a successful parse has to release the node,
		// or it stays loading === true for good and takes one of the global
		// concurrency slots with it. See PointCloudEptGeometryNode.loadFailed.
		xhr.timeout = 60000;
		xhr.onreadystatechange = () => {
			if (xhr.readyState === 4) {
				if (xhr.status === 200) {
					let buffer = xhr.response;
					this.parse(node, buffer);
				} else {
					node.loadFailed('HTTP ' + xhr.status + ' ' + url);
				}
			}
		};
		xhr.onerror = () => node.loadFailed('network ' + url);
		xhr.ontimeout = () => node.loadFailed('timeout ' + url);
		xhr.onabort = () => node.loadFailed('aborted ' + url);

		try {
			xhr.send(null);
		}
		catch (e) {
			node.loadFailed('send threw: ' + e);
		}
	}

	parse(node, buffer) {
		let workerPath = this.workerPath();
		let worker = Potree.workerPool.getWorker(workerPath);

		// A worker that throws, or a malformed message, would otherwise never
		// reach doneLoading and leak the node exactly like a failed request.
		worker.onerror = (err) => {
			node.loadFailed('decode worker: ' + (err && err.message ? err.message : err));
			Potree.workerPool.returnWorker(workerPath, worker);
		};

		worker.onmessage = function(e) {
			try {
			let g = new THREE.BufferGeometry();
			let numPoints = e.data.numPoints;

			let position = new Float32Array(e.data.position);
			g.setAttribute('position', new THREE.BufferAttribute(position, 3));

			let indices = new Uint8Array(e.data.indices);
			g.setAttribute('indices', new THREE.BufferAttribute(indices, 4));

			if (e.data.color) {
				let color = new Uint8Array(e.data.color);
				g.setAttribute('color', new THREE.BufferAttribute(color, 4, true));
			}
			if (e.data.intensity) {
				let intensity = new Float32Array(e.data.intensity);
				g.setAttribute('intensity',
						new THREE.BufferAttribute(intensity, 1));
			}
			if (e.data.classification) {
				let classification = new Uint8Array(e.data.classification);
				g.setAttribute('classification',
						new THREE.BufferAttribute(classification, 1));
			}
			if (e.data.returnNumber) {
				let returnNumber = new Uint8Array(e.data.returnNumber);
				g.setAttribute('return number',
						new THREE.BufferAttribute(returnNumber, 1));
			}
			if (e.data.numberOfReturns) {
				let numberOfReturns = new Uint8Array(e.data.numberOfReturns);
				g.setAttribute('number of returns',
						new THREE.BufferAttribute(numberOfReturns, 1));
			}
			if (e.data.pointSourceId) {
				let pointSourceId = new Uint16Array(e.data.pointSourceId);
				g.setAttribute('source id',
						new THREE.BufferAttribute(pointSourceId, 1));
			}

			g.attributes.indices.normalized = true;

			let tightBoundingBox = new THREE.Box3(
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.min),
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.max)
			);

			node.doneLoading(
					g,
					tightBoundingBox,
					numPoints,
					new THREE.Vector3(...e.data.mean));

			Potree.workerPool.returnWorker(workerPath, worker);
			} catch (err) {
				node.loadFailed('decode: ' + err);
				Potree.workerPool.returnWorker(workerPath, worker);
			}
		};

		let toArray = (v) => [v.x, v.y, v.z];
		let message = {
			buffer: buffer,
			schema: node.ept.schema,
			scale: node.ept.eptScale,
			offset: node.ept.eptOffset,
			mins: toArray(node.key.b.min)
		};

		worker.postMessage(message, [message.buffer]);
	}
};

