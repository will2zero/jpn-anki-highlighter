import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const dictionarySource = new URL("./node_modules/kuromoji.js/dict/", import.meta.url);
const dictionaryTarget = new URL("./dict/", import.meta.url);
const picoCssSource = new URL("./node_modules/@picocss/pico/css/pico.min.css", import.meta.url);
const picoLicenseSource = new URL("./node_modules/@picocss/pico/LICENSE.md", import.meta.url);
const vendorTarget = new URL("./vendor/", import.meta.url);
const pathShim = fileURLToPath(new URL("./path-shim.js", import.meta.url));

await build({
  entryPoints: ["background.js", "content.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outdir: ".",
  entryNames: "[name].bundle",
  sourcemap: false,
  plugins: [{
    name: "extension-path",
    setup(build) {
      build.onResolve({ filter: /^(node:)?path$/ }, () => ({ path: pathShim }));
    }
  }]
});

await mkdir(dictionaryTarget, { recursive: true });
await cp(dictionarySource, dictionaryTarget, { recursive: true });
await mkdir(vendorTarget, { recursive: true });
await cp(picoCssSource, new URL("./vendor/pico.min.css", import.meta.url));
await cp(picoLicenseSource, new URL("./vendor/PICO-LICENSE", import.meta.url));
