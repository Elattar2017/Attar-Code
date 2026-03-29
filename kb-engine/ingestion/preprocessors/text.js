const fs = require("fs");

function preprocessText(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");

  // Detect title: first non-empty line
  const lines = raw.split("\n");
  const titleLine = lines.find(l => l.trim());
  const title = titleLine ? titleLine.trim().slice(0, 100) : require("path").basename(filePath);

  // Convert likely headings:
  // - ALL CAPS lines → ## heading
  // - Lines ending with : that are short → ### heading
  let content = raw.replace(/^([A-Z][A-Z\s]{3,})$/gm, (match) => `## ${match.trim()}`);
  content = content.replace(/^(.{5,60}):$/gm, (match, p1) => `### ${p1.trim()}`);

  return { content, title, format: "text" };
}

module.exports = { preprocessText };
