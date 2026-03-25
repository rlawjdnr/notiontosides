const express = require("express");
const path = require("path");

const isVercelRuntime = Boolean(process.env.VERCEL || process.env.AWS_REGION || process.env.VERCEL_ENV);
const { chromium } = isVercelRuntime ? require("playwright-core") : require("playwright");
const serverlessChromium = isVercelRuntime ? require("@sparticuz/chromium") : null;

const app = express();
const PORT = Number(process.env.PORT) || 3040;

let browserPromise = null;

function isPublicNotionUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) && /(^|\.)notion\.so$/i.test(parsed.hostname);
  } catch (error) {
    return false;
  }
}

function normalizeTitle(title) {
  return String(title || "Untitled Presentation")
    .replace(/\s*\|\s*Notion\s*$/i, "")
    .trim() || "Untitled Presentation";
}

function splitSlides(blocks) {
  const slides = [];
  let current = [];

  for (const block of blocks) {
    if (!block) continue;

    if (block.type === "divider") {
      if (current.length > 0) {
        slides.push(current);
      }
      current = [];
      continue;
    }

    current.push(block);
  }

  if (current.length > 0) {
    slides.push(current);
  }

  return slides;
}

async function getLaunchOptions() {
  if (!isVercelRuntime) {
    return {
      headless: true,
      args: ["--disable-dev-shm-usage"]
    };
  }

  return {
    headless: serverlessChromium.headless,
    executablePath: await serverlessChromium.executablePath(),
    args: [...serverlessChromium.args, "--disable-dev-shm-usage"]
  };
}

async function getBrowser() {
  if (!browserPromise) {
    const launchOptions = await getLaunchOptions();
    browserPromise = chromium.launch(launchOptions).then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    });
  }

  let browser = await browserPromise;

  if (!browser.isConnected()) {
    browserPromise = null;
    browser = await getBrowser();
  }

  return browser;
}

async function waitForNotionReady(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 120000 });
  await page.waitForTimeout(1800);
  await page.waitForFunction(() => {
    return Boolean(
      document.querySelector(".notion-page-content") ||
      document.querySelector("[class*='notion-page-content']") ||
      document.querySelector("main")
    );
  }, { timeout: 30000 }).catch(() => {});
}

async function expandInteractiveBlocks(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clickTargets = Array.from(
      document.querySelectorAll('[aria-expanded="false"], [role="button"][aria-expanded="false"]')
    );

    for (const node of clickTargets) {
      try {
        node.click();
      } catch (error) {
      }
      await delay(50);
    }
  });
}

async function scrollToLoadEverything(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const scroller = document.scrollingElement || document.documentElement || document.body;
    let previousHeight = 0;

    for (let index = 0; index < 24; index += 1) {
      scroller.scrollTo(0, scroller.scrollHeight);
      await delay(350);

      if (scroller.scrollHeight === previousHeight) {
        break;
      }

      previousHeight = scroller.scrollHeight;
    }

    scroller.scrollTo(0, 0);
    await delay(150);
  });
}

async function extractBlocks(page) {
  return page.evaluate(() => {
    const transparentValues = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
    const allowedTags = new Set([
      "a", "b", "blockquote", "br", "code", "details", "div", "em", "figcaption", "figure", "h1", "h2", "h3",
      "i", "img", "li", "mark", "ol", "p", "pre", "s", "span", "strong", "summary", "table", "tbody", "td", "th", "thead", "tr", "u", "ul"
    ]);
    const styleProps = [
      "display", "flex-direction", "justify-content", "align-items", "gap", "align-self",
      "color", "background-color", "font-size", "font-style", "font-weight", "font-family", "line-height",
      "letter-spacing", "text-align", "text-decoration-line", "text-decoration-color", "text-transform",
      "white-space", "list-style-type", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
      "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
      "border", "border-top", "border-right", "border-bottom", "border-left", "border-radius",
      "width", "max-width", "min-width", "height", "max-height", "min-height", "opacity",
      "border-collapse", "border-spacing", "table-layout", "vertical-align"
    ];

    const cleanText = (value) => String(value || "")
      .replace(/\u200b/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const escapeHtml = (value) => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const escapeAttr = (value) => escapeHtml(value).replace(/"/g, "&quot;");

    const root = (
      document.querySelector(".notion-page-content") ||
      document.querySelector("[class*='notion-page-content']") ||
      document.querySelector("main") ||
      document.body
    );

    const blockCandidates = Array.from(root.querySelectorAll("[data-block-id]"));
    const topLevelBlocks = blockCandidates.filter((node) => {
      const parentBlock = node.parentElement ? node.parentElement.closest("[data-block-id]") : null;
      return !parentBlock || !root.contains(parentBlock) || parentBlock === node;
    });

    const orderedBlocks = topLevelBlocks.length > 0 ? topLevelBlocks : Array.from(root.children);

    function getText(node) {
      return cleanText(node ? node.innerText || node.textContent || "" : "");
    }

    function isDivider(node) {
      try {
        if (!node) return false;
        if (node.querySelector("hr")) return true;
        if ((node.getAttribute("data-block-type") || "").toLowerCase() === "divider") return true;
        if ((node.dataset.blockType || "").toLowerCase() === "divider") return true;

        const className = String(node.className || "");
        if (/divider/i.test(className)) return true;

        const role = node.getAttribute("role");
        if (role === "separator") return true;

        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.height <= 4 &&
          rect.width > 80 &&
          (style.borderTopWidth !== "0px" || style.borderBottomWidth !== "0px")
        );
      } catch (error) {
        return false;
      }
    }


    function findDirectChildContaining(node, selector) {
      return Array.from(node.children || []).find((child) => child.querySelector(selector) || child.matches(selector)) || null;
    }

    function isToggleBlock(node) {
      try {
        if (!node) return false;
        if ((node.getAttribute("data-block-type") || "").toLowerCase().includes("toggle")) return true;
        if ((node.dataset.blockType || "").toLowerCase().includes("toggle")) return true;
        const className = String(node.className || "");
        if (/toggle/i.test(className)) return true;
        return Boolean(findDirectChildContaining(node, '[aria-expanded]'));
      } catch (error) {
        return false;
      }
    }

    function serializeStyle(node) {
      try {
        const computed = window.getComputedStyle(node);
        const serialized = [];
        const tagName = node.tagName.toLowerCase();
        const isTableLike = ["table", "thead", "tbody", "tr", "td", "th"].includes(tagName);
        const containsDirectTable = tagName === "div" && Array.from(node.children || []).some((child) => child.tagName && child.tagName.toLowerCase() === "table");

        for (const prop of styleProps) {
          const value = computed.getPropertyValue(prop);
          if (!value) continue;
          if (prop === "background-color" && transparentValues.has(value)) continue;
          if (prop === "text-decoration-line" && (value === "none" || value === "normal")) continue;
          if (prop === "letter-spacing" && value === "normal") continue;
          if (["width", "max-width", "min-width", "height", "max-height", "min-height"].includes(prop) && value === "auto") continue;
          if ((isTableLike || containsDirectTable) && ["width", "max-width", "min-width", "height", "max-height", "min-height"].includes(prop)) continue;
          if (containsDirectTable && ["display", "justify-content", "align-items", "align-self", "gap", "padding-left", "list-style-type"].includes(prop)) continue;
          serialized.push(`${prop}:${value}`);
        }

        return serialized.join(";");
      } catch (error) {
        return "";
      }
    }

    function serializeToggleNode(node) {
      try {
        const toggleRow = findDirectChildContaining(node, '[aria-expanded]') || node.firstElementChild;
        const toggleControl = toggleRow ? toggleRow.querySelector('[aria-expanded]') || toggleRow.closest('[aria-expanded]') : null;
        const open = toggleControl ? toggleControl.getAttribute('aria-expanded') === 'true' : false;
        const summaryClone = toggleRow ? toggleRow.cloneNode(true) : node.cloneNode(true);

        for (const nestedBlock of summaryClone.querySelectorAll('[data-block-id]')) {
          nestedBlock.remove();
        }

        for (const nestedList of summaryClone.querySelectorAll('ul, ol, pre, blockquote, table, details')) {
          nestedList.remove();
        }

        for (const buttonNode of summaryClone.querySelectorAll('[aria-expanded], button, [role="button"]')) {
          buttonNode.remove();
        }

        const summaryText = cleanText(summaryClone.innerText || summaryClone.textContent || '');
        const contentClone = node.cloneNode(true);
        const contentParts = [];
        const contentToggleRow = findDirectChildContaining(contentClone, '[aria-expanded]') || contentClone.firstElementChild;
        const contentToggleControl = contentToggleRow ? contentToggleRow.querySelector('[aria-expanded]') || contentToggleRow.closest('[aria-expanded]') : null;
        const controlledId = contentToggleControl ? contentToggleControl.getAttribute('aria-controls') : '';

        if (controlledId) {
          const escapedId = window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(controlledId) : controlledId.replace(/([ #;?%&,.+*~':"!^$\[\]()=>|\/@])/g, '\$1');
          const controlledNode = contentClone.querySelector(`#${escapedId}`);
          if (controlledNode) {
            contentParts.push(serializeNode(controlledNode));
            controlledNode.remove();
          }
        }

        if (contentToggleRow) {
          const rowContentCandidates = Array.from(contentToggleRow.children || []).filter((child) => {
            if (child.querySelector('[aria-expanded]') || child.matches('[aria-expanded], button, [role="button"]')) {
              return false;
            }
            return Boolean(
              child.matches('[data-block-id], ul, ol, pre, blockquote, table, details') ||
              child.querySelector('[data-block-id], ul, ol, pre, blockquote, table, details')
            );
          });

          for (const candidate of rowContentCandidates) {
            contentParts.push(serializeNode(candidate));
          }

          for (const child of Array.from(contentClone.children || [])) {
            if (child === contentToggleRow) continue;
            contentParts.push(serializeNode(child));
          }
        } else {
          for (const child of Array.from(contentClone.children || [])) {
            contentParts.push(serializeNode(child));
          }
        }

        const contentHtml = contentParts.filter(Boolean).join('');
        const summaryHtml = `<span class="notion-toggle__label">${escapeHtml(summaryText)}</span>`;

        return `<details class="notion-toggle"${open ? ' open' : ''}><summary class="notion-toggle__summary">${summaryHtml}</summary><div class="notion-toggle__content">${contentHtml}</div></details>`;
      } catch (error) {
        return serializeNode(node);
      }
    }

    function normalizeTableHtml(html) {
      if (!html || !html.includes("<table")) return html;

      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const tableTags = new Set(["table", "thead", "tbody", "tr", "td", "th"]);

      for (const element of wrapper.querySelectorAll("*")) {
        const tagName = element.tagName.toLowerCase();
        const containsTable = Boolean(element.querySelector("table"));

        if (tableTags.has(tagName)) {
          element.style.removeProperty("width");
          element.style.removeProperty("max-width");
          element.style.removeProperty("min-width");
          element.style.removeProperty("height");
          element.style.removeProperty("max-height");
          element.style.removeProperty("min-height");
        }

        if (containsTable) {
          element.style.removeProperty("display");
          element.style.removeProperty("justify-content");
          element.style.removeProperty("align-items");
          element.style.removeProperty("align-self");
          element.style.removeProperty("gap");
          element.style.removeProperty("padding-left");
          element.style.removeProperty("list-style-type");
          element.style.removeProperty("margin-left");
          element.style.removeProperty("margin-right");
          element.style.removeProperty("width");
          element.style.removeProperty("max-width");
          element.style.removeProperty("min-width");
        }
      }

      for (const table of wrapper.querySelectorAll("table")) {
        table.style.marginLeft = "0";
        table.style.marginRight = "auto";
        table.style.width = "auto";
        table.style.maxWidth = "100%";
      }

      return wrapper.innerHTML;
    }

    function serializeNode(node) {
      if (!node) return "";

      if (node.nodeType === Node.TEXT_NODE) {
        return escapeHtml(node.textContent || "");
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const sourceTag = node.tagName.toLowerCase();
      if (["script", "style", "noscript", "iframe"].includes(sourceTag)) {
        return "";
      }
      if (sourceTag === "hr") {
        return "";
      }

      const tag = allowedTags.has(sourceTag) ? sourceTag : "div";
      const attrs = [];
      const style = serializeStyle(node);
      if (style) {
        attrs.push(`style="${escapeAttr(style)}"`);
      }

      if (tag === "a") {
        const href = node.getAttribute("href");
        if (href) attrs.push(`href="${escapeAttr(href)}"`);
        attrs.push('target="_blank"', 'rel="noreferrer noopener"');
      }

      if (tag === "img") {
        const src =
          node.currentSrc ||
          node.getAttribute("src") ||
          node.getAttribute("data-src") ||
          node.getAttribute("data-original") ||
          "";
        if (!src) return "";
        attrs.push(`src="${escapeAttr(src)}"`);
        attrs.push(`alt="${escapeAttr(node.getAttribute("alt") || "")}"`);
        attrs.push('loading="eager"');
        attrs.push('decoding="sync"');
        attrs.push('referrerpolicy="no-referrer"');

        const srcset = node.getAttribute("srcset") || node.getAttribute("data-srcset") || "";
        const sizes = node.getAttribute("sizes") || "";
        if (srcset) attrs.push(`srcset="${escapeAttr(srcset)}"`);
        if (sizes) attrs.push(`sizes="${escapeAttr(sizes)}"`);
      }

      const children = tag === "img"
        ? ""
        : Array.from(node.childNodes).map((child) => serializeNode(child)).join("");

      return `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${children}</${tag}>`;
    }

    function parseNode(node) {
      try {
        if (!node) return null;
        if (isDivider(node)) return { type: "divider" };

        let html = (isToggleBlock(node) ? serializeToggleNode(node) : serializeNode(node)).trim();
        html = normalizeTableHtml(html);
        const text = getText(node);
        const heading = node.matches("h1, h2, h3")
          ? node
          : node.querySelector(":scope h1, :scope h2, :scope h3");

        if (heading) {
          return {
            type: "heading",
            level: heading.tagName.toLowerCase(),
            text: getText(heading),
            html
          };
        }

        if (html && (text || node.querySelector("img, ul, ol, pre, blockquote"))) {
          return {
            type: "html",
            text,
            html
          };
        }

        return null;
      } catch (error) {
        return null;
      }
    }

    const blocks = [];
    for (const node of orderedBlocks) {
      const block = parseNode(node);
      if (block) {
        blocks.push(block);
      }
    }
    return blocks;
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));


app.get("/api/image", async (req, res) => {
  const src = String(req.query.src || "").trim();
  const pageUrl = String(req.query.page || "https://www.notion.so/").trim();

  if (!src) {
    res.status(400).send("missing src");
    return;
  }

  let target;
  try {
    target = new URL(src);
  } catch (error) {
    res.status(400).send("invalid src");
    return;
  }

  if (!/^https?:$/.test(target.protocol)) {
    res.status(400).send("invalid protocol");
    return;
  }

  try {
    const response = await fetch(target, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "referer": pageUrl || "https://www.notion.so/"
      }
    });

    if (!response.ok) {
      res.status(response.status).send(`image fetch failed: ${response.status}`);
      return;
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const cacheControl = response.headers.get("cache-control") || "public, max-age=3600";
    const arrayBuffer = await response.arrayBuffer();

    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", cacheControl);
    res.end(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(502).send(error.message || "image proxy failed");
  }
});

app.get("/api/parse", async (req, res) => {
  const url = String(req.query.url || "").trim();

  if (!isPublicNotionUrl(url)) {
    res.status(400).json({
      ok: false,
      error: "공개 Notion 링크만 지원합니다."
    });
    return;
  }

  let context;
  let page;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });

    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitForNotionReady(page);
    await expandInteractiveBlocks(page);
    await scrollToLoadEverything(page);

    const title = normalizeTitle(await page.title());
    const blocks = await extractBlocks(page);
    const slides = splitSlides(blocks);

    res.json({
      ok: true,
      title,
      url,
      slides
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Notion 페이지를 렌더링하거나 파싱하지 못했습니다.",
      detail: error.message
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }

    if (context) {
      await context.close().catch(() => {});
    }
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function startServer(port, attemptsLeft = 10) {
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Notion presentation app running at http://localhost:${port}`);
  });

  server.on("error", (error) => {
    if ((error.code === "EADDRINUSE" || error.code === "EPERM") && attemptsLeft > 0) {
      console.log(`Port ${port} unavailable, retrying on ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
      return;
    }

    throw error;
  });

  return server;
}

async function shutdown() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  startServer(PORT);

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
}

module.exports = app;
