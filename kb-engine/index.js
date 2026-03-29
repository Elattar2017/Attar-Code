// kb-engine/index.js — Main entry point for the KB Engine
// Exports all modules and provides a KBEngine orchestrator class.
"use strict";

const { QdrantManager }    = require("./qdrant-manager");
const { UnifiedEmbedder, DualEmbedder } = require("./embedder");
const { SparseVectorizer } = require("./sparse-vectors");
const { CollectionManager }= require("./collections");
const { ChunkStore }       = require("./store");
const config               = require("./config");

// Ingestion + Retrieval pipelines
let IngestPipeline, RetrievalPipeline;
try { IngestPipeline = require("./ingestion").IngestPipeline; } catch (_) {}
try { RetrievalPipeline = require("./retrieval").RetrievalPipeline; } catch (_) {}

// ─── KBEngine ─────────────────────────────────────────────────────────────────

/**
 * Orchestrator that wires together all KB engine subsystems.
 *
 * Usage:
 *   const { KBEngine } = require("./kb-engine");
 *   const engine = new KBEngine();
 *   const status = await engine.start();  // starts Qdrant, ensures collections
 *   // … use engine.store, engine.embedder, etc.
 *   engine.stop();
 */
class KBEngine {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]       Qdrant base URL override
   * @param {string} [opts.host]      Qdrant host override
   * @param {number} [opts.port]      Qdrant port override
   * @param {string} [opts.binDir]    Qdrant binary directory override
   * @param {string} [opts.platform]  Platform override (for testing)
   * @param {string} [opts.arch]      Architecture override (for testing)
   */
  constructor(opts = {}) {
    this.qdrantManager = new QdrantManager(opts);
    this.embedder      = new UnifiedEmbedder(opts);
    this.collectionMgr = new CollectionManager(opts);
    this.store         = new ChunkStore(opts);
    this.config        = config;
    // Ingestion + Retrieval (optional — may not be installed yet)
    if (IngestPipeline) this.ingestion = new IngestPipeline({ store: this.store, ...opts });
    if (RetrievalPipeline) this.retrieval = new RetrievalPipeline({ store: this.store, ...opts });
  }

  // ── start ──────────────────────────────────────────────────────────────────

  /**
   * Start the KB engine:
   *   1. Ensure Qdrant is running (starts it if managed binary is available).
   *   2. Ensure all default collections exist.
   *   3. Probe Ollama embedding models.
   *
   * @returns {Promise<{
   *   qdrant:      { running: boolean, managedByUs: boolean, pid: number|null, collections: string[]|null },
   *   models:      { codeModel: boolean, textModel: boolean },
   *   collections: string[]
   * }>}
   */
  async start() {
    await this.qdrantManager.start();
    await this.collectionMgr.ensureAllCollections();
    // Start reranker sidecar if retrieval pipeline available
    if (this.retrieval) try { await this.retrieval.start(); } catch (_) {}
    const models = await this.embedder.getAvailableModels();

    return {
      qdrant:      await this.qdrantManager.getStatus(),
      models,
      collections: await this.collectionMgr.listCollections(),
    };
  }

  // ── stop ───────────────────────────────────────────────────────────────────

  /**
   * Stop the Qdrant process managed by this engine instance (if any).
   * @returns {Promise<void>}
   */
  stop() {
    if (this.retrieval) try { this.retrieval.stop(); } catch (_) {}
    return this.qdrantManager.stop();
  }

  // ── getStatus ──────────────────────────────────────────────────────────────

  /**
   * Return a snapshot of the engine's current state.
   *
   * @returns {Promise<{
   *   qdrant:      { running: boolean, managedByUs: boolean, pid: number|null, collections: string[]|null },
   *   models:      { codeModel: boolean, textModel: boolean },
   *   collections: Array<{ name: string, vectors_count: number, points_count: number, status: string }>
   * }>}
   */
  async getStatus() {
    return {
      qdrant:      await this.qdrantManager.getStatus(),
      models:      await this.embedder.getAvailableModels(),
      collections: await this.collectionMgr.getAllStats(),
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  KBEngine,
  QdrantManager,
  UnifiedEmbedder,
  DualEmbedder,        // Backward compat alias
  SparseVectorizer,
  CollectionManager,
  ChunkStore,
  IngestPipeline,
  RetrievalPipeline,
  config,
};
