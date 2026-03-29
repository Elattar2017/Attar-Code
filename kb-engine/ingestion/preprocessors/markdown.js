const fs = require("fs");

function preprocessMarkdown(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");

  // Extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : require("path").basename(filePath, ".md");

  return { content, title, format: "markdown" };
}

module.exports = { preprocessMarkdown };
