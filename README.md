# Anki Japanese Highlighter

A Chromium Manifest V3 extension that highlights Japanese words on webpages according to the review state of cards in selected Anki decks. It does not provide dictionary lookups or integrate with Yomitan; highlighting uses the browser's CSS Custom Highlight API without wrapping or replacing page text. Japanese text is parsed locally with Kuromoji so inflected forms can match the dictionary forms saved in Anki.

## Requirements

- Chrome, Edge, Brave, or another Chromium browser with Manifest V3 and the CSS Custom Highlight API.
- Anki with [AnkiConnect](https://ankiweb.net/shared/info/2055492159) installed and running on its default local port, `8765`.
- Node.js and npm to build the extension and bundle the offline Japanese tokenizer dictionary.

## Install for development

1. In Anki, install AnkiConnect and restart Anki.
2. In this project folder, run `npm install` and `npm run build`.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
4. Select this project folder.
5. Copy the extension ID shown on its extension card.
6. In AnkiConnect's configuration, add the extension origin (`chrome-extension://YOUR_EXTENSION_ID`) to `webCorsOriginList`, then restart Anki. Keep the origin restricted to this extension rather than allowing every origin.
7. Open the extension popup; it loads decks from Anki automatically. Open **Choose decks** and check the decks to use. The expression-field list is limited to fields with data on those selected decks. Choose the field containing the Japanese expression, then choose **Sync vocabulary**.

The extension requests access only to the local AnkiConnect endpoints `127.0.0.1:8765` and `localhost:8765`. It reads cards and stores the resulting vocabulary in local extension storage. Sync again after reviewing or changing cards. The Kuromoji dictionary is bundled locally and is not downloaded at runtime.

## Highlight states

- **Not in deck**: the Japanese word is not present in the vocabulary synced from the selected decks.
- **New**: the card is new and has not been reviewed.
- **Learning**: the card is in learning/relearning, or has reviews but an interval under 21 days.
- **Mature**: review interval is at least 21 days (Anki's mature-card threshold).

If a note has multiple cards, the strongest in-deck state is used: new, learning, then mature. Words absent from the selected decks are highlighted as not in deck; particles and punctuation are not labeled as unknown words. Kuromoji tokenizes page text and matches each token's dictionary form against Anki expressions, so conjugated words can match their base forms. Kana-only spellings can also match kanji expressions using their dictionary readings. Inline markup is joined while parsing, and ruby reading text (`rt`/`rp`) is ignored, so words split by furigana markup can still match and only their visible base text is highlighted. The extension observes page text changes and refreshes highlights as the page updates.

The extension popup shows mature word coverage for the active page: mature Japanese word occurrences divided by all Japanese lexical word occurrences, rounded to the nearest percent. Repeated appearances count separately.

Use the popup's **Enable highlighting** toggle to turn page highlights off without deleting the synced vocabulary. The **Highlight settings** page lets you choose each state's color and display style (background, underline, or text color), and exclude hostnames (including all their subdomains).

The popup and settings page use a dark theme and Pico CSS, copied into the extension locally during `npm run build`; no styling assets are loaded from a CDN.
