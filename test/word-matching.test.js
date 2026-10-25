import assert from "node:assert/strict";
import test from "node:test";
import kuromoji from "kuromoji.js/promise";
import {
  buildReadingVocabulary,
  findWordMatches,
  getMatureWordCoverage,
  mapTextRange,
  splitTextForTokenization,
  toWordTokens
} from "../word-matching.js";

const tokenizer = await kuromoji.builder({
  dicPath: "node_modules/kuromoji.js/dict/"
}).build();

function match(text, vocabulary, vocabularyReadings = {}) {
  return findWordMatches(
    text,
    toWordTokens(tokenizer.tokenize(text)),
    vocabulary,
    vocabularyReadings
  )
    .map(({ start, end, status }) => ({ surface: text.slice(start, end), status }));
}

test("matches hiragana spellings against kanji Anki expressions by reading", () => {
  const vocabulary = { 分かる: "mature", 食べる: "learning", 天気: "new" };
  const readings = buildReadingVocabulary(vocabulary, tokenizer);

  assert.deepEqual(match("わかった。", vocabulary, readings), [
    { surface: "わかった", status: "mature" }
  ]);
  assert.deepEqual(match("たべました。", vocabulary, readings), [
    { surface: "たべました", status: "learning" }
  ]);
  assert.deepEqual(match("てんき。", vocabulary, readings), [
    { surface: "てんき", status: "new" }
  ]);
});

test("reading aliases contribute to mature page coverage", () => {
  const vocabulary = { 天気: "mature", 猫: "new" };
  const readings = buildReadingVocabulary(vocabulary, tokenizer);
  const text = "てんきとねこ。";
  assert.deepEqual(
    getMatureWordCoverage(text, toWordTokens(tokenizer.tokenize(text)), vocabulary, readings),
    { matureWords: 1, totalWords: 2, percentage: 50 }
  );
});

test("matches inflected verbs by their Anki dictionary form", () => {
  assert.deepEqual(match("昨日は本を読みました。", { 読む: "known" }), [
    { surface: "昨日", status: "unknown" },
    { surface: "本", status: "unknown" },
    { surface: "読みました", status: "mature" }
  ]);
  assert.deepEqual(match("食べなかった。", { 食べる: "learning" }), [
    { surface: "食べなかった", status: "learning" }
  ]);
});

test("extends te-form verbs through the connective particle", () => {
  assert.deepEqual(match("猫が走っている。", { 走る: "new" }), [
    { surface: "猫", status: "unknown" },
    { surface: "走って", status: "new" },
    { surface: "いる", status: "unknown" }
  ]);
});

test("highlights words missing from the deck but not particles or punctuation", () => {
  assert.deepEqual(match("猫が走っている。", { 犬: "mature" }), [
    { surface: "猫", status: "unknown" },
    { surface: "走って", status: "unknown" },
    { surface: "いる", status: "unknown" }
  ]);
});

test("uses normalized surface forms for non-conjugated words", () => {
  assert.deepEqual(match("猫を見た。", { "猫": "known", 見る: "learning" }), [
    { surface: "猫", status: "mature" },
    { surface: "見た", status: "learning" }
  ]);
});

test("matches words split by ruby markup and maps highlights only to visible text", () => {
  const text = "弱いところが見つかりました。";
  const tokens = toWordTokens(tokenizer.tokenize(text));
  const wordMatch = findWordMatches(text, tokens, { 見つかる: "known" })
    .find(({ start }) => start === text.indexOf("見"));
  assert.ok(wordMatch);
  assert.equal(text.slice(wordMatch.start, wordMatch.end), "見つかりました");

  const baseNode = {};
  const conjugationNode = {};
  const splitAt = text.indexOf("見") + 1;
  assert.deepEqual(
    mapTextRange([
      { node: baseNode, start: 0, end: splitAt },
      { node: conjugationNode, start: splitAt, end: text.length }
    ], wordMatch.start, wordMatch.end),
    [
      { node: baseNode, start: wordMatch.start, end: splitAt },
      { node: conjugationNode, start: 0, end: wordMatch.end - splitAt }
    ]
  );
});

test("distinguishes new deck cards from words absent from the deck", () => {
  assert.deepEqual(match("猫と犬。", { 猫: "new" }), [
    { surface: "猫", status: "new" },
    { surface: "犬", status: "unknown" }
  ]);
});

test("calculates mature coverage from word occurrences, including repeated words", () => {
  const text = "猫と猫を犬が見る。";
  const tokens = toWordTokens(tokenizer.tokenize(text));
  assert.deepEqual(
    getMatureWordCoverage(text, tokens, { 猫: "mature", 見る: "learning" }),
    { matureWords: 2, totalWords: 4, percentage: 50 }
  );
});

test("returns zero coverage when no Japanese lexical words are present", () => {
  const text = "、。";
  const tokens = toWordTokens(tokenizer.tokenize(text));
  assert.deepEqual(getMatureWordCoverage(text, tokens, {}), {
    matureWords: 0,
    totalWords: 0,
    percentage: 0
  });
});

test("splits long text into bounded chunks with overlapping word-boundary context", () => {
  const text = "猫".repeat(23);
  const chunks = splitTextForTokenization(text, 10, 2);
  assert.deepEqual(chunks.map(({ text, offset, coreStart, coreEnd }) => ({
    text,
    offset,
    coreStart,
    coreEnd
  })), [
    { text: "猫".repeat(12), offset: 0, coreStart: 0, coreEnd: 10 },
    { text: "猫".repeat(14), offset: 8, coreStart: 2, coreEnd: 12 },
    { text: "猫".repeat(5), offset: 18, coreStart: 2, coreEnd: 5 }
  ]);
});
