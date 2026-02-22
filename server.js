const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const fs = require("fs");
const path = require("path");
require('dotenv').config();

// Configuration from environment variables
const API_REQUEST_TIMEOUT = parseInt(process.env.API_REQUEST_TIMEOUT || "45000", 10); // milliseconds
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS || "3", 10);

const app = express();
app.use(cors());
app.use(express.json());

// Configure axios retry with exponential backoff
axiosRetry(axios, {
  retries: MAX_RETRY_ATTEMPTS,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    // Retry on network errors, timeouts, and 5xx server errors
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.code === 'ECONNABORTED' ||
      (error.response && error.response.status >= 500);
  },
  onRetry: (retryCount, error, requestConfig) => {
    console.log(`Retry attempt ${retryCount} for ${requestConfig.url}`);
    console.log(`Error: ${error.message}`);
  }
});

// Storage for uploaded PDFs
const upload = multer({ dest: "uploads/" });

// Route: Upload PDF
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use form field name 'file'." });
    }

    const filePath = path.join(__dirname, req.file.path);

    // Send PDF to Python service with timeout
    await axios.post("http://localhost:5000/process-pdf", {
      filePath: filePath,
    }, {
      timeout: API_REQUEST_TIMEOUT
    });

    res.json({ message: "PDF uploaded & processed successfully!" });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("Upload processing failed:", details);

    // Handle timeout specifically
    if (err.code === 'ECONNABORTED' || err.response?.status === 504) {
      return res.status(504).json({
        error: "Request timed out",
        details: "The PDF processing took too long. Please try again or use a smaller PDF."
      });
    }

    res.status(500).json({ error: "PDF processing failed", details });
  }
});

// Route: Ask Question
app.post("/ask", async (req, res) => {
  const { question } = req.body;

  // Input validation
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: "Question is required and must be a string" });
  }

  if (!question.trim()) {
    return res.status(400).json({ error: "Question cannot be empty" });
  }

  if (question.length > 2000) {
    return res.status(400).json({ error: "Question too long (max 2000 characters)" });
  }

  try {
    const startTime = Date.now();
    console.log(`Processing question: "${question.trim().substring(0, 50)}..."`);

    const response = await axios.post("http://localhost:5000/ask", {
      question: question.trim(),
    }, {
      timeout: API_REQUEST_TIMEOUT
    });

    const duration = Date.now() - startTime;
    console.log(`Question answered in ${duration}ms`);

    res.json({ answer: response.data.answer });
  } catch (err) {
    console.error("Error answering question:", err.message);

    // Handle timeout specifically
    if (err.code === 'ECONNABORTED' || err.response?.status === 504) {
      return res.status(504).json({
        error: "Request timed out",
        details: "The question took too long to process. Please try a simpler question or try again."
      });
    }

    // Handle other errors
    const errorMessage = err.response?.data?.detail || err.message || "Error answering question";
    res.status(err.response?.status || 500).json({
      error: errorMessage,
      details: err.response?.data
    });
  }
});

app.post("/summarize", async (req, res) => {
  try {
    console.log("Processing summarization request");
    const startTime = Date.now();

    const response = await axios.post("http://localhost:5000/summarize", req.body || {}, {
      timeout: API_REQUEST_TIMEOUT
    });

    const duration = Date.now() - startTime;
    console.log(`Summarization completed in ${duration}ms`);

    res.json({ summary: response.data.summary });
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error("Summarization failed:", details);

    // Handle timeout specifically
    if (err.code === 'ECONNABORTED' || err.response?.status === 504) {
      return res.status(504).json({
        error: "Request timed out",
        details: "The summarization took too long. Please try again."
      });
    }

    res.status(err.response?.status || 500).json({ error: "Error summarizing PDF", details });
  }
});

app.listen(4000, () => console.log("Backend running on http://localhost:4000"));
