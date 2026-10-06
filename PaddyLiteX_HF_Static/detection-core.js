/* Decode standard YOLOv8 exports: batch 1, xywh + nine class scores, no NMS. */
(function (scope) {
  'use strict';

  function iou(a, b) {
    const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const overlap = width * height;
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    return overlap / Math.max(1e-12, areaA + areaB - overlap);
  }

  function decode(output, names, transform, confidence, threshold = 0.7) {
    const dims = output.dims;
    const channels = 4 + names.length;
    if (dims.length !== 3 || dims[0] !== 1 ||
        (dims[1] !== channels && dims[2] !== channels)) {
      throw new Error('Unsupported ONNX output. Export YOLOv8 with nine classes and nms=False.');
    }
    const channelFirst = dims[1] === channels;
    const count = channelFirst ? dims[2] : dims[1];
    const value = (candidate, channel) => output.data[
      channelFirst ? channel * count + candidate : candidate * channels + channel
    ];
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      let classId = 0;
      let score = -Infinity;
      for (let cls = 0; cls < names.length; cls += 1) {
        const current = value(index, cls + 4);
        if (current > score) { score = current; classId = cls; }
      }
      if (!Number.isFinite(score) || score < confidence) continue;
      const cx = value(index, 0), cy = value(index, 1);
      const width = value(index, 2), height = value(index, 3);
      if (![cx, cy, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      candidates.push({
        raw: [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2],
        confidence: score, class_id: classId, class_name: names[classId],
      });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    // Match Ultralytics' pre-NMS candidate cap; class-aware NMS, max_det=100.
    const retained = [];
    for (const candidate of candidates.slice(0, 30000)) {
      if (retained.some(item => item.class_id === candidate.class_id && iou(item.raw, candidate.raw) > threshold)) continue;
      retained.push(candidate);
      if (retained.length === 100) break;
    }
    const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
    return retained.map(item => ({
      class_id: item.class_id,
      class_name: item.class_name,
      confidence: item.confidence,
      box: item.raw.map((value, axis) => {
        const horizontal = axis % 2 === 0;
        const coordinate = (value - (horizontal ? transform.left : transform.top)) / transform.ratio;
        return Math.round(clamp(coordinate, horizontal ? transform.width : transform.height) * 100) / 100;
      }),
    }));
  }

  scope.PaddyDetectionCore = { decode, iou };
})(typeof self !== 'undefined' ? self : globalThis);
