/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let decoder;
function decodeZbic(data, size) {
  if (!Buffer.isBuffer(data) || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024) {
    throw new Error('Invalid ZBIC input size');
  }
  if (!size && !data.length) return Buffer.alloc(0);
  if (!decoder) {
    const wasm = fs.readFileSync(path.join(__dirname, 'zbic.wasm'));
    const mod = new WebAssembly.Module(wasm);
    decoder = new WebAssembly.Instance(mod).exports;
    decoder._initialize();
  }
  const input = decoder.malloc(data.length || 1) >>> 0;
  let output = 0;
  try {
    if (!input) throw new Error('Cannot allocate ZBIC input');
    output = decoder.malloc(size || 1) >>> 0;
    if (!output) throw new Error('Cannot allocate ZBIC output');
    new Uint8Array(decoder.memory.buffer, input, data.length).set(data);
    const result = decoder.ZSTD_decompress(output, size, input, data.length) >>> 0;
    if (decoder.ZSTD_isError(result) || result !== size) throw new Error('Cannot decode NSO ZBIC segment');
    return Buffer.from(new Uint8Array(decoder.memory.buffer, output, size));
  } finally {
    if (output) decoder.free(output);
    if (input) decoder.free(input);
  }
}

module.exports = {decodeZbic};
