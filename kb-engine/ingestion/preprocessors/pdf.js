'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { convertWithMarker, isMarkerAvailable } = require('./pdf-marker');

// Cache Marker availability check
let _markerAvailable = null;

/**
 * Preprocess a PDF file for ingestion.
 *
 * Strategy 1: Marker (ML-powered, GPU-accelerated, proper headings)
 * Strategy 2: pymupdf4llm (rule-based, fast, good for digital PDFs)
 * Strategy 3: PyMuPDF fitz (plain text extraction, last resort)
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {boolean} [opts.forceMarker]   Skip pymupdf4llm, only use Marker
 * @param {boolean} [opts.forceLegacy]   Skip Marker, only use pymupdf4llm
 * @param {boolean} [opts.useLlm]       Enable Marker's LLM mode for tables
 * @param {string}  [opts.ollamaModel]  Ollama model for LLM mode
 * @returns {Promise<{ content: string, title: string, format: string, toc?: Array, headings?: Array, error?: string }>}
 */
async function preprocessPdf(filePath, opts = {}) {
  const fallback = {
    content: '',
    title: path.basename(filePath, '.pdf'),
    format: 'pdf',
  };

  if (!fs.existsSync(filePath)) {
    return { ...fallback, error: 'File not found: ' + filePath };
  }

  // Strategy 1: Marker (if available and not forced legacy)
  if (!opts.forceLegacy) {
    if (_markerAvailable === null) {
      _markerAvailable = await isMarkerAvailable();
    }

    if (_markerAvailable) {
      const result = await convertWithMarker(filePath, {
        useLlm: opts.useLlm,
        ollamaModel: opts.ollamaModel,
      });

      if (!result.error && result.content.length > 0) {
        return {
          content: result.content,
          title: result.title || fallback.title,
          format: 'pdf',
          toc: result.toc,
          headings: result.headings,
          converter: 'marker',
        };
      }
      // Marker failed — fall through to pymupdf4llm
    }
  }

  if (opts.forceMarker) {
    return { ...fallback, error: 'Marker not available. Install: pip install marker-pdf' };
  }

  // Strategy 2: pymupdf4llm -> Strategy 3: fitz plain text
  // Both paths emit <!-- page:N --> markers for page tracking in chunks
  try {
    // Python script uses string concat (not f-strings) to avoid JS template literal escaping issues
    const script = [
      'import sys, json, os',
      'os.environ["PYTHONIOENCODING"] = "utf-8"',
      'try:',
      '    sys.stdout.reconfigure(encoding="utf-8")',
      'except:',
      '    pass',
      'try:',
      '    import pymupdf4llm',
      '    try:',
      '        pages = pymupdf4llm.to_markdown(sys.argv[1], page_chunks=True)',
      '        if isinstance(pages, list):',
      '            parts = []',
      '            for i, page in enumerate(pages):',
      '                text = page["text"] if isinstance(page, dict) else str(page)',
      '                parts.append("<!-- page:" + str(i+1) + " -->\\n" + text)',
      '            md = "\\n\\n".join(parts)',
      '        else:',
      '            md = str(pages)',
      '    except:',
      '        md = pymupdf4llm.to_markdown(sys.argv[1])',
      '    print(json.dumps({"content": md, "ok": True}))',
      'except ImportError:',
      '    import fitz',
      '    doc = fitz.open(sys.argv[1])',
      '    parts = []',
      '    for i in range(len(doc)):',
      '        parts.append("<!-- page:" + str(i+1) + " -->\\n" + doc[i].get_text())',
      '    text = "\\n\\n".join(parts)',
      '    print(json.dumps({"content": text, "ok": True}))',
    ].join('\n');
    const tmpScript = path.join(os.tmpdir(), `attar-pdf-extract-${Date.now()}.py`);
    fs.writeFileSync(tmpScript, script);
    const result = execFileSync('python', [tmpScript, filePath], {
      encoding: 'utf-8',
      timeout: 120000,
    });
    try { fs.unlinkSync(tmpScript); } catch (_) {}

    const parsed = JSON.parse(result.trim().split('\n').pop());
    return {
      content: parsed.content,
      title: fallback.title,
      format: 'pdf',
      converter: 'pymupdf4llm',
    };
  } catch (pyErr) {
    return {
      ...fallback,
      error: `PDF extraction failed. Install: pip install marker-pdf (recommended) or pip install pymupdf4llm\nError: ${pyErr.message}`,
    };
  }
}

module.exports = { preprocessPdf };
