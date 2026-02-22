import React, { useState, useEffect } from "react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import { Document, Page, pdfjs } from "react-pdf";
import 'bootstrap/dist/css/bootstrap.min.css';
import {
  Container,
  Row,
  Col,
  Button,
  Form,
  Card,
  Spinner,
  Navbar
} from "react-bootstrap";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const API_BASE = process.env.REACT_APP_API_URL || "";

function App() {
  const [file, setFile] = useState(null);
  const [pdfs, setPdfs] = useState([]);
  const [selectedDocs, setSelectedDocs] = useState([]);
  const [chatHistory, setChatHistory] = useState([]);
  const [comparisonResult, setComparisonResult] = useState(null);
  const [question, setQuestion] = useState("");
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  // ===============================
  // Upload
  // ===============================
  const uploadPDF = async () => {
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    // Setup timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    try {
      const res = await axios.post(`${API_BASE}/upload`, formData, {
        signal: controller.signal
      });

      const url = URL.createObjectURL(file);
      setPdfs(prev => [
        ...prev,
        { name: file.name, doc_id: res.data?.doc_id, url }
      ]);

      setFile(null);
      alert("PDF uploaded!");
    } catch (e) {
      let message = "Upload failed.";

      if (e.name === "AbortError" || e.code === "ECONNABORTED") {
        message = "Upload timed out. Please try again with a smaller file.";
      } else if (e.response?.status === 504) {
        message = "Gateway timeout. The upload took too long.";
      } else {
        message = e.response?.data?.error || e.response?.data?.details || "Upload failed.";
      }

      alert(message);
    } finally {
      clearTimeout(timeoutId);
      setUploading(false);
    }
  };

  // ===============================
  // Toggle selection
  // ===============================
  const toggleDocSelection = (doc_id) => {
    setComparisonResult(null);
    setSelectedDocs(prev =>
      prev.includes(doc_id)
        ? prev.filter(id => id !== doc_id)
        : [...prev, doc_id]
    );
  };

  // ===============================
  // Ask
  // ===============================
  const askQuestion = async () => {
    if (!question || !question.trim()) {
      alert("Question cannot be empty");
      return;
    }

    if (question.length > 2000) {
      alert("Question too long (max 2000 characters)");
      return;
    }

    setAsking(true);
    setChatHistory(prev => [...prev, { role: "user", text: question }]);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await axios.post(
        `${API_BASE}/ask`,
        { question },
        { signal: controller.signal }
      );

      setChatHistory(prev => [
        ...prev,
        { role: "bot", text: res.data.answer }
      ]);
    } catch (e) {
      let errorMsg = "Error getting answer.";

      if (e.name === "AbortError" || e.code === "ECONNABORTED") {
        errorMsg = "Request timed out.";
      } else if (e.response?.status === 504) {
        errorMsg = "Gateway timeout.";
      }

      setChatHistory(prev => [
        ...prev,
        { role: "bot", text: errorMsg }
      ]);
    } finally {
      clearTimeout(timeoutId);
      setQuestion("");
      setAsking(false);
    }
  };

  // ===============================
  // Summarize
  // ===============================
  const summarizePDF = async () => {
    setSummarizing(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await axios.post(
        `${API_BASE}/summarize`,
        {},
        { signal: controller.signal }
      );

      setChatHistory(prev => [
        ...prev,
        { role: "bot", text: res.data.summary }
      ]);
    } catch {
      alert("Error summarizing PDF.");
    } finally {
      clearTimeout(timeoutId);
      setSummarizing(false);
    }
  };

  // ===============================
  // Compare
  // ===============================
  const compareDocuments = async () => {
    if (selectedDocs.length < 2) return;

    setComparing(true);

    try {
      const res = await axios.post(`${API_BASE}/compare`, {
        doc_ids: selectedDocs
      });

      setComparisonResult(res.data.comparison);
    } catch {
      alert("Error comparing documents.");
    }

    setComparing(false);
  };

  const themeClass = darkMode ? "bg-dark text-light" : "bg-light text-dark";

  return (
    <div className={themeClass} style={{ minHeight: "100vh" }}>
      <Navbar bg={darkMode ? "dark" : "primary"} variant="dark">
        <Container>
          <Navbar.Brand>PDF Q&A Bot</Navbar.Brand>
          <Button variant="outline-light" onClick={() => setDarkMode(!darkMode)}>
            Toggle Theme
          </Button>
        </Container>
      </Navbar>

      <Container className="mt-4">
        {/* Upload */}
        <Card className="mb-4">
          <Card.Body>
            <Form>
              <Form.Control type="file" onChange={e => setFile(e.target.files[0])} />
              <Button
                className="mt-2"
                onClick={uploadPDF}
                disabled={!file || uploading}
              >
                {uploading ? <Spinner size="sm" animation="border" /> : "Upload"}
              </Button>
            </Form>
          </Card.Body>
        </Card>

        {/* Chat */}
        <Card>
          <Card.Body>
            <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 16 }}>
              {chatHistory.map((msg, i) => (
                <div key={i}>
                  <strong>{msg.role === "user" ? "You" : "Bot"}:</strong>
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                </div>
              ))}
            </div>

            <Form className="d-flex gap-2">
              <Form.Control
                type="text"
                value={question}
                onChange={e => setQuestion(e.target.value)}
              />
              <Button onClick={askQuestion} disabled={asking}>
                {asking ? <Spinner size="sm" animation="border" /> : "Ask"}
              </Button>
            </Form>

            <div className="mt-3">
              <Button
                variant="warning"
                onClick={summarizePDF}
                disabled={summarizing}
                className="me-2"
              >
                Summarize
              </Button>

              <Button
                variant="info"
                onClick={compareDocuments}
                disabled={selectedDocs.length < 2 || comparing}
              >
                Compare
              </Button>
            </div>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}

export default App;