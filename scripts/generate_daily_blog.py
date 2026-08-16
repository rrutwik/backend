import os
import json
import sys
import logging
import requests
import xml.etree.ElementTree as ET
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List

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
        self.current_model_index = 0
        
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
        
        while self.current_model_index < len(self.models):
            current_model = self.models[self.current_model_index]
            api_url = f"https://generativelanguage.googleapis.com/v1beta/models/{current_model}:generateContent?key={self.api_key}"
            
            logger.info(f"Sending API request to {current_model}...")
            response = requests.post(api_url, headers={"Content-Type": "application/json"}, json=payload)
            
            if response.status_code == 429 and self.current_model_index < len(self.models) - 1:
                logger.warning(f"Rate limit (429) reached for {current_model}. Falling back to next model...")
                self.current_model_index += 1
                continue
                
            if response.status_code != 200:
                logger.error(f"API Error: {response.status_code} - {response.text}")
                raise Exception("API request failed")
                
            break
            
        data = response.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise Exception("No candidates returned from API")
            
        part = candidates[0].get("content", {}).get("parts", [{}])[0]
        
        if "functionCall" in part:
            return {"type": "functionCall", "data": part["functionCall"], "raw_part": part}
        elif "text" in part:
            return {"type": "text", "data": part["text"]}
            
        raise Exception("Unexpected response part format from Gemini")

    def generate_post_data(self) -> Dict[str, Any]:
        recent_history = self._get_recent_history()
        history_str = "\n".join([f"- {t}" for t in recent_history]) if recent_history else "None so far."
        
        prompt = f"""
You are an experienced tech blogger and backend engineer from India. Your task is to write a highly detailed, unique, and engaging tech news blog post.

CRITICAL INSTRUCTIONS:
1. First, use your function tools (`get_techcrunch_news` or `get_hacker_news`) to fetch the latest technology news.
2. Pick EXACTLY ONE of the most interesting news topics returned by the tools.
3. Write the post in a conversational, authentic, human-written Indian English tone. Sound like a seasoned techie sharing field notes with peers over a cup of chai.
4. AVOID cliché AI buzzwords completely (e.g., do not use "delve into", "revolutionary", "game-changer", "landscape", "testament").
5. The post must be comprehensive (at least 600-800 words), offering deep analysis, context, and engineering perspective.
6. Include specific numbers, company names, or quotes found during your research.
7. DO NOT write about any of the following recently covered topics:
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
        published_at = datetime.now(timezone.utc)
        
        document = {
            'title': title,
            'slug': slug,
            'publishedAt': published_at,
            'readTime': read_time,
            'tags': tags,
            'content': content,
            'createdAt': published_at,
            'updatedAt': published_at
        }
        
        # Send to API
        logger.info(f"Sending new blog post to API at {API_URL}...")
        
        # document has datetime which needs to be serialized to isoformat
        document["publishedAt"] = document["publishedAt"].isoformat()
        document["createdAt"] = document["createdAt"].isoformat()
        document["updatedAt"] = document["updatedAt"].isoformat()
        
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
