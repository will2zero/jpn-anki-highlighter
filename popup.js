const enabledInput = document.querySelector("#enabled");
const deckPicker = document.querySelector("#deckPicker");
const deckPickerTrigger = document.querySelector("#deckPickerTrigger");
const deckPickerSummary = document.querySelector("#deckPickerSummary");
const deckPickerMenu = document.querySelector("#deckPickerMenu");
const deckOptions = document.querySelector("#decks");
const fieldSelect = document.querySelector("#field");
const refreshButton = document.querySelector("#refresh");
const syncButton = document.querySelector("#sync");
const settingsButton = document.querySelector("#settings");
const statusElement = document.querySelector("#status");
const coverageValue = document.querySelector("#coverageValue");
const coverageDetail = document.querySelector("#coverageDetail");
const coverageProgress = document.querySelector("#coverageProgress");
let fieldLoadId = 0;

initialize();

async function initialize() {
  const stored = await chrome.storage.local.get([
    "enabled", "selectedDecks", "expressionField", "lastSync", "vocabulary"
  ]);
  enabledInput.checked = stored.enabled !== false;
  statusElement.textContent = stored.lastSync
    ? `Last sync: ${new Date(stored.lastSync).toLocaleString()} (${Object.keys(stored.vocabulary || {}).length} words)`
    : "Connect to Anki to load decks and sync.";

  enabledInput.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: enabledInput.checked });
  });
  deckPickerTrigger.addEventListener("click", toggleDeckPicker);
  deckOptions.addEventListener("change", onDeckSelectionChanged);
  fieldSelect.addEventListener("change", persistSettings);
  refreshButton.addEventListener("click", loadAnkiOptions);
  syncButton.addEventListener("click", sync);
  settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeyDown);

  if (stored.selectedDecks?.length || stored.expressionField) {
    deckOptions.dataset.selected = JSON.stringify(stored.selectedDecks || []);
    updateDeckPickerSummary(stored.selectedDecks || []);
    fieldSelect.dataset.selected = stored.expressionField || "";
  }

  void loadPageCoverage();
  void loadAnkiOptions();
}

function toggleDeckPicker() {
  setDeckPickerOpen(deckPickerMenu.hidden);
}

function setDeckPickerOpen(isOpen) {
  deckPickerMenu.hidden = !isOpen;
  deckPickerTrigger.setAttribute("aria-expanded", String(isOpen));
}

function onDocumentClick(event) {
  if (!deckPicker.contains(event.target)) setDeckPickerOpen(false);
}

function onDocumentKeyDown(event) {
  if (event.key === "Escape" && !deckPickerMenu.hidden) {
    setDeckPickerOpen(false);
    deckPickerTrigger.focus();
  }
}

async function loadPageCoverage() {
  coverageValue.textContent = "Checking current page…";
  coverageDetail.textContent = "Mature words out of Japanese word occurrences";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      coverageValue.textContent = "Page coverage unavailable";
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: "anki-get-page-coverage" });
    if (!response?.ok) throw new Error(response?.error || "Could not read page coverage.");
    renderPageCoverage(response.result);
  } catch {
    coverageValue.textContent = "Page coverage unavailable";
    coverageDetail.textContent = "Open a regular webpage and reload it to analyze its text.";
  }
}

function renderPageCoverage(coverage) {
  if (coverage.state === "disabled") {
    setCoverageMessage("Off", "Turn highlighting on to scan this page.");
    return;
  }
  if (coverage.state === "excluded") {
    setCoverageMessage("Site excluded", "This hostname is on your exclusion list.");
    return;
  }
  if (coverage.state === "unsupported") {
    setCoverageMessage("Unsupported page", "Try a regular webpage in a Chromium browser.");
    return;
  }
  if (coverage.state === "no-vocabulary") {
    setCoverageMessage("Sync Anki", "Choose your decks to calculate page coverage.");
    return;
  }
  if (coverage.totalWords === 0) {
    setCoverageMessage("No words yet", "No Japanese word occurrences found on this page.");
    return;
  }

  coverageValue.textContent = `${coverage.percentage}%`;
  coverageDetail.textContent =
    `${coverage.matureWords} of ${coverage.totalWords} Japanese word occurrences`;
  coverageProgress.value = coverage.percentage;
}

function setCoverageMessage(value, detail) {
  coverageValue.textContent = value;
  coverageDetail.textContent = detail;
  coverageProgress.value = 0;
}

async function loadAnkiOptions() {
  setBusy(true);
  statusElement.textContent = "Loading decks from Anki…";
  deckPickerTrigger.disabled = true;
  deckOptions.replaceChildren(createDeckMessage("Loading decks from Anki…"));
  try {
    const decks = await sendMessage({ type: "anki-decks" });
    const previouslySelected = new Set(JSON.parse(deckOptions.dataset.selected || "[]"));
    const options = decks.map((deck) => createDeckOption(
      deck,
      previouslySelected.has(deck)
    ));
    if (options.length === 0) options.push(createDeckMessage("No decks found in Anki."));
    deckOptions.replaceChildren(...options);
    const selectedDecks = [...previouslySelected].filter((deck) => decks.includes(deck));
    updateDeckPickerSummary(selectedDecks);
    deckPickerTrigger.disabled = decks.length === 0;
    statusElement.textContent = `Loaded ${decks.length} decks. Select the deck or decks to use.`;
    await onDeckSelectionChanged();
  } catch (error) {
    deckOptions.replaceChildren(createDeckMessage("Could not load decks. Check the status below."));
    deckPickerTrigger.disabled = true;
    statusElement.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function sync() {
  setBusy(true);
  statusElement.textContent = "Syncing cards from Anki…";
  try {
    const result = await sendMessage({
      type: "anki-sync",
      selectedDecks: getSelectedDecks(),
      expressionField: fieldSelect.value
    });
    statusElement.textContent = `Synced ${result.wordCount} words.`;
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function persistSettings() {
  const selectedDecks = getSelectedDecks();
  const expressionField = fieldSelect.value;
  deckOptions.dataset.selected = JSON.stringify(selectedDecks);
  updateDeckPickerSummary(selectedDecks);
  fieldSelect.dataset.selected = expressionField;
  await chrome.storage.local.set({ selectedDecks, expressionField });
}

async function onDeckSelectionChanged() {
  await persistSettings();
  const requestId = ++fieldLoadId;
  const selectedDecks = getSelectedDecks();
  const previousField = fieldSelect.value || fieldSelect.dataset.selected || "";
  fieldSelect.disabled = true;
  fieldSelect.replaceChildren(new Option(
    selectedDecks.length ? "Loading fields…" : "Choose decks first…",
    ""
  ));

  if (selectedDecks.length === 0) {
    await chrome.storage.local.set({ expressionField: "" });
    fieldSelect.dataset.selected = "";
    statusElement.textContent = "Select one or more decks to see their fields.";
    return;
  }

  statusElement.textContent = "Finding note fields in the selected decks…";
  try {
    const models = await sendMessage({ type: "anki-fields", selectedDecks });
    if (requestId !== fieldLoadId) return;
    const fields = [...new Set(models.flatMap((model) => model.fields))].sort();
    fieldSelect.replaceChildren(new Option(
      fields.length ? "Choose a field…" : "No notes found in these decks",
      ""
    ));
    for (const name of fields) {
      const option = new Option(name, name);
      option.selected = name === previousField;
      fieldSelect.add(option);
    }
    fieldSelect.disabled = fields.length === 0;
    fieldSelect.dataset.selected = fieldSelect.value;
    await persistSettings();
    statusElement.textContent = fields.length
      ? `Showing ${fields.length} fields with data in the selected decks.`
      : "No populated fields found in the selected decks.";
  } catch (error) {
    if (requestId !== fieldLoadId) return;
    fieldSelect.replaceChildren(new Option("Could not load fields", ""));
    statusElement.textContent = error.message;
  }
}

function getSelectedDecks() {
  return [...deckOptions.querySelectorAll('input[type="checkbox"]:checked')]
    .map((checkbox) => checkbox.value);
}

function createDeckOption(deck, selected) {
  const label = document.createElement("label");
  label.className = "deck-option";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = deck;
  checkbox.checked = selected;

  const name = document.createElement("span");
  name.textContent = deck;
  label.append(checkbox, name);
  return label;
}

function createDeckMessage(message) {
  const item = document.createElement("p");
  item.className = "deck-empty";
  item.textContent = message;
  return item;
}

function updateDeckPickerSummary(selectedDecks) {
  const count = selectedDecks.length;
  deckPickerSummary.textContent = count === 0
    ? "Select Anki decks…"
    : `${count} deck${count === 1 ? "" : "s"} selected`;
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "The extension could not complete the request.");
  return response.result;
}

function setBusy(busy) {
  refreshButton.disabled = busy;
  syncButton.disabled = busy;
}
