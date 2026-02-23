const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// Storage for uploaded PDFs
const upload = multer({ dest: "uploads/", limits: { fileSize: 10 * 1024 * 1024 } });

// Route: Upload PDF
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use form field name 'file'." });
    }

    const sessionId = crypto.randomUUID();
    const filePath = path.join(__dirname, req.file.path);

    // Send PDF to Python service with session ID
    await axios.post("http://localhost:5000/process-pdf", {
      filePath: filePath,
      sessionId: sessionId
    });

    res.json({ 
      message: "PDF uploaded & processed successfully!",
      sessionId: sessionId,
      filename: req.file.originalname
    });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("Upload processing failed:", details);
    res.status(500).json({ error: "PDF processing failed", details });
  }
});

// Route: Ask Question
app.post("/ask", async (req, res) => {
  const { question, sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  try {
    const response = await axios.post("http://localhost:5000/ask", {
      question,
      sessionId
    });

    res.json({ answer: response.data.answer });
  } catch (err) {
    console.error(err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.detail || "Error answering question" });
  }
});

app.post("/summarize", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  try {
    const response = await axios.post("http://localhost:5000/summarize", { sessionId });
    res.json({ summary: response.data.summary });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("Summarization failed:", details);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.detail || "Error summarizing PDF", details });
  }
});

app.listen(4000, () => console.log("Backend running on http://localhost:4000"));
