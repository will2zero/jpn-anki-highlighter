import {
  DEFAULT_ANKI_CONNECTION,
  DEFAULT_HIGHLIGHT_COLORS,
  DEFAULT_HIGHLIGHT_STYLES,
  HIGHLIGHT_STYLES
} from "./constants.js";

const form = document.querySelector("#settings");
const excludedSitesInput = document.querySelector("#excludedSites");
const statusElement = document.querySelector("#status");
const testConnectionButton = document.querySelector("#testAnkiConnection");

initialize();

async function initialize() {
  const stored = await chrome.storage.local.get([
    "highlightColors", "highlightStyles", "excludedSites", "ankiConnection"
  ]);
  const colors = { ...DEFAULT_HIGHLIGHT_COLORS, ...stored.highlightColors };
  const styles = { ...DEFAULT_HIGHLIGHT_STYLES, ...stored.highlightStyles };
  const ankiConnection = { ...DEFAULT_ANKI_CONNECTION, ...stored.ankiConnection };
  if (!stored.highlightColors?.mature && stored.highlightColors?.known) {
    colors.mature = stored.highlightColors.known;
  }
  for (const status of Object.keys(DEFAULT_HIGHLIGHT_COLORS)) {
    form.elements.namedItem(status).value = colors[status];
    form.elements.namedItem(`style-${status}`).value = styles[status];
  }
  form.elements.namedItem("ankiHost").value = ankiConnection.host;
  form.elements.namedItem("ankiPort").value = ankiConnection.port;
  form.elements.namedItem("ankiUseHttps").checked = ankiConnection.useHttps;
  excludedSitesInput.value = (stored.excludedSites || []).join("\n");
  form.addEventListener("submit", saveSettings);
  testConnectionButton.addEventListener("click", testAnkiConnection);
}

async function saveSettings(event) {
  event.preventDefault();
  const highlightColors = {};
  const highlightStyles = {};
  let ankiConnection;
  try {
    ankiConnection = readAnkiConnection();
  } catch (error) {
    statusElement.textContent = error.message;
    return;
  }

  for (const status of Object.keys(DEFAULT_HIGHLIGHT_COLORS)) {
    const color = form.elements.namedItem(status).value;
    const style = form.elements.namedItem(`style-${status}`).value;
    if (!CSS.supports("color", color)) {
      statusElement.textContent = `Invalid color for ${status}.`;
      return;
    }
    if (!Object.hasOwn(DEFAULT_HIGHLIGHT_STYLES, status) || !HIGHLIGHT_STYLES.includes(style)) {
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

  if (!await requestAnkiOriginPermission(ankiConnection)) {
    statusElement.textContent = "Connection permission was not granted; settings were not saved.";
    return;
  }
  await chrome.storage.local.set({ highlightColors, highlightStyles, excludedSites, ankiConnection });
  statusElement.textContent = "Settings saved.";
}

function readAnkiConnection() {
  const host = form.elements.namedItem("ankiHost").value.trim();
  const port = Number(form.elements.namedItem("ankiPort").value);
  const useHttps = form.elements.namedItem("ankiUseHttps").checked;
  if (!host) throw new Error("Enter the hostname or IP address running AnkiConnect.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Enter a port between 1 and 65535.");
  }
  let url;
  try {
    url = new URL(`${useHttps ? "https" : "http"}://${host}:${port}`);
  } catch {
    throw new Error("Enter a valid hostname or IP address. Include brackets around IPv6 addresses.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter only a hostname or IP address, without a URL path.");
  }
  return { host: url.hostname, port, useHttps };
}

async function requestAnkiOriginPermission(connection) {
  const scheme = connection.useHttps ? "https" : "http";
  const origin = `${scheme}://${connection.host}:${connection.port}/*`;
  return chrome.permissions.request({ origins: [origin] });
}

async function testAnkiConnection() {
  testConnectionButton.disabled = true;
  statusElement.textContent = "Checking AnkiConnect…";
  try {
    const ankiConnection = readAnkiConnection();
    if (!await requestAnkiOriginPermission(ankiConnection)) {
      throw new Error("Connection permission was not granted.");
    }
    await chrome.storage.local.set({ ankiConnection });
    const response = await chrome.runtime.sendMessage({ type: "anki-test-connection" });
    if (!response?.ok) {
      throw new Error(response?.error || "AnkiConnect could not be reached.");
    }
    statusElement.textContent = `Connected to AnkiConnect (API version ${response.result}).`;
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    testConnectionButton.disabled = false;
  }
}
