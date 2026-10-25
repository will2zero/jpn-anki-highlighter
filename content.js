import {
  findWordMatches,
  getMatureWordCoverage,
  mapTextRange,
  splitTextForTokenization
} from "./word-matching.js";

const HIGHLIGHT_NAMES = ["anki-unknown", "anki-new", "anki-learning", "anki-mature"];
const EXCLUDED_PARENTS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "RT", "RP",
  "CODE", "PRE", "SVG", "MATH"
]);
const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIALOG",
  "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV",
  "OL", "P", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"
]);
const TOKEN_BATCH_SIZE = 25;
const TOKEN_BATCH_CHAR_LIMIT = 12000;
const TOKEN_CHUNK_LENGTH = 5000;
const TOKEN_CHUNK_OVERLAP = 64;
const TOKEN_CACHE_LIMIT = 1000;

let enabled = true;
let vocabulary = {};
let vocabularyReadings = {};
let highlightColors = {};
let highlightStyles = {};
let excludedSites = [];
let updateTimer;
let refreshRunning = false;
let refreshPending = false;
let pageCoverage = null;
const coverageWaiters = [];
const tokenCache = new Map();

initialize();

async function initialize() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "anki-get-page-coverage") return;
    if (pageCoverage) {
      sendResponse({ ok: true, result: pageCoverage });
    } else {
      coverageWaiters.push(sendResponse);
      return true;
    }
  });

  const stored = await chrome.storage.local.get([
    "enabled", "vocabulary", "vocabularyReadings", "highlightColors", "highlightStyles", "excludedSites"
  ]);
  enabled = stored.enabled !== false;
  vocabulary = stored.vocabulary || {};
  vocabularyReadings = stored.vocabularyReadings || {};
  highlightColors = { ...stored.highlightColors };
  highlightStyles = { ...stored.highlightStyles };
  if (!highlightColors.mature && highlightColors.known) {
    highlightColors.mature = highlightColors.known;
  }
  excludedSites = stored.excludedSites || [];
  applyHighlightStyles();
  refreshHighlights();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    if (changes.vocabulary) vocabulary = changes.vocabulary.newValue || {};
    if (changes.vocabularyReadings) vocabularyReadings = changes.vocabularyReadings.newValue || {};
    if (changes.highlightColors || changes.highlightStyles) {
      if (changes.highlightColors) {
        highlightColors = changes.highlightColors.newValue || {};
      }
      if (changes.highlightStyles) {
        highlightStyles = changes.highlightStyles.newValue || {};
      }
      applyHighlightStyles();
    }
    if (changes.excludedSites) excludedSites = changes.excludedSites.newValue || [];
    if (changes.enabled || changes.vocabulary || changes.vocabularyReadings || changes.excludedSites) scheduleRefresh();
  });

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

function scheduleRefresh() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(refreshHighlights, 250);
}

async function refreshHighlights() {
  if (!("highlights" in CSS) || typeof Highlight === "undefined") {
    publishPageCoverage({ state: "unsupported" });
    return;
  }
  if (refreshRunning) {
    refreshPending = true;
    return;
  }

  refreshRunning = true;
  try {
    if (!enabled || isSiteExcluded() || Object.keys(vocabulary).length === 0) {
      clearHighlights();
      publishPageCoverage({
        state: !enabled ? "disabled" : isSiteExcluded() ? "excluded" : "no-vocabulary"
      });
      return;
    }

    const ranges = { unknown: [], new: [], learning: [], mature: [] };
    const groups = collectTextGroups(document.body || document.documentElement);
    let matureWords = 0;
    let totalWords = 0;

    let failedBatches = 0;
    for (const batch of getUncachedBatches(groups)) {
      try {
        const tokenGroups = await tokenizeBatch(batch.map(({ text }) => text));
        batch.forEach((chunk, index) => {
          for (const token of tokenGroups[index]) {
            if (token.start < chunk.coreStart || token.start >= chunk.coreEnd) continue;
            chunk.group.tokens.push({
              ...token,
              start: token.start + chunk.offset,
              end: token.end + chunk.offset
            });
          }
        });
      } catch (error) {
        failedBatches++;
        for (const chunk of batch) chunk.group.tokenizationFailed = true;
        console.error("Anki Japanese Highlighter could not parse a text batch.", error);
      }
    }

    for (const group of groups) {
      if (group.tokens && !group.tokenizationFailed) {
        cacheTokens(group.text, group.tokens);
      } else if (group.tokenizationFailed) {
        group.tokens = null;
      }
      delete group.tokenizationFailed;
    }

    for (const { text, segments, tokens } of groups) {
      if (!tokens || segments.some(({ node, text: originalText }) =>
        !node.isConnected || node.nodeValue !== originalText
      )) continue;
      const coverage = getMatureWordCoverage(text, tokens, vocabulary, vocabularyReadings);
      matureWords += coverage.matureWords;
      totalWords += coverage.totalWords;
      for (const match of findWordMatches(text, tokens, vocabulary, vocabularyReadings)) {
        for (const part of mapTextRange(segments, match.start, match.end)) {
          const range = new Range();
          range.setStart(part.node, part.start);
          range.setEnd(part.node, part.end);
          ranges[match.status].push(range);
        }
      }
    }

    clearHighlights();
    for (const status of Object.keys(ranges)) {
      if (ranges[status].length > 0) {
        const highlight = new Highlight();
        for (const range of ranges[status]) highlight.add(range);
        CSS.highlights.set(`anki-${status}`, highlight);
      }
    }
    if (failedBatches > 0) {
      console.warn(`Anki Japanese Highlighter skipped ${failedBatches} text batch(es).`);
    }
    publishPageCoverage({
      state: "ready",
      matureWords,
      totalWords,
      percentage: totalWords === 0 ? 0 : Math.round((matureWords / totalWords) * 100)
    });
  } finally {
    refreshRunning = false;
    if (refreshPending) {
      refreshPending = false;
      scheduleRefresh();
    }
  }
}

function publishPageCoverage(coverage) {
  pageCoverage = coverage;
  for (const sendResponse of coverageWaiters.splice(0)) {
    sendResponse({ ok: true, result: pageCoverage });
  }
}

function collectTextGroups(root) {
  const groups = [];
  let text = "";
  let segments = [];

  function flush() {
    if (text) groups.push({ text, segments, tokens: tokenCache.get(text) });
    text = "";
    segments = [];
  }

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue && !isExcluded(node)) {
        const start = text.length;
        text += node.nodeValue;
        segments.push({ node, text: node.nodeValue, start, end: text.length });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || isExcluded(node)) return;
    if (node.tagName === "BR") {
      flush();
      return;
    }

    const isBlock = node !== root && BLOCK_ELEMENTS.has(node.tagName);
    if (isBlock) flush();
    for (const child of node.childNodes) visit(child);
    if (isBlock) flush();
  }

  visit(root);
  flush();
  return groups;
}

function clearHighlights() {
  for (const name of HIGHLIGHT_NAMES) CSS.highlights.delete(name);
}

function* getUncachedBatches(nodes) {
  let batch = [];
  let characterCount = 0;
  for (const node of nodes) {
    if (node.tokens) continue;
    node.tokens = [];
    node.tokenizationFailed = false;
    for (const chunk of splitTextForTokenization(node.text, TOKEN_CHUNK_LENGTH, TOKEN_CHUNK_OVERLAP)) {
      const item = { ...chunk, group: node };
      if (
        batch.length > 0 &&
        (batch.length >= TOKEN_BATCH_SIZE || characterCount + chunk.text.length > TOKEN_BATCH_CHAR_LIMIT)
      ) {
        yield batch;
        batch = [];
        characterCount = 0;
      }
      batch.push(item);
      characterCount += chunk.text.length;
    }
  }
  if (batch.length > 0) yield batch;
}

async function tokenizeBatch(texts) {
  const response = await chrome.runtime.sendMessage({ type: "anki-tokenize", texts });
  if (!response?.ok) {
    throw new Error(response?.error || "The tokenizer did not return a result.");
  }
  if (!Array.isArray(response.result) || response.result.length !== texts.length) {
    throw new Error("The tokenizer returned an invalid result.");
  }
  return response.result;
}

function cacheTokens(text, tokens) {
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    tokenCache.delete(tokenCache.keys().next().value);
  }
  tokenCache.set(text, tokens);
}

function applyHighlightStyles() {
  const properties = {
    unknown: "--anki-unknown",
    mature: "--anki-mature",
    learning: "--anki-learning",
    new: "--anki-new"
  };
  const opacity = { unknown: 30, mature: 30, learning: 35, new: 35 };
  for (const [status, prefix] of Object.entries(properties)) {
    const color = highlightColors[status];
    if (typeof color !== "string" || !CSS.supports("color", color)) continue;
    const requestedStyle = highlightStyles[status];
    const style = ["background", "underline", "text"].includes(requestedStyle)
      ? requestedStyle
      : "background";
    const background = style === "background"
      ? `color-mix(in srgb, ${color} ${opacity[status]}%, transparent)`
      : "transparent";
    const textColor = style === "text" ? color : "inherit";
    const decoration = style === "underline" ? `underline solid ${color}` : "none";
    document.documentElement.style.setProperty(`${prefix}-background`, background);
    document.documentElement.style.setProperty(`${prefix}-color`, textColor);
    document.documentElement.style.setProperty(`${prefix}-decoration`, decoration);
  }
}

function isSiteExcluded() {
  const hostname = location.hostname.toLowerCase();
  return excludedSites.some((site) => {
    const normalizedSite = typeof site === "string" ? site.trim().toLowerCase() : "";
    return normalizedSite &&
      (hostname === normalizedSite || hostname.endsWith(`.${normalizedSite}`));
  });
}

function isExcluded(node) {
  let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (element) {
    if (
      EXCLUDED_PARENTS.has(element.tagName) ||
      element.isContentEditable
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return Boolean(
    (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)
      ?.closest("[data-anki-highlighter-ignore]")
  );
}
