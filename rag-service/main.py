from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_community.embeddings import HuggingFaceEmbeddings
from dotenv import load_dotenv
import os
import uvicorn
import torch
from transformers import (
    AutoConfig,
    AutoTokenizer,
    AutoModelForSeq2SeqLM,
    AutoModelForCausalLM,
)
import threading
import logging
from uuid import uuid4
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

# --------------------------------------------------
# Logging
# --------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

app = FastAPI()

# --------------------------------------------------
# Config
# --------------------------------------------------
LLM_GENERATION_TIMEOUT = int(os.getenv("LLM_GENERATION_TIMEOUT", "30"))
HF_GENERATION_MODEL = os.getenv("HF_GENERATION_MODEL", "google/flan-t5-base")

# --------------------------------------------------
# Global State (MULTI-DOC)
# --------------------------------------------------
VECTOR_STORE = None
DOCUMENT_REGISTRY = {}
DOCUMENT_EMBEDDINGS = {}

generation_tokenizer = None
generation_model = None
generation_is_encoder_decoder = False

# --------------------------------------------------
# Embeddings
# --------------------------------------------------
embedding_model = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2"
)

# --------------------------------------------------
# Model Loading
# --------------------------------------------------
def load_generation_model():
    global generation_tokenizer, generation_model, generation_is_encoder_decoder

    if generation_model is not None and generation_tokenizer is not None:
        return generation_tokenizer, generation_model, generation_is_encoder_decoder

    config = AutoConfig.from_pretrained(HF_GENERATION_MODEL)
    generation_is_encoder_decoder = bool(getattr(config, "is_encoder_decoder", False))
    generation_tokenizer = AutoTokenizer.from_pretrained(HF_GENERATION_MODEL)

    if generation_is_encoder_decoder:
        generation_model = AutoModelForSeq2SeqLM.from_pretrained(HF_GENERATION_MODEL)
    else:
        generation_model = AutoModelForCausalLM.from_pretrained(HF_GENERATION_MODEL)

    if torch.cuda.is_available():
        generation_model = generation_model.to("cuda")

    generation_model.eval()
    return generation_tokenizer, generation_model, generation_is_encoder_decoder


# --------------------------------------------------
# Timeout-safe Generation
# --------------------------------------------------
class TimeoutException(Exception):
    pass


def generate_with_timeout(model, encoded, max_new_tokens, pad_token_id, timeout):
    result = {"output": None, "error": None}

    def target():
        try:
            with torch.no_grad():
                result["output"] = model.generate(
                    **encoded,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    pad_token_id=pad_token_id,
                )
        except Exception as e:
            result["error"] = str(e)

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout)

    if thread.is_alive():
        raise TimeoutException("LLM generation timed out")

    if result["error"]:
        raise Exception(result["error"])

    return result["output"]


def generate_response(prompt: str, max_new_tokens: int) -> str:
    tokenizer, model, is_encoder_decoder = load_generation_model()
    device = next(model.parameters()).device

    encoded = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=2048)
    encoded = {k: v.to(device) for k, v in encoded.items()}

    pad_token_id = tokenizer.pad_token_id or tokenizer.eos_token_id

    try:
        output_ids = generate_with_timeout(
            model,
            encoded,
            max_new_tokens,
            pad_token_id,
            LLM_GENERATION_TIMEOUT,
        )
    except TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="Request timed out. Model took too long to respond.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if is_encoder_decoder:
        return tokenizer.decode(output_ids[0], skip_special_tokens=True).strip()

    input_len = encoded["input_ids"].shape[1]
    return tokenizer.decode(
        output_ids[0][input_len:], skip_special_tokens=True
    ).strip()


# --------------------------------------------------
# Schemas
# --------------------------------------------------
class PDFPath(BaseModel):
    filePath: str


class Question(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    doc_ids: list[str] | None = None

    @validator("question")
    def validate_question(cls, v):
        if not v.strip():
            raise ValueError("Question cannot be empty")
        return v.strip()


class SummarizeRequest(BaseModel):
    doc_ids: list[str] | None = None


class CompareRequest(BaseModel):
    doc_ids: list[str]


# --------------------------------------------------
# Process PDF
# --------------------------------------------------
@app.post("/process-pdf")
def process_pdf(data: PDFPath):
    global VECTOR_STORE, DOCUMENT_REGISTRY, DOCUMENT_EMBEDDINGS

    if not os.path.exists(data.filePath):
        return {"error": "File not found."}

    loader = PyPDFLoader(data.filePath)
    docs = loader.load()

    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
    chunks = splitter.split_documents(docs)

    if not chunks:
        return {"error": "No text chunks generated."}

    doc_id = str(uuid4())
    filename = os.path.basename(data.filePath)

    for c in chunks:
        c.metadata = {"doc_id": doc_id, "filename": filename}

    if VECTOR_STORE is None:
        VECTOR_STORE = FAISS.from_documents(chunks, embedding_model)
    else:
        VECTOR_STORE.add_documents(chunks)

    embeddings = embedding_model.embed_documents([c.page_content for c in chunks])
    DOCUMENT_EMBEDDINGS[doc_id] = np.mean(embeddings, axis=0)
    DOCUMENT_REGISTRY[doc_id] = {"filename": filename, "chunks": len(chunks)}

    return {"message": "PDF processed successfully", "doc_id": doc_id}


# --------------------------------------------------
# Documents
# --------------------------------------------------
@app.get("/documents")
def list_documents():
    return DOCUMENT_REGISTRY


@app.get("/similarity-matrix")
def similarity_matrix():
    if len(DOCUMENT_EMBEDDINGS) < 2:
        return {"error": "At least two documents required"}

    ids = list(DOCUMENT_EMBEDDINGS.keys())
    vectors = np.array([DOCUMENT_EMBEDDINGS[i] for i in ids])
    sim = cosine_similarity(vectors)

    return {
        ids[i]: {ids[j]: float(sim[i][j]) for j in range(len(ids))}
        for i in range(len(ids))
    }


# --------------------------------------------------
# Ask
# --------------------------------------------------
@app.post("/ask")
def ask_question(data: Question):
    if VECTOR_STORE is None:
        return {"answer": "Upload a PDF first."}

    docs = VECTOR_STORE.similarity_search(data.question, k=10)

    if data.doc_ids:
        docs = [d for d in docs if d.metadata.get("doc_id") in data.doc_ids]

    if not docs:
        return {"answer": "No relevant context found."}

    context = "\n\n".join(d.page_content for d in docs)
    prompt = f"Context:\n{context}\n\nQuestion: {data.question}\nAnswer:"

    return {"answer": generate_response(prompt, 300)}


# --------------------------------------------------
# Summarize
# --------------------------------------------------
@app.post("/summarize")
def summarize_pdf(data: SummarizeRequest):
    if VECTOR_STORE is None:
        return {"summary": "Upload a PDF first."}

    docs = VECTOR_STORE.similarity_search("Summarize the document.", k=12)

    if data.doc_ids:
        docs = [d for d in docs if d.metadata.get("doc_id") in data.doc_ids]

    context = "\n\n".join(d.page_content for d in docs)
    prompt = f"Summarize in bullet points:\n{context}"

    return {"summary": generate_response(prompt, 250)}


# --------------------------------------------------
# Compare
# --------------------------------------------------
@app.post("/compare")
def compare_documents(data: CompareRequest):
    if VECTOR_STORE is None or len(data.doc_ids) < 2:
        return {"comparison": "Select at least two documents."}

    docs = VECTOR_STORE.similarity_search("Main differences.", k=15)
    docs = [d for d in docs if d.metadata.get("doc_id") in data.doc_ids]

    context = "\n\n".join(d.page_content for d in docs)
    prompt = f"Compare these documents:\n{context}"

    return {"comparison": generate_response(prompt, 600)}


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=5000)