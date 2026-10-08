/* Local adapter for the existing UI. There are no Python or Render requests. */
(function () {
  'use strict';
  const root = new URL('./', document.currentScript.src);
  const nativeFetch = window.fetch.bind(window);
  let manifestPromise;
  let worker;
  let workerFailure;
  let sequence = 0;
  let busy = false;
  const pending = new Map();
  const manifest = () => manifestPromise ??= nativeFetch(new URL('browser-models.json', root))
    .then(response => { if (!response.ok) throw new Error('Browser model manifest is missing.'); return response.json(); });
  const reply = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  function getWorker() {
    if (workerFailure) throw new Error(workerFailure);
    if (worker) return worker;
    worker = new Worker(new URL('detection-worker.js', root));
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.requestId);
      if (!task) return;
      if (data.stage) {
        const message = document.getElementById('message');
        if (message) message.textContent = data.stage;
        return;
      }
      pending.delete(data.requestId);
      if (data.error) task.reject(new Error(data.error));
      else task.resolve(data.detections);
    };
    worker.onerror = () => {
      workerFailure = 'Browser runtime could not start. Check that the vendor runtime files were uploaded.';
      for (const task of pending.values()) task.reject(new Error(workerFailure));
      pending.clear();
      worker.terminate();
      worker = null;
    };
    return worker;
  }

  function runModel(model, size, input, transform, confidence) {
    const detector = getWorker();
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      // Transfer a separate tensor for each model; the original stays reusable.
      const copy = input.slice();
      detector.postMessage({ requestId, model, size, input: copy.buffer, transform, confidence }, [copy.buffer]);
    });
  }

  function prepareImage(image, size) {
    const ratio = Math.min(size / image.width, size / image.height);
    const resizedWidth = Math.round(image.width * ratio);
    const resizedHeight = Math.round(image.height * ratio);
    const left = Math.round((size - resizedWidth) / 2 - 0.1);
    const top = Math.round((size - resizedHeight) / 2 - 0.1);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image, left, top, resizedWidth, resizedHeight);
    const pixels = ctx.getImageData(0, 0, size, size).data;
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let pixel = 0; pixel < plane; pixel += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        input[channel * plane + pixel] = pixels[pixel * 4 + channel] / 255;
      }
    }
    return { input, transform: { ratio, left, top, width: image.width, height: image.height } };
  }

  function annotate(image, detections) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const fontSize = Math.max(12, Math.round(Math.max(image.width, image.height) / 45));
    ctx.font = '600 ' + fontSize + 'px system-ui, sans-serif';
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 6));
    const colors = ['#ff4848', '#ee9635', '#2aab65', '#2a98dd', '#8861d6', '#dc5697', '#b58530', '#278d84', '#cc6144'];
    for (const detection of detections) {
      const [x1, y1, x2, y2] = detection.box;
      const color = colors[detection.class_id % colors.length];
      ctx.strokeStyle = color;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = detection.class_name + ' ' + (detection.confidence * 100).toFixed(1) + '%';
      const labelWidth = Math.min(canvas.width, ctx.measureText(label).width + 10);
      const labelX = Math.max(0, Math.min(x1, canvas.width - labelWidth));
      const labelY = Math.max(0, y1 - fontSize - 8);
      ctx.fillStyle = color;
      ctx.fillRect(labelX, labelY, labelWidth, fontSize + 8);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, labelX + 5, labelY + fontSize + 1, labelWidth - 10);
    }
    return canvas.toDataURL('image/png');
  }

  // JPG upload compatibility: some files have an alias or no MIME type.
  function isSupportedImageFile(file) {
    if (!file) return false;

    const imageType = (file.type || '').toLowerCase();
    const supportedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/pjpeg',
      'image/png',
      'image/webp',
    ];

    if (supportedTypes.includes(imageType)) return true;

    // The existing image decoder still verifies that this is an actual image.
    return (
      ['', 'application/octet-stream'].includes(imageType) &&
      /\.(jpg|jpeg|png|webp)$/i.test(file.name || '')
    );
  }

  async function compare(form) {
    if (busy) return reply({ detail: 'A comparison is already running on this device.' }, 429);
    busy = true;
    let image;
    try {
      const models = await manifest();
      if (!models.ready || models.models.length !== 3) {
        return reply({ detail: models.message || 'Export and upload the three ONNX models first.' }, 503);
      }
      const file = form.get('file');
      const confidence = Number(form.get('confidence'));
      const size = Number(form.get('image_size'));
      if (!isSupportedImageFile(file)) {
        throw new Error('Choose a JPG, JPEG, PNG, or WebP image.');
      }
      if (file.size > 10 * 1024 * 1024) throw new Error('Image exceeds 10 MB.');
      if (![320, 512, 640].includes(size) || !Number.isFinite(confidence) || confidence < 0.05 || confidence > 0.95) throw new Error('Invalid detection settings.');
      image = await createImageBitmap(file);
      if (image.width * image.height > 12000000) throw new Error('Image exceeds 12 megapixels.');
      const { input, transform } = prepareImage(image, size);
      const results = [];
      for (const model of models.models) {
        try {
          if (!model.files[String(size)]) throw new Error('This input size has not been exported.');
          const detections = await runModel(model, size, input, transform, confidence);
          results.push({ id: model.id, status: 'success', detections,
            image: annotate(image, detections),
            class_names: Object.fromEntries(model.names.map((name, id) => [String(id), name])) });
        } catch (error) {
          results.push({ id: model.id, status: 'error', message: error.message });
        }
      }
      document.getElementById('message').textContent = results.some(result => result.status === 'error')
        ? 'Some browser models could not run. See the model cards for details.'
        : 'Comparison completed on your device.';
      return reply({ results, image_size: [image.width, image.height], settings: { confidence, imgsz: size, iou: 0.7 } });
    } catch (error) {
      return reply({ detail: error.message }, 400);
    } finally {
      image?.close();
      busy = false;
    }
  }

  window.PaddyLiteXBrowser = {
    async fetch(url, options = {}) {
      if (url === '/api/benchmarks') return nativeFetch(new URL('results.json', root));
      if (url === '/api/status') {
        const models = await manifest();
        const benchmarks = await (await nativeFetch(new URL('results.json', root))).json();
        return reply({ inference_enabled: Boolean(models.ready), models: benchmarks.main.map(model => ({
          id: model.id, checkpoint_present: Boolean(models.ready && models.models.some(item => item.id === model.id)),
        })) });
      }
      if (url === '/api/compare') return compare(options.body);
      throw new Error('Unsupported browser API route: ' + url);
    },
  };
})();
