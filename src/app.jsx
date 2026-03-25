import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "framer-motion";

if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  import("react-grab").catch((error) => {
    console.warn("Failed to load react-grab.", error);
  });
}

const AUTO_REFRESH_MS = 10000;
const TOOLBAR_IDLE_MS = 2000;
const APP_STYLE_URL = "/style.css";
const STORAGE_KEY = "notion-presentation:last-state";
const DEFAULT_COVER_SUBTITLE = "";
const SPRING_TRANSITION = {
  type: "spring",
  stiffness: 380,
  damping: 34,
  mass: 0.9
};
const SOFT_SPRING_TRANSITION = {
  type: "spring",
  stiffness: 320,
  damping: 30,
  mass: 0.9
};

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, "");
}

function readStoredState() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
  } catch (error) {
    return null;
  }
}

function writeStoredState(nextState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  } catch (error) {
  }
}

function getInitialPersistedState() {
  const params = new URLSearchParams(window.location.search);
  const stored = readStoredState();
  const initialUrl = params.get("url") || stored?.sourceUrl || stored?.inputUrl || "";
  const autoParam = params.get("autoRefresh");
  const autoRefresh = autoParam === null ? Boolean(stored?.autoRefresh) : (autoParam === "true" || autoParam === "1");
  const fontMode = stored?.fontMode === "serif" ? "serif" : "sans";

  return {
    initialUrl,
    autoRefresh,
    fontMode
  };
}

function titleTextForSlide(slide, index) {
  const heading = normalizeSlideBlocks(slide).find((block) => block.type === "heading" && block.text);
  return heading ? heading.text : `Slide ${index + 1}`;
}

function ensureSlideHasTitle(slide, index) {
  const blocks = normalizeSlideBlocks(slide);

  if (blocks.some((block) => block.type === "heading" && block.text)) {
    return blocks;
  }

  const title = titleTextForSlide(slide, index);
  return [
    {
      type: "heading",
      level: "h2",
      text: title,
      html: `<h2>${escapeHtml(title)}</h2>`
    },
    ...blocks
  ];
}

function subtitleTextForBlock(block) {
  if (!block) return "";

  let text = String(block.text || "").trim();

  if (!text && block.html) {
    const template = document.createElement("template");
    template.innerHTML = String(block.html).trim();
    text = String(template.content.textContent || "").trim();
  }

  if (!text.startsWith(":")) return "";
  return text.replace(/^:\s*/, "").trim();
}

function blockPlainText(block) {
  if (!block) return "";

  const directText = String(block.text || "").trim();
  if (directText) return directText;
  if (!block.html) return "";

  const template = document.createElement("template");
  template.innerHTML = String(block.html).trim();
  return String(template.content.textContent || "").trim();
}

function shouldHideBlock(block) {
  const text = blockPlainText(block);
  return text === "사용자의 실제 회고";
}

function visibleSlideBlocks(slide) {
  return normalizeSlideBlocks(slide).filter((block) => !shouldHideBlock(block));
}

function deckCoverSubtitleInfo(slide) {
  const blocks = visibleSlideBlocks(slide);
  if (!blocks.length) {
    return { subtitle: "", removeIndex: -1 };
  }

  if (subtitleTextForBlock(blocks[0])) {
    return {
      subtitle: subtitleTextForBlock(blocks[0]),
      removeIndex: 0
    };
  }

  if (blocks[0]?.type === "heading" && subtitleTextForBlock(blocks[1])) {
    return {
      subtitle: subtitleTextForBlock(blocks[1]),
      removeIndex: 1
    };
  }

  return { subtitle: "", removeIndex: -1 };
}

function bodyBlocksForSlide(slide, index, slides = []) {
  const blocks = visibleSlideBlocks(slide);

  if (index === 0 && Array.isArray(slides) && slides.length > 0) {
    const info = deckCoverSubtitleInfo(slide);
    if (info.removeIndex >= 0) {
      return blocks.filter((_, blockIndex) => blockIndex !== info.removeIndex);
    }
  }

  return blocks;
}

function isCoverLayoutSlide(slide) {
  return Boolean(slide && !Array.isArray(slide) && slide.layout === "cover");
}

function isClosingCoverCandidate(slide, index, slides = []) {
  if (index !== slides.length - 1) return false;
  if (isCoverLayoutSlide(slide)) return true;

  const blocks = visibleSlideBlocks(slide);
  if (blocks.length < 1 || blocks.length > 2) return false;

  const titleText = blockPlainText(blocks[0]);
  if (!titleText) return false;
  if (titleText.length > 40) return false;
  if (/[.!?]\s.+/.test(titleText)) return false;

  for (const block of blocks) {
    if (/<img|<table|class="notion-toggle"/i.test(String(block?.html || ""))) return false;
  }

  if (blocks.length === 2 && !subtitleTextForBlock(blocks[1])) return false;

  return true;
}

function coverContentForSlide(slide, index, slides = [], fallbackTitle = "", fallbackSubtitle = "") {
  const coverLayout = isCoverLayoutSlide(slide);
  const closingCandidate = isClosingCoverCandidate(slide, index, slides);

  if (!coverLayout && !closingCandidate) {
    return {
      title: fallbackTitle,
      subtitle: fallbackSubtitle
    };
  }

  if (!coverLayout && closingCandidate) {
    const blocks = visibleSlideBlocks(slide);
    const titleText = blockPlainText(blocks[0]);
    return {
      title: titleText || fallbackTitle,
      subtitle: subtitleTextForBlock(blocks[1]) || fallbackSubtitle
    };
  }

  const blocks = withStickySubtitle(slide, index);
  const firstBlock = blocks[0] || null;
  const rest = blocks.slice(1);
  const title = blockPlainText(firstBlock) || titleTextForSlide(slide, index);
  const subtitleBlock = rest.find((block) => {
    const text = blockPlainText(block);
    return text && text !== title;
  });

  return {
    title,
    subtitle: firstBlock?.subtitle || subtitleTextForBlock(subtitleBlock) || blockPlainText(subtitleBlock) || fallbackSubtitle
  };
}

function coverSubtitleFromSlide(slide, index, fallbackSubtitle = "") {
  const info = deckCoverSubtitleInfo(slide);
  return info.subtitle || fallbackSubtitle;
}

function deckCoverContent(title, slides = []) {
  const firstSlide = Array.isArray(slides) ? slides[0] : null;

  return {
    title,
    subtitle: firstSlide ? coverSubtitleFromSlide(firstSlide, 0, DEFAULT_COVER_SUBTITLE) : DEFAULT_COVER_SUBTITLE
  };
}

function withStickySubtitle(slide, index, slides = []) {
  const titledSlide = ensureSlideHasTitle(bodyBlocksForSlide(slide, index, slides), index);
  if (!Array.isArray(titledSlide) || titledSlide.length < 2) {
    return titledSlide;
  }

  const [firstBlock, ...rest] = titledSlide;
  if (firstBlock?.type !== "heading") {
    return titledSlide;
  }

  const subtitleIndex = rest.findIndex((block) => {
    const text = String(block?.text || "").trim();
    if (!text && !block?.html) return false;
    return Boolean(subtitleTextForBlock(block));
  });

  if (subtitleIndex === -1) {
    return titledSlide;
  }

  const subtitle = subtitleTextForBlock(rest[subtitleIndex]);
  const remaining = rest.filter((_, idx) => idx !== subtitleIndex);

  return [
    {
      ...firstBlock,
      subtitle
    },
    ...remaining
  ];
}

function isToggleHtmlBlock(block) {
  return Boolean(block?.html && String(block.html).includes('class="notion-toggle"'));
}

function readInlinePx(styleText, property) {
  const target = String(property || "").trim().toLowerCase();
  const declarations = String(styleText || "").split(";");

  for (const declaration of declarations) {
    const [rawName, rawValue] = declaration.split(":");
    if (!rawName || !rawValue) continue;
    if (rawName.trim().toLowerCase() !== target) continue;

    const match = rawValue.match(/([0-9.]+)px/i);
    return match ? Number(match[1]) : 0;
  }

  return 0;
}

function getBlockIndent(block) {
  if (!block?.html) return 0;

  const template = document.createElement("template");
  template.innerHTML = String(block.html).trim();
  const root = template.content.firstElementChild;
  if (!root) return 0;

  let indent = 0;
  const elements = [root, ...Array.from(root.querySelectorAll("[style]"))].slice(0, 6);
  for (const element of elements) {
    const styleText = element.getAttribute("style") || "";
    indent = Math.max(indent, readInlinePx(styleText, "padding-left"), readInlinePx(styleText, "margin-left"));
  }

  return indent;
}

function readComputedPx(value) {
  const parsed = Number.parseFloat(value || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function getElementIndent(element) {
  if (!element) return 0;

  let indent = 0;
  const elements = [element, ...Array.from(element.querySelectorAll("[style]"))].slice(0, 8);
  for (const current of elements) {
    const computed = window.getComputedStyle(current);
    indent = Math.max(indent, readComputedPx(computed.paddingLeft), readComputedPx(computed.marginLeft));
  }

  return indent;
}

function regroupToggleDom(container) {
  if (!container) return;

  const blockElements = Array.from(container.children);

  for (const blockElement of blockElements) {
    const details = Array.from(blockElement.children).find((child) => {
      return child.matches?.("details.notion-toggle");
    });
    if (!details) continue;

    const content = details.querySelector(":scope > .notion-toggle__content");
    if (!content) continue;

    let sibling = blockElement.nextElementSibling;

    while (sibling) {
      const nextSibling = sibling.nextElementSibling;
      if (sibling.classList.contains("sticky-title")) break;
      if (sibling.querySelector(":scope details.notion-toggle")) break;

      content.appendChild(sibling);
      sibling = nextSibling;
    }
  }
}

function renderBlockInnerHtml(block) {
  if (!block) return "";
  if (block.html) {
    return `<div class="rendered-block rendered-rich">${block.html}</div>`;
  }
  if (block.type === "paragraph") {
    return `<p class="notion-paragraph">${escapeHtml(block.text || "")}</p>`;
  }
  return "";
}

function mergeToggleBlockHtml(toggleHtml, childBlocks) {
  if (!toggleHtml || !childBlocks.length) return toggleHtml;

  const template = document.createElement("template");
  template.innerHTML = String(toggleHtml);
  const content = template.content.querySelector(".notion-toggle__content");
  if (!content) return toggleHtml;

  content.innerHTML = childBlocks.map((block) => renderBlockInnerHtml(block)).join("");
  return template.innerHTML;
}

function normalizeSlideBlocks(slide) {
  if (Array.isArray(slide)) return slide;
  if (slide && Array.isArray(slide.blocks)) return slide.blocks;
  return [];
}

function proxiedImageUrl(src, pageUrl) {
  if (!src) return "";
  return `/api/image?src=${encodeURIComponent(src)}&page=${encodeURIComponent(pageUrl || "")}`;
}

function rewriteBlockHtml(html = "", pageUrl = "") {
  const template = document.createElement("template");
  template.innerHTML = String(html);

  for (const image of template.content.querySelectorAll("img")) {
    const original = image.getAttribute("src") || image.currentSrc || "";
    if (!original) continue;
    image.setAttribute("src", proxiedImageUrl(original, pageUrl));
  }

  return template.innerHTML;
}

function renderStaticBlock(block, pageUrl = "") {
  if (!block) return "";

  if (block.type === "heading") {
    if (block.html) {
      const headingHtml = rewriteBlockHtml(block.html, pageUrl);
      const subtitleHtml = block.subtitle ? `<div class="sticky-title__subtitle">${escapeHtml(block.subtitle)}</div>` : "";
      return `<div class="sticky-title rendered-rich rendered-rich--title">${headingHtml}${subtitleHtml}</div>`;
    }
    const level = block.level === "h1" ? "h1" : block.level === "h3" ? "h3" : "h2";
    const subtitleHtml = block.subtitle ? `<div class="sticky-title__subtitle">${escapeHtml(block.subtitle)}</div>` : "";
    return `<div class="sticky-title sticky-title--${level}"><${level}>${escapeHtml(block.text || "")}</${level}>${subtitleHtml}</div>`;
  }

  if (block.html) {
    return `<div class="rendered-block rendered-rich">${rewriteBlockHtml(block.html, pageUrl)}</div>`;
  }

  if (block.type === "paragraph") {
    return `<p class="notion-paragraph">${escapeHtml(block.text || "")}</p>`;
  }

  return "";
}

function buildCoverMarkup(title, subtitle, slideIndex, active = false) {
  return `
    <section class="slide cover-slide${active ? " is-active" : ""}" data-slide-index="${slideIndex}">
      <div class="slide__mask"></div>
      <div class="slide__scroll">
        <div class="cover-slide__inner">
          <h1 class="cover-slide__title">${escapeHtml(title)}</h1>
          ${subtitle ? `<div class="cover-slide__subtitle">${escapeHtml(subtitle)}</div>` : ""}
        </div>
      </div>
    </section>
  `;
}

function buildSlidesMarkup(title, slides, pageUrl) {
  const deckCover = deckCoverContent(title, slides);
  const cover = buildCoverMarkup(deckCover.title, deckCover.subtitle, 0, true);

  const content = (slides || []).map((slide, index) => {
    if (isClosingCoverCandidate(slide, index, slides || [])) {
      const coverContent = coverContentForSlide(slide, index, slides || [], titleTextForSlide(slide, index), "");
      return buildCoverMarkup(coverContent.title, coverContent.subtitle, index + 1);
    }

    const fullSlide = withStickySubtitle(slide, index, slides || []);
    const body = fullSlide.map((block) => renderStaticBlock(block, pageUrl)).join("");
    return `
      <section class="slide" data-slide-index="${index + 1}">
        <div class="slide__mask"></div>
        <div class="slide__scroll">
          <div class="slide__inner">${body}</div>
        </div>
      </section>
    `;
  }).join("");

  return cover + content;
}

function buildStandaloneScript() {
  return `
    const slides = Array.from(document.querySelectorAll(".slide"));
    const deck = document.getElementById("deck");
    const imageLightbox = document.getElementById("imageLightbox");
    const imageLightboxImg = document.getElementById("imageLightboxImg");
    const progressFill = document.getElementById("progressFill");
    const slideCounter = document.getElementById("slideCounter");
    const prevButton = document.getElementById("prevButton");
    const nextButton = document.getElementById("nextButton");
    const topButton = document.getElementById("topButton");
    const coverButton = document.getElementById("coverButton");
    let currentSlideIndex = 0;

    function getCurrentScroller() {
      const slide = slides[currentSlideIndex];
      return slide ? slide.querySelector(".slide__scroll") : null;
    }

    function update() {
      slides.forEach((slide, index) => {
        slide.classList.toggle("is-active", index === currentSlideIndex);
      });
      prevButton.disabled = currentSlideIndex === 0;
      nextButton.disabled = currentSlideIndex === slides.length - 1;
      slideCounter.textContent = (currentSlideIndex + 1) + " / " + slides.length;
      const ratio = slides.length <= 1 ? 1 : currentSlideIndex / (slides.length - 1);
      progressFill.style.width = (Math.max(0, Math.min(1, ratio)) * 100) + "%";
    }

    function goTo(index) {
      currentSlideIndex = Math.max(0, Math.min(index, slides.length - 1));
      update();
      const scroller = getCurrentScroller();
      if (scroller) {
        scroller.scrollTo({ top: 0, behavior: "auto" });
      }
    }

    function closeLightbox() {
      imageLightbox.hidden = true;
      imageLightboxImg.removeAttribute("src");
      imageLightboxImg.removeAttribute("alt");
    }

    function openLightbox(image) {
      const src = image?.getAttribute("src");
      if (!src) return;
      imageLightboxImg.src = src;
      imageLightboxImg.alt = image.getAttribute("alt") || "";
      imageLightbox.hidden = false;
    }

    prevButton.addEventListener("click", () => goTo(currentSlideIndex - 1));
    nextButton.addEventListener("click", () => goTo(currentSlideIndex + 1));
    topButton.addEventListener("click", () => {
      const scroller = getCurrentScroller();
      if (scroller) {
        scroller.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
    coverButton.addEventListener("click", () => goTo(0));
    imageLightbox.addEventListener("click", (event) => {
      if (event.target === imageLightbox) {
        closeLightbox();
      }
    });
    imageLightboxImg.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    deck.addEventListener("dblclick", (event) => {
      const image = event.target instanceof Element ? event.target.closest("img") : null;
      if (!image) return;
      event.preventDefault();
      openLightbox(image);
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !imageLightbox.hidden) {
        event.preventDefault();
        closeLightbox();
        return;
      }
      if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        goTo(currentSlideIndex + 1);
      }
      if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        goTo(currentSlideIndex - 1);
      }
      if (event.key === "Home") {
        event.preventDefault();
        goTo(0);
      }
    });

    update();
  `;
}

function RenderedBlock({ block, pageUrl }) {
  if (!block) return null;

  if (block.type === "heading") {
    if (block.html) {
      return (
        <div className="sticky-title rendered-rich rendered-rich--title">
          <div dangerouslySetInnerHTML={{ __html: rewriteBlockHtml(block.html, pageUrl) }} />
          {block.subtitle ? <div className="sticky-title__subtitle">{block.subtitle}</div> : null}
        </div>
      );
    }

    const level = block.level === "h1" ? "h1" : block.level === "h3" ? "h3" : "h2";
    const Tag = level;
    return (
      <div className={`sticky-title sticky-title--${level}`}>
        <Tag>{block.text || ""}</Tag>
        {block.subtitle ? <div className="sticky-title__subtitle">{block.subtitle}</div> : null}
      </div>
    );
  }

  if (block.html) {
    return <div className="rendered-block rendered-rich" dangerouslySetInnerHTML={{ __html: rewriteBlockHtml(block.html, pageUrl) }} />;
  }

  if (block.type === "paragraph") {
    return <p className="notion-paragraph">{block.text || ""}</p>;
  }

  return null;
}

function DeckSlide({ cover, title, subtitle, slide, slides, index, pageUrl, slideIndex, totalSlides, onPrev, onNext, onTop, onCover, onImageDoubleClick }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [slideIndex]);

  useEffect(() => {
    if (cover || !scrollRef.current) return;
    const inner = scrollRef.current.querySelector(".slide__inner");
    regroupToggleDom(inner);
  }, [cover, slide, pageUrl, slideIndex]);

  return (
    <motion.section
      key={slideIndex}
      className={`slide is-active${cover ? " cover-slide" : ""}`}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      exit={false}
      transition={{ duration: 0 }}
    >
      <div className="slide__mask" />
      {cover ? (
        <div className="slide__scroll" ref={scrollRef}>
          <div className="cover-slide__inner">
            <h1 className="cover-slide__title">{title}</h1>
            {subtitle ? <div className="cover-slide__subtitle">{subtitle}</div> : null}
          </div>
        </div>
      ) : (
        <div
          className="slide__scroll"
          ref={scrollRef}
          onDoubleClickCapture={(event) => {
            const image = event.target instanceof Element ? event.target.closest("img") : null;
            if (!image) return;
            event.preventDefault();
            onImageDoubleClick?.(image);
          }}
        >
          <div className="slide__inner">
            {withStickySubtitle(slide, index, slides || []).map((block, blockIndex) => (
              <RenderedBlock
                key={`${slideIndex}-${blockIndex}`}
                block={block}
                pageUrl={pageUrl}
              />
            ))}
          </div>
        </div>
      )}

      <div className="presentation-nav">
        <button className="icon-button" type="button" aria-label="이전 슬라이드" onClick={onPrev} disabled={slideIndex === 0}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <div className="presentation-nav__count">{slideIndex + 1} / {totalSlides}</div>
        <button className="icon-button" type="button" aria-label="다음 슬라이드" onClick={onNext} disabled={slideIndex === totalSlides - 1}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
        <div className="presentation-nav__divider" aria-hidden="true"></div>
        <button className="text-button" type="button" onClick={() => onTop(scrollRef.current)}>맨 위로</button>
        <button className="text-button" type="button" onClick={onCover}>표지</button>
      </div>
    </motion.section>
  );
}

function App() {
  const initialPersistedState = useMemo(() => getInitialPersistedState(), []);
  const [sourceUrl, setSourceUrl] = useState(initialPersistedState.initialUrl);
  const [inputUrl, setInputUrl] = useState(initialPersistedState.initialUrl);
  const [title, setTitle] = useState("Notion Presentation View");
  const [slides, setSlides] = useState([]);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(initialPersistedState.autoRefresh);
  const [fontMode, setFontMode] = useState(initialPersistedState.fontMode);
  const [toolbarHidden, setToolbarHidden] = useState(false);
  const [toolbarPointerInside, setToolbarPointerInside] = useState(false);
  const [hasLoadedDeck, setHasLoadedDeck] = useState(false);
  const [status, setStatus] = useState("공개 Notion 링크를 입력하면 divider 기준으로 슬라이드를 분리해 발표 화면으로 보여줍니다.");
  const [lightboxImage, setLightboxImage] = useState(null);
  const hideTimerRef = useRef(null);
  const hydratedRef = useRef(false);
  const toolbarRef = useRef(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 272, height: 198 });
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight
  }));

  const totalSlides = slides.length + 1;
  const progress = totalSlides <= 1 ? 1 : currentSlideIndex / (totalSlides - 1);
  const activeSlide = currentSlideIndex === 0 ? null : slides[currentSlideIndex - 1];
  const shouldCenterToolbar = !hasLoadedDeck;

  const toolbarPosition = useMemo(() => {
    if (shouldCenterToolbar) {
      return {
        x: -(toolbarSize.width / 2),
        y: -(toolbarSize.height / 2)
      };
    }

    return {
      x: (viewportSize.width / 2) - 18 - toolbarSize.width,
      y: 18 - (viewportSize.height / 2)
    };
  }, [shouldCenterToolbar, toolbarSize.height, toolbarSize.width, viewportSize.height, viewportSize.width]);

  const clearToolbarHideTimer = () => {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const hideToolbar = () => {
    clearToolbarHideTimer();
    setToolbarHidden(true);
  };

  const scheduleToolbarAutoHide = () => {
    clearToolbarHideTimer();

    if (!hasLoadedDeck) return;

    hideTimerRef.current = window.setTimeout(() => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA";

      if (toolbarPointerInside || isTyping) {
        scheduleToolbarAutoHide();
        return;
      }

      setToolbarHidden(true);
    }, TOOLBAR_IDLE_MS);
  };

  const showToolbar = () => {
    setToolbarHidden(false);
  };

  useEffect(() => {
    if (toolbarHidden) {
      clearToolbarHideTimer();
      return undefined;
    }

    if (!hasLoadedDeck) {
      return undefined;
    }

    scheduleToolbarAutoHide();
    return clearToolbarHideTimer;
  }, [toolbarHidden, toolbarPointerInside, hasLoadedDeck]);

  useEffect(() => () => clearToolbarHideTimer(), []);

  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };

    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    return () => window.removeEventListener("resize", updateViewportSize);
  }, []);

  useEffect(() => {
    if (!toolbarRef.current) return undefined;

    const element = toolbarRef.current;
    const updateToolbarSize = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      setToolbarSize({
        width: rect.width,
        height: rect.height
      });
    };

    updateToolbarSize();

    const resizeObserver = new ResizeObserver(updateToolbarSize);
    resizeObserver.observe(element);
    window.requestAnimationFrame(updateToolbarSize);

    return () => resizeObserver.disconnect();
  }, [toolbarHidden, shouldCenterToolbar]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const persistedUrl = sourceUrl || inputUrl;
    if (persistedUrl) params.set("url", persistedUrl);
    else params.delete("url");

    if (autoRefresh) params.set("autoRefresh", "true");
    else params.delete("autoRefresh");

    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [sourceUrl, inputUrl, autoRefresh]);

  useEffect(() => {
    if (!hydratedRef.current) {
      return;
    }

    writeStoredState({
      sourceUrl,
      inputUrl,
      autoRefresh,
      fontMode
    });
  }, [sourceUrl, inputUrl, autoRefresh, fontMode]);

  useEffect(() => {
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!autoRefresh || !sourceUrl || !hasLoadedDeck) return undefined;

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadPresentation(sourceUrl, true);
    }, AUTO_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [autoRefresh, hasLoadedDeck, sourceUrl]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA";

      if (event.key === "Escape") {
        event.preventDefault();
        if (lightboxImage) {
          setLightboxImage(null);
          return;
        }
        showToolbar();
        return;
      }

      if (event.key.toLowerCase() === "r" && !isTyping) {
        event.preventDefault();
        if (inputUrl.trim()) {
          void loadPresentation(inputUrl.trim(), true);
        }
        return;
      }

      if (["ArrowRight", "PageDown", " "].includes(event.key) && !isTyping) {
        event.preventDefault();
        setCurrentSlideIndex((current) => Math.min(totalSlides - 1, current + 1));
        return;
      }

      if (["ArrowLeft", "PageUp"].includes(event.key) && !isTyping) {
        event.preventDefault();
        setCurrentSlideIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (event.key === "Home" && !isTyping) {
        event.preventDefault();
        setCurrentSlideIndex(0);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inputUrl, lightboxImage, totalSlides]);

  async function loadPresentation(urlOverride, isReload) {
    const url = (urlOverride || inputUrl).trim();
    if (!url) {
      setStatus("공개 Notion 링크를 입력하세요.");
      showToolbar();
      return;
    }

    setStatus("불러오는 중");
    showToolbar();

    try {
      const response = await fetch(`/api/parse?url=${encodeURIComponent(url)}`);
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        const message = [payload.error, payload.detail].filter(Boolean).join(" - ");
        throw new Error(message || "불러오기에 실패했습니다.");
      }

      setTitle(payload.title || "Untitled Presentation");
      setSourceUrl(payload.url || url);
      setInputUrl(payload.url || url);
      const nextSlides = Array.isArray(payload.slides) ? payload.slides : [];
      setSlides(nextSlides);
      setCurrentSlideIndex((current) => (isReload ? Math.min(current, nextSlides.length) : 0));
      setHasLoadedDeck(true);
      setStatus("불러왔어요");
    } catch (error) {
      setStatus(error.message || "불러오기에 실패했습니다.");
      showToolbar();
    }
  }

  function toggleAutoRefresh() {
    setAutoRefresh((current) => {
      const next = !current;
      setStatus(next ? "자동 새로고침을 켰습니다. 10초마다 다시 불러옵니다." : "자동 새로고침을 껐습니다.");
      showToolbar();
      return next;
    });
  }

  async function buildStandaloneHtml() {
    const styleText = await fetch(APP_STYLE_URL, { cache: "no-store" }).then((res) => res.text());
    const slideMarkup = buildSlidesMarkup(title, slides, sourceUrl);
    const safeTitle = escapeHtml(title || "Notion Presentation View");
    const safeSource = escapeHtml(sourceUrl || "");

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>${styleText}</style>
</head>
<body>
  <div class="app">
    <div class="progress-bar"><div class="progress-bar__fill" id="progressFill"></div></div>
    <main class="deck" id="deck">${slideMarkup}</main>
    <div class="image-lightbox" id="imageLightbox" hidden>
      <img class="image-lightbox__image" id="imageLightboxImg" alt="" />
    </div>
    <div class="presentation-nav">
      <button class="icon-button" id="prevButton" type="button" aria-label="이전 슬라이드"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg></button>
      <div class="presentation-nav__count" id="slideCounter">1 / 1</div>
      <button class="icon-button" id="nextButton" type="button" aria-label="다음 슬라이드"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg></button>
      <div class="presentation-nav__divider" aria-hidden="true"></div>
      <button class="text-button" id="topButton" type="button">맨 위로</button>
      <button class="text-button" id="coverButton" type="button">표지</button>
    </div>
  </div>
  <script>${buildStandaloneScript().replace(/<\/script>/g, "<\\/script>")}</script>
</body>
</html>`;
  }

  async function downloadStandaloneHtml() {
    if (!totalSlides) return;

    const html = await buildStandaloneHtml();
    const baseName = stripHtml(title || "presentation")
      .replace(/[^\w\-가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "") || "presentation";

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `${baseName}.html`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  const activeContent = useMemo(() => {
    if (currentSlideIndex === 0) {
      const deckCover = deckCoverContent(title, slides);
      return {
        cover: true,
        title: deckCover.title,
        subtitle: deckCover.subtitle
      };
    }

    if (isClosingCoverCandidate(activeSlide, currentSlideIndex - 1, slides)) {
      const coverContent = coverContentForSlide(activeSlide, currentSlideIndex - 1, slides, titleTextForSlide(activeSlide, currentSlideIndex - 1), "");
      return {
        cover: true,
        title: coverContent.title,
        subtitle: coverContent.subtitle
      };
    }

    return { cover: false, slide: activeSlide, index: currentSlideIndex - 1 };
  }, [currentSlideIndex, activeSlide, slides, title]);

  const toolbarTitle = hasLoadedDeck ? stripHtml(title || "slide name") : "paste notion link";
  const toolbarMeta = hasLoadedDeck ? `총 ${totalSlides}장` : "must be public";

  return (
    <div className="app">
      <div className="toolbar-hotspot" aria-hidden="true" onMouseEnter={showToolbar} />

      <AnimatePresence>
        {hasLoadedDeck ? (
          <motion.div
            key="progress"
            className="progress-bar"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <motion.div
              className="progress-bar__fill"
              animate={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
              transition={SOFT_SPRING_TRANSITION}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {!toolbarHidden && (
          <motion.div
            key="toolbar-shell"
            className="toolbar-shell"
            initial={shouldCenterToolbar ? false : {
              opacity: 0,
              scale: 0.92,
              x: toolbarPosition.x,
              y: toolbarPosition.y
            }}
            animate={{
              opacity: 1,
              scale: 1,
              x: toolbarPosition.x,
              y: toolbarPosition.y
            }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{
              opacity: { duration: 0.14, ease: "easeOut" },
              scale: { duration: 0.16, ease: "easeOut" },
              x: { type: "spring", stiffness: 200, damping: 30 },
              y: { type: "spring", stiffness: 200, damping: 30, delay: 0.09 }
            }}
            style={{ transformOrigin: "100% 0%" }}
          >
            <div
              ref={toolbarRef}
              className="toolbar"
              data-toolbar-state={shouldCenterToolbar ? "center" : "corner"}
              onMouseEnter={() => setToolbarPointerInside(true)}
              onMouseLeave={() => setToolbarPointerInside(false)}
              onFocus={() => setToolbarPointerInside(true)}
              onBlur={() => setToolbarPointerInside(false)}
            >
            <div className="toolbar__header">
              <div className="toolbar__title-group">
                <p className="toolbar__title" title={toolbarTitle}>{toolbarTitle}</p>
                <p className="toolbar__meta">{toolbarMeta}</p>
              </div>
              <div className="toolbar__top-actions">
                <button
                  className={`toolbar__icon-button ${autoRefresh ? "is-active" : ""}`}
                  type="button"
                  onClick={() => void loadPresentation(inputUrl, true)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    toggleAutoRefresh();
                  }}
                  aria-label={autoRefresh ? "다시 불러오기, 자동 새로고침 켜짐" : "다시 불러오기"}
                  title={autoRefresh ? "클릭: 다시 불러오기 / 우클릭: 자동 새로고침 끄기" : "클릭: 다시 불러오기 / 우클릭: 자동 새로고침 켜기"}
                >
                  <img src="/refresh-icon.svg" alt="" aria-hidden="true" />
                </button>
                <button className="toolbar__export-button" type="button" onClick={() => void downloadStandaloneHtml()}>Export</button>
              </div>
            </div>

            <div className="toolbar__field">
              <label className="toolbar__label" htmlFor="toolbar-url-input">Notion URL</label>
              <input
                id="toolbar-url-input"
                className="toolbar__input"
                type="url"
                value={inputUrl}
                onChange={(event) => setInputUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void loadPresentation(inputUrl, false);
                  }
                }}
                placeholder="공개 Notion 링크를 입력하세요"
                autoComplete="off"
                spellCheck="false"
              />
            </div>

            <button className="toolbar__load-button" type="button" onClick={() => void loadPresentation(inputUrl, false)}>
              {status === "불러오는 중" || status === "불러왔어요" ? status : "불러오기"}
            </button>

            <div className="toolbar__field toolbar__field--font">
              <label className="toolbar__label">font</label>
              <div className="toolbar__font-group" role="tablist" aria-label="폰트 선택">
                <button
                  className={`toolbar__font-option ${fontMode === "sans" ? "is-selected" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={fontMode === "sans"}
                  onClick={() => setFontMode("sans")}
                >
                  <span className="toolbar__font-sample toolbar__font-sample--sans">Aa</span>
                  <span className="toolbar__font-name toolbar__font-name--sans">고딕체</span>
                </button>
                <button
                  className={`toolbar__font-option ${fontMode === "serif" ? "is-selected" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={fontMode === "serif"}
                  onClick={() => setFontMode("serif")}
                >
                  <span className="toolbar__font-sample toolbar__font-sample--serif">Aa</span>
                  <span className="toolbar__font-name toolbar__font-name--serif">세리프체</span>
                </button>
              </div>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hasLoadedDeck ? (
          <motion.main
            key="deck"
            className={`deck deck--${fontMode}`}
            aria-live="polite"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <AnimatePresence initial={false} mode="wait">
              <DeckSlide
                key={currentSlideIndex}
                cover={activeContent.cover}
                title={activeContent.title}
                subtitle={activeContent.subtitle}
                slide={activeContent.slide}
                slides={slides}
                index={activeContent.index || 0}
                pageUrl={sourceUrl}
                slideIndex={currentSlideIndex}
                totalSlides={totalSlides}
                onPrev={() => setCurrentSlideIndex((current) => Math.max(0, current - 1))}
                onNext={() => setCurrentSlideIndex((current) => Math.min(totalSlides - 1, current + 1))}
                onTop={(scroller) => scroller?.scrollTo({ top: 0, behavior: "smooth" })}
                onCover={() => setCurrentSlideIndex(0)}
                onImageDoubleClick={(image) => {
                  const src = image.getAttribute("src");
                  if (!src) return;
                  setLightboxImage({
                    src,
                    alt: image.getAttribute("alt") || ""
                  });
                }}
              />
            </AnimatePresence>
          </motion.main>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {lightboxImage ? (
          <motion.div
            key="image-lightbox"
            className="image-lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SOFT_SPRING_TRANSITION}
            onClick={() => setLightboxImage(null)}
          >
            <motion.img
              className="image-lightbox__image"
              src={lightboxImage.src}
              alt={lightboxImage.alt}
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 6 }}
              transition={SOFT_SPRING_TRANSITION}
              onClick={(event) => event.stopPropagation()}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
