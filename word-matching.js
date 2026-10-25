const JAPANESE_CHARACTERS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const KANA_WORD = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const LEXICAL_PARTS_OF_SPEECH = new Set([
  "名詞", "動詞", "形容詞", "形容動詞", "副詞", "連体詞", "接続詞", "感動詞"
]);
const STATUS_RANK = { new: 0, learning: 1, mature: 2, known: 2 };

export function toWordTokens(tokens) {
  return tokens.map((token) => {
    const start = token.word_position - 1;
    return {
      start,
      end: start + token.surface_form.length,
      surfaceForm: token.surface_form,
      baseForm: token.basic_form,
      partOfSpeech: token.pos,
      conjugatedType: token.conjugated_type
    };
  });
}

export function buildReadingVocabulary(vocabulary, tokenizer) {
  const readings = {};
  for (const [expression, status] of Object.entries(vocabulary)) {
    const tokens = tokenizer.tokenize(expression);
    if (tokens.length !== 1 || !tokens[0].reading || tokens[0].reading === "*") continue;
    const reading = normalizeKey(toHiragana(tokens[0].reading));
    if (!reading) continue;
    if (!readings[reading] || (STATUS_RANK[status] ?? -1) > (STATUS_RANK[readings[reading]] ?? -1)) {
      readings[reading] = status;
    }
  }
  return readings;
}

export function findWordMatches(text, tokens, vocabulary, vocabularyReadings = {}) {
  const matches = [];
  const consumed = new Set();

  for (let index = 0; index < tokens.length; index++) {
    if (consumed.has(index)) continue;
    const token = tokens[index];
    const baseForm = token.baseForm === "*" ? token.surfaceForm : token.baseForm;
    const deckStatus = vocabulary[normalizeKey(baseForm)] ||
      vocabulary[normalizeKey(token.surfaceForm)] ||
      (KANA_WORD.test(baseForm)
        ? vocabularyReadings[normalizeKey(toHiragana(baseForm))]
        : null);
    const status = normalizeStatus(deckStatus) ||
      (isUnknownWord(token) ? "unknown" : null);
    if (!status) continue;

    let end = token.end;
    if (token.conjugatedType !== "*") {
      for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex++) {
        const next = tokens[nextIndex];
        const surface = text.slice(next.start, next.end);
        const isInflection = next.partOfSpeech === "助動詞" ||
          (next.partOfSpeech === "助詞" && (surface === "て" || surface === "で"));
        if (next.start !== end || !isInflection) break;
        end = next.end;
        consumed.add(nextIndex);
      }
    }
    matches.push({ start: token.start, end, status });
  }

  return matches;
}

function normalizeStatus(status) {
  if (status === "known") return "mature";
  return ["unknown", "new", "learning", "mature"].includes(status) ? status : null;
}

function isUnknownWord(token) {
  return LEXICAL_PARTS_OF_SPEECH.has(token.partOfSpeech) &&
    JAPANESE_CHARACTERS.test(token.surfaceForm);
}

export function getMatureWordCoverage(text, tokens, vocabulary, vocabularyReadings = {}) {
  const matches = findWordMatches(text, tokens, vocabulary, vocabularyReadings);
  const matureWords = matches.filter(({ status }) => status === "mature").length;
  const totalWords = matches.length;
  return {
    matureWords,
    totalWords,
    percentage: totalWords === 0 ? 0 : Math.round((matureWords / totalWords) * 100)
  };
}

export function mapTextRange(segments, start, end) {
  const parts = [];
  for (const segment of segments) {
    const overlapStart = Math.max(start, segment.start);
    const overlapEnd = Math.min(end, segment.end);
    if (overlapStart >= overlapEnd) continue;
    parts.push({
      node: segment.node,
      start: overlapStart - segment.start,
      end: overlapEnd - segment.start
    });
  }
  return parts;
}

export function splitTextForTokenization(text, maxLength, overlap) {
  const chunks = [];
  for (let coreStart = 0; coreStart < text.length; coreStart += maxLength) {
    const coreEnd = Math.min(coreStart + maxLength, text.length);
    const start = Math.max(0, coreStart - overlap);
    const end = Math.min(text.length, coreEnd + overlap);
    chunks.push({
      text: text.slice(start, end),
      offset: start,
      coreStart: coreStart - start,
      coreEnd: coreEnd - start
    });
  }
  return chunks;
}

function normalizeKey(value) {
  return value.normalize("NFKC").trim();
}

function toHiragana(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0x30a1 && codePoint <= 0x30f6
      ? String.fromCodePoint(codePoint - 0x60)
      : character;
  }).join("");
}
