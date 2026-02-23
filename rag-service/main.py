from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_community.embeddings import HuggingFaceEmbeddings
from dotenv import load_dotenv
import os
import uvicorn
import torch
from transformers import AutoConfig, AutoTokenizer, AutoModelForSeq2SeqLM, AutoModelForCausalLM
import asyncio
import threading

load_dotenv()

app = FastAPI()

# Session-based storage for multi-PDF support
pdf_sessions = {}  # {session_id: {"vectorstore": FAISS, "filename": str}}
session_lock = threading.Lock()

HF_GENERATION_MODEL = os.getenv("HF_GENERATION_MODEL", "google/flan-t5-base")
generation_tokenizer = None
generation_model = None
generation_is_encoder_decoder = False

# Thread safety and resource management
model_lock = threading.Lock()
inference_semaphore = asyncio.Semaphore(2)
MAX_GPU_MEMORY_MB = int(os.getenv("MAX_GPU_MEMORY_MB", "3000"))

# Load local embedding model
embedding_model = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")


def load_generation_model():
    global generation_tokenizer, generation_model, generation_is_encoder_decoder
    
    with model_lock:
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
            try:
                generation_model = generation_model.to("cuda")
                torch.cuda.empty_cache()
            except RuntimeError as e:
                print(f"GPU allocation failed: {e}. Falling back to CPU.")
                generation_model = generation_model.to("cpu")

        generation_model.eval()
        return generation_tokenizer, generation_model, generation_is_encoder_decoder


async def generate_response(prompt: str, max_new_tokens: int) -> str:
    async with inference_semaphore:
        try:
            tokenizer, model, is_encoder_decoder = load_generation_model()
            model_device = next(model.parameters()).device

            encoded = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=2048)
            encoded = {key: value.to(model_device) for key, value in encoded.items()}
            pad_token_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id

            with torch.no_grad():
                generated_ids = model.generate(
                    **encoded,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    pad_token_id=pad_token_id,
                )

            if model_device.type == "cuda":
                torch.cuda.empty_cache()

            if is_encoder_decoder:
                text = tokenizer.decode(generated_ids[0], skip_special_tokens=True)
                return text.strip()

            input_len = encoded["input_ids"].shape[1]
            new_tokens = generated_ids[0][input_len:]
            text = tokenizer.decode(new_tokens, skip_special_tokens=True)
            return text.strip()
        except RuntimeError as e:
            if "out of memory" in str(e).lower():
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                raise HTTPException(status_code=503, detail="GPU memory exhausted. Please try again.")
            raise

class PDFPath(BaseModel):
    filePath: str
    sessionId: str

class Question(BaseModel):
    question: str
    sessionId: str

class SummarizeRequest(BaseModel):
    sessionId: str

@app.post("/process-pdf")
def process_pdf(data: PDFPath):
    loader = PyPDFLoader(data.filePath)
    docs = loader.load()

    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
    chunks = splitter.split_documents(docs)
    if not chunks:
        return {"error": "No text chunks generated from the PDF. Please check your file."}
    
    vectorstore = FAISS.from_documents(chunks, embedding_model)
    
    with session_lock:
        pdf_sessions[data.sessionId] = {
            "vectorstore": vectorstore,
            "filename": os.path.basename(data.filePath)
        }

    return {"message": "PDF processed successfully", "sessionId": data.sessionId}


@app.post("/ask")
async def ask_question(data: Question):
    with session_lock:
        session = pdf_sessions.get(data.sessionId)
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found. Please upload a PDF first.")

    vectorstore = session["vectorstore"]
    docs = vectorstore.similarity_search(data.question, k=4)
    if not docs:
        return {"answer": "No relevant context found."}

    context = "\n\n".join([doc.page_content for doc in docs])

    prompt = (
        "You are a helpful assistant for question answering over PDF documents. "
        "Use only the provided context. If the context does not contain the answer, say so briefly.\n\n"
        f"Context:\n{context}\n\n"
        f"Question: {data.question}\n"
        "Answer:"
    )

    answer = await generate_response(prompt, max_new_tokens=256)
    return {"answer": answer}


@app.post("/summarize")
async def summarize_pdf(data: SummarizeRequest):
    with session_lock:
        session = pdf_sessions.get(data.sessionId)
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found. Please upload a PDF first.")

    vectorstore = session["vectorstore"]
    docs = vectorstore.similarity_search("Give a concise summary of the document.", k=6)
    if not docs:
        return {"summary": "No document context available to summarize."}

    context = "\n\n".join([doc.page_content for doc in docs])
    prompt = (
        "Summarize the following document content in 6-8 concise bullet points.\n\n"
        f"Context:\n{context}\n\n"
        "Summary:"
    )

    summary = await generate_response(prompt, max_new_tokens=220)
    return {"summary": summary}


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=True)
