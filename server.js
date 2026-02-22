const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// Multer setup (PDF uploads)
// ===============================
const upload = multer({ dest: "uploads/" });

// ===============================
// Route: Upload PDF
// ===============================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded. Use form field name 'file'." });
    }

    const filePath = path.join(__dirname, req.file.path);

    // Forward to Python FastAPI service
    await axios.post("http://localhost:5000/process-pdf", {
      filePath,
    });

    res.json({ message: "PDF uploaded & processed successfully!" });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("Upload processing failed:", details);
    res.status(500).json({
      error: "PDF processing failed",
      details,
    });
  }
});

// ===============================
// Route: Ask Question (Validated)
// ===============================
app.post("/ask", async (req, res) => {
  const { question } = req.body;

  // ---- Input Validation (from fix/Input-Validation) ----
  if (!question || typeof question !== "string") {
    return res
      .status(400)
      .json({ error: "Question is required and must be a string" });
  }

  if (!question.trim()) {
    return res.status(400).json({ error: "Question cannot be empty" });
  }

  if (question.length > 2000) {
    return res
      .status(400)
      .json({ error: "Question too long (max 2000 characters)" });
  }

  try {
    const response = await axios.post("http://localhost:5000/ask", {
      question: question.trim(),
    });

    res.json({ answer: response.data.answer });
  } catch (err) {
    console.error("Ask failed:", err.response?.data || err.message);
    res.status(500).json({ error: "Error answering question" });
  }
});

// ===============================
// Route: Summarize PDF
// ===============================
app.post("/summarize", async (req, res) => {
  try {
    const response = await axios.post(
      "http://localhost:5000/summarize",
      req.body || {}
    );

    res.json({ summary: response.data.summary });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("Summarization failed:", details);
    res.status(500).json({
      error: "Error summarizing PDF",
      details,
    });
  }
});

// ===============================
// Start Server
// ===============================
app.listen(4000, () => {
  console.log("Backend running on http://localhost:4000");
});