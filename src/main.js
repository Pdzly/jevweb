import './register-sw.js';
import { MODELS, DecisionEngine, getRuntimeSupport } from './inference.js';
import './style.css';

const SOURCE_LIMIT = 6000;
const QUESTION_LIMIT = 8;
const QUESTION_LENGTH = 300;
const CRITERIA_LIMIT = 8;

const SAMPLE_SOURCE = 'I was charged twice for the same order. The order number is 4412 and I need help getting the duplicate charge reversed. I have checked my bank statement and the second charge is still pending.';
let nextQuestionId = 1;

function makeQuestion(instructions, type, criteria = []) {
  return { id: `question-${nextQuestionId++}`, instructions, type, criteria };
}

function sampleQuestions() {
  return [
    makeQuestion('Does this customer need a refund for a duplicate charge?', 'noul'),
    makeQuestion('Which team should handle this request?', 'choice', ['Billing', 'Technical', 'Other']),
    makeQuestion('How urgent is this request?', 'score', ['Low', 'Medium', 'High'])
  ];
}

const elements = {
  source: document.querySelector('#source-text'),
  sourceCount: document.querySelector('#source-count'),
  loadExample: document.querySelector('#load-example'),
  questionList: document.querySelector('#question-list'),
  questionCount: document.querySelector('#question-count'),
  addQuestion: document.querySelector('#add-question'),
  resetQuestions: document.querySelector('#reset-questions'),
  modelSelect: document.querySelector('#model-select'),
  modelDescription: document.querySelector('#model-description'),
  downloadLabel: document.querySelector('#download-label'),
  memoryLabel: document.querySelector('#memory-label'),
  modelLicense: document.querySelector('#model-license'),
  loadModel: document.querySelector('#load-model'),
  loadProgress: document.querySelector('#load-progress'),
  loadStatus: document.querySelector('#load-status'),
  modelState: document.querySelector('#model-state'),
  runtimeAlert: document.querySelector('#runtime-alert'),
  runtimeDetail: document.querySelector('#runtime-detail'),
  error: document.querySelector('#error-message'),
  liveStatus: document.querySelector('#live-status'),
  evaluationHint: document.querySelector('#evaluation-hint'),
  evaluate: document.querySelector('#evaluate'),
  stop: document.querySelector('#stop-evaluation'),
  resultsEmpty: document.querySelector('#results-empty'),
  resultsList: document.querySelector('#results-list'),
  copyResults: document.querySelector('#copy-results'),
  exportResults: document.querySelector('#export-results')
};

const state = {
  engine: new DecisionEngine(),
  support: null,
  busy: null,
  loadedModelId: null,
  runtimeInfo: null,
  questions: sampleQuestions(),
  completedResults: [],
  resultCards: new Map()
};

function announce(message) { elements.liveStatus.textContent = message; }
function showError(message) { elements.error.textContent = message; elements.error.hidden = false; announce(message); }
function clearError() { elements.error.textContent = ''; elements.error.hidden = true; }
function selectedModel() { return MODELS.find((model) => model.id === elements.modelSelect.value) ?? null; }
function modelIsAvailable(model) { return Boolean(model) && !model.unavailableReason; }

function updateSourceCount() {
  const count = `${elements.source.value.length.toLocaleString()} / ${SOURCE_LIMIT.toLocaleString()}`;
  elements.sourceCount.value = count;
  elements.sourceCount.textContent = count;
}

function setModelState(label, ready = false) {
  elements.modelState.textContent = label;
  elements.modelState.classList.toggle('is-ready', ready);
}

function clearRuntimeInfo() {
  state.runtimeInfo = null;
  elements.loadStatus.removeAttribute('title');
  elements.loadStatus.removeAttribute('aria-describedby');
  elements.runtimeDetail.textContent = '';
}

function runtimeStatusLabel(runtimeInfo) {
  return runtimeInfo.fallback ? `${runtimeInfo.label} — GPU unavailable` : runtimeInfo.label;
}

function setRuntimeInfo(runtimeInfo) {
  state.runtimeInfo = runtimeInfo;
  elements.loadStatus.textContent = runtimeStatusLabel(runtimeInfo);
  if (runtimeInfo.reason) elements.loadStatus.title = runtimeInfo.reason;
  if (runtimeInfo.reason && (runtimeInfo.fallback || runtimeInfo.threads === 1)) {
    elements.runtimeDetail.textContent = runtimeInfo.reason;
    elements.loadStatus.setAttribute('aria-describedby', elements.runtimeDetail.id);
  }
}

function resetEngine() {
  state.engine.dispose();
  state.engine = new DecisionEngine();
  clearRuntimeInfo();
}

function invalidateModel(status = 'Automatic · selected on load') {
  state.loadedModelId = null;
  clearRuntimeInfo();
  elements.loadProgress.value = 0;
  elements.loadStatus.textContent = status;
  setModelState('Not loaded');
}

function renderModels() {
  const options = document.createDocumentFragment();
  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.unavailableReason
      ? `${model.name} — unavailable (GitHub Pages cannot host its 6.3 GB model; Laya and Julia-1 remain browser-local)`
      : model.name;
    option.disabled = Boolean(model.unavailableReason);
    option.title = model.unavailableReason || "";
    options.append(option);
  }
  elements.modelSelect.replaceChildren(options);
  const defaultModel = MODELS.find(modelIsAvailable);
  if (defaultModel) elements.modelSelect.value = defaultModel.id;
  updateModelDetails();
}

function updateModelDetails() {
  const model = selectedModel();
  if (!model) return;
  elements.modelDescription.textContent = model.unavailableReason
    ? `${model.description} ${model.unavailableReason}`
    : model.description;
  elements.modelDescription.title = elements.modelDescription.textContent;
  elements.downloadLabel.textContent = model.downloadLabel;
  elements.downloadLabel.title = model.downloadLabel;
  elements.memoryLabel.textContent = model.memoryLabel;
  elements.memoryLabel.title = model.memoryLabel;
  elements.modelLicense.hidden = !model.licenseLabel;
  elements.modelLicense.textContent = model.licenseLabel || '';
  elements.modelLicense.href = model.source || '';
  if (state.loadedModelId !== model.id) {
    invalidateModel(model.unavailableReason || undefined);
  }
  if (model.unavailableReason) setModelState('Unavailable');
}

function criteriaLabel(type) {
  return type === 'choice' ? 'Options — one per line' : 'Levels — lowest to highest';
}

function renderQuestions() {
  const fragment = document.createDocumentFragment();
  state.questions.forEach((question, index) => {
    const row = document.createElement('div');
    row.className = 'question-row typed-question-row';

    const number = document.createElement('span');
    number.className = 'question-number';
    number.textContent = String(index + 1).padStart(2, '0');
    number.setAttribute('aria-hidden', 'true');

    const field = document.createElement('div');
    field.className = 'question-field';
    const label = document.createElement('label');
    label.className = 'sr-only';
    label.htmlFor = question.id;
    label.textContent = `Decision question ${index + 1}`;
    const input = document.createElement('textarea');
    input.id = question.id;
    input.rows = 2;
    input.maxLength = QUESTION_LENGTH;
    input.value = question.instructions;
    input.placeholder = 'Write a decision question…';
    input.addEventListener('input', () => { question.instructions = input.value; clearError(); });
    field.append(label, input);

    const typeField = document.createElement('div');
    typeField.className = 'question-type';
    const typeLabel = document.createElement('label');
    typeLabel.htmlFor = `${question.id}-type`;
    typeLabel.textContent = 'Decision type';
    const type = document.createElement('select');
    type.id = `${question.id}-type`;
    for (const [value, text] of [['noul', 'Yes / no'], ['choice', 'Choice'], ['score', 'Score']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = question.type === value;
      type.append(option);
    }
    type.addEventListener('change', () => {
      question.type = type.value;
      if (question.type === 'noul') question.criteria = [];
      if (question.type !== 'noul' && question.criteria.length < 2) question.criteria = question.type === 'choice' ? ['Option A', 'Option B'] : ['Low', 'High'];
      renderQuestions();
      clearError();
    });
    typeField.append(typeLabel, type);
    field.append(typeField);

    if (question.type !== 'noul') {
      const criteriaLabelElement = document.createElement('label');
      criteriaLabelElement.htmlFor = `${question.id}-criteria`;
      criteriaLabelElement.textContent = criteriaLabel(question.type);
      const criteria = document.createElement('textarea');
      criteria.id = `${question.id}-criteria`;
      criteria.rows = 3;
      criteria.value = question.criteria.join('\n');
      criteria.placeholder = question.type === 'choice' ? 'Billing\nTechnical' : 'Low\nHigh';
      criteria.addEventListener('input', () => {
        question.criteria = criteria.value.split('\n').map((value) => value.trim()).filter(Boolean);
        clearError();
      });
      field.append(criteriaLabelElement, criteria);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove decision question ${index + 1}`);
    remove.disabled = state.questions.length === 1 || Boolean(state.busy);
    remove.addEventListener('click', () => {
      state.questions.splice(index, 1);
      renderQuestions();
      updateControls();
      announce('Question removed.');
    });

    row.append(number, field, remove);
    fragment.append(row);
  });
  elements.questionList.replaceChildren(fragment);
  elements.questionCount.textContent = `${state.questions.length} of ${QUESTION_LIMIT} questions`;
  updateControls();
}

function setResultsEmpty() {
  state.completedResults = [];
  state.resultCards.clear();
  elements.resultsList.replaceChildren();
  elements.resultsEmpty.hidden = false;
  updateResultTools();
}

function updateResultTools() {
  const ready = !state.busy && state.completedResults.length > 0;
  elements.copyResults.disabled = !ready;
  elements.exportResults.disabled = !ready;
}

function createResultCard(index, question) {
  const article = document.createElement('article');
  article.className = 'result-card is-pending';
  const header = document.createElement('div');
  header.className = 'result-card-header';
  const label = document.createElement('p');
  label.className = 'result-label';
  label.textContent = `Question ${String(index + 1).padStart(2, '0')}`;
  const status = document.createElement('span');
  status.className = 'result-status';
  status.textContent = 'Waiting';
  header.append(label, status);
  const title = document.createElement('h3');
  title.textContent = question.instructions;
  const body = document.createElement('div');
  body.className = 'decision-output';
  body.textContent = 'Evaluating typed decision…';
  article.append(header, title, body);
  elements.resultsList.append(article);
  state.resultCards.set(index, { article, status, body, question });
}

function probabilityEntries(answer, question) {
  if (answer.type === 'noul') {
    const probability = Number(answer.noul);
    return [['Yes', probability], ['No', 1 - probability]];
  }
  return Object.entries(answer.probabilities ?? {}).map(([option, probability]) => {
    if (answer.type !== 'score') return [option, probability];
    const label = answer.legend?.[option] ?? question?.criteria?.[Number(option)] ?? option;
    return [label, probability];
  });
}

function decisionValue(answer, question) {
  if (answer.type === 'choice') return answer.choice;
  if (answer.type === 'score') {
    const maximum = Math.max(0, (question?.criteria?.length ?? 1) - 1);
    return `Expected score: ${Number(answer.score).toFixed(2)} / ${maximum}`;
  }
  if (answer.type === 'noul') return Number(answer.noul) >= .5 ? 'Yes' : 'No';
  return 'No value returned';
}

function renderDecision(answer, question) {
  const output = document.createElement('div');
  const value = document.createElement('p');
  value.className = 'decision-value';
  value.textContent = decisionValue(answer, question);
  output.append(value);

  const table = document.createElement('table');
  table.className = 'decision-table';
  const body = document.createElement('tbody');
  const chosen = answer.type === 'choice' ? answer.choice : answer.type === 'noul' ? (Number(answer.noul) >= .5 ? 'Yes' : 'No') : null;
  const entries = probabilityEntries(answer, question);
  let highest = -Infinity;
  if (answer.type === 'score') highest = Math.max(...entries.map(([, probability]) => Number(probability)));
  entries.forEach(([option, probability]) => {
    const row = document.createElement('tr');
    const optionCell = document.createElement('th');
    optionCell.scope = 'row';
    optionCell.textContent = option;
    const barCell = document.createElement('td');
    const meter = document.createElement('span');
    meter.className = 'probability-bar';
    const width = Math.max(0, Math.min(100, Number(probability) * 100));
    meter.style.width = `${width}%`;
    barCell.append(meter);
    const probabilityCell = document.createElement('td');
    probabilityCell.className = 'probability-value';
    probabilityCell.textContent = Number(probability).toFixed(3);
    if (option === chosen || (answer.type === 'score' && Number(probability) === highest)) row.className = 'is-selected';
    row.append(optionCell, barCell, probabilityCell);
    body.append(row);
  });
  table.append(body);
  output.append(table);
  return output;
}

function completeResult(index, question, answer) {
  const card = state.resultCards.get(index);
  if (!card) return;
  card.body.replaceChildren(renderDecision(answer, card.question));
  card.status.textContent = 'Complete';
  card.article.classList.remove('is-pending');
  card.article.classList.add('is-complete');
  state.completedResults[index] = { question, answer };
}

function setBusy(kind) { state.busy = kind; updateControls(); }

function updateControls() {
  const busy = Boolean(state.busy);
  const model = selectedModel();
  const modelAvailable = modelIsAvailable(model);
  const supported = state.support?.supported === true;
  const ready = supported && modelAvailable && state.loadedModelId === model?.id;
  elements.modelSelect.disabled = busy;
  elements.loadModel.disabled = busy || !supported || !modelAvailable;
  elements.evaluate.disabled = busy || !ready;
  elements.stop.disabled = !busy;
  elements.source.disabled = busy;
  elements.loadExample.disabled = busy;
  elements.addQuestion.disabled = busy || state.questions.length >= QUESTION_LIMIT;
  elements.resetQuestions.disabled = busy;
  elements.questionList.querySelectorAll('textarea, select, .icon-button').forEach((control) => { control.disabled = busy || (control.classList.contains('icon-button') && state.questions.length === 1); });
  elements.evaluationHint.textContent = busy ? (state.busy === 'loading' ? 'Loading local model…' : 'Evaluating typed decisions…') : model?.unavailableReason || (ready ? state.runtimeInfo?.label || 'Model ready.' : 'Load a model to evaluate.');
  updateResultTools();
}

function validateInput() {
  const text = elements.source.value.trim();
  if (!text) return { error: 'Add source text before evaluating.' };
  if (text.length > SOURCE_LIMIT) return { error: `Source text must be ${SOURCE_LIMIT.toLocaleString()} characters or fewer.` };
  if (!state.questions.length) return { error: 'Add a decision question.' };
  for (const [index, question] of state.questions.entries()) {
    const instructions = question.instructions.trim();
    if (!instructions) return { error: `Question ${index + 1} needs text.` };
    if (instructions.length > QUESTION_LENGTH) return { error: `Question ${index + 1} is too long.` };
    if (question.type !== 'noul') {
      const criteria = question.criteria.map((item) => item.trim()).filter(Boolean);
      if (criteria.length < 2) return { error: `Question ${index + 1} needs at least two options.` };
      if (criteria.length > CRITERIA_LIMIT) return { error: `Question ${index + 1} allows up to ${CRITERIA_LIMIT} options.` };
      if (new Set(criteria).size !== criteria.length) return { error: `Question ${index + 1} has duplicate options.` };
      question.criteria = criteria;
    }
  }
  const questions = state.questions.map((question) => {
    const criteria = question.criteria.map((item) => item.trim()).filter(Boolean);
    const typedQuestion = { id: question.id, instructions: question.instructions.trim(), type: question.type };
    if (question.type === 'choice') typedQuestion.criteria = Object.fromEntries(criteria.map((item) => [item, item]));
    if (question.type === 'score') typedQuestion.criteria = criteria;
    return typedQuestion;
  });
  return { text, questions };
}

async function loadModel() {
  const model = selectedModel();
  if (!modelIsAvailable(model) || state.busy || state.support?.supported !== true) return;
  const engine = state.engine;
  clearError();
  setBusy('loading');
  invalidateModel('Starting download…');
  setModelState('Loading');
  try {
    const runtimeInfo = await engine.load(model.id, ({ progress, text, runtimeInfo: loadedRuntimeInfo }) => {
      if (state.busy !== 'loading' || state.engine !== engine) return;
      elements.loadProgress.value = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      if (loadedRuntimeInfo) setRuntimeInfo(loadedRuntimeInfo);
      else if (!state.runtimeInfo) elements.loadStatus.textContent = text || 'Loading model…';
    });
    if (state.engine !== engine) return;
    state.loadedModelId = model.id;
    elements.loadProgress.value = 1;
    setRuntimeInfo(runtimeInfo);
    setModelState('Ready', true);
    announce(`${model.name} is ready: ${runtimeStatusLabel(runtimeInfo)}.`);
  } catch (error) {
    if (state.engine !== engine) return;
    const stopped = error?.name === 'AbortError';
    invalidateModel(stopped ? 'Loading stopped.' : 'Model did not load.');
    showError(stopped ? 'Loading stopped. Use Load model to try again.' : `Model did not load: ${error?.message || 'unknown error'}.`);
  } finally {
    setBusy(null);
  }
}

function markIncompleteCards() {
  for (const card of state.resultCards.values()) {
    if (!card.article.classList.contains('is-complete')) {
      card.status.textContent = 'Incomplete';
      card.body.textContent = 'No completed decision returned.';
      card.article.classList.remove('is-pending');
    }
  }
}

async function evaluate() {
  const input = validateInput();
  if (input.error) return showError(input.error);
  if (state.loadedModelId !== selectedModel()?.id) return showError('Load the selected model first.');
  clearError();
  setResultsEmpty();
  input.questions.forEach((question, index) => createResultCard(index, question));
  elements.resultsEmpty.hidden = true;
  setBusy('evaluating');
  try {
    const results = await state.engine.evaluate({
      text: input.text,
      questions: input.questions,
      onResult: ({ index, question, answer }) => completeResult(index, question, answer)
    });
    state.completedResults = results.map(({ question, answer }) => ({ question, answer }));
    elements.resultsEmpty.hidden = results.length > 0;
    announce('Decisions complete.');
  } catch (error) {
    markIncompleteCards();
    resetEngine();
    invalidateModel('Model reset. Load it again.');
    showError(error?.name === 'AbortError' ? 'Evaluation stopped. Load the model again to continue.' : `Evaluation did not complete: ${error?.message || 'unknown error'}. Load the model again, then retry.`);
  } finally {
    setBusy(null);
  }
}

function stopCurrentWork() {
  if (!state.busy) return;
  state.engine.cancel();
  resetEngine();
  invalidateModel('Stopped. Load the model again.');
  updateControls();
  announce('Stopped. Load the model again to continue.');
}

function plainAnswer(answer, question) {
  const entries = probabilityEntries(answer, question).map(([label, probability]) => `${label}: ${Number(probability).toFixed(3)}`).join(', ');
  return `Value: ${decisionValue(answer, question)}\nProbabilities: ${entries}`;
}

function formatResults() {
  return state.completedResults.filter(Boolean).map(({ question, answer }, index) => `Question ${index + 1}: ${question}\n${plainAnswer(answer, state.resultCards.get(index)?.question)}`).join('\n\n' + '—'.repeat(24) + '\n\n');
}

async function copyResults() {
  const text = formatResults();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); announce('Completed decisions copied.'); }
  catch (error) { showError(`Could not copy: ${error?.message || 'clipboard unavailable'}. Select the results and copy manually.`); }
}

function exportResults() {
  const text = formatResults();
  if (!text) return;
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'decision-results.txt';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announce('Completed decisions exported.');
  } catch (error) { showError(`Could not export: ${error?.message || 'download unavailable'}. Copy the results instead.`); }
}

async function checkRuntime() {
  try {
    state.support = await getRuntimeSupport();
    if (!state.support.supported) {
      elements.runtimeAlert.hidden = false;
      elements.runtimeAlert.textContent = `Local runtime unavailable: ${state.support.reason}. You can still edit the decision inputs.`;
      clearRuntimeInfo();
      setModelState('Unavailable');
    } else {
      elements.runtimeAlert.hidden = true;
      invalidateModel();
    }
  } catch (error) {
    state.support = { supported: false };
    clearRuntimeInfo();
    elements.runtimeAlert.hidden = false;
    elements.runtimeAlert.textContent = `Local runtime unavailable: ${error?.message || 'unknown error'}. You can still edit the decision inputs.`;
    setModelState('Unavailable');
  }
  updateControls();
}

function bindEvents() {
  elements.source.addEventListener('input', () => { updateSourceCount(); clearError(); });
  elements.loadExample.addEventListener('click', () => { elements.source.value = SAMPLE_SOURCE; updateSourceCount(); clearError(); announce('Example loaded.'); });
  elements.modelSelect.addEventListener('change', () => {
    const wasLoaded = state.loadedModelId && state.loadedModelId !== elements.modelSelect.value;
    clearError();
    if (wasLoaded) {
      resetEngine();
      invalidateModel('Model changed. Load the selected model.');
      setResultsEmpty();
    }
    updateModelDetails();
    updateControls();
  });
  elements.addQuestion.addEventListener('click', () => {
    if (state.questions.length >= QUESTION_LIMIT) return;
    state.questions.push(makeQuestion('', 'noul'));
    renderQuestions();
    elements.questionList.querySelectorAll('textarea')[elements.questionList.querySelectorAll('textarea').length - 1]?.focus();
  });
  elements.resetQuestions.addEventListener('click', () => { state.questions = sampleQuestions(); renderQuestions(); clearError(); announce('Sample questions restored.'); });
  elements.loadModel.addEventListener('click', loadModel);
  elements.evaluate.addEventListener('click', evaluate);
  elements.stop.addEventListener('click', stopCurrentWork);
  elements.copyResults.addEventListener('click', copyResults);
  elements.exportResults.addEventListener('click', exportResults);
  window.addEventListener('beforeunload', () => state.engine.dispose(), { once: true });
}

renderModels();
renderQuestions();
updateSourceCount();
bindEvents();
updateControls();
checkRuntime();
