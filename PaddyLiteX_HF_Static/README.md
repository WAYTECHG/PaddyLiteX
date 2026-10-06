---
title: PaddyLiteX
emoji: 🌾
colorFrom: green
colorTo: blue
sdk: static
app_file: index.html
license: agpl-3.0
short_description: Browser-based paddy disease model comparison
---

# PaddyLiteX

Paddy disease detection by Wilbert Andrew Yonathan, AIT2309246,
Xiamen University Malaysia.

The interface runs in a Static Space. Three exported ONNX detection models run
on the visitor's device using ONNX Runtime Web and WebAssembly. Images are not
uploaded to a detection server. No Docker, Render, GitHub or Python backend is
used by the deployed website.

This deployment scaffold requires the trained model exports before detection
can work. The export script validates each ONNX model against its corresponding
PyTorch model. Browser preprocessing and drawing may differ slightly from the
original Python interface; compare real-image predictions before presenting
results as equivalent. Recorded benchmark charts retain the original test-set
measurements; they are not new measurements of this browser runtime.

The initial model downloads can be large. Speed and memory usage depend on the
visitor's computer or phone. This removes the shared server inference lock;
it does not promise fast detection on every device. Model exports served by a
public Space can be downloaded by visitors.

The project uses Ultralytics YOLO and existing research components. It presents
my thesis implementation and experimental comparison, and does not claim
ownership of upstream architectures. ONNX Runtime is provided under the MIT
license; its license is included with the vendor assets.
