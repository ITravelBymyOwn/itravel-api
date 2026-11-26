import { copyFile, mkdir } from 'node:fs/promises';

const dependencies = new URL('./node_modules/', import.meta.url);
const output = new URL('./dist/', import.meta.url);
const assets = {
  'pdf.min.mjs': 'pdfjs-dist/legacy/build/pdf.min.mjs',
  'pdf.worker.min.mjs': 'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  'pdfjs-LICENSE.txt': 'pdfjs-dist/LICENSE',
  'tesseract.min.js': 'tesseract.js/dist/tesseract.min.js',
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract-LICENSE.txt': 'tesseract.js-core/LICENSE',
  'eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  'spa.traineddata.gz': '@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz'
};

await mkdir(output, { recursive: true });
await Promise.all(Object.entries(assets).map(([name, source]) => copyFile(
  new URL(source, dependencies), new URL(name, output)
)));
