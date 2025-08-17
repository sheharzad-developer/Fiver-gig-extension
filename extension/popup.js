const API = "http://localhost:8000";
const el = (s) => document.querySelector(s);
const show = (s, on=true) => el(s).classList.toggle("hidden", !on);

function setStatus(sel, text, cls="") {
  const n = el(sel);
  n.className = `small ${cls}`;
  n.textContent = text;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getFieldsFromPage() {
  const tab = await activeTab();
  if (!tab || !/^https:\/\/.*\.fiverr\.com\//.test(tab.url || "")) throw new Error("Open a Fiverr Gig Edit page.");
  return await chrome.tabs.sendMessage(tab.id, { type: "GET_GIG_FIELDS" });
}

/* ------- tabs ------- */
function switchTab(which) {
  show("#viewImprove", which === "improve");
  show("#viewReply", which === "reply");
  show("#viewUpcraft", which === "upcraft");
}
el("#tabImprove").onclick = () => switchTab("improve");
el("#tabReply").onclick = () => switchTab("reply");
el("#tabUpcraft").onclick = () => switchTab("upcraft");

/* ------- existing Improve & Reply handlers (from your current code) ------- */
function renderData(data) {
  // Check if data has a response field (our new natural language format)
  if (data && data.response && typeof data.response === 'string') {
    // Natural language response - display it directly
    el("#rawText").innerHTML = data.response.replace(/\n/g, '<br>');
    show("#raw", true);
    show("#chatbotSection", true);
    
    // Hide other sections since we're showing the full analysis
    show("#sectionTitle", false);
    show("#sectionDesc", false);
    show("#sectionTags", false);
    show("#sectionFAQs", false);
    show("#sectionSteps", false);
    show("#sectionChecks", false);
    
    // Extract content for copy buttons
    extractContentForCopy(data.response);
    
  } else if (typeof data === 'string') {
    // Direct string response - display it directly
    el("#rawText").innerHTML = data.replace(/\n/g, '<br>');
    show("#raw", true);
    show("#chatbotSection", true);
    
    // Hide other sections since we're showing the full analysis
    show("#sectionTitle", false);
    show("#sectionDesc", false);
    show("#sectionTags", false);
    show("#sectionFAQs", false);
    show("#sectionSteps", false);
    show("#sectionChecks", false);
    
    // Extract content for copy buttons
    extractContentForCopy(data);
    
  } else {
    // JSON response - handle as before
    show("#sectionTitle", Boolean(data.suggested_title));
    show("#sectionDesc", Boolean(data.suggested_description));
    show("#sectionTags", Boolean(data.tags && data.tags.length));
    show("#sectionFAQs", Boolean(data.faqs && data.faqs.length));
    show("#sectionSteps", Boolean(data.steps && data.steps.length));
    show("#sectionChecks", Boolean(data.checks && data.checks.length));
    show("#raw", true);

    // Populate title section
    if (data.suggested_title) {
      el("#titleText").textContent = data.suggested_title;
    }

    // Populate description section
    if (data.suggested_description) {
      el("#descText").textContent = data.suggested_description;
    }

    // Populate tags section
    if (data.tags && data.tags.length) {
      el("#tagsWrap").innerHTML = data.tags.map(tag => `<span class="pill">${tag}</span>`).join("");
    }

    // Populate FAQs section
    if (data.faqs && data.faqs.length) {
      el("#faqsWrap").textContent = data.faqs.map(faq => `Q: ${faq.q}\nA: ${faq.a}`).join("\n\n");
    }

    // Populate steps section
    if (data.steps && data.steps.length) {
      const stepsList = el("#stepsList");
      stepsList.innerHTML = "";
      data.steps.forEach(step => {
        const li = document.createElement("li");
        li.textContent = step;
        stepsList.appendChild(li);
      });
    }

    // Populate checks section
    if (data.checks && data.checks.length) {
      el("#checksWrap").innerHTML = data.checks.map(check => `<div>• ${check}</div>`).join("");
    }

    // Populate raw response section
    el("#rawText").textContent = JSON.stringify(data, null, 2);
  }
}

// Extract content from natural language response for copy buttons
function extractContentForCopy(responseText) {
  // Extract title
  const titleMatch = responseText.match(/✅\s*["""]([^"""]+)["""]/);
  if (titleMatch) {
    window.extractedTitle = titleMatch[1];
    show("#copyTitle", true);
  }
  
  // Extract description
  const descMatch = responseText.match(/## 3\. \*\*Rewritten Description\*\*\n([\s\S]*?)(?=\n## 4\.|$)/);
  if (descMatch) {
    window.extractedDescription = descMatch[1].trim();
    show("#copyDescription", true);
  }
  
  // Extract tags
  const tagsMatch = responseText.match(/## 4\. \*\*SEO Tags\*\*\n([\s\S]*?)(?=\n## 5\.|$)/);
  if (tagsMatch) {
    const tagsText = tagsMatch[1].replace(/•\s*/g, '').trim();
    window.extractedTags = tagsText;
    show("#copyTags", true);
  }
  
  // Show copy all button if we have any content
  if (window.extractedTitle || window.extractedDescription || window.extractedTags) {
    show("#copyAll", true);
  }
}

async function improveGig() {
  try {
    setStatus("#status", "Reading fields from page…");
    const gig = await getFieldsFromPage();
    if (!gig || (!gig.title && !gig.description)) {
      setStatus("#status", "Could not read fields. Use Upcraft tab or adjust selectors.", "warn");
      return;
    }
    setStatus("#status", "Generating suggestions…");
    const r = await fetch(`${API}/improve_gig`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gig)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    renderData(data);               // reuse your existing renderer
    show("#btnInsert", Boolean(data.suggested_title || data.suggested_description));
    setStatus("#status", "Done ✅", "ok");
  } catch (e) {
    setStatus("#status", String(e), "error");
  }
}
el("#btnImprove").onclick = improveGig;

async function draftReply() {
  try {
    const tab = await activeTab();
    if (!tab || !/^https:\/\/.*\.fiverr\.com\//.test(tab.url || "")) {
      setStatus("#status", "Open a Fiverr Inbox thread first.", "warn");
      return;
    }
    const buyer = await chrome.tabs.sendMessage(tab.id, { type: "GET_BUYER_MESSAGE" });
    const r = await fetch(`${API}/reply_suggestion`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyer_message: buyer?.message || "", tone: "friendly" })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} - ${await r.text()}`);
    const data = await r.json();
    el("#replyText").textContent = data.reply || JSON.stringify(data, null, 2);
    switchTab("reply");
  } catch (e) {
    el("#replyText").textContent = String(e);
  }
}
el("#btnReply").onclick = draftReply;

/* ------- Upcraft: edit fields locally, AI rewrite, variations, insert ------- */
el("#ucLoadFromPage").onclick = async () => {
  try {
    setStatus("#ucStatus", "Loading from page…");
    const gig = await getFieldsFromPage();
    el("#ucTitle").value = gig.title || "";
    el("#ucDesc").value = gig.description || "";
    el("#ucNiche").value = gig.niche || "";
    setStatus("#ucStatus", "Loaded ✅", "ok");
  } catch (e) {
    setStatus("#ucStatus", String(e), "error");
  }
};

el("#ucRewrite").onclick = async () => {
  try {
    setStatus("#ucStatus", "Rewriting…");
    const payload = {
      title: el("#ucTitle").value || "",
      description: el("#ucDesc").value || "",
      niche: el("#ucNiche").value || ""
    };
    const r = await fetch(`${API}/improve_gig`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();

    // render compactly into Upcraft boxes
    el("#ucOutTitle").textContent = data.suggested_title || "";
    el("#ucOutDesc").textContent = data.suggested_description || "";
    el("#ucOutTags").innerHTML = (data.tags || []).map(t => `<span class="pill">${t}</span>`).join("");
    el("#ucOutFaqs").textContent = (data.faqs || []).map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");
    show("#ucResults", true);
    setStatus("#ucStatus", "Done ✅", "ok");

    // click to copy
    el("#ucOutTitle").onclick = async () => { await navigator.clipboard.writeText(el("#ucOutTitle").textContent); setStatus("#ucStatus","Title copied ✅","ok"); };
    el("#ucOutDesc").onclick = async () => { await navigator.clipboard.writeText(el("#ucOutDesc").textContent); setStatus("#ucStatus","Description copied ✅","ok"); };
  } catch (e) {
    setStatus("#ucStatus", String(e), "error");
  }
};

el("#ucVariations").onclick = async () => {
  try {
    setStatus("#ucStatus", "Generating title variations…");
    // reuse /improve_gig but feed description + niche; we’ll derive 3 variants from suggested title
    const payload = {
      title: el("#ucTitle").value || "",
      description: el("#ucDesc").value || "",
      niche: el("#ucNiche").value || ""
    };
    const r = await fetch(`${API}/improve_gig`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const base = data.suggested_title || payload.title || "Professional service";
    // Simple client-side variants: short / SEO / benefit-led
    const vars = [
      base,
      base.replace(/^\s*I will\s+/i, ""),                         // short
      `${(payload.niche || "expert").split(" ")[0]} ${base}`,     // niche-led
    ];
    const list = el("#ucVarList");
    list.innerHTML = "";
    vars.forEach(v => {
      const li = document.createElement("li");
      li.textContent = v;
      li.style.cursor = "pointer";
      li.onclick = () => { el("#ucTitle").value = v; setStatus("#ucStatus","Applied variation ✅","ok"); };
      list.appendChild(li);
    });
    show("#ucVarBox", true);
    setStatus("#ucStatus", "Variations ready ✅", "ok");
  } catch (e) {
    setStatus("#ucStatus", String(e), "error");
  }
};

el("#ucInsert").onclick = async () => {
  try {
    setStatus("#ucStatus", "Inserting to page…");
    const tab = await activeTab();
    const payload = {
      suggested_title: el("#ucTitle").value || "",
      suggested_description: el("#ucDesc").value || ""
    };
    await chrome.tabs.sendMessage(tab.id, { type: "INSERT_GIG_COPY", payload });
    setStatus("#ucStatus", "Inserted ✅", "ok");
  } catch (e) {
    setStatus("#ucStatus", String(e), "error");
  }
};

/* existing insert button for Improve view */
el("#btnInsert").onclick = async () => {
  const tab = await activeTab();
  const payload = {
    suggested_title: el("#titleText").textContent || "",
    suggested_description: el("#descText").textContent || ""
  };
  await chrome.tabs.sendMessage(tab.id, { type: "INSERT_GIG_COPY", payload });
};

/* Copy button handlers */
el("#copyTitle").onclick = async () => {
  if (window.extractedTitle) {
    await navigator.clipboard.writeText(window.extractedTitle);
    setStatus("#status", "Title copied to clipboard! ✅", "ok");
  }
};

el("#copyDescription").onclick = async () => {
  if (window.extractedDescription) {
    await navigator.clipboard.writeText(window.extractedDescription);
    setStatus("#status", "Description copied to clipboard! ✅", "ok");
  }
};

el("#copyTags").onclick = async () => {
  if (window.extractedTags) {
    await navigator.clipboard.writeText(window.extractedTags);
    setStatus("#status", "Tags copied to clipboard! ✅", "ok");
  }
};

el("#copyAll").onclick = async () => {
  let allContent = "";
  if (window.extractedTitle) allContent += `Title: ${window.extractedTitle}\n\n`;
  if (window.extractedDescription) allContent += `Description: ${window.extractedDescription}\n\n`;
  if (window.extractedTags) allContent += `Tags: ${window.extractedTags}\n\n`;
  
  if (allContent) {
    await navigator.clipboard.writeText(allContent);
    setStatus("#status", "All content copied to clipboard! ✅", "ok");
  }
};

/* Chatbot functionality */
el("#sendChat").onclick = async () => {
  const chatInput = el("#chatInput");
  const message = chatInput.value.trim();
  if (!message) return;
  
  // Add user message to chat history
  addChatMessage("You", message, "user");
  chatInput.value = "";
  
  try {
    setStatus("#status", "Processing your request...", "");
    
    // Get current gig data
    const gig = await getFieldsFromPage();
    
    // Send chat request to backend
    const r = await fetch(`${API}/chat_gig`, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: gig.title || "",
        description: gig.description || "",
        niche: gig.niche || "",
        user_message: message
      })
    });
    
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    
    // Add AI response to chat history
    addChatMessage("AI Assistant", data.response || "I'm sorry, I couldn't process that request.", "ai");
    
    setStatus("#status", "Response ready! ✅", "ok");
  } catch (e) {
    addChatMessage("AI Assistant", "Sorry, I encountered an error. Please try again.", "ai");
    setStatus("#status", String(e), "error");
  }
};

// Handle Enter key in chat input
el("#chatInput").onkeypress = (e) => {
  if (e.key === "Enter") {
    el("#sendChat").click();
  }
};

function addChatMessage(sender, message, type) {
  const chatHistory = el("#chatHistory");
  const messageDiv = document.createElement("div");
  messageDiv.style.marginBottom = "8px";
  messageDiv.style.padding = "8px";
  messageDiv.style.borderRadius = "8px";
  messageDiv.style.backgroundColor = type === "user" ? "#1f2937" : "#0f1115";
  messageDiv.style.border = `1px solid ${type === "user" ? "#374151" : "#1f2937"}`;
  
  const senderSpan = document.createElement("div");
  senderSpan.textContent = sender;
  senderSpan.style.fontWeight = "bold";
  senderSpan.style.fontSize = "12px";
  senderSpan.style.marginBottom = "4px";
  senderSpan.style.color = type === "user" ? "#10b981" : "#3b82f6";
  
  const messageSpan = document.createElement("div");
  messageSpan.textContent = message;
  messageSpan.style.fontSize = "12px";
  messageSpan.style.whiteSpace = "pre-wrap";
  
  messageDiv.appendChild(senderSpan);
  messageDiv.appendChild(messageSpan);
  chatHistory.appendChild(messageDiv);
  
  // Scroll to bottom
  chatHistory.scrollTop = chatHistory.scrollHeight;
}