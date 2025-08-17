import os, json, requests, re # type: ignore
from fastapi import FastAPI, Body # type: ignore
from fastapi.middleware.cors import CORSMiddleware # type: ignore
from pydantic import BaseModel # type: ignore
from dotenv import load_dotenv # type: ignore
from prompts import (
    SYSTEM_PROMPT_IMPROVE_GIG,
    build_user_prompt_for_improve,
    build_user_prompt_from_scratch,
)

load_dotenv()

# Use an Ollama model name (pulled locally), e.g. "llama3.1" or "qwen2.5:7b-instruct"
MODEL = os.getenv("MODEL", "llama3.1")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    # permissive for local dev (popup + localhost)
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?|chrome-extension://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class GigReq(BaseModel):
    title: str = ""
    description: str = ""
    niche: str = ""

class ReplyReq(BaseModel):
    buyer_message: str
    tone: str = "friendly"
    context: str = ""  # optional: gig type, delivery time, etc.

class ChatReq(BaseModel):
    title: str = ""
    description: str = ""
    niche: str = ""
    user_message: str = ""

# ---------- Ollama helpers ----------

def _flatten_messages_to_prompt(messages) -> str:
    sys_txt = "\n".join(m.get("content", "") for m in messages if m.get("role") == "system").strip()
    user_txt = "\n".join(m.get("content", "") for m in messages if m.get("role") == "user").strip()
    if sys_txt:
        return f"{sys_txt}\n\nUser:\n{user_txt}\n\nAssistant:"
    return user_txt

def call_ollama(messages, model: str = MODEL, temperature: float = 0.5) -> str:
    """
    Use /api/chat if available; otherwise fall back to /api/generate (older Ollama).
    Also handles NDJSON streaming from very old builds.
    """
    print(f"[DEBUG] call_ollama called with model: {model}")
    
    # --- Try /api/chat (newer Ollama) ---
    try:
        print(f"[DEBUG] Trying /api/chat endpoint...")
        r = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": model,
                "messages": messages,
                "options": {"temperature": temperature},
                "stream": False
            },
            timeout=120
        )
        print(f"[DEBUG] /api/chat response status: {r.status_code}")
        # If server exists but returns non-200 (e.g., 404 on old builds), don't raise; we will fall back.
        if r.status_code == 200:
            data = r.json()
            content = data.get("message", {}).get("content", "")
            print(f"[DEBUG] /api/chat successful, content length: {len(content)}")
            return content
        else:
            print(f"[DEBUG] /api/chat failed with status {r.status_code}, falling back to /api/generate")
    except requests.RequestException as e:
        # network/connection error — fall through to /api/generate
        print(f"[DEBUG] /api/chat exception: {e}, falling back to /api/generate")
        pass

    # --- Fallback: /api/generate (older Ollama) ---
    prompt = _flatten_messages_to_prompt(messages)

    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "options": {"temperature": temperature},
                "stream": False
            },
            timeout=120
        )
    except requests.RequestException as e:
        # final error back to caller as JSON string (handled by coerce_json)
        return json.dumps({"error": f"Ollama request failed: {e}"})

    # Some older builds ignore stream=False and return NDJSON stream; detect by content-type
    ctype = (r.headers.get("content-type") or "").lower()
    if r.status_code == 200 and "application/json" in ctype:
        try:
            return r.json().get("response", "")
        except Exception:
            return r.text

    # NDJSON streaming fallback
    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": model, "prompt": prompt, "options": {"temperature": temperature}, "stream": True},
            timeout=120, stream=True
        )
        r.raise_for_status()
        chunks = []
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                obj = json.loads(line)
                if "response" in obj:
                    chunks.append(obj["response"])
                if obj.get("done"):
                    break
            except Exception:
                continue
        return "".join(chunks)
    except requests.RequestException as e:
        return json.dumps({"error": f"Ollama streaming failed: {e}"})


def coerce_json(text: str):
    """
    Handle both JSON and natural language responses.
    - If text is valid JSON, return it as object
    - If text is natural language (like our new format), return it as string
    - Fallback to JSON extraction for compatibility
    """
    # Clean up the text
    cleaned_text = text.strip()
    cleaned_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned_text, flags=re.I)
    
    # Try to parse as JSON first
    try:
        return json.loads(cleaned_text)
    except Exception:
        pass

    # Check if this looks like natural language (has headings, bullet points, etc.)
    if re.search(r'^\s*[#*•\d]', cleaned_text, re.M) or '**' in cleaned_text:
        # This looks like natural language with formatting - return as string
        return cleaned_text

    # Try extract fenced JSON
    candidate = cleaned_text
    m = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", candidate, flags=re.S)
    if m:
        candidate = m.group(0)

    # Remove trailing commas in objects/arrays
    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)

    try:
        return json.loads(candidate)
    except Exception:
        # Try to extract key-value pairs from the text and construct valid JSON
        result = {}
        
        # Extract suggested_title
        title_match = re.search(r'"suggested_title"\s*:\s*"([^"]+)"', text, re.I)
        if title_match:
            result["suggested_title"] = title_match.group(1)
        
        # Extract suggested_description
        desc_match = re.search(r'"suggested_description"\s*:\s*"([^"]+(?:"[^"]*"[^"]*)*)"', text, re.I | re.S)
        if desc_match:
            result["suggested_description"] = desc_match.group(1)
        
        # Extract tags array
        tags_match = re.search(r'"tags"\s*:\s*\[([^\]]+)\]', text, re.I)
        if tags_match:
            tags_str = tags_match.group(1)
            tags = [tag.strip().strip('"\'') for tag in re.findall(r'"([^"]+)"', tags_str)]
            result["tags"] = tags
        
        # Extract FAQs
        faqs_match = re.search(r'"faqs"\s*:\s*\[(.*?)\]', text, re.I | re.S)
        if faqs_match:
            faqs_text = faqs_match.group(1)
            faqs = []
            qa_pairs = re.findall(r'\{[^}]*"q"\s*:\s*"([^"]+)"[^}]*"a"\s*:\s*"([^"]+)"[^}]*\}', faqs_text, re.I)
            for q, a in qa_pairs:
                faqs.append({"q": q, "a": a})
            result["faqs"] = faqs
        
        # If we extracted any content, return it
        if result:
            return result
        
        # Fallback: return the raw text as string for natural language
        return cleaned_text

# ---------- Helpers ----------

def ensure_keys(d: dict) -> dict:
    """Ensure all required JSON keys exist with sensible defaults."""
    return {
        "suggested_title": d.get("suggested_title", ""),
        "suggested_description": d.get("suggested_description", ""),
        "tags": d.get("tags", []),
        "faqs": d.get("faqs", []),
        "step_by_step": d.get("step_by_step", []),
        "reasons": d.get("reasons", []),
        "checks": d.get("checks", {}),
    }

def convert_json_to_natural_language(data: dict, req: GigReq) -> str:
    """Convert JSON response to natural language format."""
    
    # Analyze current gig weaknesses
    weaknesses = []
    if req.title:
        if len(req.title) < 30:
            weaknesses.append("Title is too short and lacks impact")
        if "I will" in req.title.lower():
            weaknesses.append("Title starts with generic 'I will' instead of focusing on benefits")
        if not any(word in req.title.lower() for word in ["professional", "expert", "stunning", "high-quality", "premium"]):
            weaknesses.append("Title lacks compelling adjectives that attract buyers")
    
    if req.description:
        if len(req.description) < 100:
            weaknesses.append("Description is too short and lacks detail")
        if not req.description.startswith(("Transform", "Tired", "Looking", "Need", "Want")):
            weaknesses.append("Description lacks a compelling hook in the first line")
        if "•" not in req.description:
            weaknesses.append("Description lacks benefit bullets that make it scannable")
    
    if not weaknesses:
        weaknesses.append("Gig could benefit from more specific benefits and clearer call-to-action")
    
    # Build natural language response
    response = f"""# 🚀 Fiverr Gig Optimization Analysis

## 1. **Current Weaknesses & Fiverr-Unfriendly Elements**
❌ {chr(10).join(f"• {weakness}" for weakness in weaknesses)}

## 2. **Stronger Title with Keywords**
✅ **{data.get('suggested_title', 'Professional Web Development Services')}**
**Why this works:** This title is more benefit-focused, includes relevant keywords, and avoids the generic "I will" format that buyers often ignore.

## 3. **Rewritten Description**
{data.get('suggested_description', 'Professional web development services with focus on quality and results.')}

## 4. **SEO Tags**
• {' • '.join(data.get('tags', ['web development', 'professional', 'quality']))}

## 5. **Relevant FAQs**
"""
    
    for faq in data.get('faqs', []):
        response += f"""**Q:** {faq.get('q', '')}
**A:** {faq.get('a', '')}

"""
    
    response += """## 6. **Step-by-Step Implementation Checklist**
"""
    
    for i, step in enumerate(data.get('step_by_step', []), 1):
        response += f"**Step {i}:** {step}\n"
    
    response += """
## 7. **Why These Improvements Help**
"""
    
    for reason in data.get('reasons', []):
        response += f"• {reason}\n"
    
    response += """
**Ready to implement these changes? Start with Step 1 and watch your gig performance improve!** 🚀"""
    
    return response

# ---------- Routes ----------

@app.post("/improve_gig")
def improve_gig(req: GigReq):
    """
    If we have at least a title or description from the Fiverr page,
    use the 'improve' prompt. Otherwise, fall back to 'create from scratch'
    with sensible defaults.
    """
    has_any = bool((req.title or "").strip() or (req.description or "").strip())

    if has_any:
        user = build_user_prompt_for_improve(
            niche=req.niche or "",
            title=req.title or "",
            description=req.description or ""
        )
    else:
        # You can pass real values from your popup form; these are placeholders.
        user = build_user_prompt_from_scratch(
            niche=req.niche or "Website design",
            buyer="eCommerce brands",
            deliverables="Homepage + product page + about page",
            turnaround="3 days",
            proof="4+ years experience"
        )

    out = call_ollama([
        {"role": "system", "content": SYSTEM_PROMPT_IMPROVE_GIG},
        {"role": "user", "content": user}
    ])
    
    # Check if the response is JSON and convert it to natural language format
    data = coerce_json(out)
    print(f"[DEBUG] Response type: {type(data)}")
    print(f"[DEBUG] Response keys: {list(data.keys()) if isinstance(data, dict) else 'Not a dict'}")
    print(f"[DEBUG] Has suggested_title: {'suggested_title' in data if isinstance(data, dict) else False}")
    
    # Force conversion to natural language format
    if isinstance(data, dict):
        print("[DEBUG] Converting JSON to natural language")
        natural_response = convert_json_to_natural_language(data, req)
        print(f"[DEBUG] Natural response length: {len(natural_response)}")
        print(f"[DEBUG] Natural response preview: {natural_response[:100]}...")
        # Return the natural language response as a string
        return {"response": natural_response}
    else:
        # Check if the response is a refusal message
        if "cannot fulfill" in str(data).lower() or "cannot provide" in str(data).lower():
            print("[DEBUG] AI refused, generating fallback response")
            # Generate a fallback response using the conversion function
            fallback_data = {
                "suggested_title": "Professional Web Development Services",
                "suggested_description": "Transform your online presence with expertly crafted websites.",
                "tags": ["web development", "professional", "quality"],
                "faqs": [{"q": "What services do you offer?", "a": "Professional web development services."}],
                "step_by_step": ["Update your title", "Improve your description", "Add relevant tags"],
                "reasons": ["Better visibility", "Higher conversions", "Professional appearance"]
            }
            natural_response = convert_json_to_natural_language(fallback_data, req)
            return {"response": natural_response}
        else:
            # Already natural language, return as is
            print("[DEBUG] Returning as natural language")
            return data

@app.post("/seo_score")
def seo_score(data=Body(...)):
    title = (data.get("title") or "").strip()
    desc = (data.get("description") or "").strip()
    primary_kw = (data.get("primary_kw") or "").strip().lower()

    score = 0
    score += 10 if 50 <= len(title) <= 70 else 0
    score += 10 if primary_kw and primary_kw in desc[:100].lower() else 0
    bullets = len([ln for ln in desc.splitlines() if ln.strip().startswith(("•", "-"))])
    score += 10 if 3 <= bullets <= 5 else 0
    score += 10 if 120 <= len(desc.split()) <= 250 else 0

    tips = []
    if not (50 <= len(title) <= 70): tips.append("Aim 50–70 chars for the title.")
    if primary_kw and primary_kw not in desc[:100].lower(): tips.append("Put the primary keyword in the first 100 chars.")
    if bullets < 3: tips.append("Add at least 3 benefit bullets (start with •).")
    if bullets > 5: tips.append("Keep bullets to 3–5 for clarity.")
    if not (120 <= len(desc.split()) <= 250): tips.append("Keep description 120–250 words.")

    return {"score": score, "bullets": bullets, "tips": tips}

@app.post("/reply_suggestion")
def reply_suggestion(req: ReplyReq):
    sys = "You are a professional Fiverr seller assistant. Output JSON with keys: summary, reply, clarifying_questions[], next_steps[]."
    user = f"Tone: {req.tone}\nContext: {req.context}\nBuyer message: {req.buyer_message}\nReturn JSON only."
    out = call_ollama([{"role": "system", "content": sys}, {"role": "user", "content": user}])
    return coerce_json(out)

@app.post("/chat_gig")
def chat_gig(req: ChatReq):
    """
    Chatbot endpoint for follow-up questions about gig optimization.
    """
    sys = """You are a helpful Fiverr Gig Optimization Coach. Users can ask you follow-up questions about their gig improvements.

Examples of requests you can handle:
- "Make it more formal" - Rewrite the title/description in a more professional tone
- "Add more benefits" - Add more benefit bullets to the description
- "Make it shorter" - Create a more concise version
- "Add more keywords" - Suggest additional SEO keywords
- "Make it more casual" - Rewrite in a more friendly, approachable tone
- "Focus on [specific benefit]" - Emphasize a particular benefit or feature

Always provide helpful, actionable responses. If the user asks for changes, provide the updated content in the same format as the original analysis."""
    
    user = f"""Current Gig:
Title: {req.title}
Description: {req.description}
Niche: {req.niche}

User Request: {req.user_message}

Please help the user with their request. Provide specific, actionable advice or updated content."""
    
    out = call_ollama([{"role": "system", "content": sys}, {"role": "user", "content": user}])
    
    # Handle the response
    data = coerce_json(out)
    if isinstance(data, dict):
        return {"response": data.get("response", str(data))}
    else:
        return {"response": str(data)}

@app.get("/health")
def health():
    # Enrich health with Ollama version and model presence
    version = None
    models = []
    model_present = None
    err = None

    try:
        vr = requests.get(f"{OLLAMA_URL}/api/version", timeout=5)
        if vr.ok:
            version = vr.json()
    except Exception as e:
        err = f"version: {e}"

    try:
        tr = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        if tr.ok:
            data = tr.json()
            # tags schema: {"models":[{"name":"llama3.1",...}, ...]}
            models = [m.get("name") for m in data.get("models", []) if m.get("name")]
            model_present = any((MODEL == m) or m.startswith(MODEL) for m in models)
    except Exception as e:
        err = f"{(err + '; ' if err else '')}tags: {e}"

    return {
        "ok": True if version else False,
        "model": MODEL,
        "ollama_url": OLLAMA_URL,
        "ollama_version": version,
        "models": models,
        "model_present": model_present,
        "error": err,
    }

if __name__ == "__main__":
    import uvicorn # type: ignore
    uvicorn.run(app, host="127.0.0.1", port=8000)