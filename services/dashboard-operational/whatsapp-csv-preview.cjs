(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShrigmaWhatsAppCsvPreview = factory();
})(typeof window === 'object' ? window : globalThis, function () {
'use strict';

// Pure, in-memory CSV preview. No file, network, log, ledger or sending API.
// Requirement: docs/REQUISITOS.md:53. A syntactically valid phone is neither
// proof of a real E.164 allocation nor consent/eligibility. Do not infer a DDI,
// remove a Brazilian ninth digit, turn kit into a template or extract a name.
// Comma is the default; semicolon requires an explicit caller option.
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(value).byteLength;
const SCHEMA = 'shrigma-whatsapp-csv-preview-v1';
const HEADERS = Object.freeze(['telefone', 'primeiro_nome', 'kit']);
const LIMITS = Object.freeze({bytes: 1048576, rows: 5000, physicalLines: 10001,
  fieldBytes: 4096, firstNameBytes: 256, kitBytes: 512});
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BAD_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function refusal(code, location = {}) {
  return {schema: SCHEMA, ok: false, error: {code, ...location},
    validation: 'format-only', rows: [], rowResults: [], counts: null};
}
function fail(code, location = {}) { const error = new Error(code); error.code = code;
  error.location = location; throw error; }
function limits(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('CSV_OPTIONS_INVALID');
  if (Object.keys(options).some(k => !['delimiter', 'maxBytes', 'maxRows', 'maxPhysicalLines'].includes(k))) fail('CSV_OPTIONS_INVALID');
  const out = {delimiter: options.delimiter === undefined ? ',' : options.delimiter};
  if (![';', ','].includes(out.delimiter)) fail('CSV_DELIMITER_INVALID');
  for (const [key, hardKey] of [['maxBytes', 'bytes'], ['maxRows', 'rows'], ['maxPhysicalLines', 'physicalLines']]) {
    out[key] = options[key] === undefined ? LIMITS[hardKey] : options[key];
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > LIMITS[hardKey]) fail('CSV_OPTIONS_INVALID');
  }
  return out;
}
function inputText(input, maxBytes) {
  let text, bytes;
  if (typeof input === 'string') {
    if (input.length > maxBytes) fail('CSV_BYTE_LIMIT');
    bytes = byteLength(input);
    if (bytes > maxBytes) fail('CSV_BYTE_LIMIT');
    if (BAD_SURROGATE.test(input)) fail('CSV_ENCODING_INVALID');
    text = input;
  } else if (input instanceof Uint8Array) {
    bytes = input.byteLength;
    if (bytes > maxBytes) fail('CSV_BYTE_LIMIT');
    try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input); }
    catch (_) { fail('CSV_ENCODING_INVALID'); }
  } else { fail('CSV_INPUT_INVALID'); }
  // Strip exactly one initial UTF-8 BOM. Interior BOMs are not silently removed.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return {text, bytes};
}

function records(text, config) {
  const out = []; let fields = [], field = '', state = 'start', dirty = false;
  let line = 1, startLine = 1;
  function fieldEnd() {
    if (byteLength(field) > LIMITS.fieldBytes) fail('CSV_FIELD_BYTE_LIMIT', {line: startLine});
    fields.push(field); field = ''; state = 'start';
  }
  function recordEnd() {
    fieldEnd(); out.push({fields, line: startLine}); fields = []; dirty = false;
    // Header excluded; blank data records still consume the row budget.
    if (out.length > config.maxRows + 1) fail('CSV_ROW_LIMIT', {line: startLine});
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r' || ch === '\n') {
      const width = ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (state === 'quoted') field += text.slice(i, i + width);
      else recordEnd();
      i += width - 1; line++;
      if (i + 1 < text.length && line > config.maxPhysicalLines) fail('CSV_LINE_LIMIT', {line});
      if (state !== 'quoted') startLine = line;
      continue;
    }
    dirty = true;
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += ch;
    } else if (ch === config.delimiter) fieldEnd();
    else if (ch === '"') {
      if (state !== 'start') fail('CSV_QUOTE_UNEXPECTED', {line});
      state = 'quoted';
    } else {
      if (state === 'closed') fail('CSV_AFTER_QUOTE_INVALID', {line});
      field += ch; state = 'plain';
    }
    // Bound a single field while reading; exact UTF-8 size is checked at its end.
    if (field.length > LIMITS.fieldBytes) fail('CSV_FIELD_BYTE_LIMIT', {line: startLine});
  }
  if (state === 'quoted') fail('CSV_QUOTE_UNCLOSED', {line: startLine});
  if (dirty || fields.length || field.length || state === 'closed') recordEnd();
  return out;
}

function previewCsv(input, options = {}) {
  try {
    const config = limits(options), {text, bytes} = inputText(input, config.maxBytes);
    const parsed = records(text, config);
    if (!parsed.length) return refusal('CSV_HEADER_MISSING');
    const headers = parsed[0].fields.map(value => value.trim());
    if (headers.some(h => !h)) return refusal('CSV_HEADER_EMPTY', {line: parsed[0].line});
    if (new Set(headers).size !== headers.length) return refusal('CSV_HEADER_DUPLICATE', {line: parsed[0].line});
    if (headers.length !== HEADERS.length || HEADERS.some(h => !headers.includes(h))) return refusal('CSV_HEADER_INVALID', {line: parsed[0].line});
    const columns = Object.fromEntries(HEADERS.map(key => [key, headers.indexOf(key)]));
    const rows = [], rowResults = [], seen = new Map(), codeCounts = {};
    const counts = {inputBytes: bytes, dataRows: parsed.length - 1, validRows: 0,
      invalidRows: 0, duplicateRows: 0, blankRows: 0, codeCounts};
    for (let index = 1; index < parsed.length; index++) {
      const record = parsed[index], result = {row: index, line: record.line, status: 'invalid', codes: []};
      if (record.fields.length === 1 && !record.fields[0].trim()) {
        result.status = 'blank'; result.codes.push('CSV_BLANK_ROW'); counts.blankRows++;
      } else if (record.fields.length !== headers.length) {
        result.codes.push('CSV_COLUMN_COUNT_INVALID'); counts.invalidRows++;
      } else {
        const telefone = record.fields[columns.telefone].trim();
        const primeiro_nome = record.fields[columns.primeiro_nome].trim();
        const kit = record.fields[columns.kit].trim();
        // E.164 lexical envelope only: 2..15 ASCII digits, nonzero first digit.
        // A local-looking digit string is not relabelled or certified international.
        if (!/^\+?[1-9][0-9]{1,14}$/.test(telefone)) result.codes.push('PHONE_FORMAT_INVALID');
        if (!primeiro_nome) result.codes.push('FIRST_NAME_EMPTY');
        else if (CONTROL.test(primeiro_nome)) result.codes.push('FIRST_NAME_CONTROL_INVALID');
        if (byteLength(primeiro_nome) > LIMITS.firstNameBytes) result.codes.push('FIRST_NAME_BYTE_LIMIT');
        if (CONTROL.test(kit)) result.codes.push('KIT_CONTROL_INVALID');
        if (byteLength(kit) > LIMITS.kitBytes) result.codes.push('KIT_BYTE_LIMIT');
        if (result.codes.length) counts.invalidRows++;
        else {
          const canonical = telefone.startsWith('+') ? telefone.slice(1) : telefone;
          const previous = seen.get(canonical);
          if (previous) {
            result.status = 'duplicate'; result.codes.push('DUPLICATE_PHONE'); result.duplicateOfRow = previous.row;
            if (previous.primeiro_nome !== primeiro_nome || previous.kit !== kit) result.codes.push('DUPLICATE_FIELDS_DIFFER');
            counts.duplicateRows++;
          } else {
            const valid = {row: index, line: record.line, telefone: canonical, primeiro_nome, kit};
            rows.push(valid); seen.set(canonical, valid); result.status = 'valid'; counts.validRows++;
          }
        }
      }
      for (const code of result.codes) codeCounts[code] = (codeCounts[code] || 0) + 1;
      rowResults.push(result);
    }
    return {schema: SCHEMA, ok: true, validation: 'format-only', delimiter: config.delimiter,
      headers: [...headers], rows, rowResults, counts};
  } catch (error) {
    // Only finite internal codes and source locations escape. Never error text/input.
    if (error && /^CSV_[A-Z_]+$/.test(error.code || '')) return refusal(error.code, error.location);
    return refusal('CSV_INPUT_REFUSED');
  }
}
return Object.freeze({previewCsv, HEADERS, LIMITS, SCHEMA});
});
