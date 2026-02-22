
import React, { useState, useEffect } from "react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import { Document, Page, pdfjs } from "react-pdf";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import 'bootstrap/dist/css/bootstrap.min.css';
import './App.css';
import { Container, Row, Col, Button, Form, Card, ToggleButton, ToggleButtonGroup, Spinner, Navbar, Nav, Dropdown } from 'react-bootstrap';
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const API_BASE = process.env.REACT_APP_API_URL || "";

// Theme persistence key
const THEME_STORAGE_KEY = 'pdf-qa-bot-theme';

function App() {
  const [file, setFile] = useState(null);
  const [pdfs, setPdfs] = useState([]); // {name, url, chat: []}
  const [selectedPdf, setSelectedPdf] = useState(null);
  const [question, setQuestion] = useState("");
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    // Load theme preference from localStorage
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return savedTheme ? JSON.parse(savedTheme) : false;
  });
  const [numPages, setNumPages] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [summarizing, setSummarizing] = useState(false);

  // Save theme preference when it changes
  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(darkMode));
    // Update document body class for global styling
    document.body.classList.toggle('dark-mode', darkMode);
  }, [darkMode]);

  // Multi-PDF upload
  const uploadPDF = async () => {
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    // Setup timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 second timeout for upload

    try {
      await axios.post(`${API_BASE}/upload`, formData, {
        signal: controller.signal
      });
      const url = URL.createObjectURL(file);
      setPdfs(prev => [...prev, { name: file.name, url, chat: [] }]);
      setSelectedPdf(file.name);
      alert("PDF uploaded!");
    } catch (e) {
      let message = "Upload failed.";

      if (e.name === 'AbortError' || e.code === 'ECONNABORTED') {
        message = "Upload timed out. Please try again with a smaller file.";
      } else if (e.response?.status === 504) {
        message = "Gateway timeout. The upload took too long. Please try again.";
      } else {
        message = e.response?.data?.error || e.response?.data?.details || "Upload failed.";
      }

      alert(message);
    } finally {
      clearTimeout(timeoutId);
      setUploading(false);
    }
  };

  // Chat per PDF
  const askQuestion = async () => {
    if (!selectedPdf) return;

    // Input validation
    if (!question || !question.trim()) {
      alert("Question cannot be empty");
      return;
    }

    if (question.length > 2000) {
      alert("Question too long (max 2000 characters)");
      return;
    }

    setAsking(true);
    const trimmedQuestion = question.trim();
    setPdfs(prev => prev.map(pdf => pdf.name === selectedPdf ? { ...pdf, chat: [...pdf.chat, { role: "user", text: trimmedQuestion }] } : pdf));

    // Setup timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second client-side timeout

    try {
      const res = await axios.post(`${API_BASE}/ask`,
        { question: trimmedQuestion },
        { signal: controller.signal }
      );
      setPdfs(prev => prev.map(pdf => pdf.name === selectedPdf ? { ...pdf, chat: [...pdf.chat, { role: "bot", text: res.data.answer }] } : pdf));
    } catch (e) {
      let errorMsg = "Error getting answer.";

      if (e.name === 'AbortError' || e.code === 'ECONNABORTED') {
        errorMsg = "⏱️ Request timed out. The question took too long to process. Please try a simpler question or try again.";
      } else if (e.response?.status === 504) {
        errorMsg = "⏱️ Gateway timeout. The server took too long to respond. Please try again.";
      } else {
        errorMsg = e.response?.data?.error || e.response?.data?.details || "Error getting answer.";
      }

      setPdfs(prev => prev.map(pdf => pdf.name === selectedPdf ? { ...pdf, chat: [...pdf.chat, { role: "bot", text: errorMsg }] } : pdf));
    } finally {
      clearTimeout(timeoutId);
      setQuestion("");
      setAsking(false);
    }
  };

  // Summarization
  const summarizePDF = async () => {
    if (!selectedPdf) return;
    setSummarizing(true);

    // Setup timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second client-side timeout

    try {
      const res = await axios.post(`${API_BASE}/summarize`,
        { pdf: selectedPdf },
        { signal: controller.signal }
      );
      setPdfs(prev => prev.map(pdf => pdf.name === selectedPdf ? { ...pdf, chat: [...pdf.chat, { role: "bot", text: res.data.summary }] } : pdf));
    } catch (e) {
      let errorMsg = "Error summarizing PDF.";

      if (e.name === 'AbortError' || e.code === 'ECONNABORTED') {
        errorMsg = "⏱️ Request timed out. The summarization took too long. Please try again.";
      } else if (e.response?.status === 504) {
        errorMsg = "⏱️ Gateway timeout. The server took too long to respond. Please try again.";
      } else {
        errorMsg = e.response?.data?.error || e.response?.data?.details || "Error summarizing PDF.";
      }

      setPdfs(prev => prev.map(pdf => pdf.name === selectedPdf ? { ...pdf, chat: [...pdf.chat, { role: "bot", text: errorMsg }] } : pdf));
    } finally {
      clearTimeout(timeoutId);
      setSummarizing(false);
    }
  };

  // Export chat
  const exportChat = (type) => {
    if (!selectedPdf) return;
    const chat = pdfs.find(pdf => pdf.name === selectedPdf)?.chat || [];
    if (type === "csv") {
      const csv = Papa.unparse(chat);
      const blob = new Blob([csv], { type: "text/csv" });
      saveAs(blob, `${selectedPdf}-chat.csv`);
    } else if (type === "pdf") {
      // Simple text PDF export
      const text = chat.map(msg => `${msg.role}: ${msg.text}`).join("\n\n");
      const blob = new Blob([text], { type: "application/pdf" });
      saveAs(blob, `${selectedPdf}-chat.pdf`);
    }
  };

  // PDF Viewer
  const onDocumentLoadSuccess = ({ numPages }) => {
    setNumPages(numPages);
    setPageNumber(1);
  };

  const themeClass = darkMode ? "bg-dark text-light" : "bg-light text-dark";

  const currentChat = pdfs.find(pdf => pdf.name === selectedPdf)?.chat || [];
  const currentPdfUrl = pdfs.find(pdf => pdf.name === selectedPdf)?.url || null;

  const toggleTheme = () => {
    setDarkMode(!darkMode);
  };

  return (
    <div className={`${themeClass} app-container`} style={{ minHeight: "100vh", transition: "all 0.3s ease" }}>
      <Navbar bg={darkMode ? "dark" : "primary"} variant={darkMode ? "dark" : "light"} expand="lg" className="mb-4 shadow-sm">
        <Container>
          <Navbar.Brand href="#" className="fw-bold">
            📄 PDF Q&A Bot
          </Navbar.Brand>
          <Nav className="ms-auto">
            <div className="theme-toggle-container d-flex align-items-center">
              <span className="me-2 text-muted small">Theme:</span>
              <ToggleButtonGroup
                type="radio"
                name="theme"
                value={darkMode ? 1 : 0}
                onChange={toggleTheme}
                className="theme-toggle-group"
              >
                <ToggleButton
                  id="tbg-light"
                  value={0}
                  variant={darkMode ? "outline-light" : "primary"}
                  size="sm"
                  className="theme-btn"
                >
                  ☀️ Light
                </ToggleButton>
                <ToggleButton
                  id="tbg-dark"
                  value={1}
                  variant={darkMode ? "light" : "outline-secondary"}
                  size="sm"
                  className="theme-btn"
                >
                  🌙 Dark
                </ToggleButton>
              </ToggleButtonGroup>
            </div>
          </Nav>
        </Container>
      </Navbar>
      <Container>
        <Row className="justify-content-center mb-4">
          <Col md={8}>
            <Card className={`${darkMode ? "bg-secondary text-light border-dark" : "bg-white text-dark border-light"} shadow`}>
              <Card.Body>
                <Form>
                  <Form.Group controlId="formFile" className="mb-3">
                    <Form.Label className="fw-semibold">Upload PDF</Form.Label>
                    <Form.Control
                      type="file"
                      onChange={e => setFile(e.target.files[0])}
                      className={darkMode ? "bg-dark text-light border-secondary" : ""}
                    />
                  </Form.Group>
                  <Button variant="primary" onClick={uploadPDF} disabled={!file || uploading}>
                    {uploading ? <Spinner animation="border" size="sm" /> : "📤 Upload"}
                  </Button>
                  {file && <span className="ms-3 text-muted">{file.name}</span>}
                </Form>
                {pdfs.length > 0 && (
                  <Dropdown className="mt-3">
                    <Dropdown.Toggle variant={darkMode ? "outline-light" : "info"} id="dropdown-pdf">
                      📚 {selectedPdf || "Select PDF"}
                    </Dropdown.Toggle>
                    <Dropdown.Menu className={darkMode ? "bg-dark" : ""}>
                      {pdfs.map(pdf => (
                        <Dropdown.Item
                          key={pdf.name}
                          onClick={() => setSelectedPdf(pdf.name)}
                          className={darkMode ? "text-light" : ""}
                          style={darkMode ? { backgroundColor: 'transparent' } : {}}
                        >
                          {pdf.name}
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown>
                )}
              </Card.Body>
            </Card>
          </Col>
        </Row>
        {currentPdfUrl && (
          <Row className="justify-content-center mb-4">
            <Col md={8}>
              <Card className={`${darkMode ? "bg-secondary text-light border-dark" : "bg-white text-dark border-light"} shadow`}>
                <Card.Body>
                  <div style={{ textAlign: "center" }}>
                    <Document file={currentPdfUrl} onLoadSuccess={onDocumentLoadSuccess}>
                      <Page pageNumber={pageNumber} />
                    </Document>
                    <div className="d-flex justify-content-between align-items-center mt-3">
                      <Button
                        variant={darkMode ? "outline-light" : "outline-info"}
                        size="sm"
                        disabled={pageNumber <= 1}
                        onClick={() => setPageNumber(pageNumber - 1)}
                      >
                        ← Prev
                      </Button>
                      <span className="fw-semibold">Page {pageNumber} of {numPages}</span>
                      <Button
                        variant={darkMode ? "outline-light" : "outline-info"}
                        size="sm"
                        disabled={pageNumber >= numPages}
                        onClick={() => setPageNumber(pageNumber + 1)}
                      >
                        Next →
                      </Button>
                    </div>
                  </div>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        )}
        <Row className="justify-content-center">
          <Col md={8}>
            <Card className={`${darkMode ? "bg-secondary text-light border-dark" : "bg-white text-dark border-light"} shadow`}>
              <Card.Body style={{ minHeight: 300 }}>
                <h5 className="mb-3">💬 Chat</h5>
                <div
                  className={`chat-messages ${darkMode ? "chat-messages-dark" : "chat-messages-light"}`}
                  style={{
                    maxHeight: 250,
                    overflowY: "auto",
                    marginBottom: 16,
                    padding: "10px",
                    borderRadius: "8px",
                    backgroundColor: darkMode ? "#1a1a1a" : "#f8f9fa"
                  }}
                >
                  {currentChat.length === 0 ? (
                    <div className="text-center text-muted py-4">
                      <p>No messages yet. Ask a question about your PDF!</p>
                    </div>
                  ) : (
                    currentChat.map((msg, i) => (
                      <div key={i} className={`d-flex ${msg.role === "user" ? "justify-content-end" : "justify-content-start"} mb-2`}>
                        <div
                          className={`p-2 rounded ${msg.role === "user"
                            ? "bg-primary text-light"
                            : darkMode
                              ? "bg-dark text-light border border-secondary"
                              : "bg-white text-dark border"
                            }`}
                          style={{ maxWidth: "80%" }}
                        >
                          {msg.role === "bot" ? (
                            <div className="markdown-content">
                              <ReactMarkdown>{msg.text}</ReactMarkdown>
                            </div>
                          ) : (
                            <span><strong>You:</strong> {msg.text}</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <Form className="d-flex gap-2 mb-3">
                  <Form.Control
                    type="text"
                    placeholder="Ask a question..."
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    disabled={asking}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); askQuestion(); } }}
                    className={darkMode ? "bg-dark text-light border-secondary" : ""}
                  />
                  <Button variant="success" onClick={askQuestion} disabled={asking || !question.trim() || !selectedPdf}>
                    {asking ? <Spinner animation="border" size="sm" /> : "💭 Ask"}
                  </Button>
                </Form>
                <div className="d-flex gap-2 flex-wrap">
                  <Button
                    variant={darkMode ? "outline-warning" : "warning"}
                    onClick={summarizePDF}
                    disabled={summarizing || !selectedPdf}
                  >
                    {summarizing ? <Spinner animation="border" size="sm" /> : "📝 Summarize PDF"}
                  </Button>
                  <Button
                    variant={darkMode ? "outline-light" : "outline-secondary"}
                    onClick={() => exportChat("csv")}
                    disabled={!selectedPdf}
                  >
                    📊 Export CSV
                  </Button>
                  <Button
                    variant={darkMode ? "outline-light" : "outline-secondary"}
                    onClick={() => exportChat("pdf")}
                    disabled={!selectedPdf}
                  >
                    📄 Export PDF
                  </Button>
                </div>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Container>
    </div>
  );
}

export default App;
