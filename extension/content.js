// Helper utils
function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  function valFrom(el) {
    if (!el) return "";
    if ("value" in el && el.value) return el.value.trim();
    if (el.getAttribute && el.getAttribute("contenteditable") === "true") return el.innerText.trim();
    return (el.textContent || "").trim();
  }
  function firstNonEmpty(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (isVisible(el)) {
        const v = valFrom(el);
        if (v) return v;
      }
    }
    return "";
  }
  function findByLabel(keywords = []) {
    const labelEls = Array.from(document.querySelectorAll("label, [aria-label], [placeholder]"));
    for (const el of labelEls) {
      const text = ((el.innerText || el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase();
      if (keywords.some(k => text.includes(k))) {
        // associated control via for= or nearest input/textarea/div[contenteditable]
        const forId = el.getAttribute("for");
        let ctrl = forId ? document.getElementById(forId) : null;
        if (!ctrl) {
          ctrl = el.querySelector("input, textarea, [contenteditable='true'], [role='textbox']");
        }
        if (!ctrl) {
          ctrl = el.nextElementSibling && el.nextElementSibling.matches?.("input, textarea, [contenteditable='true'], [role='textbox']") ? el.nextElementSibling : null;
        }
        if (isVisible(ctrl)) {
          const v = valFrom(ctrl);
          if (v) return v;
        }
      }
    }
    return "";
  }
  function bestGuessDescription() {
    // Prefer big editors and big textareas
    const candidates = Array.from(document.querySelectorAll(
      `[data-testid*="description" i],
       textarea[name*="description" i],
       textarea[id*="description" i],
       [contenteditable="true"],
       [role="textbox"],
       .public-DraftEditor-content, .ql-editor, .ProseMirror`
    )).filter(isVisible);
  
    // Score by character length and area
    let best = "";
    for (const el of candidates) {
      const v = valFrom(el);
      const score = v.length + el.getBoundingClientRect().width * el.getBoundingClientRect().height / 1000;
      if ((v && v.length > best.length) || (v.length === best.length && score > 0)) best = v;
    }
  
    // Fallback: largest visible textarea
    if (!best) {
      const tas = Array.from(document.querySelectorAll("textarea")).filter(isVisible);
      tas.sort((a,b)=> (b.value?.length||0) - (a.value?.length||0));
      if (tas[0]?.value) best = tas[0].value.trim();
    }
    return best;
  }
  function bestGuessTitle() {
    // Likely single-line inputs near “Title”
    const byLabel = findByLabel(["title", "gig title", "service title"]);
    if (byLabel) return byLabel;
  
    const inputs = Array.from(document.querySelectorAll(
      `input[name*="title" i],
       input[id*="title" i],
       [data-testid*="title" i] input,
       input[placeholder*="title" i]`
    )).filter(isVisible);
  
    for (const el of inputs) {
      const v = valFrom(el);
      if (v && v.split(/\s+/).length <= 20) return v;
    }
  
    // Fallback: any visible input with some text but not too long
    const anyInputs = Array.from(document.querySelectorAll("input")).filter(isVisible);
    for (const el of anyInputs) {
      const v = valFrom(el);
      if (v && v.length <= 120) return v;
    }
    return "";
  }
  function bestGuessKeywords() {
    const byLabel = findByLabel(["keywords", "tags", "search tags"]);
    if (byLabel) return byLabel;
  
    const inputs = Array.from(document.querySelectorAll(
      `input[name*="keyword" i],
       textarea[name*="keyword" i],
       [data-testid*="keyword" i] input,
       input[placeholder*="keyword" i]`
    )).filter(isVisible);
  
    for (const el of inputs) {
      const v = valFrom(el);
      if (v) return v;
    }
    return "";
  }
  
  // Listener
  console.log("[FiverrAI] Content script loaded and listening for messages");
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    console.log("[FiverrAI] Received message:", msg.type);
    
    if (msg.type === "GET_GIG_FIELDS") {
      try {
        // 1) Try exact/common selectors first
        let title = firstNonEmpty([
          'input[name="gig_title"]',
          'textarea[name="gig_title"]',
          '[data-testid="gig-title"] input',
          'input[placeholder*="Gig title" i]'
        ]);
        let description = firstNonEmpty([
          'textarea[name="gig_description"]',
          '[data-testid="gig-description"] textarea',
          '[data-testid="gig-description"]',
          'textarea[placeholder*="Description" i]',
          '.public-DraftEditor-content',
          '.ql-editor',
          '.ProseMirror'
        ]);
        let niche = firstNonEmpty([
          'input[name="gig_keywords"]',
          'textarea[name="gig_keywords"]',
          '[data-testid="gig-keywords"] input',
          'input[placeholder*="keywords" i]',
          'input[placeholder*="tags" i]'
        ]);
    
        // 2) Heuristics if still empty
        if (!title) title = bestGuessTitle();
        if (!description) description = bestGuessDescription();
        if (!niche) niche = bestGuessKeywords();
    
        console.log("[FiverrAI] extracted:", { title, description, niche });
        sendResponse({ title, description, niche });
        return true;
      } catch (error) {
        console.error("[FiverrAI] Error in GET_GIG_FIELDS:", error);
        sendResponse({ error: error.message });
        return true;
      }
    }
  
    if (msg.type === "GET_BUYER_MESSAGE") {
      try {
        const message =
          firstNonEmpty(['[data-testid="message-text"]', '.message-text', '[data-qa="message-text"]']) ||
          bestGuessDescription(); // fallback: biggest visible text region on the page
        console.log("[FiverrAI] buyer message:", message);
        sendResponse({ message });
        return true;
      } catch (error) {
        console.error("[FiverrAI] Error in GET_BUYER_MESSAGE:", error);
        sendResponse({ error: error.message });
        return true;
      }
    }
  
    if (msg.type === "INSERT_GIG_COPY") {
      const { suggested_title, suggested_description } = msg.payload || {};
      // Try to find writable fields to paste into
      const titleEl = document.querySelector(
        'input[name="gig_title"], textarea[name="gig_title"], [data-testid="gig-title"] input, input[placeholder*="Gig title" i], input[id*="title" i]'
      ) || document.querySelector("input");
      const descEl =
        document.querySelector('textarea[name="gig_description"], [data-testid="gig-description"] textarea, textarea[placeholder*="Description" i]') ||
        document.querySelector('[contenteditable="true"], [role="textbox"], .public-DraftEditor-content, .ql-editor, .ProseMirror') ||
        document.querySelector("textarea");
  
      if (titleEl && suggested_title) {
        titleEl.focus();
        if ("value" in titleEl) titleEl.value = suggested_title;
      }
      if (descEl && suggested_description) {
        descEl.focus();
        if (descEl.getAttribute && descEl.getAttribute("contenteditable") === "true") {
          descEl.innerText = suggested_description;
        } else if ("value" in descEl) {
          descEl.value = suggested_description;
        }
      }
      sendResponse({ ok: true });
      return true;
    }
  });