// kb-engine/ingestion/dna-loader.js
// Document DNA sidecar file management.
//
// DNA files are JSON sidecar files stored at:
//   ~/.attar-code/knowledge/dna/{bookId}.dna.json
//
// They contain user-provided rich metadata (authority, trust, anti-tags, etc.)
// that supplements the automatically extracted metadata on every chunk.
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load a DNA sidecar file for a document.
 * @param {string} bookId  12-char hex hash of the document path
 * @returns {object|null}  Parsed DNA object, or null if missing/corrupted
 */
function loadDNA(bookId) {
  try {
    const filePath = path.join(config.DNA_DIR, `${bookId}.dna.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_) {
    return null;
  }
}

/**
 * Save a DNA sidecar file for a document.
 * @param {string} bookId  12-char hex hash of the document path
 * @param {object} dna     DNA object (attar-code/doc-dna-v1 schema)
 */
function saveDNA(bookId, dna) {
  const dir = config.DNA_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${bookId}.dna.json`);
  fs.writeFileSync(filePath, JSON.stringify(dna, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Flatten
// ---------------------------------------------------------------------------

/**
 * Convert nested DNA schema to flat dna_* payload fields for Qdrant storage.
 *
 * Input:  { authority: { level: "canonical", trust_rating: 5 }, retrieval: { anti_tags: ["ml"] } }
 * Output: { dna_authority: "canonical", dna_trust: 5, dna_anti_tags: ["ml"] }
 *
 * Only non-undefined fields are included. Missing sections produce no fields.
 *
 * @param {object} dna  DNA object
 * @returns {object}    Flat metadata fields with dna_ prefix
 */
function flattenDNA(dna) {
  if (!dna || typeof dna !== "object") return {};
  const flat = {};

  // Authority
  if (dna.authority) {
    if (dna.authority.level !== undefined)        flat.dna_authority = dna.authority.level;
    if (dna.authority.trust_rating !== undefined)  flat.dna_trust = dna.authority.trust_rating;
    if (dna.authority.is_canonical !== undefined)  flat.dna_canonical = dna.authority.is_canonical;
    if (dna.authority.freshness !== undefined)     flat.dna_freshness = dna.authority.freshness;
  }

  // Character
  if (dna.character) {
    if (dna.character.depth !== undefined)         flat.dna_depth = dna.character.depth;
    if (dna.character.doc_type !== undefined)      flat.dna_doc_type = dna.character.doc_type;
    if (dna.character.content_style !== undefined)  flat.dna_content_style = dna.character.content_style;
    if (dna.character.scope !== undefined)          flat.dna_scope = dna.character.scope;
  }

  // Retrieval
  if (dna.retrieval) {
    if (Array.isArray(dna.retrieval.key_topics) && dna.retrieval.key_topics.length > 0) {
      flat.dna_key_topics = dna.retrieval.key_topics;
    }
    if (Array.isArray(dna.retrieval.best_for) && dna.retrieval.best_for.length > 0) {
      flat.dna_best_for = dna.retrieval.best_for;
    }
    if (Array.isArray(dna.retrieval.anti_tags) && dna.retrieval.anti_tags.length > 0) {
      flat.dna_anti_tags = dna.retrieval.anti_tags;
    }
    if (dna.retrieval.prerequisites !== undefined) {
      flat.dna_prerequisites = dna.retrieval.prerequisites;
    }
    if (dna.retrieval.exclude_from !== undefined) {
      flat.dna_exclude_from = dna.retrieval.exclude_from;
    }
  }

  // Relations
  if (dna.relations) {
    if (dna.relations.conflict_priority !== undefined) {
      flat.dna_conflict_priority = dna.relations.conflict_priority;
    }
    if (dna.relations.supersedes !== undefined) {
      flat.dna_supersedes = dna.relations.supersedes;
    }
  }

  return flat;
}

module.exports = { loadDNA, saveDNA, flattenDNA };
