'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Python executable — try multiple names to find one that has marker installed
let _pythonExe = null;

/**
 * Find a Python executable that has marker-pdf installed.
 * Tries multiple paths: python, python3, and known install locations.
 * @returns {Promise<string|null>}
 */
async function _findMarkerPython() {
  const candidates = ['python', 'python3'];

  // On Windows, also check common install locations
  if (process.platform === 'win32') {
    const home = os.homedir();
    for (const ver of ['311', '312', '313', '310']) {
      candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Python', `Python${ver}`, 'python.exe'));
      candidates.push(path.join('C:', `Python${ver}`, 'python.exe'));
    }
  }

  const checkCmd = 'from marker.converters.pdf import PdfConverter; from marker.models import create_model_dict; print("ok")';

  for (const exe of candidates) {
    const found = await new Promise((resolve) => {
      execFile(exe, ['-c', checkCmd], { timeout: 15000 }, (err, stdout) => {
        resolve(!err && stdout.trim() === 'ok');
      });
    });
    if (found) return exe;
  }
  return null;
}

/**
 * Check if marker-pdf is installed and available.
 * @returns {Promise<boolean>}
 */
async function isMarkerAvailable() {
  if (_pythonExe) return true;
  _pythonExe = await _findMarkerPython();
  return _pythonExe !== null;
}

/**
 * Convert a PDF to structured Markdown using Marker.
 *
 * Returns: { content, title, toc, headings, error? }
 *   - content: Full Markdown string with proper # headings
 *   - title: Document title extracted from first heading or filename
 *   - toc: Array of { level, title, page } from Marker's table_of_contents
 *   - headings: Array of { level, text } — all headings found in the document
 *   - error: Error message if conversion failed
 *
 * @param {string} filePath  Absolute path to the PDF file
 * @param {object} [opts]
 * @param {boolean} [opts.useLlm=false]   Enable LLM-assisted mode (better tables)
 * @param {string}  [opts.ollamaModel]    Ollama model for LLM mode
 * @returns {Promise<{ content: string, title: string, toc: Array, headings: Array, error?: string }>}
 */
async function convertWithMarker(filePath, opts = {}) {
  // Ensure we have the right Python executable
  if (!_pythonExe) {
    _pythonExe = await _findMarkerPython();
  }

  const fallback = {
    content: '',
    title: path.basename(filePath, '.pdf'),
    toc: [],
    headings: [],
    format: 'pdf',
  };

  if (!fs.existsSync(filePath)) {
    return { ...fallback, error: 'File not found: ' + filePath };
  }

  const useLlm = opts.useLlm || false;
  const ollamaModel = opts.ollamaModel || '';

  const script = `
import sys, json, os, traceback

try:
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered

    config_overrides = {}
    use_llm = ${useLlm ? 'True' : 'False'}
    ollama_model = "${ollamaModel}"

    if use_llm and ollama_model:
        try:
            from marker.config.parser import ConfigParser
            config_overrides = {
                "use_llm": True,
                "ollama_model": ollama_model,
                "llm_service": "marker.services.ollama.OllamaService",
            }
            config_parser = ConfigParser(config_overrides)
            converter = PdfConverter(
                config=config_parser.generate_config_dict(),
                artifact_dict=create_model_dict(),
                processor_list=config_parser.get_processors(),
                renderer=config_parser.get_renderer(),
                llm_service=config_parser.get_llm_service()
            )
        except Exception:
            converter = PdfConverter(artifact_dict=create_model_dict())
    else:
        converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(sys.argv[1])
    text, metadata, images = text_from_rendered(rendered)

    # Extract table of contents from metadata
    toc = []
    if hasattr(rendered, 'metadata') and rendered.metadata:
        toc_data = getattr(rendered.metadata, 'table_of_contents', None)
        if toc_data:
            for entry in toc_data:
                toc.append({
                    "level": getattr(entry, 'heading_level', 1),
                    "title": getattr(entry, 'title', ''),
                    "page": getattr(entry, 'page_id', 0),
                })
    elif isinstance(metadata, dict) and 'table_of_contents' in metadata:
        for entry in metadata['table_of_contents']:
            toc.append({
                "level": entry.get('heading_level', 1),
                "title": entry.get('title', ''),
                "page": entry.get('page_id', 0),
            })

    # Extract all headings from the markdown
    headings = []
    for line in text.split('\\n'):
        stripped = line.strip()
        if stripped.startswith('#'):
            hashes = 0
            for ch in stripped:
                if ch == '#':
                    hashes += 1
                else:
                    break
            heading_text = stripped[hashes:].strip()
            if heading_text:
                headings.append({"level": hashes, "text": heading_text})

    # Extract title from first H1 heading or metadata
    title = ''
    for h in headings:
        if h['level'] == 1:
            title = h['text']
            break
    if not title and toc:
        title = toc[0].get('title', '')
    if not title:
        title = os.path.splitext(os.path.basename(sys.argv[1]))[0]

    result = {
        "ok": True,
        "markdown": text,
        "title": title,
        "toc": toc,
        "headings": headings,
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({
        "ok": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }))
`;

  return new Promise((resolve) => {
    const tmpScript = path.join(os.tmpdir(), `attar-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
    try {
      fs.writeFileSync(tmpScript, script);
    } catch (writeErr) {
      return resolve({ ...fallback, error: 'Failed to write temp script: ' + writeErr.message });
    }

    const pythonExe = _pythonExe || 'python';
    execFile(pythonExe, [tmpScript, filePath], {
      encoding: 'utf-8',
      timeout: 600000,  // 10 minutes for large PDFs
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer for large outputs
    }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch (_) {}

      if (err) {
        const detail = stderr ? `\nStderr: ${stderr.slice(0, 500)}` : '';
        return resolve({ ...fallback, error: 'Marker execution failed: ' + err.message + detail });
      }

      try {
        // Last line of stdout is the JSON result
        const lines = stdout.trim().split('\n');
        const parsed = JSON.parse(lines[lines.length - 1]);

        if (!parsed.ok) {
          return resolve({ ...fallback, error: parsed.error || 'Unknown Marker error' });
        }

        resolve({
          content: parsed.markdown || '',
          title: parsed.title || fallback.title,
          toc: Array.isArray(parsed.toc) ? parsed.toc : [],
          headings: Array.isArray(parsed.headings) ? parsed.headings : [],
          format: 'pdf',
        });
      } catch (parseErr) {
        resolve({ ...fallback, error: 'Failed to parse Marker output: ' + parseErr.message });
      }
    });
  });
}

module.exports = { convertWithMarker, isMarkerAvailable };
