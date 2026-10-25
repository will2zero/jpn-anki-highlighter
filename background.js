import kuromoji from "kuromoji.js/browser";
import { buildReadingVocabulary, toWordTokens } from "./word-matching.js";
import {
  DEFAULT_ANKI_CONNECTION,
  DEFAULT_HIGHLIGHT_COLORS
} from "./constants.js";
const KNOWN_INTERVAL_DAYS = 21;
const CARD_BATCH_SIZE = 300;
let tokenizerPromise;

const defaultState = {
  enabled: true,
  selectedDecks: [],
  expressionField: "",
  vocabulary: {},
  vocabularyReadings: {},
  ankiConnection: DEFAULT_ANKI_CONNECTION,
  highlightColors: DEFAULT_HIGHLIGHT_COLORS,
  excludedSites: [],
  lastSync: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get({ ...defaultState, vocabularyReadings: null });
  const vocabularyReadings = stored.vocabularyReadings ||
    (Object.keys(stored.vocabulary).length
      ? buildReadingVocabulary(stored.vocabulary, await getTokenizer())
      : {});
  await chrome.storage.local.set({
    enabled: stored.enabled,
    selectedDecks: stored.selectedDecks,
    expressionField: stored.expressionField,
    vocabulary: stored.vocabulary,
    vocabularyReadings,
    ankiConnection: stored.ankiConnection || DEFAULT_ANKI_CONNECTION,
    highlightColors: stored.highlightColors,
    excludedSites: stored.excludedSites,
    lastSync: stored.lastSync
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  const handlers = {
    "anki-decks": getDecks,
    "anki-fields": getFields,
    "anki-sync": syncVocabulary,
    "anki-test-connection": testAnkiConnection,
    "anki-tokenize": tokenizeTexts
  };
  const handler = handlers[message.type];
  if (!handler) return;

  handler(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  );
  return true;
});

async function invokeAnki(action, params = {}) {
  const { ankiConnection = DEFAULT_ANKI_CONNECTION } =
    await chrome.storage.local.get("ankiConnection");
  const url = getAnkiConnectUrl(ankiConnection);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params })
    });
  } catch (error) {
    throw new Error(
      `Could not reach AnkiConnect at ${url}. Make sure Anki is running, AnkiConnect is installed, and the configured host is reachable. ${error.message}`
    );
  }

  if (!response.ok) {
    throw new Error(`AnkiConnect returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`AnkiConnect ${action} failed: ${payload.error}`);
  }
  return payload.result;
}

async function testAnkiConnection() {
  return invokeAnki("version");
}

function getAnkiConnectUrl(connection) {
  const host = typeof connection?.host === "string" ? connection.host : "";
  const port = Number(connection?.port);
  const scheme = connection?.useHttps === true ? "https" : "http";
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid AnkiConnect settings. Check the hostname and port in Settings.");
  }

  let url;
  try {
    url = new URL(`${scheme}://${host}:${port}`);
  } catch {
    throw new Error("Invalid AnkiConnect hostname. Check the connection settings.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AnkiConnect host must be a hostname or IP address only.");
  }
  return url.toString();
}

async function getDecks() {
  return invokeAnki("deckNames");
}

async function getFields(message) {
  const selectedDecks = getSelectedDecks(message);
  if (selectedDecks.length === 0) return [];

  const cardIds = await getCardIdsForDecks(selectedDecks);
  const fieldsByModel = new Map();

  for (let start = 0; start < cardIds.length; start += CARD_BATCH_SIZE) {
    const cards = await invokeAnki("cardsInfo", {
      cards: cardIds.slice(start, start + CARD_BATCH_SIZE)
    });
    for (const card of cards) {
      if (!fieldsByModel.has(card.modelName)) fieldsByModel.set(card.modelName, new Set());
      for (const [fieldName, field] of Object.entries(card.fields || {})) {
        if (typeof field.value === "string" && normalizeExpression(field.value)) {
          fieldsByModel.get(card.modelName).add(fieldName);
        }
      }
    }
  }

  return [...fieldsByModel.entries()].map(([modelName, fields]) => ({
    modelName,
    fields: [...fields]
  }));
}

async function tokenizeTexts(message) {
  if (!Array.isArray(message.texts) || message.texts.some((text) => typeof text !== "string")) {
    throw new Error("Invalid text batch for Japanese parsing.");
  }

  const tokenizer = await getTokenizer();
  return message.texts.map((text) =>
    toWordTokens(tokenizer.tokenize(text))
  );
}

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: "dict/" }).build((error, tokenizer) => {
        if (error) reject(error);
        else resolve(tokenizer);
      });
    }).catch((error) => {
      tokenizerPromise = undefined;
      throw new Error(`Could not load the Japanese tokenizer dictionary: ${error.message}`);
    });
  }
  return tokenizerPromise;
}

async function syncVocabulary(message) {
  const selectedDecks = getSelectedDecks(message);
  const expressionField = typeof message.expressionField === "string"
    ? message.expressionField.trim()
    : "";

  if (selectedDecks.length === 0) {
    throw new Error("Select at least one Anki deck before syncing.");
  }
  if (!expressionField) {
    throw new Error("Choose the Anki field that contains the Japanese expression.");
  }

  const cardIds = await getCardIdsForDecks(selectedDecks);
  const vocabulary = {};
  const tokenizer = await getTokenizer();

  for (let start = 0; start < cardIds.length; start += CARD_BATCH_SIZE) {
    const batch = cardIds.slice(start, start + CARD_BATCH_SIZE);
    const cards = await invokeAnki("cardsInfo", { cards: batch });
    for (const card of cards) {
      const field = card.fields?.[expressionField];
      if (!field || typeof field.value !== "string") continue;

      const expression = normalizeExpression(field.value);
      if (!expression) continue;

      const status = getKnowledgeStatus(card);
      const key = normalizeKey(expression);
      if (!key) continue;
      if (!vocabulary[key] || statusRank(status) > statusRank(vocabulary[key])) {
        vocabulary[key] = status;
      }
    }
  }

  const vocabularyReadings = buildReadingVocabulary(vocabulary, tokenizer);
  const lastSync = new Date().toISOString();
  await chrome.storage.local.set({
    selectedDecks,
    expressionField,
    vocabulary,
    vocabularyReadings,
    lastSync
  });

  return { wordCount: Object.keys(vocabulary).length, lastSync };
}

function getSelectedDecks(message) {
  return Array.isArray(message.selectedDecks)
    ? message.selectedDecks.filter((deck) => typeof deck === "string" && deck.length > 0)
    : [];
}

async function getCardIdsForDecks(selectedDecks) {
  const cardIdGroups = await Promise.all(
    selectedDecks.map((deck) =>
      invokeAnki("findCards", { query: `deck:"${deck.replaceAll('"', '\\"')}"` })
    )
  );
  return [...new Set(cardIdGroups.flat())];
}

function getKnowledgeStatus(card) {
  if (card.type === 1 || card.type === 3 || card.queue === 1 || card.queue === 3) {
    return "learning";
  }
  if (Number(card.interval) >= KNOWN_INTERVAL_DAYS) return "mature";
  if (Number(card.reps) > 0 || card.type === 2) return "learning";
  return "new";
}

function statusRank(status) {
  return { new: 0, learning: 1, mature: 2, known: 2 }[status];
}

function normalizeExpression(value) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:div|p|li)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return value.normalize("NFKC").trim();
}
