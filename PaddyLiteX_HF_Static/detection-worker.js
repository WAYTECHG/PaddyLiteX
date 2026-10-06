'use strict';

importScripts('./vendor/ort.wasm.min.js', './detection-core.js');
ort.env.wasm.numThreads = 1; // Works inside HF frames without cross-origin isolation.
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;

let currentSession;
let currentPath;
let running = false;

self.onmessage = async ({ data }) => {
  if (running) {
    self.postMessage({ requestId: data.requestId, error: 'A comparison is already running on this device.' });
    return;
  }
  running = true;
  const { requestId, model, size, input, transform, confidence } = data;
  try {
    const path = new URL(model.files[String(size)], self.location.href).href;
    if (!currentSession || currentPath !== path) {
      self.postMessage({ requestId, stage: 'Downloading/loading ' + model.label + ' on your device…' });
      if (currentSession) await currentSession.release();
      currentSession = null;
      currentPath = null;
      currentSession = await ort.InferenceSession.create(path, {
        executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      });
      currentPath = path;
    }
    self.postMessage({ requestId, stage: 'Running ' + model.label + ' on your device…' });
    const tensor = new ort.Tensor('float32', new Float32Array(input), [1, 3, size, size]);
    const outputs = await currentSession.run({ [currentSession.inputNames[0]]: tensor });
    const output = outputs[currentSession.outputNames[0]];
    const detections = PaddyDetectionCore.decode(output, model.names, transform, confidence);
    tensor.dispose();
    for (const value of Object.values(outputs)) value.dispose();
    self.postMessage({ requestId, detections });
  } catch (error) {
    self.postMessage({ requestId, error: model.label + ': ' + error.message });
  } finally {
    running = false;
  }
};
