#!/usr/bin/env python3
import os
import json
import sys
import atexit
import logging
import random
import requests
import xml.etree.ElementTree as ET
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List

class GateStateTracker:
    """
    Hooks interpreter exit to automatically mark the run as completed in the
    state file only if the pipeline finished successfully (no exit code != 0 or unhandled exceptions).
    """
    def __init__(self, last_run_file: str, today_str: str, log_file: str, tz: timezone):
        self.last_run_file = last_run_file
        self.today_str = today_str
        self.log_file = log_file
        self.tz = tz
        self.failed = False

        self._orig_exit = sys.exit
        sys.exit = self._hook_exit
        self._orig_excepthook = sys.excepthook
        sys.excepthook = self._hook_exception
        atexit.register(self._on_exit)

    def _hook_exit(self, code=0):
        if code != 0:
            self.failed = True
        self._orig_exit(code)

    def _hook_exception(self, tp, val, tb):
        self.failed = True
        self._orig_excepthook(tp, val, tb)

    def _on_exit(self):
        if not self.failed:
            try:
                with open(self.last_run_file, "w") as f:
                    f.write(self.today_str + "\n")
                now_str = datetime.now(self.tz).strftime("%Y-%m-%d %H:%M:%S IST")
                with open(self.log_file, "a") as f:
                    f.write(f"[{now_str}] Task executed successfully. Marked {self.today_str} as completed in {os.path.basename(self.last_run_file)}.\n")
            except Exception as e:
                sys.stderr.write(f"Error updating completion state file {self.last_run_file}: {e}\n")


def run_gate():
    """
    Gate check designed for 5-minute cron triggers (*/5 * * * *).
    Features:
    - Safe against server restarts: no sleep calls, purely state-file-based.
    - Alternate-day check based on epoch day difference.
    - Random target execution time between window_start_time and window_end_time (IST), persisted to file.
    - Executes task once current time >= target time, then marks date as completed upon success.
    - Meaningful state transitions logged to run.log with timestamps; recurring checks exit quietly.
    """
    # --- Configurable Variables ---
    interval_days = 2
    window_start_time = "09:00"  # Format HH:MM (IST)
    window_end_time = "15:00"    # Format HH:MM (IST)

    # IST Timezone (UTC+05:30)
    ist = timezone(timedelta(hours=5, minutes=30))
    epoch_date = datetime(1970, 1, 1).date()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    last_run_file = os.path.join(script_dir, ".last_run_date")
    target_time_file = os.path.join(script_dir, ".today_target_time")
    gate_state_file = os.path.join(script_dir, ".last_gate_state")
    log_file = os.path.join(script_dir, "run.log")

    now_ist = datetime.now(ist)
    today_ist = now_ist.date()
    today_str = today_ist.strftime("%Y-%m-%d")
    now_str = now_ist.strftime("%Y-%m-%d %H:%M:%S IST")
    now_time_str = now_ist.strftime("%H:%M:%S")

    def _log(msg: str):
        try:
            with open(log_file, "a") as f:
                f.write(msg + "\n")
        except Exception as e:
            sys.stderr.write(f"Failed writing to {log_file}: {e}\n")

    def _save_state(state: str):
        try:
            with open(gate_state_file, "w") as f:
                f.write(state.strip() + "\n")
        except Exception as e:
            sys.stderr.write(f"Failed writing to {gate_state_file}: {e}\n")

    last_gate_state = ""
    if os.path.exists(gate_state_file):
        try:
            with open(gate_state_file, "r") as f:
                last_gate_state = f.read().strip()
        except Exception:
            pass

    today_epoch_day = (today_ist - epoch_date).days

    # 1. Alternate-day check
    if os.path.exists(last_run_file):
        try:
            with open(last_run_file, "r") as f:
                last_run_str = f.read().strip()
            if last_run_str:
                last_run_date = datetime.strptime(last_run_str, "%Y-%m-%d").date()
                last_run_epoch_day = (last_run_date - epoch_date).days
                diff_days = today_epoch_day - last_run_epoch_day

                # If today's task is already marked complete, exit quietly
                if last_run_str == today_str:
                    sys.exit(0)

                # If fewer than interval_days have passed since last run, exit
                if diff_days < interval_days:
                    not_due_state = f"NOT_DUE:{today_str}"
                    if last_gate_state != not_due_state:
                        _log(f"[{now_str}] Skipped: Not due today (only {diff_days} day(s) passed since last run on {last_run_str}; interval is {interval_days} days).")
                        _save_state(not_due_state)
                    sys.exit(0)
        except SystemExit:
            raise
        except Exception:
            # If reading state file fails, proceed to target time check
            pass

    # 2. Random target time selection (persisted for the day)
    target_date_str = None
    target_time_str = None
    if os.path.exists(target_time_file):
        try:
            with open(target_time_file, "r") as f:
                parts = f.read().strip().split()
                if len(parts) >= 2:
                    target_date_str, target_time_str = parts[0], parts[1]
        except Exception:
            pass

    # If no target time has been picked yet for today, generate one
    if target_date_str != today_str:
        try:
            start_h, start_m = map(int, window_start_time.split(":"))
            end_h, end_m = map(int, window_end_time.split(":"))
            start_sec = start_h * 3600 + start_m * 60
            end_sec = end_h * 3600 + end_m * 60

            random_sec = random.randint(start_sec, end_sec)
            target_time_str = f"{random_sec // 3600:02d}:{(random_sec % 3600) // 60:02d}:{random_sec % 60:02d}"

            with open(target_time_file, "w") as f:
                f.write(f"{today_str} {target_time_str}\n")

            _log(f"[{now_str}] Target time for {today_str} picked: {target_time_str} IST (window: {window_start_time}-{window_end_time} IST).")
        except Exception as e:
            sys.stderr.write(f"Failed generating target time: {e}\n")
            target_time_str = f"{window_start_time}:00"

    try:
        target_dt = datetime.strptime(f"{today_str} {target_time_str}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=ist)
    except Exception:
        target_dt = datetime.strptime(f"{today_str} {target_time_str}", "%Y-%m-%d %H:%M").replace(tzinfo=ist)

    # 3. Execution check
    if now_ist < target_dt:
        waiting_state = f"WAITING:{today_str}:{target_time_str}"
        if last_gate_state != waiting_state:
            _log(f"[{now_str}] Skipped: Waiting for target time ({target_time_str} IST), current time is {now_time_str} IST.")
            _save_state(waiting_state)
        # Exit quietly with no action
        sys.exit(0)

    # Current time >= target time: proceed with execution
    exec_state = f"EXECUTING:{today_str}"
    if last_gate_state != exec_state:
        _log(f"[{now_str}] Executing task: Current time ({now_time_str} IST) has reached target time ({target_time_str} IST).")
        _save_state(exec_state)

    # Arm completion tracker to update .last_run_date only upon successful execution
    GateStateTracker(last_run_file, today_str, log_file, ist)


# Call gate function near top of script
run_gate()


# Configure production-style logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [%(levelname)s] - %(name)s - %(message)s'
)
logger = logging.getLogger("BlogGenerator")
logger.setLevel(logging.DEBUG)

# Backend DB Configuration (matches .env.development.local)
API_URL = os.environ.get("API_URL", "http://localhost:3000/blogs")
API_SECRET = os.environ.get("API_SECRET")
if not API_SECRET:
    raise ValueError("API_SECRET environment variable is missing and is required.")

class NewsFetcher:
    """Provides tools for fetching news, exposed to the AI model."""
    
    @staticmethod
    def get_techcrunch_news() -> Dict[str, Any]:
        logger.info("Tool Execution: get_techcrunch_news")
        news_items = []
        try:
            url = "https://techcrunch.com/feed/"
            response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=10)
            if response.status_code == 200:
                root = ET.fromstring(response.content)
                for item in root.findall('.//item')[:5]:
                    title = item.find('title').text if item.find('title') is not None else ""
                    link = item.find('link').text if item.find('link') is not None else ""
                    if title:
                        news_items.append({"title": title, "url": link})
            return {"headlines": news_items}
        except Exception as e:
            logger.error(f"Failed to fetch TechCrunch: {e}")
            return {"error": str(e)}

    @staticmethod
    def get_hacker_news() -> Dict[str, Any]:
        logger.info("Tool Execution: get_hacker_news")
        news_items = []
        try:
            hn_res = requests.get("https://hacker-news.firebaseio.com/v0/topstories.json", timeout=10)
            if hn_res.status_code == 200:
                top_ids = hn_res.json()[:5]
                for item_id in top_ids:
                    item_res = requests.get(f"https://hacker-news.firebaseio.com/v0/item/{item_id}.json", timeout=5)
                    if item_res.status_code == 200:
                        item_data = item_res.json()
                        title = item_data.get("title", "")
                        url = item_data.get("url", "")
                        if title:
                            news_items.append({"title": title, "url": url})
            return {"headlines": news_items}
        except Exception as e:
            logger.error(f"Failed to fetch Hacker News: {e}")
            return {"error": str(e)}

class GeminiBlogGenerator:
    """Handles interaction with Gemini API and Database for blog generation."""
    
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.models = ["gemini-3.6-flash", "gemini-3.5-flash"]
        
        self.tools_schema = {
            "functionDeclarations": [
                {
                    "name": "get_techcrunch_news",
                    "description": "Fetches the latest technology news headlines from TechCrunch. Call this to see recent news.",
                    "parameters": {"type": "OBJECT", "properties": {}}
                },
                {
                    "name": "get_hacker_news",
                    "description": "Fetches the top technology stories from Hacker News. Call this to see recent news.",
                    "parameters": {"type": "OBJECT", "properties": {}}
                }
            ]
        }
        
        self.response_schema = {
            "type": "OBJECT",
            "properties": {
                "title": {"type": "STRING", "description": "A catchy, SEO-friendly title"},
                "slug": {"type": "STRING", "description": "url-friendly-slug-like-this"},
                "tags": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"},
                    "description": "Array of 3-4 relevant tags (e.g., 'Tech', 'News')"
                },
                "content": {"type": "STRING", "description": "The full markdown content of the blog post, excluding the title as an H1. Start with an engaging introduction."}
            },
            "required": ["title", "slug", "tags", "content"]
        }

    def _get_recent_history(self) -> List[str]:
        try:
            # Fetch the latest 5 blogs from the API to avoid duplicate topics
            response = requests.get(API_URL + "?limit=5", timeout=10)
            if response.status_code == 200:
                data = response.json()
                blogs = data.get("data", [])
                return [blog.get("title", "") for blog in blogs if blog.get("title")]
        except Exception as e:
            logger.warning(f"Failed to fetch recent history from API: {e}")
        return []

    def _execute_prompt(self, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        payload = {
            "contents": messages,
            "tools": [self.tools_schema],
            "generationConfig": {
                "temperature": 0.7,
                "responseMimeType": "application/json",
                "responseSchema": self.response_schema
            }
        }

        retryable_status_codes = {429, 500, 502, 503, 504}

        for model_index, current_model in enumerate(self.models):
            api_url = (
                f"https://generativelanguage.googleapis.com/"
                f"v1beta/models/{current_model}:generateContent"
                f"?key={self.api_key}"
            )

            for attempt in range(1, 4):
                logger.info(
                    f"Sending API request to {current_model} "
                    f"(attempt {attempt}/3)..."
                )

                try:
                    response = requests.post(
                        api_url,
                        headers={"Content-Type": "application/json"},
                        json=payload,
                        timeout=120
                    )

                except requests.RequestException as e:
                    logger.warning(
                        f"Request failed for {current_model}: {e}"
                    )

                    if attempt < 3:
                        delay = 2 ** (attempt - 1)
                        logger.info(f"Retrying in {delay}s...")
                        time.sleep(delay)
                        continue

                    break

                # Success
                if response.status_code == 200:
                    logger.info(
                        f"Gemini request succeeded using {current_model}"
                    )

                    data = response.json()
                    candidates = data.get("candidates", [])

                    if not candidates:
                        raise Exception("No candidates returned from API")

                    parts = (
                        candidates[0]
                        .get("content", {})
                        .get("parts", [])
                    )

                    if not parts:
                        raise Exception(
                            "No content parts returned from Gemini"
                        )

                    part = parts[0]

                    if "functionCall" in part:
                        return {
                            "type": "functionCall",
                            "data": part["functionCall"],
                            "raw_part": part
                        }

                    if "text" in part:
                        return {
                            "type": "text",
                            "data": part["text"]
                        }

                    raise Exception(
                        "Unexpected response part format from Gemini"
                    )

                # Retryable error
                if response.status_code in retryable_status_codes:
                    logger.warning(
                        f"Gemini {current_model} returned "
                        f"HTTP {response.status_code}"
                    )

                    if attempt < 3:
                        delay = 2 ** (attempt - 1)

                        logger.info(
                            f"Retrying {current_model} in {delay}s..."
                        )

                        time.sleep(delay)
                        continue

                    logger.warning(
                        f"{current_model} failed after 3 attempts."
                    )

                    break

                # Non-retryable error
                logger.error(
                    f"Gemini API Error: "
                    f"{response.status_code} - {response.text}"
                )

                raise Exception(
                    f"Gemini API request failed with "
                    f"HTTP {response.status_code}"
                )

            # Current model exhausted → fallback
            if model_index < len(self.models) - 1:
                next_model = self.models[model_index + 1]

                logger.warning(
                    f"Falling back from {current_model} "
                    f"to {next_model}..."
                )

        raise Exception(
            "All Gemini models failed after retries."
        )

    def generate_post_data(self) -> Dict[str, Any]:
        recent_history = self._get_recent_history()
        history_str = "\n".join([f"- {t}" for t in recent_history]) if recent_history else "None so far."
        
        prompt = f"""
You are an experienced tech blogger and backend engineer from India. Your task is to write a highly detailed, unique, and engaging tech news blog post.

CRITICAL INSTRUCTIONS:
1. First, use your function tools (`get_techcrunch_news` or `get_hacker_news`) to fetch the latest technology news.
2. Pick EXACTLY ONE of the most interesting news topics returned by the tools.
3. Write the post in a conversational, authentic, human-written tone. Sound like a seasoned engineer sharing field notes with peers.
4. VARY your introductory style significantly. Sometimes dive straight into the technical context, other times open with a very short, unique personal observation. NEVER use the exact same intro phrase (like "Grab a cup of chai") twice. The goal is to sound like a real human who writes differently each day.
5. AVOID cliché AI buzzwords completely (e.g., do not use "delve into", "revolutionary", "game-changer", "landscape", "testament").
6. The post must be comprehensive (at least 600-800 words), offering deep analysis, context, and engineering perspective.
7. Include specific numbers, company names, or quotes found during your research.
8. DO NOT write about any of the following recently covered topics:
{history_str}
"""
        
        messages = [{"role": "user", "parts": [{"text": prompt}]}]
        
        for i in range(5):
            if i > 0:
                time.sleep(5)
                
            logger.info(f"API interaction loop {i+1}...")
            res = self._execute_prompt(messages)
            
            if res["type"] == "text":
                return json.loads(res["data"])
                
            elif res["type"] == "functionCall":
                func_name = res["data"].get("name")
                logger.info(f"Model requested function call: {func_name}")
                
                func_res = None
                if func_name == "get_techcrunch_news":
                    func_res = NewsFetcher.get_techcrunch_news()
                elif func_name == "get_hacker_news":
                    func_res = NewsFetcher.get_hacker_news()
                else:
                    func_res = {"error": f"Unknown function {func_name}"}
                    
                messages.append({"role": "model", "parts": [res["raw_part"]]})
                messages.append({"role": "user", "parts": [{"functionResponse": {"name": func_name, "response": func_res}}]})
                
        raise Exception("Exceeded maximum tool call iterations without final response")

    @staticmethod
    def calculate_read_time(text: str) -> str:
        words = len(text.split())
        minutes = max(1, round(words / 200))
        return f"{minutes} min read"

    def write_to_db(self, post_data: Dict[str, Any]) -> None:
        title = post_data.get('title', 'Untitled')
        slug = post_data.get('slug', 'untitled')
        tags = post_data.get('tags', [])
        content = post_data.get('content', '')
        
        read_time = self.calculate_read_time(content)
        
        document = {
            'title': title,
            'slug': slug,
            'readTime': read_time,
            'tags': tags,
            'content': content
        }
        
        # Send to API
        logger.info(f"Sending new blog post to API at {API_URL}...")
        
        headers = {"x-api-key": API_SECRET, "Content-Type": "application/json"}
        response = requests.post(API_URL, json=document, headers=headers)
        
        if response.status_code in [200, 201]:
            logger.info("Successfully inserted blog post via API.")
        else:
            logger.error(f"Failed to insert blog post. API returned: {response.status_code} {response.text}")
            raise Exception("API synchronization failed")

def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable not set.")
        sys.exit(1)

    logger.info("Starting Database Blog Generation Pipeline")
    generator = GeminiBlogGenerator(api_key=api_key)
    
    try:
        post_data = generator.generate_post_data()
        generator.write_to_db(post_data)
        logger.info("Pipeline completed successfully.")
    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
