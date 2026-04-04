"""
reranker-server.py — Cross-encoder reranker HTTP sidecar.

Supports two model backends:
  1. Qwen3-Reranker (default) — uses yes/no token logit scoring via transformers
  2. Sentence-transformers CrossEncoder — fallback for other models

Usage:
  python reranker-server.py [model_name] [port]

  model_name: HuggingFace model ID (default: Qwen/Qwen3-Reranker-0.6B)
  port:       HTTP port (default: 6334)

API:
  POST /rerank  { query: str, documents: [str], instruction?: str }
  GET /health   { ok: true, model_loaded: true, model_name: str, backend: str }
"""

import sys
import torch
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

app = FastAPI()
model = None
tokenizer = None
model_name_global = ""
backend = ""  # "qwen3-reranker" or "cross-encoder"

# Token IDs for yes/no scoring (Qwen3-Reranker)
token_true_id = None
token_false_id = None

# Prompt template for Qwen3-Reranker
QWEN3_PREFIX = (
    '<|im_start|>system\n'
    'Judge whether the Document meets the requirements based on the Query '
    'and the Instruct provided. Note that the answer can only be "yes" or "no".'
    '<|im_end|>\n<|im_start|>user\n'
)
QWEN3_SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
DEFAULT_INSTRUCTION = "Given a search query, retrieve relevant passages that answer the query"


class RerankRequest(BaseModel):
    query: str
    documents: list[str]
    instruction: str = DEFAULT_INSTRUCTION


def format_qwen3_pair(instruction: str, query: str, document: str) -> str:
    """Format a single query-document pair for Qwen3-Reranker scoring."""
    return f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}"


@app.on_event("startup")
def load_model():
    global model, tokenizer, model_name_global, backend, token_true_id, token_false_id

    model_name_global = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3-Reranker-0.6B"

    # Detect backend based on model name
    if "reranker" in model_name_global.lower() and "qwen" in model_name_global.lower():
        backend = "qwen3-reranker"
        from transformers import AutoTokenizer, AutoModelForCausalLM

        print(f"Loading Qwen3-Reranker: {model_name_global}")
        tokenizer = AutoTokenizer.from_pretrained(model_name_global, padding_side='left')
        model = AutoModelForCausalLM.from_pretrained(
            model_name_global,
            dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        )
        if torch.cuda.is_available():
            model = model.cuda()

        # Pre-compute yes/no token IDs
        token_true_id = tokenizer.convert_tokens_to_ids("yes")
        token_false_id = tokenizer.convert_tokens_to_ids("no")
        print(f"  Backend: qwen3-reranker | yes_id={token_true_id} | no_id={token_false_id}")
    else:
        backend = "cross-encoder"
        from sentence_transformers import CrossEncoder

        print(f"Loading CrossEncoder: {model_name_global}")
        model = CrossEncoder(model_name_global)
        print(f"  Backend: cross-encoder")


@app.post("/rerank")
def rerank(req: RerankRequest):
    if backend == "qwen3-reranker":
        return _rerank_qwen3(req)
    else:
        return _rerank_cross_encoder(req)


def _rerank_qwen3(req: RerankRequest):
    """Score documents using Qwen3-Reranker yes/no token logit method."""
    pairs = [format_qwen3_pair(req.instruction, req.query, doc) for doc in req.documents]

    # Tokenize with prefix/suffix
    prefix_tokens = tokenizer.encode(QWEN3_PREFIX, add_special_tokens=False)
    suffix_tokens = tokenizer.encode(QWEN3_SUFFIX, add_special_tokens=False)

    encoded = tokenizer(pairs, padding=False, truncation=True, max_length=7500,
                        return_attention_mask=False, add_special_tokens=False)

    for i in range(len(encoded['input_ids'])):
        encoded['input_ids'][i] = prefix_tokens + encoded['input_ids'][i] + suffix_tokens

    inputs = tokenizer.pad(encoded, padding=True, return_tensors="pt")
    if torch.cuda.is_available():
        inputs = {k: v.cuda() for k, v in inputs.items()}

    with torch.no_grad():
        logits = model(**inputs).logits[:, -1, :]  # last token logits
        true_logits = logits[:, token_true_id]
        false_logits = logits[:, token_false_id]
        stacked = torch.stack([false_logits, true_logits], dim=1)
        probs = torch.nn.functional.log_softmax(stacked, dim=1)
        scores = probs[:, 1].exp().tolist()  # P(yes) as relevance score

    return {"scores": scores}


def _rerank_cross_encoder(req: RerankRequest):
    """Score documents using sentence-transformers CrossEncoder."""
    pairs = [[req.query, doc] for doc in req.documents]
    scores = model.predict(pairs).tolist()
    return {"scores": scores}


@app.get("/health")
def health():
    return {
        "ok": True,
        "model_loaded": model is not None,
        "model_name": model_name_global,
        "backend": backend,
    }


if __name__ == "__main__":
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 6334
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
