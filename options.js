const DEFAULT_COLORS = {
  unknown: "#a78bfa",
  mature: "#68be78",
  learning: "#ffc452",
  new: "#ff7373"
};
const DEFAULT_STYLES = {
  unknown: "background",
  mature: "background",
  learning: "background",
  new: "background"
};

const form = document.querySelector("#settings");
const excludedSitesInput = document.querySelector("#excludedSites");
const statusElement = document.querySelector("#status");

initialize();

async function initialize() {
  const stored = await chrome.storage.local.get(["highlightColors", "highlightStyles", "excludedSites"]);
  const colors = { ...DEFAULT_COLORS, ...stored.highlightColors };
  const styles = { ...DEFAULT_STYLES, ...stored.highlightStyles };
  if (!stored.highlightColors?.mature && stored.highlightColors?.known) {
    colors.mature = stored.highlightColors.known;
  }
  for (const status of Object.keys(DEFAULT_COLORS)) {
    form.elements.namedItem(status).value = colors[status];
    form.elements.namedItem(`style-${status}`).value = styles[status];
  }
  excludedSitesInput.value = (stored.excludedSites || []).join("\n");
  form.addEventListener("submit", saveSettings);
}

async function saveSettings(event) {
  event.preventDefault();
  const highlightColors = {};
  const highlightStyles = {};
  for (const status of Object.keys(DEFAULT_COLORS)) {
    const color = form.elements.namedItem(status).value;
    const style = form.elements.namedItem(`style-${status}`).value;
    if (!CSS.supports("color", color)) {
      statusElement.textContent = `Invalid color for ${status}.`;
      return;
    }
    if (!Object.hasOwn(DEFAULT_STYLES, status) || !["background", "underline", "text"].includes(style)) {
      statusElement.textContent = `Invalid display style for ${status}.`;
      return;
    }
    highlightColors[status] = color;
    highlightStyles[status] = style;
  }

  const excludedSites = [...new Set(
    excludedSitesInput.value
      .split(/\r?\n/)
      .map((site) => site.trim().toLowerCase())
      .filter(Boolean)
  )];
  if (excludedSites.some((site) => !/^[a-z0-9.-]+$/.test(site))) {
    statusElement.textContent = "Enter hostnames only, one per line.";
    return;
  }

  await chrome.storage.local.set({ highlightColors, highlightStyles, excludedSites });
  statusElement.textContent = "Settings saved.";
}
