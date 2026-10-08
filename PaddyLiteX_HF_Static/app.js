'use strict';

// PaddyLiteX: resolve class results beside the running app.js.
const paddyClassResultsUrl = new URL('per_class.json', document.currentScript?.src || document.baseURI);


// Application state is shared by the detection and benchmark views.
const getElement = (id) => document.getElementById(id);
const formatNumber = (value) => new Intl.NumberFormat('en-US').format(value);
const performanceMetrics = {
  map5095: { label: 'mAP@0.5:0.95', unit: '%' },
  map50: { label: 'mAP@0.5', unit: '%' },
  precision: { label: 'Precision', unit: '%' },
  recall: { label: 'Recall', unit: '%' },
};
const complexityMetrics = {
  parameters: {
    label: 'Parameters',
    axisLabel: 'Parameters (millions)',
    scale: 1000000,
    unit: 'M',
  },
  gflops: { label: 'GFLOPs', axisLabel: 'GFLOPs', scale: 1, unit: 'G' },
};

let benchmarkData;
let currentStudy = 'main';
let selectedFile = null;
let previewUrl = null;
let comparisonRunning = false;
let latestResults = null;
let classData = null;
let classDataError = '';
const classMetricLabels = {
  map5095: 'AP@0.5:0.95',
  map50: 'AP@0.5',
  precision: 'Precision',
  recall: 'Recall',
};
// Dataset class IDs supplied for this thesis. Keep names independent of scores.
const paddyClassNames = [
  'Rice__BacterialLeafBlight',
  'Rice__BrownSpot',
  'Rice__Healthy',
  'Rice__Hispa',
  'Rice__LeafBlast',
  'Rice__LeafScald',
  'Rice__LeafSmut',
  'Rice__NarrowBrownLeafSpot',
  'Rice__NeckBlast',
];

function classRows() {
  const supplied = new Map((classData?.classes || []).map((row) => [row.id, row]));
  return paddyClassNames.map((name, id) => ({
    id,
    name,
    models: supplied.get(id)?.models || {},
  }));
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function displayModelName(model) {
  // Older local configurations still use the previous baseline label.
  return model.label.replace(/\bDenseNet121\b/g, 'Yolov8n_DenseNet121');
}

function showView(viewName) {
  document.querySelectorAll('.view').forEach((view) => {
    const active = view.id === viewName;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });

  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

async function readResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The server returned an unexpected response. Please try again.');
  }

  if (!response.ok) {
    throw new Error(
      typeof payload.detail === 'string' ? payload.detail : 'The request could not be completed.',
    );
  }
  return payload;
}

// Detection studio
function resultHeading(model) {
  return `
    <div class="card-head">
      <p class="role">${escapeHtml(model.role)}</p>
      <h3>${escapeHtml(displayModelName(model))}</h3>
    </div>
  `;
}

function showEmptyResults(message = 'Upload an image to compare predictions.') {
  if (!benchmarkData) return;

  getElement('results').innerHTML = benchmarkData.main
    .map(
      (model) => `
    <article class="result-card" style="--model-color: ${model.color}">
      ${resultHeading(model)}
      <div class="result-stage"><p>${escapeHtml(message)}</p></div>
      <div class="result-body">${escapeHtml(model.id)}</div>
    </article>
  `,
    )
    .join('');
}

function showLoadingResults() {
  getElement('results').innerHTML = benchmarkData.main
    .map(
      (model) => `
    <article class="result-card" style="--model-color: ${model.color}">
      ${resultHeading(model)}
      <div class="result-stage">
        <div>
          <div class="spinner" style="margin: auto"></div>
          <p>Comparing models…</p>
        </div>
      </div>
      <div class="result-body">Identical image and settings</div>
    </article>
  `,
    )
    .join('');
}

function renderResults(results) {
  const classMappings = results
    .filter((result) => result.status === 'success')
    .map((result) => JSON.stringify(Object.entries(result.class_names).sort()));

  if (new Set(classMappings).size > 1) {
    getElement('message').textContent =
      'The checkpoints have different class mappings. Verify their dataset configuration before treating this as a matched comparison.';
  }

  getElement('results').innerHTML = benchmarkData.main
    .map((model) => {
      const result = results.find((item) => item.id === model.id);
      if (!result || result.status !== 'success') {
        const description =
          result?.status === 'unavailable' ? 'Model unavailable' : 'Inference error';
        return `
        <article class="result-card" style="--model-color: ${model.color}">
          ${resultHeading(model)}
          <div class="result-stage">
            <p>${escapeHtml(result?.message || 'No result returned.')}</p>
          </div>
          <div class="result-body">${description}</div>
        </article>
      `;
      }

      const detections = result.detections;
      const detectionRows = detections.length
        ? detections
            .map(
              (detection) => `
          <div class="detection-row">
            <span>${escapeHtml(detection.class_name)}</span>
            <strong>${(detection.confidence * 100).toFixed(1)}%</strong>
          </div>
        `,
            )
            .join('')
        : '<p>No boxes exceeded the selected threshold. This does not confirm that the leaf is healthy.</p>';

      return `
      <article class="result-card" style="--model-color: ${model.color}">
        ${resultHeading(model)}
        <div class="result-stage">
          <img src="${escapeHtml(result.image)}" alt="${escapeHtml(displayModelName(model))} annotated detection result">
        </div>
        <div class="result-body">
          <strong>${detections.length} detection${detections.length === 1 ? '' : 's'}</strong>
          ${detectionRows}
          <a class="download-link" href="${escapeHtml(result.image)}" download="${escapeHtml(model.id)}_prediction.png">
            Download annotated image
          </a>
        </div>
      </article>
    `;
    })
    .join('');
}

function updateControls() {
  getElement('compare').disabled = !selectedFile || comparisonRunning || !benchmarkData;
  getElement('compare').textContent = comparisonRunning
    ? 'Comparing models…'
    : 'Compare all three models';
  ['file', 'clear', 'confidence', 'image-size'].forEach((id) => {
    getElement(id).disabled = comparisonRunning;
  });
}

function clearFile() {
  if (comparisonRunning) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);

  selectedFile = null;
  previewUrl = null;
  latestResults = null;
  getElement('file').value = '';
  getElement('input-preview').hidden = true;
  getElement('input-preview').removeAttribute('src');
  getElement('upload-hint').hidden = false;
  getElement('clear').hidden = true;
  getElement('filename').textContent = 'No image selected';
  getElement('message').textContent = '';
  showEmptyResults();
  updateControls();
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

async function selectFile(file) {
  if (comparisonRunning || !file) return;
  getElement('message').textContent = '';

  if (!isSupportedImageFile(file)) {
    getElement('message').textContent = 'Choose a JPG, JPEG, PNG, or WebP image.';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    getElement('message').textContent = 'Image exceeds 10 MB. Choose a smaller file.';
    return;
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 12000000) {
      throw new Error('Image exceeds 12 megapixels. Resize it first.');
    }
  } catch (error) {
    getElement('message').textContent = error.message.startsWith('Image exceeds')
      ? error.message
      : 'The file cannot be decoded as an image.';
    return;
  } finally {
    bitmap?.close();
  }

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedFile = file;
  latestResults = null;
  previewUrl = URL.createObjectURL(file);
  getElement('input-preview').src = previewUrl;
  getElement('input-preview').hidden = false;
  getElement('upload-hint').hidden = true;
  getElement('clear').hidden = false;
  getElement('filename').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  showEmptyResults();
  updateControls();
}

async function compareModels() {
  if (!selectedFile || comparisonRunning || !benchmarkData) return;
  comparisonRunning = true;
  updateControls();
  showLoadingResults();
  getElement('message').textContent = '';

  const form = new FormData();
  form.append('file', selectedFile);
  form.append('confidence', getElement('confidence').value);
  form.append('image_size', getElement('image-size').value);

  try {
    const response = await PaddyLiteXBrowser.fetch('/api/compare', { method: 'POST', body: form });
    latestResults = await readResponse(response);
    renderResults(latestResults.results);
  } catch (error) {
    showEmptyResults('Comparison could not complete. See the message above.');
    getElement('message').textContent = error.message;
  } finally {
    comparisonRunning = false;
    updateControls();
  }
}

// Benchmark charts: both bar charts and the scatter plot use these selectors.
function formatMetric(value, metric) {
  if (performanceMetrics[metric]) return `${value.toFixed(2)}%`;
  if (metric === 'parameters') return `${(value / 1000000).toFixed(2)} M`;
  return `${value.toFixed(1)} G`;
}

function axisScale(maximum) {
  // Choose round tick values and keep all points inside the plotting area.
  const approximateStep = ((maximum || 1) * 1.08) / 6;
  const magnitude = 10 ** Math.floor(Math.log10(approximateStep));
  const normalizedStep = approximateStep / magnitude;
  const multiplier = [1, 2, 5, 10].find((value) => value >= normalizedStep);
  const step = multiplier * magnitude;
  const limit = Math.ceil(((maximum || 1) * 1.08) / step) * step;
  const ticks = [];
  for (let index = 0; index <= Math.round(limit / step); index += 1) {
    ticks.push(Number((index * step).toPrecision(10)));
  }
  return { limit, ticks };
}

function renderBarChart(containerId, models, metric) {
  const percentage = Boolean(performanceMetrics[metric]);
  const maximum = Math.max(...models.map((model) => model[metric]));
  const limit = percentage ? 100 : axisScale(maximum).limit;
  const axisEnd = percentage ? '100%' : formatMetric(limit, metric);

  getElement(containerId).innerHTML =
    models
      .map(
        (model) => `
    <div>
      <div class="bar-label">
        <span>${escapeHtml(displayModelName(model))}</span>
        <strong>${formatMetric(model[metric], metric)}</strong>
      </div>
      <div class="bar-track" role="img" aria-label="${escapeHtml(displayModelName(model))}: ${formatMetric(model[metric], metric)}">
        <div class="bar-fill" style="width: ${(model[metric] / limit) * 100}%; background: ${model.color}"></div>
      </div>
    </div>
  `,
      )
      .join('') +
    `
    <div class="axis"><span>0</span><span>${axisEnd}</span></div>
  `;
}

function renderScatterPlot(models, performanceMetric, complexityMetric) {
  const performance = performanceMetrics[performanceMetric];
  const complexity = complexityMetrics[complexityMetric];
  const width = 1000;
  const height = 340;
  const margin = { left: 75, right: 40, top: 30, bottom: 65 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const horizontalScale = axisScale(
    Math.max(...models.map((model) => model[complexityMetric] / complexity.scale)),
  );
  const x = (value) => margin.left + (value / horizontalScale.limit) * plotWidth;
  const y = (value) => height - margin.bottom - (value / 100) * plotHeight;

  const horizontalGrid = [0, 20, 40, 60, 80, 100]
    .map(
      (value) => `
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" stroke="#e7edf4" />
    <text x="${margin.left - 14}" y="${y(value) + 4}" text-anchor="end" fill="#68758a" font-size="13">${value}</text>
  `,
    )
    .join('');

  const horizontalTicks = horizontalScale.ticks
    .map(
      (value) => `
    <text x="${x(value)}" y="${height - margin.bottom + 23}" text-anchor="middle" fill="#68758a" font-size="13">${value}</text>
  `,
    )
    .join('');

  const points = models
    .map((model, index) => {
      const pointX = x(model[complexityMetric] / complexity.scale);
      const pointY = y(model[performanceMetric]);
      const tooltip = `${displayModelName(model)}: ${complexity.label} ${formatMetric(model[complexityMetric], complexityMetric)}; ${performance.label} ${formatMetric(model[performanceMetric], performanceMetric)}`;
      const label =
        currentStudy === 'main'
          ? `
      <text x="${pointX}" y="${pointY + (index === 0 ? 25 : -16)}" text-anchor="middle" font-size="13" fill="${model.color}">
        ${model.role === 'Proposed' ? 'Proposed' : escapeHtml(displayModelName(model))}
      </text>
    `
          : '';

      return `
      <circle data-model-id="${escapeHtml(model.id)}" cx="${pointX}" cy="${pointY}" r="${model.role === 'Proposed' ? 9 : 7}" fill="${model.color}" stroke="white" stroke-width="2">
        <title>${escapeHtml(tooltip)}</title>
      </circle>
      ${label}
    `;
    })
    .join('');

  getElement('scatter').innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${complexity.axisLabel} versus ${performance.label} (%)">
      ${horizontalGrid}
      ${horizontalTicks}
      <text data-axis="x" x="${margin.left + plotWidth / 2}" y="${height - 8}" text-anchor="middle" fill="#68758a" font-size="14">${complexity.axisLabel}</text>
      <text data-axis="y" x="18" y="${margin.top + plotHeight / 2}" transform="rotate(-90 18 ${margin.top + plotHeight / 2})" text-anchor="middle" fill="#68758a" font-size="14">${performance.label} (%)</text>
      ${points}
    </svg>
  `;

  getElement('scatter-metrics').textContent = `${complexity.label} vs. ${performance.label}`;
  getElement('legend').innerHTML = models
    .map(
      (model) => `
    <span><i style="background: ${model.color}"></i>${escapeHtml(displayModelName(model))}</span>
  `,
    )
    .join('');
}

function renderBenchmarks() {
  if (!benchmarkData) return;
  const models = benchmarkData[currentStudy];
  const performanceMetric = getElement('metric').value;
  const complexityMetric = getElement('cost-metric').value;

  renderBarChart('quality-chart', models, performanceMetric);
  renderBarChart('cost-chart', models, complexityMetric);
  renderScatterPlot(models, performanceMetric, complexityMetric);
  renderClassChart();

  getElement('metrics-table').innerHTML = models
    .map(
      (model) => `
    <tr class="${model.role === 'Proposed' ? 'proposed' : ''}">
      <td>${escapeHtml(displayModelName(model))}</td>
      <td>${model.precision.toFixed(2)}%</td>
      <td>${model.recall.toFixed(2)}%</td>
      <td>${model.map50.toFixed(2)}%</td>
      <td>${model.map5095.toFixed(2)}%</td>
      <td>${formatNumber(model.parameters)}</td>
      <td>${model.gflops.toFixed(1)}</td>
    </tr>
  `,
    )
    .join('');
}

// Class metrics come from a separate file so checkpoint paths never need editing.
function validateClassData(data) {
  if (data?.schema_version !== 1 || data.unit !== 'percent' || !Array.isArray(data.classes)) {
    throw new Error('The class results file has an unsupported format.');
  }
  const ids = new Set();
  for (const row of data.classes) {
    if (
      !Number.isInteger(row.id) ||
      row.id < 0 ||
      row.id >= paddyClassNames.length ||
      ids.has(row.id) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      !row.models ||
      typeof row.models !== 'object' ||
      Array.isArray(row.models)
    ) {
      throw new Error('Check the class IDs, names and model results in the class results file.');
    }
    ids.add(row.id);
    for (const scores of Object.values(row.models)) {
      if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
        throw new Error('Each model must have a class metric object.');
      }
      for (const metric of Object.keys(classMetricLabels)) {
        const value = scores[metric];
        if (
          value != null &&
          (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
        ) {
          throw new Error('Class metrics must be percentages between 0 and 100, or null.');
        }
      }
    }
  }
  return data;
}

function classScore(row, modelId, metric) {
  const value = row.models[modelId]?.[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Ablation studies may have class results for only some of their models.
function classChartModels() {
  if (!benchmarkData) return [];
  if (currentStudy === 'main') return benchmarkData.main;
  const rows = classRows();
  return benchmarkData.ablation.filter((model) =>
    rows.some((row) =>
      Object.keys(classMetricLabels).some((metric) => classScore(row, model.id, metric) !== null),
    ),
  );
}

function classModelCode(model, index) {
  if (model.role === 'Proposed') return 'P';
  return currentStudy === 'main' ? `B${index + 1}` : `A${index + 1}`;
}

function renderClassChart() {
  if (!benchmarkData) return;
  const panel = getElement('class-panel');
  panel.hidden = false;
  const models = classChartModels();
  const mainStudy = currentStudy === 'main';
  getElement('class-heading').textContent = mainStudy
    ? 'Every class, three perspectives.'
    : 'Class results across available ablations.';
  getElement('class-heading').nextElementSibling.textContent = mainStudy
    ? 'Compare your two baselines and final proposed model for each class.'
    : 'Compare the ablation models with supplied class results and the final proposed model.';
  const metric = getElement('class-metric').value;
  const label = classMetricLabels[metric];
  const rows = classRows();
  const proposed = models.find((model) => model.role === 'Proposed');
  const order = getElement('class-order').value;
  if (order !== 'dataset' && proposed) {
    rows.sort((a, b) => {
      const first = classScore(a, proposed.id, metric);
      const second = classScore(b, proposed.id, metric);
      if (first == null) return second == null ? a.id - b.id : 1;
      if (second == null) return -1;
      return (order === 'lowest' ? first - second : second - first) || a.id - b.id;
    });
  }

  getElement('class-legend').innerHTML = models
    .map(
      (model) => `
    <span><i style="background: ${model.color}"></i>${escapeHtml(model.role)} · ${escapeHtml(displayModelName(model))}</span>
  `,
    )
    .join('');
  const hasValues = rows.some((row) =>
    models.some((model) =>
      Object.keys(classMetricLabels).some((key) => classScore(row, model.id, key) !== null),
    ),
  );
  getElement('download-class-csv').disabled = !hasValues;
  const split = classData?.context?.split || 'test';
  getElement('class-context').textContent = rows.length
    ? `${split} set · ${rows.length} classes · ${label} (%)`
    : '';
  getElement('class-chart').innerHTML = `
    <div class="class-axis" aria-hidden="true">
      <span>${escapeHtml(label)} (%)</span>
      <div>${[0, 20, 40, 60, 80, 100].map((value) => `<span>${value}%</span>`).join('')}</div>
    </div>
    ${rows
      .map(
        (row) => `
      <div class="class-group" data-class-id="${row.id}">
        <div class="class-name"><strong>${escapeHtml(row.name)}</strong><small>Class ${row.id}</small></div>
        <div class="class-series">
          ${models
            .map((model, index) => {
              const value = classScore(row, model.id, metric);
              const text = value === null ? 'N/A' : `${value.toFixed(2)}%`;
              const caption = `${row.name} · ${displayModelName(model)} · ${label}: ${text}`;
              return `
              <div class="class-bar" data-model-id="${escapeHtml(model.id)}" role="img" aria-label="${escapeHtml(caption)}" title="${escapeHtml(caption)}">
                <span class="class-short" style="color: ${model.color}">${classModelCode(model, index)}</span>
                <div class="class-track"><div class="class-fill" style="width: ${value ?? 0}%; background: ${model.color}" ${value === null ? 'hidden' : ''}></div></div>
                <strong>${text}</strong>
              </div>`;
            })
            .join('')}
        </div>
      </div>`,
      )
      .join('')}`;
  const missingModels = currentStudy === 'ablation'
    ? benchmarkData.ablation.length - models.length
    : 0;
  const coverageNote = missingModels > 0
    ? ` Class results are available for ${models.length} of ${benchmarkData.ablation.length} ablation models. Models without supplied class results are omitted.`
    : '';
  getElement('class-note').textContent =
    classDataError ||
    (hasValues
      ? `${split} set · percent · higher is better · 0–100% scale. N/A means no evaluated value was supplied. AP is reported per class; mAP averages across classes.${coverageNote}`
      : 'All nine disease classes are shown. N/A means their evaluation scores have not been supplied yet.');
}

async function loadClassMetrics() {
  try {
    const url = new URL(paddyClassResultsUrl);
    url.searchParams.set('v', 'class-results-20261007');
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`per_class.json could not load (HTTP ${response.status}). Upload it beside app.js.`);
    }
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(raw.trimStart().startsWith('<')
        ? 'per_class.json returned an HTML page. Check its upload location beside app.js.'
        : 'per_class.json is not valid JSON. Replace it with the supplied results file.');
    }
    classData = validateClassData(data);
    classDataError = '';
  } catch (error) {
    classDataError = `Class results could not load. ${error.message}`;
  }
  renderClassChart();
}

function downloadClassMetrics() {
  if (!classData?.classes.length || !benchmarkData) return;
  const rows = [
    [
      'Class ID',
      'Class',
      'Model',
      'Role',
      'Precision (%)',
      'Recall (%)',
      'AP@0.5 (%)',
      'AP@0.5:0.95 (%)',
    ],
  ];
  for (const row of classRows()) {
    for (const model of classChartModels()) {
      rows.push([
        row.id,
        row.name,
        displayModelName(model),
        model.role,
        ...['precision', 'recall', 'map50', 'map5095'].map(
          (metric) => classScore(row, model.id, metric) ?? '',
        ),
      ]);
    }
  }
  const content = rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `paddylitex_${currentStudy}_per_class.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderSummaryCards() {
  const context = benchmarkData.context;
  const proposed = benchmarkData.main.find((model) => model.role === 'Proposed');
  const baseline = benchmarkData.main.find((model) => model.id === 'yolov8n_densenet121');
  getElement('test-images').textContent = formatNumber(context.images);
  getElement('test-objects').textContent = formatNumber(context.objects);
  getElement('test-classes').textContent = formatNumber(context.classes);

  if (proposed) {
    getElement('proposed-map5095').innerHTML = `${proposed.map5095.toFixed(2)}<span>%</span>`;
    getElement('proposed-map50').innerHTML = `${proposed.map50.toFixed(2)}<span>%</span>`;
  }
  if (proposed && baseline) {
    const improvements = [
      { metric: 'map5095', valueId: 'map-improvement', changeId: 'map5095-change' },
      { metric: 'map50', valueId: 'map50-improvement', changeId: 'map50-change' },
    ];
    for (const { metric, valueId, changeId } of improvements) {
      const scoreGain = proposed[metric] - baseline[metric];
      getElement(valueId).textContent =
        `${scoreGain >= 0 ? '+' : ''}${scoreGain.toFixed(2)}%`;
      getElement(valueId).title =
        `Score difference: ${scoreGain.toFixed(2)} percentage points (${proposed[metric].toFixed(2)}% − ${baseline[metric].toFixed(2)}%).`;
      getElement(changeId).textContent =
        `${baseline[metric].toFixed(2)}% → ${proposed[metric].toFixed(2)}%`;
    }
    getElement('parameter-reduction').textContent =
      `${(((baseline.parameters - proposed.parameters) / baseline.parameters) * 100).toFixed(2)}% fewer`;
    getElement('flops-reduction').textContent =
      `${(((baseline.gflops - proposed.gflops) / baseline.gflops) * 100).toFixed(2)}% fewer`;
  }
}

function downloadBenchmarks() {
  if (!benchmarkData) return;
  const rows = [
    [
      'Model',
      'Precision (%)',
      'Recall (%)',
      'mAP@0.5 (%)',
      'mAP@0.5:0.95 (%)',
      'Parameters',
      'GFLOPs',
    ],
    ...benchmarkData[currentStudy].map((model) => [
      displayModelName(model),
      model.precision,
      model.recall,
      model.map50,
      model.map5095,
      model.parameters,
      model.gflops,
    ]),
  ];
  const content = rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `paddylitex_${currentStudy}_benchmarks.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Event listeners
function markSettingsChanged() {
  if (latestResults)
    getElement('message').textContent = 'Settings changed. Compare again to update predictions.';
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.view));
});

document.querySelectorAll('[data-scope]').forEach((button) => {
  button.addEventListener('click', () => {
    currentStudy = button.dataset.scope;
    document
      .querySelectorAll('[data-scope]')
      .forEach((item) => item.classList.toggle('selected', item === button));
    renderBenchmarks();
  });
});

getElement('metric').addEventListener('change', renderBenchmarks);
getElement('cost-metric').addEventListener('change', renderBenchmarks);
getElement('download-csv').addEventListener('click', downloadBenchmarks);
getElement('class-metric').addEventListener('change', renderClassChart);
getElement('class-order').addEventListener('change', renderClassChart);
getElement('download-class-csv').addEventListener('click', downloadClassMetrics);
getElement('file').addEventListener('change', (event) => selectFile(event.target.files[0]));
getElement('clear').addEventListener('click', clearFile);
getElement('compare').addEventListener('click', compareModels);
getElement('image-size').addEventListener('change', markSettingsChanged);
getElement('confidence').addEventListener('input', () => {
  getElement('confidence-value').textContent = Number(getElement('confidence').value).toFixed(2);
  markSettingsChanged();
});

getElement('dropzone').addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !comparisonRunning) {
    event.preventDefault();
    getElement('file').click();
  }
});

['dragenter', 'dragover'].forEach((eventName) => {
  getElement('dropzone').addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!comparisonRunning) getElement('dropzone').classList.add('dragging');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  getElement('dropzone').addEventListener(eventName, (event) => {
    event.preventDefault();
    getElement('dropzone').classList.remove('dragging');
  });
});

getElement('dropzone').addEventListener('drop', (event) => {
  if (!comparisonRunning) selectFile(event.dataTransfer.files[0]);
});

async function initialize() {
  try {
    benchmarkData = await readResponse(await PaddyLiteXBrowser.fetch('/api/benchmarks'));
    const status = await readResponse(await PaddyLiteXBrowser.fetch('/api/status'));
    const available = status.models.filter((model) => model.checkpoint_present).length;
    const statusBadge = getElement('service-status');
    // Hide the installed-checkpoint badge without claiming inference was verified.
    statusBadge.hidden = status.inference_enabled && available === benchmarkData.main.length;
    statusBadge.textContent = !status.inference_enabled
      ? 'Inference paused'
      : `${available}/${benchmarkData.main.length} checkpoints installed`;

    getElement('model-list').innerHTML = benchmarkData.main
      .map(
        (model) => `
      <div class="model-item">
        <span class="model-color" style="background: ${model.color}"></span>
        <div>
          <strong>${escapeHtml(displayModelName(model))}</strong>
          <small>${escapeHtml(model.role)} · ${(model.parameters / 1000000).toFixed(2)} M parameters</small>
        </div>
        <span class="model-state">${status.models.find((item) => item.id === model.id)?.checkpoint_present ? 'Checkpoint installed' : 'Awaiting checkpoint'}</span>
      </div>
    `,
      )
      .join('');

    renderSummaryCards();
    showEmptyResults();
    renderBenchmarks();
    updateControls();
  } catch (error) {
    getElement('service-status').hidden = false;
    getElement('service-status').textContent = 'Service unavailable';
    getElement('message').textContent = error.message;
  }
}

// Presentation controls. The illustration is separate from model predictions.
function initializePresentation() {
  const hero = getElement('studio-hero');
  const replayButton = getElement('replay-intro');
  const motionButton = getElement('toggle-motion');
  const preference =
    typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };
  let motionPaused = false;

  function updateMotionControls() {
    const reduced = preference.matches;
    hero.classList.toggle('motion-paused', motionPaused || reduced);
    replayButton.disabled = reduced;
    motionButton.disabled = reduced;
    motionButton.textContent = reduced
      ? 'Motion reduced'
      : motionPaused
        ? 'Play motion'
        : 'Pause motion';
    motionButton.setAttribute('aria-pressed', String(motionPaused || reduced));
  }

  motionButton.addEventListener('click', () => {
    motionPaused = !motionPaused;
    updateMotionControls();
  });

  replayButton.addEventListener('click', () => {
    if (preference.matches) return;
    motionPaused = false;
    updateMotionControls();
    hero.classList.remove('intro-playing');
    // Restart the entrance after the browser has painted the reset state.
    requestAnimationFrame(() => requestAnimationFrame(() => hero.classList.add('intro-playing')));
  });

  getElement('start-comparison').addEventListener('click', () => {
    getElement('studio-input').scrollIntoView({
      behavior: preference.matches ? 'auto' : 'smooth',
      block: 'start',
    });
    getElement('dropzone').focus({ preventScroll: true });
  });

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(([entry]) => {
      hero.classList.toggle('motion-offscreen', !entry.isIntersecting);
    });
    observer.observe(hero);
  }

  preference.addEventListener?.('change', updateMotionControls);
  updateMotionControls();
}

initializePresentation();

initialize();
loadClassMetrics();
