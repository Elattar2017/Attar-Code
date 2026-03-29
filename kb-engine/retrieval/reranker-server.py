import sys
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder
import uvicorn

app = FastAPI()
model = None

class RerankRequest(BaseModel):
    query: str
    documents: list[str]

@app.on_event("startup")
def load_model():
    global model
    model_name = sys.argv[1] if len(sys.argv) > 1 else "cross-encoder/ms-marco-MiniLM-L-6-v2"
    model = CrossEncoder(model_name)

@app.post("/rerank")
def rerank(req: RerankRequest):
    pairs = [[req.query, doc] for doc in req.documents]
    scores = model.predict(pairs).tolist()
    return {"scores": scores}

@app.get("/health")
def health():
    return {"ok": True, "model_loaded": model is not None}

if __name__ == "__main__":
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 6334
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
