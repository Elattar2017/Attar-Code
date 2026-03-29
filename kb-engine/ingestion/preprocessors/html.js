const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");

function preprocessHtml(htmlContent, sourceUrl) {
  // 1. Parse with JSDOM
  const dom = new JSDOM(htmlContent, { url: sourceUrl || "http://localhost" });

  // 2. Extract main content with Readability (strips nav, ads, footer)
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  // 3. Convert to Markdown with Turndown
  const turndown = new TurndownService({
    headingStyle: "atx",        // # headings
    codeBlockStyle: "fenced",   // ``` code blocks
    bulletListMarker: "-",
  });

  // Preserve code blocks
  turndown.addRule("pre-code", {
    filter: ["pre"],
    replacement: (content, node) => {
      const lang =
        node.querySelector("code")?.className?.replace("language-", "") || "";
      return `\n\`\`\`${lang}\n${node.textContent.trim()}\n\`\`\`\n`;
    },
  });

  const content = article
    ? turndown.turndown(article.content)
    : turndown.turndown(htmlContent);
  const title =
    article?.title || dom.window.document.title || "Untitled";

  return { content, title, format: "html" };
}

// For file-based input:
function preprocessHtmlFile(filePath) {
  const fs = require("fs");
  const html = fs.readFileSync(filePath, "utf-8");
  return preprocessHtml(html);
}

module.exports = { preprocessHtml, preprocessHtmlFile };
