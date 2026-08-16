import os
import re
import json
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s - [%(levelname)s] - %(message)s")
logger = logging.getLogger(__name__)

API_URL = os.environ.get("API_URL", "http://localhost:3000/blogs")
API_SECRET = os.environ.get("API_SECRET")

if not API_SECRET:
    raise ValueError("API_SECRET environment variable is missing and is required.")

def get_blogs_directory():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_blogs_dir = os.path.abspath(os.path.join(current_dir, "..", "..", "..", "techkarmic-ventures", "src", "content", "blogs"))
    return frontend_blogs_dir

def parse_markdown(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        raw = f.read()
        
    match = re.match(r"^---\n([\s\S]*?)\n---\n?([\s\S]*)$", raw)
    if not match:
        return None
        
    frontmatter_raw = match.group(1)
    content = match.group(2).strip()
    
    fields = {}
    for line in frontmatter_raw.split("\n"):
        if ":" not in line: continue
        key, val = line.split(":", 1)
        key = key.strip()
        val = val.strip()
        if key == "tags":
            try:
                fields[key] = json.loads(val)
            except:
                fields[key] = []
        else:
            fields[key] = re.sub(r'^"|"$', '', val)
            
    try:
        published_date = datetime.strptime(fields.get("publishedAt", ""), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        published_date = datetime.now(timezone.utc)

    return {
        "title": fields.get("title", "Untitled"),
        "slug": fields.get("slug", "untitled"),
        "publishedAt": published_date.isoformat(),
        "readTime": fields.get("readTime", "1 min read"),
        "tags": fields.get("tags", []),
        "content": content,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat()
    }

def main():
    blogs_dir = get_blogs_directory()
    if not os.path.exists(blogs_dir):
        logger.error(f"Cannot find blogs directory at: {blogs_dir}")
        return

    logger.info(f"Syncing blogs via API to {API_URL}...")
    headers = {"x-api-key": API_SECRET, "Content-Type": "application/json"}
    
    success_count = 0
    error_count = 0

    for filename in os.listdir(blogs_dir):
        if not filename.endswith(".md"):
            continue
            
        filepath = os.path.join(blogs_dir, filename)
        blog_data = parse_markdown(filepath)
        
        if blog_data:
            try:
                response = requests.post(API_URL, json=blog_data, headers=headers)
                if response.status_code in [200, 201]:
                    logger.info(f"Successfully synced: {blog_data['title']} ({blog_data['slug']})")
                    success_count += 1
                else:
                    logger.error(f"Failed to sync {blog_data['slug']}. API returned: {response.status_code} {response.text}")
                    error_count += 1
            except Exception as e:
                logger.error(f"Error connecting to API for {blog_data['slug']}: {e}")
                error_count += 1

    logger.info(f"Completed! Synced {success_count} posts. Failed {error_count} posts.")

if __name__ == "__main__":
    main()
